import Anthropic from "./vendor/anthropic-sdk.js";
import { db } from "./db.js";
import { makeZip, readZip } from "./zip.js";
import { makeXlsx, readWorkbook, readCsv, sheetsToText } from "./xlsx.js";
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
        required: ["store_name", "date", "currency", "items", "tax", "total"],
        properties: {
          store_name: { type: "string" },
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
- If the file contains no receipt or expense, return an empty receipts array.`;

/**
 * Spreadsheets: the grid is the source. Every expense row of the grid gives exactly one line;
 * an invoice picture is only attached to a row, it never creates, merges or splits lines.
 */
const SHEET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sheet", "row", "date", "store_name", "description", "amount", "currency", "likely_for_children", "picture_ids"],
        properties: {
          sheet: { type: "string", description: "Sheet name, exactly as after '### Sheet:'" },
          row: { type: "integer", description: "Row number N from the 'LN:' prefix" },
          date: { ...nullable("string"), description: "The row's date YYYY-MM-DD" },
          store_name: { type: "string", description: "Merchant if a column gives it, otherwise a short description" },
          description: { type: "string", description: "Short item name from the row" },
          amount: { type: "number", description: "The row's amount (negative for a refund or discount row)" },
          currency: { type: "string", description: "ISO 4217 code" },
          likely_for_children: { type: "string", enum: ["yes", "no", "unsure"] },
          picture_ids: { type: "array", items: { type: "string" }, description: "Invoice pictures (P1, P2…) for this row; empty if none" },
        },
      },
    },
  },
};

const SHEET_PROMPT = `You read an expense list someone typed in a spreadsheet, for a parent who splits the children's expenses with the other parent. Each line of the grid is given as "LN: cell | cell | …" under "### Sheet: name".

Rules:
- Return exactly one entry per grid row that records an expense, in grid order: the row's own date, merchant, description and amount. Never merge several rows into one entry, never split one row into several, never skip an expense row.
- Skip only rows that are not expenses: headers, totals, subtotals, empty rows, and side calculations or reference tables beside the list.
- Amounts are plain numbers and may use a comma as decimal separator in the grid. date is YYYY-MM-DD or null; never invent values.
- likely_for_children: "yes" when clearly for a child (kids' clothing/shoes, diapers, baby food, toys, school supplies, children's medicine, kids' activities or meals); "no" when clearly for an adult; "unsure" for shared household items.
- Invoice pictures pasted in the workbook appear as [picture P3] (in a cell, or at the end of the row where a floating picture starts, with the rows it covers). You only see where they are, not what they show. Pictures never create rows: they are only attached to a row when possible. In picture_ids put the pictures that are the invoice for that row: a picture in the row, or starting on it, belongs to it; a picture on another sheet or on its own row goes to the row its caption or neighbouring cells match (store, date, amount, invoice number). One picture may back several rows; a row may have none. When unsure, leave picture_ids empty.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/**
 * Original files: {id, name, type, kind, size, addedAt, sha256, blob, status, error, receiptIds, payer}.
 * Invoice pictures found in a workbook are files too: kind "invoice", parentId = the workbook's id,
 * picKey ("P1"), place ("Sheet1 C12"), receiptIds = the entries they back.
 */
let files = [];
/** Receipts: {id, fileId, invoiceIds, source, sha256, payer, store_name, date, currency, tax, total, items[{description, line_total, ai_suggestion, alloc, split_pct, cat: "base"|"special"}]} */
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
    if (files.some((f) => f.sha256 === sha256 && f.kind !== "invoice")) { toast(t("t.already", { name: file.name }), 4000); continue; }
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

/** Removes a file and the invoice pictures taken from it. */
async function removeFile(id) {
  const gone = files.filter((f) => f.id === id || (f.kind === "invoice" && f.parentId === id));
  files = files.filter((f) => !gone.includes(f));
  for (const f of gone) {
    if (thumbs.has(f.id)) { URL.revokeObjectURL(thumbs.get(f.id)); thumbs.delete(f.id); }
    await db.del("files", f.id);
  }
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
const isCsv = (file) => /\.csv$/i.test(file.name) || file.type === "text/csv";

/** Workbook cells and pictures. Only the cell values (and where each picture sits) go to Claude. */
async function readSheetFile(file) {
  return isCsv(file) ? { sheets: readCsv(await file.blob.text()), pictures: [] } : readWorkbook(file.blob);
}

async function fileSource(file, wb) {
  if (file.kind === "sheet") {
    return { type: "text", text: `<spreadsheet name="${file.name}">\n${sheetsToText(wb.sheets, wb.pictures)}\n</spreadsheet>` };
  }
  if (file.kind === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: await readAsBase64(file.blob) } };
  }
  const img = await prepareImage(file.blob, file.type);
  return { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
}

async function extract(client, file) {
  const wb = file.kind === "sheet" ? await readSheetFile(file) : null;
  const kids = settings.kidsContext ? `\nAbout the children: ${settings.kidsContext}` : "";
  const params = {
    model: settings.model,
    max_tokens: wb ? 32000 : 16000,
    system: wb ? SHEET_PROMPT : SYSTEM_PROMPT,
    output_config: { effort: "medium", format: { type: "json_schema", schema: wb ? SHEET_SCHEMA : RECEIPT_SCHEMA } },
    messages: [{
      role: "user",
      content: [await fileSource(file, wb), {
        type: "text",
        text: `${file.kind === "sheet" ? "Return one entry per expense row of this grid" : `Extract the receipt(s) in this ${file.kind === "pdf" ? "PDF" : "image"}`} (file name: "${file.name}"). If no currency is shown, assume ${settings.currency}.${kids}`,
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
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(t("e.unreadable")); }
  if (!wb) return { receipts: data.receipts || [], pictures: [] };
  return { receipts: rowsToEntries(wb.sheets, data.rows || []), pictures: wb.pictures };
}

/**
 * One entry per grid row: rows that don't exist or are empty in the grid are dropped,
 * a row returned twice is kept once, and entries follow the grid order.
 */
function rowsToEntries(sheets, rows) {
  const order = new Map(sheets.map((s, i) => [s.name, i]));
  const seen = new Set();
  return rows
    .filter((x) => {
      const cells = sheets[order.get(x.sheet)]?.rows[x.row - 1];
      const key = `${x.sheet}\u0000${x.row}`;
      if (!cells?.some((v) => v != null && String(v).trim() !== "") || seen.has(key) || !Number.isFinite(x.amount)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => order.get(a.sheet) - order.get(b.sheet) || a.row - b.row)
    .map((x) => ({
      store_name: x.store_name || x.description,
      date: x.date,
      currency: x.currency,
      source_ref: `${x.sheet} L${x.row}`,
      picture_ids: x.picture_ids,
      tax: null,
      total: null,
      items: [{ description: x.description || x.store_name, line_total: x.amount, likely_for_children: x.likely_for_children }],
    }));
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

/**
 * Keeps each workbook picture as an invoice file (replacing those of an earlier attempt).
 * Returns picKey → file.
 */
async function saveInvoices(file, pictures) {
  for (const old of files.filter((f) => f.kind === "invoice" && f.parentId === file.id)) {
    files = files.filter((f) => f !== old);
    await db.del("files", old.id);
  }
  const byKey = new Map();
  const bySha = new Map();
  for (const p of pictures) {
    const sha256 = await sha256Hex(p.blob);
    const rows = p.places.filter((x) => x.row != null).map((x) => ({ sheet: x.sheet, row: x.row + 1, rowEnd: (x.rowEnd ?? x.row) + 1, inCell: x.inCell }));
    // The same image stored twice in the workbook is one invoice (one file, one SHA-256).
    const same = bySha.get(sha256);
    if (same) {
      same.rows.push(...rows);
      await saveFile(same);
      byKey.set(p.key, same);
      continue;
    }
    const pl = p.places[0];
    const place = pl.row == null ? pl.sheet : `${pl.sheet} ${colLetters(pl.col)}${pl.row + 1}`;
    const rec = {
      id: `F-${uid()}`,
      parentId: file.id,
      kind: "invoice",
      name: `${file.name.replace(/\.\w+$/, "")} – ${place}.${p.type.split("/")[1].replace("jpeg", "jpg")}`,
      type: p.type,
      size: p.blob.size,
      addedAt: file.addedAt,
      sha256,
      blob: p.blob,
      status: "done",
      receiptIds: [],
      payer: file.payer,
      picKey: p.key,
      place,
      rows,
    };
    files.push(rec);
    await saveFile(rec);
    byKey.set(p.key, rec);
    bySha.set(sha256, rec);
  }
  return byKey;
}

function colLetters(i) {
  let s = "";
  for (let n = (i ?? 0) + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** "Sheet1 L12" → {sheet, row}. */
function parseRef(ref) {
  const m = String(ref || "").trim().match(/^(.*?)\s*L(\d+)$/i);
  return m ? { sheet: m[1].replace(/^Sheet:\s*/i, "").trim(), row: Number(m[2]) } : null;
}

/**
 * Where each picture sits, as the entry it belongs to: a picture in a cell or starting on an
 * entry's row goes to that entry; a floating picture that starts on a non-expense row (a blank
 * or caption row) goes to the first entry row it covers. Returns source_ref → Set(files).
 */
function picturesByPosition(extracted, byKey) {
  const entryRows = new Map();
  for (const x of extracted) {
    const ref = parseRef(x.source_ref);
    if (!ref) continue;
    if (!entryRows.has(ref.sheet)) entryRows.set(ref.sheet, new Set());
    entryRows.get(ref.sheet).add(ref.row);
  }
  const out = new Map();
  const add = (sheet, row, f) => {
    const k = `${sheet} L${row}`;
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(f);
  };
  for (const f of new Set(byKey.values())) {
    for (const p of f.rows) {
      const here = entryRows.get(p.sheet);
      if (!here) continue;
      if (here.has(p.row)) { add(p.sheet, p.row, f); continue; }
      if (p.inCell) continue;
      for (let r = p.row + 1; r <= (p.rowEnd ?? p.row); r++) if (here.has(r)) { add(p.sheet, r, f); break; }
    }
  }
  return out;
}

/** The invoices of an entry: those Claude named, plus any picture placed on the entry's row. */
function invoicesFor(x, byKey, byPos) {
  const named = (x.picture_ids || []).map((k) => byKey.get(String(k).trim().toUpperCase())).filter(Boolean);
  const ref = parseRef(x.source_ref);
  const placed = ref ? [...(byPos.get(`${ref.sheet} L${ref.row}`) || [])] : [];
  return [...new Set([...named, ...placed])];
}

async function createReceipts(file, extracted, byKey = new Map()) {
  const ids = [];
  const touched = new Set();
  const byPos = picturesByPosition(extracted, byKey);
  for (const { picture_ids, ...x } of extracted) {
    const invoices = invoicesFor({ ...x, picture_ids }, byKey, byPos);
    const r = {
      ...x,
      id: nextReceiptId(),
      fileId: file.id,
      invoiceIds: invoices.map((f) => f.id),
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
    for (const f of invoices) { f.receiptIds.push(r.id); touched.add(f); }
  }
  for (const f of touched) await saveFile(f);
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
        const { receipts: extracted, pictures } = await extract(client, file);
        const byKey = await saveInvoices(file, pictures);
        file.receiptIds = await createReceipts(file, extracted, byKey);
        const created = receipts.filter((r) => file.receiptIds.includes(r.id));
        await matchByContent(client, created, [...new Set(byKey.values())]);
        await fillDatesFromInvoices(client, created);
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
// Invoice pictures: read once (date, store, total…), used to match lines left without an
// invoice and to date lines that have none
// ---------------------------------------------------------------------------
const INVOICE_INFO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["invoices"],
  properties: {
    invoices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["picture", "is_invoice", "date", "store_name", "total", "currency", "invoice_number", "items"],
        properties: {
          picture: { type: "string", description: "The label given before the image, e.g. P3" },
          is_invoice: { type: "boolean" },
          date: { ...nullable("string"), description: "Printed invoice/purchase date YYYY-MM-DD, or null" },
          store_name: nullable("string"),
          total: { ...nullable("number"), description: "Total paid" },
          currency: nullable("string"),
          invoice_number: nullable("string"),
          items: { type: "array", items: { type: "string" }, description: "Up to 8 short item names with their amount, e.g. 'Shoes 39.99'" },
        },
      },
    },
  },
};

const INVOICE_INFO_PROMPT = `Each image is an invoice or receipt, introduced by its label (P1, P2…). For each one, return what is printed on it: purchase or invoice date as YYYY-MM-DD, store, total paid, currency, invoice number and up to 8 purchased items with their amount. Use null for anything not printed or not legible, and is_invoice false when the image is not an invoice or receipt. Never use today's date and never guess. For a numeric date such as 03/04/2026, follow the convention of the invoice's country and language (day/month for French-language or Canadian-French invoices, unless the layout clearly shows otherwise).`;

const INFO_BATCH = 8;

const withFallback = (params) => {
  if (FALLBACK_MODELS.has(params.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
};

/** Reads invoice pictures not read yet; stores invoiceInfo (object, or null) and invoiceDate on each. */
async function readInvoiceInfo(client, invoices) {
  const todo = invoices.filter((f) => f.invoiceInfo === undefined && f.blob);
  for (let i = 0; i < todo.length; i += INFO_BATCH) {
    const batch = todo.slice(i, i + INFO_BATCH);
    const content = [];
    for (const f of batch) {
      const img = await prepareImage(f.blob, f.type);
      content.push({ type: "text", text: `Picture ${f.picKey}:` }, { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
    }
    content.push({ type: "text", text: "Return what is printed on each picture." });
    const message = await client.beta.messages.stream(withFallback({
      model: settings.model,
      max_tokens: 8000,
      system: INVOICE_INFO_PROMPT,
      output_config: { effort: "low", format: { type: "json_schema", schema: INVOICE_INFO_SCHEMA } },
      messages: [{ role: "user", content }],
    })).finalMessage();
    if (message.stop_reason !== "end_turn") continue;
    let list = [];
    try { list = JSON.parse(message.content.filter((b) => b.type === "text").map((b) => b.text).join("")).invoices || []; } catch { continue; }
    for (const f of batch) {
      const x = list.find((y) => String(y.picture).trim().toUpperCase() === f.picKey);
      if (!x) continue;
      const { picture, ...info } = x;
      f.invoiceInfo = info.is_invoice ? info : null;
      f.invoiceDate = info.is_invoice && /^\d{4}-\d{2}-\d{2}$/.test(info.date || "") ? info.date : (f.invoiceDate || null);
      await saveFile(f);
    }
  }
}

const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "picture_ids"],
        properties: {
          line: { type: "string", description: "The line reference, e.g. Sheet1 L12" },
          picture_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const MATCH_PROMPT = `You match lines of an expense list to the invoices that back them. You get the lines that have no invoice yet (date, store, description, amount) and what was read on each invoice picture of the same workbook (date, store, total, items), with the lines already linked to it. Give a line a picture only when they clearly match: same store and an amount equal to the invoice total or to one of its items (or several lines adding up to the total), with a date that agrees when both have one. One invoice may back several lines; it may already back other lines. When unsure, return no picture for that line.`;

/**
 * Lines still without an invoice after the position/Claude-grid pass: read the workbook's pictures
 * and match by content (store, amount, date). Only runs when such lines exist.
 */
async function matchByContent(client, list, invoices) {
  const missing = list.filter((r) => !r.invoiceIds?.length);
  if (!missing.length || !invoices.length) return;
  try {
    await readInvoiceInfo(client, invoices);
    const known = invoices.filter((f) => f.invoiceInfo);
    if (!known.length) return;
    const lines = missing.map((r) => ({ line: r.source_ref, date: r.date, store: r.store_name, description: r.items?.[0]?.description, amount: r.items?.[0]?.line_total, currency: r.currency }));
    const pics = known.map((f) => ({ picture: f.picKey, place: f.place, ...f.invoiceInfo, already_linked_to: f.receiptIds.map((id) => receipts.find((r) => r.id === id)?.source_ref).filter(Boolean) }));
    const message = await client.beta.messages.stream(withFallback({
      model: settings.model,
      max_tokens: 16000,
      system: MATCH_PROMPT,
      output_config: { effort: "medium", format: { type: "json_schema", schema: MATCH_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: `Lines without an invoice:\n${JSON.stringify(lines)}\n\nInvoice pictures:\n${JSON.stringify(pics)}` }] }],
    })).finalMessage();
    if (message.stop_reason !== "end_turn") return;
    const matches = JSON.parse(message.content.filter((b) => b.type === "text").map((b) => b.text).join("")).matches || [];
    const byKey = new Map(known.map((f) => [f.picKey, f]));
    const touched = new Set();
    for (const m of matches) {
      const r = missing.find((x) => x.source_ref === String(m.line).trim());
      if (!r || r.invoiceIds?.length) continue;
      const found = [...new Set((m.picture_ids || []).map((k) => byKey.get(String(k).trim().toUpperCase())).filter(Boolean))];
      if (!found.length) continue;
      r.invoiceIds = found.map((f) => f.id);
      r.invoiceFrom = "content";
      await saveReceipt(r);
      for (const f of found) { f.receiptIds.push(r.id); touched.add(f); }
    }
    for (const f of touched) await saveFile(f);
  } catch (err) {
    console.error(err);
    toast(t("t.matchFailed", { msg: describeError(err) }), 5000);
  }
}

/** Gives a dateless entry the date of its first linked invoice that has one. Returns true if it changed. */
function applyInvoiceDate(r) {
  if (r.date) return false;
  const d = invoicesOf(r).map((f) => f.invoiceDate).find(Boolean);
  if (!d) return false;
  r.date = d;
  r.dateFrom = "invoice";
  return true;
}

/** For Excel lines without a date: read their linked invoices (only those) and copy the date. */
async function fillDatesFromInvoices(client, list) {
  const dateless = list.filter((r) => !r.date && r.invoiceIds?.length);
  if (!dateless.length) return;
  try {
    await readInvoiceInfo(client, [...new Set(dateless.flatMap(invoicesOf))]);
  } catch (err) {
    console.error(err);
    toast(t("t.dateFailed", { msg: describeError(err) }), 5000);
  }
  for (const r of dateless) if (applyInvoiceDate(r)) await saveReceipt(r);
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
    if (/^\d{4}-\d{2}-\d{2}$/.test(date.trim()) && date.trim() !== r.date) { r.date = date.trim(); delete r.dateFrom; }
    if (total.trim() === "") r.total = null;
    else if (Number.isFinite(parseAmount(total))) r.total = parseAmount(total);
  });
}

async function deleteReceipt(r) {
  if (!confirm(t("c.delete", { id: r.id, store: r.store_name || t("unknownStore") }))) return;
  receipts = receipts.filter((x) => x.id !== r.id);
  await db.del("receipts", r.id);
  for (const inv of invoicesOf(r)) {
    inv.receiptIds = inv.receiptIds.filter((id) => id !== r.id);
    await saveFile(inv);
  }
  const f = files.find((x) => x.id === r.fileId);
  if (f) {
    f.receiptIds = (f.receiptIds || []).filter((id) => id !== r.id);
    if (!f.receiptIds.length) await removeFile(f.id);
    else await saveFile(f);
  }
  render();
}

function openBlob(f) {
  if (!f?.blob) return;
  const url = URL.createObjectURL(f.blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const viewOriginal = (r) => openBlob(files.find((x) => x.id === r.fileId));

/** Invoice pictures linked to an entry, and all those of the workbook it came from. */
const invoicesOf = (r) => (r.invoiceIds || []).map((id) => files.find((f) => f.id === id)).filter(Boolean);
const workbookInvoices = (r) => files.filter((f) => f.kind === "invoice" && f.parentId === r.fileId)
  .sort((a, b) => a.picKey.localeCompare(b.picKey, undefined, { numeric: true }));

/** Links or unlinks one workbook picture to an entry. */
async function toggleInvoice(r, inv) {
  const linked = (r.invoiceIds || []).includes(inv.id);
  r.invoiceIds = linked ? r.invoiceIds.filter((id) => id !== inv.id) : [...(r.invoiceIds || []), inv.id];
  inv.receiptIds = linked ? inv.receiptIds.filter((id) => id !== r.id) : [...inv.receiptIds, r.id];
  if (linked && r.dateFrom === "invoice" && inv.invoiceDate === r.date && !applyOtherDate(r)) { r.date = null; delete r.dateFrom; }
  await Promise.all([saveReceipt(r), saveFile(inv)]);
  render();
  renderInvoiceDialog(r);
  if (!linked && !r.date && settings.apiKey) {
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
    await fillDatesFromInvoices(client, [r]);
    render();
    renderInvoiceDialog(r);
  }
}

/** After unlinking the invoice a date came from: take another linked invoice's date, if any. */
function applyOtherDate(r) {
  const d = invoicesOf(r).map((f) => f.invoiceDate).find(Boolean);
  if (d) r.date = d;
  return !!d;
}

let invoiceDialogFor = null;
function openInvoiceDialog(r) {
  invoiceDialogFor = r.id;
  renderInvoiceDialog(r);
  $("#invoiceDialog").showModal();
}

function renderInvoiceDialog(r) {
  if (invoiceDialogFor !== r.id) return;
  $("#invoiceFor").textContent = [r.store_name || t("unknownStore"), r.date, r.source_ref].filter(Boolean).join(" · ");
  $("#invoiceGrid").replaceChildren(...workbookInvoices(r).map((inv) => {
    const on = (r.invoiceIds || []).includes(inv.id);
    const others = inv.receiptIds.filter((id) => id !== r.id).map((id) => receipts.find((x) => x.id === id)?.source_ref || id);
    return h("div", { class: `pic ${on ? "on" : ""}` },
      h("button", { type: "button", class: "pic-img", "aria-label": t("inv.open", { place: inv.place }), onclick: () => openBlob(inv) },
        h("img", { src: thumbFor(inv), alt: "" })),
      h("div", { class: "pic-meta" }, [inv.picKey, inv.place, inv.invoiceDate].filter(Boolean).join(" · ")),
      others.length ? h("div", { class: "pic-meta" }, t("inv.alsoOn", { refs: others.join(", ") })) : null,
      h("button", { type: "button", class: `btn small ${on ? "primary" : ""}`, "aria-pressed": String(on), onclick: () => toggleInvoice(r, inv) },
        t(on ? "inv.linked" : "inv.link")));
  }));
}

// ---------------------------------------------------------------------------
// Export & backup
// ---------------------------------------------------------------------------
const payerLabel = (r) => t(r.payer === "other" ? "payer.other" : "payer.me");

/** File-name-safe text that keeps accents (the ZIP stores UTF-8 names). */
const extOf = (f) => (f.name.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase()
  || { "application/pdf": ".pdf", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[f.type] || ".jpg";

/** The proof of an entry: invoice pictures linked to an Excel line, else the photo/PDF it was read from. */
function proofsOf(r) {
  if (r.source_ref) return invoicesOf(r);
  const f = files.find((x) => x.id === r.fileId);
  return f?.blob ? [f] : [];
}

/**
 * Builds the report for the chosen period. docs: every proof of a kids' line, once per content:
 * its SHA-256 (computed from the stored file) is both its identifier in the report and its file
 * name in the zip, so lines sharing an invoice show the same value.
 */
async function buildReport() {
  const list = shownReceipts().filter(inPeriod).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const docs = new Map();
  const docsOf = async (r) => {
    const out = [];
    for (const f of proofsOf(r)) {
      const sha256 = await sha256Hex(f.blob);
      if (!docs.has(sha256)) docs.set(sha256, { name: `${sha256}${extOf(f)}`, blob: f.blob, sha256 });
      if (!out.includes(docs.get(sha256))) out.push(docs.get(sha256));
    }
    return out;
  };
  const lines = [t("xl.hdr")];
  for (const r of list) {
    const kidsLines = allocation(r).lines.filter((it) => it.kids);
    if (!kidsLines.length) continue;
    const proofs = await docsOf(r);
    for (const it of kidsLines) {
      const p = isSpecial(it) ? specialShare(yearOf(r)).p : BASE_SHARE;
      lines.push([r.id, r.date, r.store_name, payerLabel(r), `${it.linked ? "↳ " : ""}${it.description}`, it.line_total,
        Math.round(kidsShare(it) * 100), it.kids, t(isSpecial(it) ? "cat.special" : "cat.base"), p, round2(it.kids * p / 100), curOf(r),
        [r.source, r.source_ref].filter(Boolean).join(" · "), proofs.map((d) => d.sha256).join(", ")]);
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
  const xlsx = await makeXlsx([
    { name: t("xl.account"), rows: summary, money: [1], widths: { 0: 44, 1: 20 } },
    { name: t("xl.lines"), rows: lines, money: [5, 7, 10], widths: { 4: 40, 8: 14, 12: 36, 13: 66 } },
  ]);
  return { xlsx, docs: [...docs.values()] };
}

const reportBase = () => `${t("xl.file")}-${new Date().toISOString().slice(0, 10)}`;

async function exportXlsx() {
  const { xlsx } = await buildReport();
  await shareOrDownload(new File([xlsx], `${reportBase()}.xlsx`, { type: xlsx.type }));
}

/**
 * Separate .zip: the report, the invoices of the kids' lines and a checksum list in
 * sha256sum format (check with `sha256sum -c` / `shasum -a 256 -c`).
 */
async function exportReportZip() {
  const { xlsx, docs } = await buildReport();
  const base = reportBase();
  const dir = t("zip.dir");
  const entries = [{ name: `${base}.xlsx`, data: xlsx }, ...docs.map((d) => ({ name: `${dir}/${d.name}`, data: d.blob }))];
  const sums = await Promise.all(entries.map(async (e) => `${await sha256Hex(e.data)}  ${e.name}`));
  entries.push({ name: t("zip.sums"), data: `${sums.join("\n")}\n` });
  const zip = await makeZip(entries);
  await shareOrDownload(new File([zip], `${base}.zip`, { type: "application/zip" }));
}

const safeName = (s) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 80);
function originalPath(f) {
  if (f.kind === "invoice") return `originals/invoices/${f.parentId}__${f.picKey}__${safeName(f.place || "")}${(f.name.match(/\.[a-z0-9]+$/i) || [".png"])[0]}`;
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
    const dup = files.some((f) => f.id === meta.id || (meta.kind !== "invoice" && f.kind !== "invoice" && f.sha256 === meta.sha256));
    if (meta.withheld || dup) continue;
    const blob = await zip.blob(prefix + (meta.packPath || originalPath(meta)), meta.type);
    if (!blob || (await sha256Hex(blob)) !== meta.sha256) continue;
    const { packPath, ...rest } = meta;
    const rec = { ...rest, blob, status: rest.kind === "invoice" || rest.receiptIds?.length ? "done" : rest.status === "done" ? "done" : "pending" };
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
  if ((f.kind !== "image" && f.kind !== "invoice") || !f.blob) return null;
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
  const loose = files.filter((f) => f.kind === "invoice" && !f.receiptIds.length && shown.some((r) => r.fileId === f.parentId)).length;
  $("#unlinkedPics").hidden = !loose;
  $("#unlinkedPics").textContent = t("list.unlinkedPics", { n: loose });
  const sorted = shown.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id));
  $("#receipts").replaceChildren(...sorted.map(renderReceipt));

  renderAccount();
}

function renderReceipt(r) {
  const c = curOf(r);
  const a = allocation(r);
  const invoices = invoicesOf(r);
  const pool = workbookInvoices(r);
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
        h("div", { class: "meta" }, [r.date ? `${r.date}${r.dateFrom === "invoice" ? ` (${t("date.fromInvoice")})` : ""}` : t("noDate"), r.id, r.source_ref].filter(Boolean).join(" · "))),
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
    invoices.length ? h("div", { class: "invoices" },
      h("span", { class: "meta" }, t("inv.label")),
      invoices.map((inv) => h("button", { class: "inv-thumb", "aria-label": t("inv.open", { place: inv.place }), title: inv.place, onclick: () => openBlob(inv) },
        h("img", { src: thumbFor(inv), alt: "" })))) : null,
    h("div", { class: "actions" },
      h("button", { class: "btn small", onclick: () => viewOriginal(r) }, t(r.source_ref ? "btn.viewSheet" : "btn.view")),
      pool.length ? h("button", { class: "btn small", onclick: () => openInvoiceDialog(r) }, t("inv.btn", { n: invoices.length, total: pool.length })) : null,
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

$("#invoiceDialog").addEventListener("close", () => { invoiceDialogFor = null; });

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
$("#reportZipBtn").addEventListener("click", () => exportReportZip().catch((err) => { console.error(err); toast(err.message); }));

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
