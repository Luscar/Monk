import Anthropic from "./vendor/anthropic-sdk.js";
import { db } from "./db.js";
import { makeZip, readZip } from "./zip.js";
import { makeXlsx, readXlsx, readCsv, sheetsToText } from "./xlsx.js";
import { t, locale, regionCurrency, applyStatic } from "./i18n.js";

// ---------------------------------------------------------------------------
// Settings (small values in localStorage; files and receipts live in IndexedDB)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
};

const pct = (raw, fallback) => {
  const s = String(raw).trim().replace(",", ".");
  const n = Number(s);
  return s !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
};

const settings = {
  get apiKey() { return store.get("apiKey").trim(); },
  get model() { return store.get("model", "claude-opus-5-5"); },
  get currency() { return (store.get("defaultCurrency") || regionCurrency()).toUpperCase(); },
  get kidsContext() { return store.get("kidsContext").trim(); },
  get intakePayer() { return store.get("intakePayer") === "other" ? "other" : "me"; },
  /** My share (%) of the "Particulière" expenses, by year: {"2025": 62, "2026": 58}. */
  get specialShares() {
    try {
      const o = JSON.parse(store.get("specialShares", "{}"));
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  },
};

/** "Base" lines are always split 50/50. */
const BASE_SHARE = 50;

/**
 * My share of a "Particulière" line for a year. A year with no ratio set uses the
 * closest earlier year (or the earliest one set); with none at all, 50 %.
 */
function specialShare(year) {
  const map = settings.specialShares;
  const years = Object.keys(map).filter((y) => /^\d{4}$/.test(y)).map(Number).sort((a, b) => a - b);
  if (!years.length) return { p: BASE_SHARE, from: null };
  const y = Number(year);
  const from = years.includes(y) ? y : years.filter((x) => x < y).pop() ?? years[0];
  return { p: pct(map[from], BASE_SHARE), from };
}

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const CONCURRENCY = 3;
const MAX_IMAGE_EDGE = 2400;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_SPLIT = 50;

// ---------------------------------------------------------------------------
// Extraction: only what's needed to split the kids' expenses
// ---------------------------------------------------------------------------
const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["receipts"],
  properties: {
    receipts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["store_name", "date", "currency", "items", "tax", "total", "source_ref"],
        properties: {
          store_name: { type: "string" },
          source_ref: { type: "string", description: "Spreadsheets only: sheet and row, e.g. 'Sheet1 L12'. Empty string for photos/PDFs" },
          date: { ...nullable("string"), description: "Purchase date YYYY-MM-DD" },
          currency: { type: "string", description: "ISO 4217 code" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description", "line_total", "likely_for_children"],
              properties: {
                description: { type: "string", description: "Short item name" },
                line_total: { type: "number", description: "Amount paid for the line; discounts are negative lines" },
                likely_for_children: { type: "string", enum: ["yes", "no", "unsure"] },
              },
            },
          },
          tax: { ...nullable("number"), description: "Total tax, if printed separately" },
          total: { ...nullable("number"), description: "Amount paid, as printed" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You read receipts and invoices (photos or PDFs) for a parent who splits the children's expenses with the other parent. Extract only what is needed for that split: store, date, currency, each purchased line (short name and amount), tax and total.

Rules:
- One file can hold several receipts; return each as its own entry.
- Amounts are plain numbers. A discount printed as its own line goes right below the item it applies to, as a negative line.
- Skip non-purchase lines (subtotals, payment, change, loyalty points, deposits returned).
- date is the printed purchase date (YYYY-MM-DD), never today. Use null for anything not printed or not legible. Never invent values.
- likely_for_children: "yes" when clearly for a child (kids' clothing/shoes, diapers, baby food, toys, school supplies, children's medicine, kids' activities or meals); "no" when clearly for an adult (alcohol, tobacco, adult clothing, adult toiletries, car parts); "unsure" for shared household items (general groceries, cleaning products, fuel).
- Spreadsheets (an expense list someone typed): each row that records an expense becomes one entry with a single line (unless the row clearly lists several), using the row's own date, description and amount. store_name is the merchant if a column gives it, otherwise a short description. source_ref is the sheet and row (e.g. "Sheet1 L12"). Skip headers, totals, subtotals, empty rows and side calculations or reference tables beside the list. tax and total are null unless the row has its own columns for them. Amounts may use a comma as decimal separator.
- If the file contains no receipt or expense, return an empty receipts array.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** Original files: {id, name, type, kind, size, addedAt, sha256, blob, status, error, receiptIds, payer} */
let files = [];
/** Receipts: {id, fileId, source, sha256, payer, store_name, date, currency, tax, total, items[{description, line_total, ai_suggestion, alloc, split_pct, cat: "base"|"special"}]} */
let receipts = [];
let seq = 0;
let processing = false;
const thumbs = new Map();

async function loadState() {
  [files, receipts, seq] = await Promise.all([db.all("files"), db.all("receipts"), db.get("meta", "seq")]);
  seq ||= 0;
  for (const f of files) if (f.status === "working" || f.status === "queued") f.status = "pending";
  receipts.sort((a, b) => a.id.localeCompare(b.id));
}

const saveFile = (f) => db.put("files", f);
const saveReceipt = (r) => db.put("receipts", r);

function nextReceiptId() {
  seq += 1;
  db.put("meta", seq, "seq");
  return `R-${new Date().getFullYear()}-${String(seq).padStart(4, "0")}`;
}

/** Receipts that count (older versions also stored voided ones and check-only photos "P-…"). */
const shownReceipts = () => receipts.filter((r) => !r.voided && !r.id.startsWith("P-"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

const uid = () => Math.random().toString(36).slice(2, 10);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const curOf = (r) => r.currency || settings.currency;
const parseAmount = (v) => Number(String(v).replace(/[\s  ]/g, "").replace(",", "."));
const numFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => (n == null ? "" : numFmt.format(Number(n)));

function fmtMoney(value, currency) {
  if (value == null || Number.isNaN(value)) return "—";
  try { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value); }
  catch { return `${currency} ${Number(value).toFixed(2)}`; }
}

async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; }
    catch (err) { if (err.name === "AbortError") return; }
  }
  download(file);
}

// ---------------------------------------------------------------------------
// 1. Collect
// ---------------------------------------------------------------------------
const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);
const isSheet = (file) => /\.(xlsx|csv)$/i.test(file.name)
  || ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(file.type);

async function addFiles(fileList) {
  for (const file of [...fileList]) {
    if (/\.(xls|numbers|ods)$/i.test(file.name)) { toast(t("t.oldSheet", { name: file.name }), 6000); continue; }
    const kind = isPdf(file) ? "pdf" : isSheet(file) ? "sheet"
      : file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name) ? "image" : null;
    if (!kind) { toast(t("t.unsupported", { name: file.name })); continue; }
    if (kind === "pdf" && file.size > MAX_PDF_BYTES) { toast(t("t.pdfTooBig", { name: file.name }), 4000); continue; }
    const sha256 = await sha256Hex(file);
    if (files.some((f) => f.sha256 === sha256)) { toast(t("t.already", { name: file.name }), 4000); continue; }
    const rec = {
      id: `F-${uid()}`,
      name: file.name || (kind === "pdf" ? "document.pdf" : "photo.jpg"),
      type: file.type || (kind === "pdf" ? "application/pdf" : "image/jpeg"),
      kind,
      size: file.size,
      addedAt: new Date().toISOString(),
      sha256,
      blob: file,
      status: "pending",
      receiptIds: [],
      payer: settings.intakePayer,
    };
    files.push(rec);
    await saveFile(rec);
  }
  render();
}

async function removeFile(id) {
  files = files.filter((f) => f.id !== id);
  if (thumbs.has(id)) { URL.revokeObjectURL(thumbs.get(id)); thumbs.delete(id); }
  await db.del("files", id);
  render();
}

/** Working copy for Claude only: downscaled, upright JPEG. The original stays untouched. */
async function prepareImage(blob, type) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)) return { data: await readAsBase64(blob), media_type: type };
    throw new Error(t("e.imageFormat"));
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const hgt = Math.round(bitmap.height * scale);
  const canvas = h("canvas", { width: w, height: hgt });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bitmap, 0, 0, w, hgt);
  bitmap.close?.();
  const out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  return { data: await readAsBase64(out), media_type: "image/jpeg" };
}

// ---------------------------------------------------------------------------
// 2. Extract
// ---------------------------------------------------------------------------
async function fileSource(file) {
  if (file.kind === "sheet") {
    // Data only: the cell values are sent as text; pictures inside a workbook are ignored.
    const sheets = /\.csv$/i.test(file.name) || file.type === "text/csv" ? readCsv(await file.blob.text()) : await readXlsx(file.blob);
    return { type: "text", text: `<spreadsheet name="${file.name}">\n${sheetsToText(sheets)}\n</spreadsheet>` };
  }
  if (file.kind === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: await readAsBase64(file.blob) } };
  }
  const img = await prepareImage(file.blob, file.type);
  return { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
}

async function extract(client, file) {
  const kids = settings.kidsContext ? `\nAbout the children: ${settings.kidsContext}` : "";
  const params = {
    model: settings.model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "medium", format: { type: "json_schema", schema: RECEIPT_SCHEMA } },
    messages: [{
      role: "user",
      content: [await fileSource(file), {
        type: "text",
        text: `${file.kind === "sheet" ? "Turn each expense row of this spreadsheet into an entry" : `Extract the receipt(s) in this ${file.kind === "pdf" ? "PDF" : "image"}`} (file name: "${file.name}"). If no currency is shown, assume ${settings.currency}.${kids}`,
      }],
    }],
  };
  if (FALLBACK_MODELS.has(params.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const message = await client.beta.messages.stream(params).finalMessage();
  if (message.stop_reason === "refusal") throw new Error(t("e.refused"));
  if (message.stop_reason === "max_tokens") throw new Error(t("e.cutoff"));
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text).receipts || []; } catch { throw new Error(t("e.unreadable")); }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return t("e.auth");
  if (err instanceof Anthropic.PermissionDeniedError) return t("e.perm");
  if (err instanceof Anthropic.RateLimitError) return t("e.rate");
  if (err instanceof Anthropic.BadRequestError) return t("e.bad", { msg: err.error?.error?.message || err.message });
  if (err instanceof Anthropic.APIConnectionError) return t("e.net");
  if (err instanceof Anthropic.APIError) return t("e.api", { status: err.status ?? "", msg: err.message });
  return err?.message || String(err);
}

/** Claude's guess becomes the starting tag; "unsure" stays untagged for you to decide. */
const SUGGESTION_TO_ALLOC = { yes: "kids", no: "not", unsure: "review" };

async function createReceipts(file, extracted) {
  const ids = [];
  for (const x of extracted) {
    const r = {
      ...x,
      id: nextReceiptId(),
      fileId: file.id,
      source: file.name,
      sha256: file.sha256,
      addedAt: file.addedAt,
      payer: file.payer || "me",
      items: (x.items || []).map((it) => ({
        description: it.description,
        line_total: it.line_total,
        ai_suggestion: it.likely_for_children,
        alloc: SUGGESTION_TO_ALLOC[it.likely_for_children] || "review",
        split_pct: DEFAULT_SPLIT,
        cat: "base",
      })),
    };
    receipts.push(r);
    ids.push(r.id);
    await saveReceipt(r);
  }
  return ids;
}

async function processAll() {
  if (!settings.apiKey) { openSettings(); return; }
  const todo = queueFiles().filter((f) => f.status === "pending" || f.status === "error");
  if (!todo.length) return;
  processing = true;
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
  todo.forEach((f) => { f.status = "queued"; f.error = undefined; });
  render();

  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      file.status = "working";
      render();
      try {
        const extracted = await extract(client, file);
        file.receiptIds = await createReceipts(file, extracted);
        file.status = "done";
        if (!extracted.length) toast(t("t.noReceipt", { name: file.name }), 4000);
      } catch (err) {
        console.error(err);
        file.status = "error";
        file.error = describeError(err);
      }
      await saveFile(file);
      render();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  processing = false;
  render();
  const failed = todo.filter((f) => f.status === "error").length;
  toast(failed ? t("t.failed", { n: failed }) : t("t.done"));
}

// ---------------------------------------------------------------------------
// 3. Split math
// ---------------------------------------------------------------------------
/** A discount line (negative) follows the tag of the item just above it. */
function effectiveItems(r) {
  let prev = null;
  return (r.items || []).map((it) => {
    if ((it.line_total || 0) < 0 && prev) return { ...it, alloc: prev.alloc, split_pct: prev.split_pct, cat: prev.cat, linked: true };
    if ((it.line_total || 0) >= 0) prev = it;
    return it;
  });
}

function receiptTotal(r) {
  if (r.total != null) return r.total;
  return (r.items || []).reduce((s, it) => s + (it.line_total || 0), 0) + (r.tax || 0);
}

const kidsShare = (it) => (it.alloc === "kids" ? 1 : it.alloc === "split" ? (it.split_pct ?? DEFAULT_SPLIT) / 100 : 0);

/** Kids' part of a receipt. Tax is shared out in proportion to the line amounts. */
function allocation(r) {
  const total = receiptTotal(r);
  const items = effectiveItems(r);
  const sum = items.reduce((s, it) => s + (it.line_total || 0), 0);
  const factor = sum ? total / sum : 0;
  const lines = items.map((it) => ({ ...it, kids: round2((it.line_total || 0) * factor * kidsShare(it)) }));
  return {
    total,
    lines,
    kids: round2(lines.reduce((s, it) => s + it.kids, 0)),
    pending: items.filter((it) => it.alloc === "review" && !it.linked).length,
  };
}

function inPeriod(r) {
  const from = $("#periodFrom").value;
  const to = $("#periodTo").value;
  if (!from && !to) return true;
  if (!r.date) return false;
  return (!from || r.date >= from) && (!to || r.date <= to);
}

const isSpecial = (it) => it.cat === "special";
const yearOf = (r) => (r.date || "").slice(0, 4) || String(new Date().getFullYear());

/**
 * Per currency: kids' expenses paid by each parent and who owes whom.
 * "Base" lines are shared 50/50; "Particulière" lines by that year's ratio.
 */
function account(list) {
  const sums = {};
  let pending = 0;
  for (const r of list) {
    const a = allocation(r);
    pending += a.pending;
    if (!a.kids) continue;
    const s = (sums[curOf(r)] ??= { me: 0, other: 0, base: 0, special: {} });
    s[r.payer === "other" ? "other" : "me"] += a.kids;
    for (const it of a.lines) {
      if (!it.kids) continue;
      if (isSpecial(it)) s.special[yearOf(r)] = (s.special[yearOf(r)] || 0) + it.kids;
      else s.base += it.kids;
    }
  }
  const rows = Object.entries(sums).sort().map(([c, s]) => {
    const total = round2(s.me + s.other);
    const base = { amount: round2(s.base), p: BASE_SHARE, mine: round2(s.base * BASE_SHARE / 100) };
    const special = Object.entries(s.special).sort().map(([year, amount]) => {
      const { p, from } = specialShare(year);
      return { year, amount: round2(amount), p, from, mine: round2(amount * p / 100) };
    });
    const myDue = round2(base.mine + special.reduce((n, x) => n + x.mine, 0));
    return { c, me: round2(s.me), other: round2(s.other), total, base, special, myDue, otherDue: round2(total - myDue), balance: round2(s.me - myDue) };
  });
  return { rows, pending };
}

/** Label for a "Particulière" year, noting when another year's ratio is used. */
function specialLabel(x) {
  const ratio = x.from == null ? t("split.noRatio") : String(x.from) !== x.year ? t("split.ratioFrom", { y: x.from }) : "";
  return `${t("split.special", { y: x.year, p: x.p })}${ratio ? ` — ${ratio}` : ""}`;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
const NEXT_ALLOC = { review: "kids", kids: "split", split: "not", not: "review" };
const ALLOC_LABEL = { kids: "tag.kids", split: "tag.split", not: "tag.not", review: "tag.review" };
const CAT_LABEL = { base: "cat.base", special: "cat.special" };

async function update(r, fn) {
  fn(r);
  await saveReceipt(r);
  render();
}

async function editAmount(r, idx) {
  const it = r.items[idx];
  const v = prompt(t("p.amount", { d: it.description }), fmtNum(it.line_total));
  if (v == null || !Number.isFinite(parseAmount(v))) return;
  await update(r, () => { it.line_total = parseAmount(v); });
}

async function editReceipt(r) {
  const store_name = prompt(t("p.store"), r.store_name || "");
  if (store_name == null) return;
  const date = prompt(t("p.date"), r.date || "");
  if (date == null) return;
  const total = prompt(t("p.total"), r.total == null ? "" : fmtNum(r.total));
  if (total == null) return;
  await update(r, () => {
    r.store_name = store_name.trim() || r.store_name;
    r.date = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? date.trim() : r.date;
    if (total.trim() === "") r.total = null;
    else if (Number.isFinite(parseAmount(total))) r.total = parseAmount(total);
  });
}

async function deleteReceipt(r) {
  if (!confirm(t("c.delete", { id: r.id, store: r.store_name || t("unknownStore") }))) return;
  receipts = receipts.filter((x) => x.id !== r.id);
  await db.del("receipts", r.id);
  const f = files.find((x) => x.id === r.fileId);
  if (f) {
    f.receiptIds = (f.receiptIds || []).filter((id) => id !== r.id);
    if (!f.receiptIds.length) await removeFile(f.id);
    else await saveFile(f);
  }
  render();
}

function viewOriginal(r) {
  const f = files.find((x) => x.id === r.fileId);
  if (!f?.blob) return;
  const url = URL.createObjectURL(f.blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Export & backup
// ---------------------------------------------------------------------------
const payerLabel = (r) => t(r.payer === "other" ? "payer.other" : "payer.me");

async function exportXlsx() {
  const list = shownReceipts().filter(inPeriod).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const lines = [t("xl.hdr")];
  for (const r of list) {
    for (const it of allocation(r).lines) {
      if (!it.kids) continue;
      const p = isSpecial(it) ? specialShare(yearOf(r)).p : BASE_SHARE;
      lines.push([r.id, r.date, r.store_name, payerLabel(r), `${it.linked ? "↳ " : ""}${it.description}`, it.line_total,
        Math.round(kidsShare(it) * 100), it.kids, t(isSpecial(it) ? "cat.special" : "cat.base"), p, round2(it.kids * p / 100), curOf(r)]);
    }
  }
  const { rows } = account(list);
  const from = $("#periodFrom").value;
  const to = $("#periodTo").value;
  const summary = [[t("xl.period"), from || to ? `${from || "…"} → ${to || "…"}` : t("xl.all")], []];
  for (const x of rows) {
    summary.push(
      [t("xl.currency"), x.c],
      [t("split.paidMe"), x.me],
      [t("split.paidOther"), x.other],
      [t("split.total"), x.total],
      [t("split.base", { p: x.base.p }), x.base.amount],
      [t("split.mineOf"), x.base.mine],
      ...x.special.flatMap((s) => [[specialLabel(s), s.amount], [t("split.mineOf"), s.mine]]),
      [t("split.shareMe"), x.myDue],
      [t("split.shareOther"), x.otherDue],
      [x.balance >= 0 ? t("split.otherOwes") : t("split.iOwe"), Math.abs(x.balance)],
      [],
    );
  }
  const blob = await makeXlsx([
    { name: t("xl.account"), rows: summary, money: [1], widths: { 0: 44, 1: 20 } },
    { name: t("xl.lines"), rows: lines, money: [5, 7, 10], widths: { 4: 40, 8: 14 } },
  ]);
  await shareOrDownload(new File([blob], `${t("xl.file")}-${new Date().toISOString().slice(0, 10)}.xlsx`, { type: blob.type }));
}

const safeName = (s) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 80);
function originalPath(f) {
  const ext = (f.name.match(/\.[a-z0-9]+$/i) || [""])[0] || (f.kind === "pdf" ? ".pdf" : ".jpg");
  return `originals/${(f.receiptIds || []).join("+") || f.id}__${safeName(f.name.replace(/\.[a-z0-9]+$/i, ""))}${ext}`;
}

async function backup() {
  const kept = files.filter((f) => f.blob);
  const data = JSON.stringify({
    format: "receipt-mailer-pack", version: 3, full: true, exportedAt: new Date().toISOString(), seq,
    receipts, files: kept.map(({ blob, ...meta }) => ({ ...meta, packPath: originalPath(meta) })),
  }, null, 2);
  const zip = await makeZip([{ name: "data.json", data }, ...kept.map((f) => ({ name: originalPath(f), data: f.blob }))]);
  store.set("lastBackup", new Date().toISOString());
  await shareOrDownload(new File([zip], `receipts-backup-${new Date().toISOString().slice(0, 10)}.zip`, { type: "application/zip" }));
}

/** Merges a backup (also those made by older versions). Fingerprints are re-checked. */
async function restore(zipFile) {
  const zip = await readZip(zipFile);
  const dataName = zip.names.find((n) => n === "data.json" || n.endsWith("/data.json"));
  if (!dataName) throw new Error(t("e.notBackup"));
  const prefix = dataName.slice(0, -"data.json".length);
  const data = JSON.parse(await zip.text(dataName));
  if (!Array.isArray(data.receipts) || !Array.isArray(data.files)) throw new Error(t("e.notBackup"));
  let nf = 0, nr = 0;
  for (const meta of data.files) {
    if (meta.withheld || files.some((f) => f.id === meta.id || f.sha256 === meta.sha256)) continue;
    const blob = await zip.blob(prefix + (meta.packPath || originalPath(meta)), meta.type);
    if (!blob || (await sha256Hex(blob)) !== meta.sha256) continue;
    const { packPath, ...rest } = meta;
    const rec = { ...rest, blob, status: rest.receiptIds?.length ? "done" : rest.status === "done" ? "done" : "pending" };
    files.push(rec);
    await saveFile(rec);
    nf += 1;
  }
  for (const r of data.receipts) {
    if (receipts.some((x) => x.id === r.id)) continue;
    receipts.push(r);
    await saveReceipt(r);
    nr += 1;
  }
  const maxId = Math.max(seq, data.seq || 0, ...receipts.map((r) => Number((r.id.match(/^R-\d+-(\d+)$/) || [])[1] || 0)));
  if (maxId !== seq) { seq = maxId; await db.put("meta", seq, "seq"); }
  receipts.sort((a, b) => a.id.localeCompare(b.id));
  render();
  alert(t("a.restoreDone", { r: nr, f: nf }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const STATUS_LABEL = { pending: "q.pending", error: "q.pending", queued: "q.queued", working: "q.working" };

/** Files waiting for extraction (files from removed features — statements, spreadsheets, hand entry — are ignored). */
const queueFiles = () => files.filter((f) => f.status !== "done" && (f.kind === "image" || f.kind === "pdf" || f.kind === "sheet")
  && !f.sensitive && !f.parentId && f.role !== "statement");

function thumbFor(f) {
  if (f.kind !== "image" || !f.blob) return null;
  if (!thumbs.has(f.id)) thumbs.set(f.id, URL.createObjectURL(f.blob));
  return thumbs.get(f.id);
}

function render() {
  $("#setupNotice").hidden = !!settings.apiKey;

  const open = queueFiles();
  $("#queue").replaceChildren(...open.map((f) => {
    const busy = f.status === "working" || f.status === "queued";
    return h("li", {},
      thumbFor(f) ? h("img", { class: "thumb", src: thumbFor(f), alt: "" }) : h("div", { class: "thumb", "aria-hidden": "true" }, f.kind === "sheet" ? "📊" : "📄"),
      h("div", {},
        h("div", { class: "qname" }, f.name),
        h("div", { class: `qstatus ${f.status}` }, f.status === "error" ? f.error : `${t(STATUS_LABEL[f.status])} · ${t(f.payer === "other" ? "payer.other" : "payer.me")}`)),
      h("button", { class: "btn small ghost", "aria-label": t("remove", { name: f.name }), disabled: busy, onclick: () => removeFile(f.id) }, "✕"));
  }));
  const pending = open.filter((f) => f.status === "pending" || f.status === "error").length;
  const pb = $("#processBtn");
  pb.disabled = processing || pending === 0;
  pb.textContent = processing ? t("process.working") : pending ? t("process.count", { n: pending }) : t("process.idle");

  const shown = shownReceipts();
  $("#listCard").hidden = !shown.length;
  $("#splitCard").hidden = !shown.length;
  if (!shown.length) return;

  const untagged = shown.reduce((n, r) => n + allocation(r).pending, 0);
  $("#untagged").hidden = !untagged;
  $("#untagged").textContent = t("list.untagged", { n: untagged });
  const sorted = shown.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id));
  $("#receipts").replaceChildren(...sorted.map(renderReceipt));

  renderAccount();
}

function renderReceipt(r) {
  const c = curOf(r);
  const a = allocation(r);
  const rows = a.lines.map((it, idx) => h("tr", { class: it.alloc === "not" ? "not-kids" : "" },
    h("td", { class: "tagcell" },
      it.linked ? h("span", { class: "tag linked" }, "↳") : h("button", {
        class: `tag ${it.alloc}`,
        onclick: () => update(r, () => { r.items[idx].alloc = NEXT_ALLOC[it.alloc] || "kids"; }),
      }, t(ALLOC_LABEL[it.alloc] || "tag.review")),
      it.alloc === "split" && !it.linked && h("div", {},
        h("input", {
          class: "pct", type: "number", min: 0, max: 100, step: 1, value: it.split_pct ?? DEFAULT_SPLIT,
          onchange: (e) => update(r, () => { r.items[idx].split_pct = pct(e.target.value, DEFAULT_SPLIT); }),
        }), "%"),
      kidsShare(it) > 0 && !it.linked && h("div", {}, h("button", {
        class: `tag cat ${isSpecial(it) ? "special" : "base"}`,
        title: isSpecial(it) ? t("cat.specialHint", { p: specialShare(yearOf(r)).p }) : t("cat.baseHint"),
        onclick: () => update(r, () => { r.items[idx].cat = isSpecial(it) ? "base" : "special"; }),
      }, t(CAT_LABEL[isSpecial(it) ? "special" : "base"])))),
    h("td", { class: "desc" }, it.description),
    h("td", { class: "num" }, h("button", { class: "amount-btn", onclick: () => editAmount(r, idx) }, fmtNum(it.line_total)))));

  return h("article", { class: "receipt" },
    h("header", {},
      h("div", {},
        h("h3", {}, r.store_name || t("unknownStore")),
        h("div", { class: "meta" }, [r.date || t("noDate"), r.id, r.source_ref].filter(Boolean).join(" · "))),
      h("button", {
        class: `badge-btn ${r.payer === "other" ? "other" : ""}`,
        onclick: () => update(r, () => { r.payer = r.payer === "other" ? "me" : "other"; }),
      }, t("btn.payer", { who: payerLabel(r) }))),
    h("div", { class: "kids-line" }, t("forKids"), h("b", {}, ` ${fmtMoney(a.kids, c)} `), h("span", { class: "meta" }, t("ofTotal", { t: fmtMoney(a.total, c) }))),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("tbody", {}, rows),
        h("tfoot", {},
          r.tax != null && h("tr", {}, h("td", {}), h("td", {}, t("tax")), h("td", { class: "num" }, fmtNum(r.tax))),
          h("tr", { class: "grand" }, h("td", {}), h("td", {}, t("total")), h("td", { class: "num" }, fmtMoney(a.total, c)))))),
    h("div", { class: "actions" },
      h("button", { class: "btn small", onclick: () => viewOriginal(r) }, t("btn.view")),
      h("button", { class: "btn small", onclick: () => update(r, () => r.items.forEach((it) => { it.alloc = "kids"; })) }, t("btn.allKids")),
      h("button", { class: "btn small", onclick: () => update(r, () => r.items.forEach((it) => { it.alloc = "not"; })) }, t("btn.noneKids")),
      h("button", { class: "btn small", onclick: () => editReceipt(r) }, t("btn.edit")),
      h("button", { class: "btn small ghost danger", onclick: () => deleteReceipt(r) }, t("btn.delete"))));
}

function renderAccount() {
  const { rows, pending } = account(shownReceipts().filter(inPeriod));
  const line = (label, value, cls = "") => h("div", { class: `acct-row ${cls}` }, h("span", {}, label), h("b", {}, value));
  $("#account").replaceChildren(
    ...(rows.length ? rows.map((x) => h("div", { class: "acct" },
      line(t("split.paidMe"), fmtMoney(x.me, x.c)),
      line(t("split.paidOther"), fmtMoney(x.other, x.c)),
      line(t("split.total"), fmtMoney(x.total, x.c)),
      x.base.amount ? line(t("split.base", { p: x.base.p }), `${fmtMoney(x.base.amount, x.c)} → ${fmtMoney(x.base.mine, x.c)}`, "sub") : null,
      ...x.special.map((s) => line(specialLabel(s), `${fmtMoney(s.amount, x.c)} → ${fmtMoney(s.mine, x.c)}`, "sub")),
      line(t("split.shareMe"), fmtMoney(x.myDue, x.c)),
      line(t("split.shareOther"), fmtMoney(x.otherDue, x.c)),
      Math.abs(x.balance) < 0.005
        ? line(t("split.even"), "", "result")
        : line(x.balance > 0 ? t("split.otherOwes") : t("split.iOwe"), fmtMoney(Math.abs(x.balance), x.c), "result")))
      : [h("p", { class: "hint" }, t("split.none"))]),
    ...(rows.length ? [h("p", { class: "hint" }, t("split.legend"))] : []),
    ...(pending ? [h("p", { class: "hint warn-text" }, t("split.pending", { n: pending }))] : []),
  );
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
function openSettings() {
  $("#apiKey").value = settings.apiKey;
  $("#model").value = settings.model;
  $("#kidsContext").value = settings.kidsContext;
  renderShareRows(settings.specialShares);
  $("#defaultCurrency").value = store.get("defaultCurrency");
  $("#defaultCurrency").placeholder = regionCurrency();
  $("#langSelect").value = store.get("lang") || "auto";
  $("#settingsDialog").showModal();
}

$("#settingsDialog").addEventListener("close", () => {
  if ($("#settingsDialog").returnValue !== "save") return;
  store.set("apiKey", $("#apiKey").value.trim());
  store.set("model", $("#model").value);
  store.set("kidsContext", $("#kidsContext").value.trim());
  const shares = {};
  for (const row of $("#shareRows").children) {
    const y = row.querySelector(".share-year").value.trim();
    const p = String(row.querySelector(".share-pct").value).trim();
    if (/^\d{4}$/.test(y) && p !== "") shares[y] = pct(p, BASE_SHARE);
  }
  store.set("specialShares", JSON.stringify(shares));
  store.set("defaultCurrency", $("#defaultCurrency").value.trim().toUpperCase());
  const newLang = $("#langSelect").value;
  if (newLang !== (store.get("lang") || "auto")) { store.set("lang", newLang); location.reload(); return; }
  toast(t("t.saved"));
  render();
});

function shareRow(year = "", p = "") {
  return h("div", { class: "share-row" },
    h("input", { class: "share-year", type: "number", min: 2000, max: 2100, step: 1, inputmode: "numeric", value: year, "aria-label": t("set.year"), placeholder: t("set.year") }),
    h("input", { class: "share-pct", type: "number", min: 0, max: 100, step: "any", inputmode: "decimal", value: p, "aria-label": t("set.pct"), placeholder: "%" }),
    h("span", {}, "%"),
    h("button", { type: "button", class: "btn small ghost", "aria-label": t("set.removeYear"), onclick: (e) => e.currentTarget.parentElement.remove() }, "✕"));
}

function renderShareRows(map) {
  const years = Object.keys(map).sort();
  $("#shareRows").replaceChildren(...years.map((y) => shareRow(y, map[y])));
}

$("#addShareYear").addEventListener("click", () => {
  const years = [...$("#shareRows").querySelectorAll(".share-year")].map((i) => Number(i.value)).filter(Boolean);
  const next = years.length ? Math.max(...years) + 1 : new Date().getFullYear();
  const prev = $("#shareRows").lastElementChild?.querySelector(".share-pct").value ?? "";
  $("#shareRows").append(shareRow(next, prev));
});

$("#wipeBtn").addEventListener("click", async () => {
  if (!confirm(t("c.wipe"))) return;
  await Promise.all(["files", "receipts", "log", "meta"].map((s) => db.clear(s)));
  files = []; receipts = []; seq = 0;
  thumbs.forEach((u) => URL.revokeObjectURL(u));
  thumbs.clear();
  $("#settingsDialog").close("cancel");
  toast(t("t.wiped"));
  render();
});

$("#backupBtn").addEventListener("click", () => backup().catch((err) => { console.error(err); toast(err.message); }));
$("#restoreInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  $("#settingsDialog").close("cancel");
  try { await restore(f); } catch (err) { console.error(err); alert(t("a.restoreFailed", { msg: err.message })); }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
applyStatic();
$("#settingsBtn").addEventListener("click", openSettings);
document.querySelectorAll("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));

function renderPayerToggle() {
  document.querySelectorAll("[data-payer]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.payer === settings.intakePayer)));
}
document.querySelectorAll("[data-payer]").forEach((b) => b.addEventListener("click", () => {
  store.set("intakePayer", b.dataset.payer);
  renderPayerToggle();
}));
renderPayerToggle();

for (const id of ["#cameraInput", "#galleryInput", "#pdfInput", "#sheetInput"]) {
  $(id).addEventListener("change", async (e) => {
    const list = [...e.target.files];
    e.target.value = "";
    await addFiles(list);
  });
}

const dz = $("#dropZone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); addFiles(e.dataTransfer.files); });

$("#processBtn").addEventListener("click", processAll);
$("#periodFrom").addEventListener("change", renderAccount);
$("#periodTo").addEventListener("change", renderAccount);
$("#exportBtn").addEventListener("click", () => exportXlsx().catch((err) => { console.error(err); toast(err.message); }));

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files?.length) await addFiles(await Promise.all(params.files.map((f) => f.getFile())));
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => reg.update())
    .catch((err) => console.warn("SW registration failed", err));
  let reloaded = !navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded || processing) return;
    reloaded = true;
    location.reload();
  });
}

navigator.storage?.persist?.().catch(() => {});

try { await loadState(); } catch (err) { console.error(err); toast(t("t.noStorage"), 6000); }
render();
