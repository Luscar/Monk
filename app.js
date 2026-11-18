import Anthropic from "./vendor/anthropic-sdk.js";
import { db } from "./db.js";
import { makeZip, readZip } from "./zip.js";

// ---------------------------------------------------------------------------
// Settings (small values in localStorage; files/receipts/log live in IndexedDB)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
};

const settings = {
  get apiKey() { return store.get("apiKey").trim(); },
  get model() { return store.get("model", "claude-opus-5-5"); },
  get defaultEmail() { return store.get("defaultEmail"); },
  get currency() { return (store.get("defaultCurrency") || "USD").toUpperCase(); },
  get autoTag() { return store.get("autoTag") === "1"; },
  get kidsContext() { return store.get("kidsContext").trim(); },
  get splitDefault() {
    const raw = store.get("splitDefault").trim();
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : 50;
  },
};

// Models that support server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const CONCURRENCY = 3;
const MAX_IMAGE_EDGE = 2400;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Extraction schema (structured outputs)
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
        required: [
          "store_name", "store_address", "date", "time", "currency",
          "receipt_number", "payment_method", "items",
          "subtotal", "discount", "tax", "tip", "total", "notes",
        ],
        properties: {
          store_name: { type: "string" },
          store_address: nullable("string"),
          date: { ...nullable("string"), description: "ISO date YYYY-MM-DD" },
          time: { ...nullable("string"), description: "24h HH:MM" },
          currency: { type: "string", description: "ISO 4217 code, e.g. USD" },
          receipt_number: nullable("string"),
          payment_method: { ...nullable("string"), description: "e.g. Visa ****1234, Cash" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description", "quantity", "unit_price", "line_total", "category", "likely_for_children"],
              properties: {
                description: { type: "string" },
                quantity: nullable("number"),
                unit_price: nullable("number"),
                line_total: { type: "number" },
                category: { ...nullable("string"), description: "e.g. Groceries, Clothing, School, Medical, Fuel, Dining" },
                likely_for_children: { type: "string", enum: ["yes", "no", "unsure"] },
              },
            },
          },
          subtotal: nullable("number"),
          discount: { ...nullable("number"), description: "Total discounts as a positive number" },
          tax: nullable("number"),
          tip: nullable("number"),
          total: nullable("number"),
          notes: { ...nullable("string"), description: "Illegible parts, assumptions, or mismatches" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You extract structured data from photos and PDFs of purchase receipts and invoices. The user tracks money spent on their children, so accuracy matters more than speed.

Rules:
- One file can contain several receipts (several photos stitched, multiple pages, or multiple paper receipts in one shot). Return each one as its own entry, in the order they appear.
- Transcribe every purchased line item. Keep the item description close to the printed text, but expand obvious abbreviations when you are confident.
- Use numbers only for amounts (no currency symbols). Discount lines inside the item list may be negative line totals.
- Dates must be YYYY-MM-DD. Resolve ambiguous day/month order using the store's country or currency when possible, and mention any ambiguity in notes.
- Use null for any field that is not printed or not legible. Never invent values.
- If the printed total does not match the sum of items plus tax, keep the printed values and explain in notes.
- likely_for_children is only a suggestion the user will confirm: "yes" for things clearly for a child (kids' clothing or shoe sizes, diapers, baby food, toys, school supplies, children's medicine, kids' activities or meals); "no" for things clearly for an adult (alcohol, tobacco, adult clothing, adult toiletries, car parts); "unsure" for shared household items such as general groceries, cleaning products, or fuel.
- If the file contains no receipt at all, return an empty receipts array.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** Original files: {id, name, type, kind, size, lastModified, addedAt, sha256, blob, status, error, receiptIds} */
let files = [];
/** Receipts: extracted fields + {id, fileId, source, sha256, addedAt, items[{..., alloc, split_pct, ai_suggestion}], reviewed, note, voided, voidReason, edits} */
let receipts = [];
/** Audit log entries: {ts, action, receiptId, detail} */
let logEntries = [];
let seq = 0;
let processing = false;
let filter = "all";
let query = "";
const thumbs = new Map();

async function loadState() {
  [files, receipts, logEntries, seq] = await Promise.all([
    db.all("files"), db.all("receipts"), db.all("log"), db.get("meta", "seq"),
  ]);
  seq ||= 0;
  for (const f of files) {
    if (f.status === "working" || f.status === "queued") f.status = "pending";
  }
  receipts.sort((a, b) => a.id.localeCompare(b.id));
  logEntries.sort((a, b) => a.seq - b.seq);
}

const saveFile = (f) => db.put("files", f);
const saveReceipt = (r) => db.put("receipts", r);

async function log(action, receiptId, detail) {
  const entry = { ts: new Date().toISOString(), action, receiptId: receiptId || "", detail };
  logEntries.push(entry);
  await db.add("log", { ...entry });
}

function nextReceiptId() {
  seq += 1;
  db.put("meta", seq, "seq");
  return `R-${new Date().getFullYear()}-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// DOM helpers
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
  for (const c of children.flat()) {
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

function fmtMoney(value, currency) {
  if (value == null || Number.isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}
const fmtNum = (n) => (n == null ? "" : Number(n).toFixed(2));
const fmtQty = (q) => (q == null ? "" : Number.isInteger(q) ? String(q) : String(+q.toFixed(3)));
const fmtTs = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) : "");
const curOf = (r) => r.currency || settings.currency;

// ---------------------------------------------------------------------------
// File intake
// ---------------------------------------------------------------------------
function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function addFiles(fileList) {
  for (const file of [...fileList]) {
    const kind = isPdf(file) ? "pdf"
      : file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name) ? "image" : null;
    if (!kind) { toast(`Skipped unsupported file: ${file.name}`); continue; }
    if (kind === "pdf" && file.size > MAX_PDF_BYTES) { toast(`${file.name} is over 25 MB — split it first.`, 4000); continue; }

    const sha256 = await sha256Hex(file);
    const existing = files.find((f) => f.sha256 === sha256);
    if (existing) {
      const ids = existing.receiptIds?.length ? ` (${existing.receiptIds.join(", ")})` : "";
      toast(`Already added: ${existing.name}${ids}`, 4000);
      continue;
    }
    const rec = {
      id: `F-${uid()}`,
      name: file.name || (kind === "pdf" ? "document.pdf" : "photo.jpg"),
      type: file.type || (kind === "pdf" ? "application/pdf" : "image/jpeg"),
      kind,
      size: file.size,
      lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      addedAt: new Date().toISOString(),
      sha256,
      blob: file,
      status: "pending",
      receiptIds: [],
    };
    files.push(rec);
    await saveFile(rec);
    await log("file_added", "", `${rec.name} (${rec.size} bytes) sha256=${sha256}`);
  }
  render();
}

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Working copy for Claude only: downscaled, upright JPEG. The original stays untouched. */
async function prepareImage(blob, type) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    const ok = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (ok.includes(type)) return { data: await readAsBase64(blob), media_type: type };
    throw new Error("This browser can't read that image format. Try exporting it as JPEG.");
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const hgt = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bitmap, 0, 0, w, hgt);
  bitmap.close?.();
  const out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  return { data: await readAsBase64(out), media_type: "image/jpeg" };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
function makeClient() {
  return new Anthropic({
    apiKey: settings.apiKey,
    // Personal, client-only app: the user supplies their own key.
    dangerouslyAllowBrowser: true,
    maxRetries: 3,
  });
}

async function extract(client, file) {
  let source;
  if (file.kind === "pdf") {
    source = {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: await readAsBase64(file.blob) },
    };
  } else {
    const img = await prepareImage(file.blob, file.type);
    source = { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
  }

  const kids = settings.kidsContext ? `\nAbout the children: ${settings.kidsContext}` : "";
  const model = settings.model;
  const params = {
    model,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: RECEIPT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          source,
          {
            type: "text",
            text: `Extract every receipt in this ${file.kind === "pdf" ? "PDF" : "image"} (file name: "${file.name}"). If no currency is shown, assume ${settings.currency}.${kids}`,
          },
        ],
      },
    ],
  };
  if (FALLBACK_MODELS.has(model)) {
    // If a safety classifier declines, the API retries on a recommended model in the same call.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const message = await client.beta.messages.stream(params).finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined this file${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Output was cut off — try splitting this file into smaller parts.");
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text).receipts || [];
  } catch {
    throw new Error("Couldn't read Claude's response. Try again.");
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid API key — check settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited — wait a moment and retry.";
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.error?.error?.message || err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Network error — are you online?";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err?.message || String(err);
}

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
      extractedAt: new Date().toISOString(),
      model: settings.model,
      items: (x.items || []).map((it) => ({
        ...it,
        ai_suggestion: it.likely_for_children,
        alloc: settings.autoTag ? SUGGESTION_TO_ALLOC[it.likely_for_children] || "review" : "review",
        split_pct: settings.splitDefault,
      })),
      reviewed: false,
      note: "",
      voided: false,
      voidReason: "",
    };
    receipts.push(r);
    ids.push(r.id);
    await saveReceipt(r);
    await log("receipt_extracted", r.id,
      `${r.store_name || "Unknown"} ${r.date || "no date"} total=${r.total ?? "?"} ${curOf(r)}, ${r.items.length} items, from ${file.name}`);
  }
  return ids;
}

async function processAll() {
  if (!settings.apiKey) { openSettings(); return; }
  const todo = files.filter((f) => f.status === "pending" || f.status === "error");
  if (!todo.length) return;
  processing = true;
  const client = makeClient();
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
        if (!extracted.length) toast(`No receipt found in ${file.name}.`, 4000);
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
  toast(failed ? `${failed} file(s) failed — tap Extract to retry.` : "Done. Review the tags below.");
}

// ---------------------------------------------------------------------------
// Child-expense math
// ---------------------------------------------------------------------------
function receiptTotal(r) {
  if (r.total != null) return r.total;
  const itemsSum = (r.items || []).reduce((s, it) => s + (it.line_total || 0), 0);
  return itemsSum + (r.tax || 0) + (r.tip || 0) - (r.discount || 0);
}

/**
 * Splits a receipt's total into kids / not-kids / unreviewed.
 * Tax, tip and receipt-level discounts are shared out in proportion to the item amounts.
 */
function allocation(r) {
  const total = receiptTotal(r);
  let sum = 0, kids = 0, not = 0, review = 0;
  for (const it of r.items || []) {
    const v = it.line_total || 0;
    sum += v;
    if (it.alloc === "kids") kids += v;
    else if (it.alloc === "split") {
      const p = (it.split_pct ?? 50) / 100;
      kids += v * p;
      not += v * (1 - p);
    } else if (it.alloc === "not") not += v;
    else review += v;
  }
  const factor = sum ? total / sum : 0;
  return {
    total,
    factor,
    kids: round2(kids * factor),
    not: round2(not * factor),
    review: round2(review * factor),
    pending: (r.items || []).filter((i) => i.alloc === "review").length,
  };
}

function itemKidsAmount(it, factor) {
  const v = (it.line_total || 0) * factor;
  if (it.alloc === "kids") return round2(v);
  if (it.alloc === "split") return round2(v * (it.split_pct ?? 50) / 100);
  return 0;
}

const dupKey = (r) => `${(r.store_name || "").toLowerCase().trim()}|${r.date || ""}|${receiptTotal(r).toFixed(2)}`;

function duplicateIds() {
  const groups = new Map();
  for (const r of receipts) {
    if (r.voided) continue;
    const k = dupKey(r);
    groups.set(k, [...(groups.get(k) || []), r.id]);
  }
  const out = new Map();
  for (const ids of groups.values()) {
    if (ids.length > 1) ids.forEach((id) => out.set(id, ids.filter((x) => x !== id)));
  }
  return out;
}

function totalsFor(list) {
  const byCur = {};
  for (const r of list) {
    const c = curOf(r);
    const a = allocation(r);
    byCur[c] ??= { kids: 0, not: 0, review: 0, total: 0, tax: 0, pending: 0, count: 0 };
    const t = byCur[c];
    t.kids += a.kids; t.not += a.not; t.review += a.review; t.total += a.total;
    t.tax += r.tax || 0; t.pending += a.pending; t.count += 1;
  }
  return byCur;
}

const isTagged = (r) => r.items.some((i) => i.alloc !== "review");

// ---------------------------------------------------------------------------
// Edits (all logged)
// ---------------------------------------------------------------------------
const ALLOC_LABEL = { kids: "Kids", split: "Split", not: "Not kids", review: "Untagged" };
const NEXT_ALLOC = { review: "kids", kids: "split", split: "not", not: "kids" };
const getReceipt = (id) => receipts.find((r) => r.id === id);

async function setAlloc(r, idx, alloc) {
  const it = r.items[idx];
  if (it.alloc === alloc) return;
  const from = it.alloc;
  it.alloc = alloc;
  await saveReceipt(r);
  await log("tag_changed", r.id, `"${it.description}": ${ALLOC_LABEL[from]} → ${ALLOC_LABEL[alloc]}${alloc === "split" ? ` (${it.split_pct}%)` : ""}`);
  render();
}

async function setSplit(r, idx, pct) {
  const it = r.items[idx];
  const n = Math.max(0, Math.min(100, Number(pct)));
  if (!Number.isFinite(n) || n === it.split_pct) return;
  const from = it.split_pct;
  it.split_pct = n;
  await saveReceipt(r);
  await log("split_changed", r.id, `"${it.description}": ${from}% → ${n}% for kids`);
  render();
}

async function setAll(r, alloc) {
  const changed = r.items.filter((it) => it.alloc !== alloc);
  if (!changed.length) return;
  changed.forEach((it) => { it.alloc = alloc; });
  await saveReceipt(r);
  await log("tag_changed", r.id, `${changed.length} item(s) → ${ALLOC_LABEL[alloc]}`);
  if (alloc === "review") toast("Tags cleared.");
  render();
}

async function editAmount(r, idx) {
  const it = r.items[idx];
  const v = prompt(`Correct the amount for "${it.description}" (as printed on the receipt):`, fmtNum(it.line_total));
  if (v == null) return;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n)) { toast("Not a number."); return; }
  if (n === it.line_total) return;
  const from = it.line_total;
  it.line_total = n;
  await saveReceipt(r);
  await log("amount_corrected", r.id, `"${it.description}": ${fmtNum(from)} → ${fmtNum(n)}`);
  render();
}

async function editReceipt(r) {
  const fields = [
    ["store_name", "Store name"],
    ["date", "Date (YYYY-MM-DD)"],
    ["total", "Printed total"],
  ];
  for (const [key, label] of fields) {
    const cur = r[key] == null ? "" : String(r[key]);
    const v = prompt(`${label}:`, cur);
    if (v == null) return;
    if (v.trim() === cur) continue;
    let val = v.trim() || null;
    if (key === "total" && val != null) {
      val = Number(val.replace(",", "."));
      if (!Number.isFinite(val)) { toast("Total must be a number."); return; }
    }
    if (key === "date" && val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) { toast("Use YYYY-MM-DD."); return; }
    r[key] = val;
    await log("field_corrected", r.id, `${label}: "${cur}" → "${val ?? ""}"`);
  }
  await saveReceipt(r);
  render();
}

async function editNote(r) {
  const v = prompt("Note for this receipt (e.g. which child, why it was needed):", r.note || "");
  if (v == null || v === r.note) return;
  r.note = v.trim();
  await saveReceipt(r);
  await log("note_set", r.id, r.note || "(cleared)");
  render();
}

async function toggleVoid(r) {
  if (!r.voided) {
    const reason = prompt("Why are you voiding this receipt? (It stays in the history, excluded from totals.)");
    if (!reason) return;
    r.voided = true;
    r.voidReason = reason.trim();
    await log("voided", r.id, r.voidReason);
  } else {
    r.voided = false;
    await log("restored", r.id, `previously voided: ${r.voidReason}`);
    r.voidReason = "";
  }
  await saveReceipt(r);
  render();
}

/** "Verified" = you checked the amounts against the paper receipt. Independent of tagging. */
async function toggleReviewed(r) {
  r.reviewed = !r.reviewed;
  await saveReceipt(r);
  await log(r.reviewed ? "marked_verified" : "unmarked_verified", r.id, `total ${fmtNum(receiptTotal(r))} ${curOf(r)}`);
  render();
}

/** Applies Claude's yes/no suggestions to untagged items only. Returns how many changed. */
function applySuggestionsTo(r) {
  let n = 0;
  for (const it of r.items) {
    const to = SUGGESTION_TO_ALLOC[it.ai_suggestion];
    if (it.alloc === "review" && to && to !== "review") { it.alloc = to; n += 1; }
  }
  return n;
}

const suggestableCount = (r) => r.voided ? 0
  : r.items.filter((it) => it.alloc === "review" && (it.ai_suggestion === "yes" || it.ai_suggestion === "no")).length;

async function applySuggestions(r) {
  const n = applySuggestionsTo(r);
  if (!n) { toast("No suggestions to apply — tag the remaining lines by hand."); return; }
  await saveReceipt(r);
  await log("suggestions_applied", r.id, `${n} item(s) tagged from Claude's suggestions`);
  render();
}

async function applyAllSuggestions() {
  const targets = receipts.filter((r) => suggestableCount(r));
  const total = targets.reduce((s, r) => s + suggestableCount(r), 0);
  if (!total || !confirm(`Tag ${total} item(s) on ${targets.length} receipt(s) using Claude's suggestions? Items Claude was unsure about (e.g. groceries) stay untagged. You can change any tag afterwards.`)) return;
  for (const r of targets) {
    const n = applySuggestionsTo(r);
    await saveReceipt(r);
    await log("suggestions_applied", r.id, `${n} item(s) tagged from Claude's suggestions (bulk)`);
  }
  toast(`Tagged ${total} item(s).`);
  render();
}

async function shareOrDownload(file, title) {
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (err) {
    if (err?.name === "AbortError") return;
  }
  download(file);
}

const fileOf = (r) => files.find((x) => x.id === r.fileId);

/** Save the untouched original (e.g. into Photos via the share sheet). */
async function saveOriginal(r) {
  const f = fileOf(r);
  if (!f?.blob) { toast("Original file not found on this device."); return; }
  await shareOrDownload(new File([f.blob], f.name, { type: f.type }), f.name);
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A copy of the photo with a banner listing its receipt ID(s), store, date, total and the
 * original's fingerprint. Meant for printing/sharing; the original stays untouched.
 */
async function stampedImage(f) {
  if (f.kind !== "image" || !f.blob) return null;
  let bmp;
  try { bmp = await createImageBitmap(f.blob, { imageOrientation: "from-image" }); } catch { return null; }
  const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const w = Math.max(600, Math.round(bmp.width * scale));
  const ih = Math.round(bmp.height * (w / bmp.width));
  const font = Math.max(16, Math.round(w * 0.026));
  const lineH = Math.round(font * 1.35);
  const pad = Math.round(font * 0.8);

  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `600 ${font}px system-ui, sans-serif`;
  const rs = (f.receiptIds || []).map(getReceipt).filter(Boolean);
  const raw = [
    ...rs.map((r) => `${r.id} · ${r.store_name || "Unknown store"} · ${r.date || "no date"} · Total ${fmtMoney(receiptTotal(r), curOf(r))}${r.voided ? " · VOIDED" : ""}`),
    `Original: ${f.name} · added ${fmtTs(f.addedAt)} UTC`,
    "SHA-256 fingerprint of original:",
    f.sha256.slice(0, 32),
    f.sha256.slice(32),
  ];
  const lines = raw.flatMap((t) => wrapText(measure, t, w - pad * 2));
  const bannerH = pad * 2 + lineH * lines.length;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = ih + bannerH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, ih);
  ctx.drawImage(bmp, 0, 0, w, ih);
  bmp.close?.();
  ctx.fillStyle = "#111";
  ctx.fillRect(0, ih, w, bannerH);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  lines.forEach((t, i) => {
    const mono = i >= lines.length - 2;
    ctx.font = mono ? `500 ${font}px ui-monospace, Menlo, monospace` : `${i < rs.length ? 700 : 500} ${font}px system-ui, sans-serif`;
    ctx.fillText(t, pad, ih + pad + i * lineH);
  });
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
}

function stampedName(f) {
  const base = safeName(f.name.replace(/\.[a-z0-9]+$/i, ""));
  return `${(f.receiptIds || []).join("+") || f.id}__${base}-stamped.jpg`;
}

async function saveStamped(r) {
  const f = fileOf(r);
  if (!f?.blob) { toast("Original file not found on this device."); return; }
  if (f.kind !== "image") { toast("Stamped copies are for photos. PDFs are kept as the original document."); return; }
  const blob = await stampedImage(f);
  if (!blob) { toast("This browser can't read that image format."); return; }
  await log("stamped_copy", r.id, `stamped copy of ${f.name} created`);
  await shareOrDownload(new File([blob], stampedName(f), { type: "image/jpeg" }), r.id);
  render();
}

function viewOriginal(r) {
  const f = files.find((x) => x.id === r.fileId);
  if (!f?.blob) { toast("Original file not found on this device."); return; }
  const url = URL.createObjectURL(f.blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function removeFile(id) {
  const f = files.find((x) => x.id === id);
  if (!f || f.status === "done") return;
  files = files.filter((x) => x.id !== id);
  thumbs.delete(id);
  await db.del("files", id);
  await log("file_removed", "", `${f.name} (never extracted)`);
  render();
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function reportReceipts() {
  const from = $("#periodFrom").value;
  const to = $("#periodTo").value;
  return receipts
    .filter((r) => (!from || (r.date && r.date >= from)) && (!to || (r.date && r.date <= to)))
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.id.localeCompare(b.id));
}

function periodLabel() {
  const from = $("#periodFrom").value;
  const to = $("#periodTo").value;
  if (!from && !to) return "All dates";
  return `${from || "start"} to ${to || "today"}`;
}

function buildReport() {
  const list = reportReceipts();
  const active = list.filter((r) => !r.voided);
  const voided = list.filter((r) => r.voided);
  const totals = totalsFor(active);
  const anyTagged = active.some(isTagged);
  const dupes = duplicateIds();
  const L = [];
  L.push(anyTagged ? "RECEIPTS & CHILD EXPENSE REPORT" : "RECEIPT REPORT");
  L.push(`Period: ${periodLabel()}`);
  L.push(`Generated: ${fmtTs(new Date().toISOString())}`);
  L.push(`Receipts: ${active.length}${voided.length ? ` (+${voided.length} voided, excluded)` : ""}`);
  L.push("");
  for (const [c, t] of Object.entries(totals)) {
    L.push(`TOTAL SPENT: ${fmtMoney(t.total, c)}  (incl. tax ${fmtMoney(t.tax, c)})`);
    if (anyTagged) {
      L.push(`  For the children: ${fmtMoney(t.kids, c)}`);
      L.push(`  Not for the children: ${fmtMoney(t.not, c)}`);
      if (t.pending) L.push(`  Not yet tagged: ${fmtMoney(t.review, c)} (${t.pending} item(s))`);
    }
    L.push("");
  }

  const byMonth = {};
  const byStore = {};
  for (const r of active) {
    const c = curOf(r);
    const m = `${(r.date || "no date").slice(0, 7)}|${c}`;
    byMonth[m] = (byMonth[m] || 0) + receiptTotal(r);
    const st = `${r.store_name || "Unknown"}|${c}`;
    byStore[st] = (byStore[st] || 0) + receiptTotal(r);
  }
  const section = (title, obj, sort) => {
    const rows = Object.entries(obj).sort(sort);
    if (rows.length < 2) return;
    L.push(title);
    for (const [k, v] of rows) { const [name, c] = k.split("|"); L.push(`  ${name}: ${fmtMoney(v, c)}`); }
    L.push("");
  };
  section("BY MONTH", byMonth, (a, b) => a[0].localeCompare(b[0]));
  section("BY STORE", byStore, (a, b) => b[1] - a[1]);

  const unverified = active.filter((r) => !r.reviewed).length;
  if (unverified) L.push(`Note: ${unverified} receipt(s) not yet verified against the paper receipt.`, "");
  if (anyTagged) {
    L.push("Tags: [KIDS] counted in full, [SPLIT n%] counted at n%, [NOT] excluded, [ ] not tagged yet.");
    L.push("Tax and receipt-level discounts are shared out in proportion to the item amounts.");
    L.push("");
  }
  L.push("RECEIPTS");
  for (const r of active) {
    const a = allocation(r);
    const c = curOf(r);
    const tagged = isTagged(r);
    L.push("");
    L.push(`${r.id} | ${r.date || "no date"}${r.time ? ` ${r.time}` : ""} | ${r.store_name || "Unknown store"} | ${fmtMoney(a.total, c)}${r.reviewed ? " | verified" : ""}`);
    if (tagged) L.push(`  For the children: ${fmtMoney(a.kids, c)}${a.pending ? ` (${a.pending} item(s) not tagged yet)` : ""}`);
    if (r.payment_method) L.push(`  Paid: ${r.payment_method}`);
    for (const it of r.items) {
      const tag = !tagged ? "-" : it.alloc === "kids" ? "[KIDS]" : it.alloc === "split" ? `[SPLIT ${it.split_pct}%]` : it.alloc === "not" ? "[NOT]" : "[ ]";
      const qty = it.quantity != null && it.quantity !== 1 ? `${fmtQty(it.quantity)} x ` : "";
      L.push(`   ${tag} ${qty}${it.description} = ${fmtNum(it.line_total)}`);
    }
    const extra = [r.tax != null && `tax ${fmtNum(r.tax)}`, r.discount && `discount -${fmtNum(r.discount)}`, r.tip && `tip ${fmtNum(r.tip)}`].filter(Boolean);
    if (extra.length) L.push(`   (${extra.join(", ")})`);
    if (r.note) L.push(`  Note: ${r.note}`);
    if (r.notes) L.push(`  Reading note: ${r.notes}`);
    if (dupes.has(r.id)) L.push(`  ⚠ Same store/date/total as ${dupes.get(r.id).join(", ")}`);
    L.push(`  Original: ${r.source} · SHA-256 ${r.sha256.slice(0, 16)}… · added ${fmtTs(r.addedAt)}`);
  }
  if (voided.length) {
    L.push("", "VOIDED (excluded from totals)");
    for (const r of voided) {
      L.push(`${r.id} | ${r.date || "no date"} | ${r.store_name || "Unknown"} | ${fmtMoney(receiptTotal(r), curOf(r))} — reason: ${r.voidReason}`);
    }
  }
  L.push("", "Original files and full SHA-256 fingerprints are in the evidence pack (manifest.csv).");
  return L.join("\n");
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");

function buildItemsCsv(list = reportReceipts()) {
  const rows = [[
    "Receipt ID", "Date", "Time", "Store", "Item", "Category", "Qty", "Unit Price", "Line Total",
    "Tag", "Split % for kids", "Kids amount (incl. tax share)", "Claude suggestion",
    "Receipt total", "Receipt kids total", "Currency", "Payment", "Verified", "Voided", "Void reason",
    "Note", "Original file", "SHA-256", "Added at",
  ]];
  for (const r of list) {
    const a = allocation(r);
    for (const it of r.items.length ? r.items : [null]) {
      rows.push([
        r.id, r.date, r.time, r.store_name, it?.description, it?.category, it?.quantity, it?.unit_price, it?.line_total,
        it ? ALLOC_LABEL[it.alloc] : "", it?.alloc === "split" ? it.split_pct : "", it ? itemKidsAmount(it, a.factor) : "",
        it?.ai_suggestion, a.total, a.kids, curOf(r), r.payment_method, r.reviewed ? "yes" : "no",
        r.voided ? "yes" : "no", r.voidReason, r.note, r.source, r.sha256, r.addedAt,
      ]);
    }
  }
  return toCsv(rows);
}

function buildLogCsv() {
  return toCsv([["Timestamp (UTC)", "Action", "Receipt ID", "Detail"], ...logEntries.map((e) => [e.ts, e.action, e.receiptId, e.detail])]);
}

function safeName(s) {
  return s.replace(/[^\w.\- ]+/g, "_").slice(0, 80);
}

function originalPath(f) {
  const ext = (f.name.match(/\.[a-z0-9]+$/i) || [""])[0] || (f.kind === "pdf" ? ".pdf" : ".jpg");
  const base = safeName(f.name.replace(/\.[a-z0-9]+$/i, ""));
  return `originals/${(f.receiptIds || []).join("+") || f.id}__${base}${ext}`;
}

/**
 * Builds the evidence pack. With full=true it contains every file, receipt and log entry on the
 * device (a backup that can be restored); otherwise only receipts in the chosen period.
 */
async function buildPack({ full = false } = {}) {
  toast("Building the pack…", 10000);
  const list = full
    ? receipts.slice().sort((a, b) => a.id.localeCompare(b.id))
    : reportReceipts();
  const ids = new Set(list.map((r) => r.fileId));
  const pf = files.filter((f) => f.blob && (full ? f.status === "done" || ids.has(f.id) : ids.has(f.id)));

  const stamped = [];
  for (const f of pf) {
    const blob = await stampedImage(f);
    if (blob) stamped.push({ name: `stamped/${stampedName(f)}`, data: blob });
  }
  const manifest = toCsv([
    ["Path in pack", "Original name", "Receipt IDs", "SHA-256", "Bytes", "Added to app (UTC)", "File last modified"],
    ...pf.map((f) => [originalPath(f), f.name, (f.receiptIds || []).join(" "), f.sha256, f.size, f.addedAt, f.lastModified]),
  ]);
  const label = full ? "Full backup (all dates)" : periodLabel();
  const data = JSON.stringify({
    format: "receipt-mailer-pack",
    version: 2,
    full,
    exportedAt: new Date().toISOString(),
    period: label,
    seq,
    receipts: list,
    files: pf.map(({ blob, ...meta }) => ({ ...meta, packPath: originalPath(meta) })),
    log: logEntries.map(({ seq: _s, ...e }) => e),
  }, null, 2);
  const readme = [
    full ? "Full backup / evidence pack" : `Evidence pack — ${label}`,
    "",
    "report.txt    Report (same text as the email).",
    "items.csv     One row per receipt line: tag and the amount counted for the children.",
    "audit-log.csv Every action taken in the app, timestamped (UTC).",
    "manifest.csv  Original files with SHA-256 fingerprints.",
    "originals/    Unmodified original photos/PDFs, named by receipt ID.",
    "stamped/      Copies of each photo with receipt ID(s) and fingerprint printed underneath,",
    "              for printing. The originals/ files are the evidence; these are for convenience.",
    "data.json     Full machine-readable data (used by Restore in the app).",
    "",
    "To check a file is unchanged, compute its SHA-256 (e.g. `shasum -a 256 file` on Mac,",
    "`certutil -hashfile file SHA256` on Windows) and compare with manifest.csv.",
  ].join("\n");

  // The report covers the period, or everything for a full backup.
  const savedFrom = $("#periodFrom").value;
  const savedTo = $("#periodTo").value;
  if (full) { $("#periodFrom").value = ""; $("#periodTo").value = ""; }
  const report = buildReport();
  $("#periodFrom").value = savedFrom;
  $("#periodTo").value = savedTo;

  const zip = await makeZip([
    { name: "README.txt", data: readme },
    { name: "report.txt", data: report },
    { name: "items.csv", data: buildItemsCsv(list) },
    { name: "audit-log.csv", data: buildLogCsv() },
    { name: "manifest.csv", data: manifest },
    { name: "data.json", data },
    ...pf.map((f) => ({ name: originalPath(f), data: f.blob })),
    ...stamped,
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  await log(full ? "backup_exported" : "exported", "", `${label}, ${list.length} receipts, ${pf.length} files`);
  if (full) store.set("lastBackup", new Date().toISOString());
  toast("Pack ready.");
  return new File([zip], `${full ? "receipts-backup" : "child-expenses"}-${stamp}.zip`, { type: "application/zip" });
}

/** Restores (merges) a pack made by this app. Existing receipts/files are kept; fingerprints are re-checked. */
async function restorePack(zipFile) {
  toast("Reading backup…", 10000);
  const zip = await readZip(zipFile);
  const dataName = zip.names.find((n) => n === "data.json" || n.endsWith("/data.json"));
  if (!dataName) throw new Error("This ZIP isn't a backup from this app (no data.json).");
  const prefix = dataName.slice(0, -"data.json".length);
  const data = JSON.parse(await zip.text(dataName));
  if (!Array.isArray(data.receipts) || !Array.isArray(data.files)) throw new Error("Backup data is unreadable.");

  let addedFiles = 0, addedReceipts = 0, badHash = 0, missing = 0;
  for (const meta of data.files) {
    if (files.some((f) => f.id === meta.id || f.sha256 === meta.sha256)) continue;
    const path = prefix + (meta.packPath || originalPath(meta));
    const blob = await zip.blob(path, meta.type);
    if (!blob) { missing += 1; continue; }
    const hash = await sha256Hex(blob);
    if (hash !== meta.sha256) { badHash += 1; continue; }
    const { packPath, ...rest } = meta;
    const rec = { ...rest, blob, status: "done" };
    files.push(rec);
    await saveFile(rec);
    addedFiles += 1;
  }
  for (const r of data.receipts) {
    if (receipts.some((x) => x.id === r.id)) continue;
    receipts.push(r);
    await saveReceipt(r);
    addedReceipts += 1;
  }
  // Bring over log entries we don't have yet (matched on timestamp + action + receipt + detail).
  const have = new Set(logEntries.map((e) => `${e.ts}|${e.action}|${e.receiptId}|${e.detail}`));
  for (const e of data.log || []) {
    const k = `${e.ts}|${e.action}|${e.receiptId}|${e.detail}`;
    if (have.has(k)) continue;
    logEntries.push(e);
    await db.add("log", { ...e });
  }
  logEntries.sort((a, b) => a.ts.localeCompare(b.ts));
  const maxId = Math.max(seq, data.seq || 0, ...receipts.map((r) => Number((r.id.match(/-(\d+)$/) || [])[1] || 0)));
  if (maxId !== seq) { seq = maxId; await db.put("meta", seq, "seq"); }
  receipts.sort((a, b) => a.id.localeCompare(b.id));

  const problems = [badHash && `${badHash} file(s) failed the fingerprint check and were skipped`, missing && `${missing} file(s) missing from the ZIP`].filter(Boolean);
  await log("restored_backup", "", `${zipFile.name}: +${addedReceipts} receipts, +${addedFiles} files${problems.length ? `; ${problems.join("; ")}` : ""}`);
  render();
  alert(`Restore complete.\n\nAdded ${addedReceipts} receipt(s) and ${addedFiles} original file(s).${problems.length ? `\n\n⚠ ${problems.join("\n⚠ ")}` : "\nAll fingerprints matched."}`);
}

function defaultSubject() {
  const active = reportReceipts().filter((r) => !r.voided);
  const totals = totalsFor(active);
  const pick = active.some(isTagged) ? "kids" : "total";
  const amt = Object.entries(totals).map(([c, t]) => fmtMoney(t[pick], c)).join(" + ") || fmtMoney(0, settings.currency);
  return pick === "kids"
    ? `Child expenses: ${amt} (${periodLabel()})`
    : `Receipts: ${active.length}, ${amt} (${periodLabel()})`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function download(file) {
  const a = h("a", { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function sendEmail() {
  const to = $("#emailTo").value.trim();
  const subject = $("#emailSubject").value.trim() || defaultSubject();
  const body = buildReport();
  if (to) store.set("lastEmail", to);
  let url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (url.length > 30000) {
    const copied = await copyText(body);
    const note = copied
      ? "The full report was copied to your clipboard — paste it here.\n\n"
      : "The report was too long for a mail link — use Share or Copy instead.\n\n";
    url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(note + body.slice(0, 20000))}`;
    toast(copied ? "Long report copied — paste into the email body." : "Report too long for a mail link.", 4500);
  }
  await log("emailed", "", `report opened in mail app${to ? ` to ${to}` : ""}, ${periodLabel()}`);
  window.location.href = url;
}

async function sharePack() {
  const subject = $("#emailSubject").value.trim() || defaultSubject();
  try {
    const pack = await buildPack();
    if (navigator.canShare?.({ files: [pack] })) {
      await navigator.share({ title: subject, text: buildReport(), files: [pack] });
    } else {
      download(pack);
      toast("Sharing files isn't supported here — downloaded instead.");
    }
  } catch (err) {
    if (err?.name !== "AbortError") { console.error(err); toast("Share failed."); }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const STATUS_LABEL = { pending: "Ready", queued: "Queued…", working: "Reading with Claude…", error: "Failed" };

function thumbFor(f) {
  if (f.kind !== "image" || !f.blob) return null;
  if (!thumbs.has(f.id)) thumbs.set(f.id, URL.createObjectURL(f.blob));
  return thumbs.get(f.id);
}

function render() {
  $("#setupNotice").hidden = !!settings.apiKey;

  // Intake queue: only files not yet extracted.
  const open = files.filter((f) => f.status !== "done");
  $("#queue").replaceChildren(...open.map((f) => h("li", {},
    thumbFor(f) ? h("img", { class: "thumb", src: thumbFor(f), alt: "" })
      : h("div", { class: "thumb", "aria-hidden": "true" }, f.kind === "pdf" ? "📄" : "🧾"),
    h("div", {},
      h("div", { class: "qname" }, f.name),
      h("div", { class: `qstatus ${f.status}` }, f.status === "error" ? f.error : STATUS_LABEL[f.status])),
    h("button", {
      class: "btn small ghost", "aria-label": `Remove ${f.name}`,
      disabled: f.status === "working" || f.status === "queued",
      onclick: () => removeFile(f.id),
    }, "✕"))));
  const doneCount = files.length - open.length;
  const last = store.get("lastBackup");
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86_400_000) : null;
  const backupNote = !receipts.length ? ""
    : last == "" ? " ⚠ Never backed up — Settings → Back up everything."
    : days >= 7 ? ` ⚠ Last backup ${days} days ago — Settings → Back up everything.` : ` Last backup: ${fmtTs(last)}.`;
  $("#processedCount").textContent = doneCount ? `${doneCount} file(s) processed, ${receipts.length} receipt(s) on record.${backupNote}` : "";

  const pending = files.filter((f) => f.status === "pending" || f.status === "error").length;
  const pb = $("#processBtn");
  pb.disabled = processing || pending === 0;
  pb.textContent = processing ? "Working…" : pending ? `Extract ${pending} file(s) with Claude` : "Extract with Claude";

  $("#resultsCard").hidden = receipts.length === 0;
  $("#sendCard").hidden = receipts.length === 0;
  if (!receipts.length) return;

  // Totals (all non-voided receipts)
  const active = receipts.filter((r) => !r.voided);
  const totals = totalsFor(active);
  const stats = [];
  const anyTagged = active.some(isTagged);
  for (const [c, t] of Object.entries(totals)) {
    stats.push([`Spent ${c}`, fmtMoney(t.total, c), anyTagged ? "" : "accent"]);
    if (anyTagged) {
      stats.push([`Kids ${c}`, fmtMoney(t.kids, c), "accent"]);
      stats.push([`Not kids ${c}`, fmtMoney(t.not, c)]);
      if (t.pending) stats.push([`Untagged ${c}`, fmtMoney(t.review, c)]);
    }
  }
  stats.push(["Receipts", active.length]);

  const suggestable = receipts.reduce((n, r) => n + suggestableCount(r), 0);
  const ab = $("#applyAllBtn");
  ab.hidden = !suggestable;
  ab.textContent = `✨ Tag ${suggestable} item(s) using Claude's suggestions`;
  $("#totals").replaceChildren(...stats.map(([label, value, cls]) =>
    h("div", { class: `stat ${cls || ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value))));

  // Filters
  const dupes = duplicateIds();
  const counts = {
    all: active.length,
    untagged: active.filter((r) => allocation(r).pending > 0).length,
    unverified: active.filter((r) => !r.reviewed).length,
    dupe: dupes.size,
    void: receipts.length - active.length,
  };
  document.querySelectorAll(".chip-filter").forEach((b) => {
    const key = b.dataset.filter;
    b.setAttribute("aria-selected", String(key === filter));
    b.replaceChildren(b.dataset.label ??= b.textContent, h("span", { class: "count" }, counts[key]));
  });

  const q = query.toLowerCase();
  const visible = receipts
    .filter((r) => {
      if (filter === "void") return r.voided;
      if (r.voided) return false;
      if (filter === "untagged") return allocation(r).pending > 0;
      if (filter === "unverified") return !r.reviewed;
      if (filter === "dupe") return dupes.has(r.id);
      return true;
    })
    .filter((r) => !q || [r.id, r.store_name, r.date, r.note, ...r.items.map((i) => i.description)]
      .some((s) => s && String(s).toLowerCase().includes(q)))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id));
  $("#receipts").replaceChildren(...(visible.length ? visible.map((r) => renderReceipt(r, dupes)) : [h("p", { class: "hint" }, "Nothing here.")]));

  $("#history").replaceChildren(...logEntries.slice(-200).reverse().map((e) =>
    h("div", { class: "log-entry" }, h("time", {}, fmtTs(e.ts)), e.receiptId ? h("b", {}, `${e.receiptId} `) : null, `${e.action.replace(/_/g, " ")}: ${e.detail}`)));

  if (!$("#emailSubject").dataset.edited) $("#emailSubject").value = defaultSubject();
  $("#emailPreview").textContent = buildReport();
}

function renderReceipt(r, dupes) {
  const c = curOf(r);
  const a = allocation(r);
  const itemsSum = r.items.reduce((s, it) => s + (it.line_total || 0), 0);
  const expected = itemsSum + (r.tax || 0) + (r.tip || 0) - (r.discount || 0);
  const mismatch = r.total != null && Math.abs(expected - r.total) > 0.05 && Math.abs(itemsSum - r.total) > 0.05;

  const badges = [];
  if (r.voided) badges.push(h("span", { class: "badge bad" }, `VOID — ${r.voidReason}`));
  else if (r.reviewed) badges.push(h("span", { class: "badge ok" }, "Verified ✓"));
  else badges.push(h("span", { class: "badge warn" }, "Not verified"));
  const tagged = isTagged(r);
  if (tagged && a.pending) badges.push(h("span", { class: "badge warn" }, `${a.pending} untagged`));
  if (dupes.has(r.id)) badges.push(h("span", { class: "badge bad" }, `Possible duplicate of ${dupes.get(r.id).join(", ")}`));
  if (mismatch) badges.push(h("span", { class: "badge warn" }, `Items+tax = ${fmtNum(expected)} ≠ printed ${fmtNum(r.total)}`));

  const rows = r.items.map((it, idx) => h("tr", { class: it.alloc === "not" ? "not-kids" : "" },
    h("td", { class: "tagcell" },
      h("button", {
        class: `tag ${it.alloc}`, disabled: r.voided,
        title: `Claude suggested: ${it.ai_suggestion}`,
        onclick: () => setAlloc(r, idx, NEXT_ALLOC[it.alloc]),
      }, it.alloc === "review" ? "Tag" : ALLOC_LABEL[it.alloc]),
      it.alloc === "split" && h("div", {},
        h("input", {
          class: "pct", type: "number", min: 0, max: 100, step: 1, value: it.split_pct, "aria-label": "Percent for kids",
          onchange: (e) => setSplit(r, idx, e.target.value),
        }), "%")),
    h("td", { class: "desc" }, it.description,
      it.quantity != null && it.quantity !== 1 ? h("div", { class: "meta" }, `${fmtQty(it.quantity)} × ${fmtNum(it.unit_price)}`) : null,
      it.alloc === "review" && (it.ai_suggestion === "yes" || it.ai_suggestion === "no")
        ? h("div", { class: "suggest" }, `Claude: likely ${it.ai_suggestion === "yes" ? "for kids" : "not for kids"}`) : null),
    h("td", { class: "num" },
      h("button", { class: "amount-btn", disabled: r.voided, title: "Correct amount", onclick: () => editAmount(r, idx) }, fmtNum(it.line_total))),
  ));

  const foot = [
    r.subtotal != null && ["Subtotal", r.subtotal],
    r.discount && ["Discount", -r.discount],
    r.tax != null && ["Tax", r.tax],
    r.tip && ["Tip", r.tip],
  ].filter(Boolean);

  return h("article", { class: `receipt ${r.voided ? "voided" : ""}` },
    h("header", {},
      h("div", {},
        h("span", { class: "rid" }, r.id),
        h("h3", {}, r.store_name || "Unknown store"),
        h("div", { class: "meta" }, [r.date || "No date", r.time, r.payment_method].filter(Boolean).join(" · ")),
        h("div", { class: "meta" }, `${r.source} · added ${fmtTs(r.addedAt)} · #${r.sha256.slice(0, 8)}`))),
    h("div", { class: "badges" }, badges),
    tagged
      ? h("div", { class: "kids-line" }, "For kids: ", h("b", {}, fmtMoney(a.kids, c)), ` of ${fmtMoney(a.total, c)}`)
      : h("div", { class: "kids-line" }, "Total: ", h("b", {}, fmtMoney(a.total, c)), h("span", { class: "meta" }, " · not separated yet")),
    r.note && h("div", { class: "meta" }, `📝 ${r.note}`),
    r.notes && h("div", { class: "meta" }, `Reading note: ${r.notes}`),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("tbody", {}, rows),
        h("tfoot", {},
          foot.map(([label, v]) => h("tr", {}, h("td", {}), h("td", {}, label), h("td", { class: "num" }, fmtNum(v)))),
          h("tr", { class: "grand" }, h("td", {}), h("td", {}, r.total == null ? "Total (calculated)" : "Total"),
            h("td", { class: "num" }, fmtMoney(a.total, c)))))),
    h("div", { class: "actions" },
      h("button", { class: "btn small", onclick: () => viewOriginal(r) }, "View original"),
      fileOf(r)?.kind === "image" && h("button", { class: "btn small", onclick: () => saveStamped(r) }, "Stamped copy"),
      !r.voided && h("button", { class: "btn small", onclick: () => editNote(r) }, "Note"),
      !r.voided && h("button", {
        class: `btn small ${r.reviewed ? "" : "primary"}`, title: "You checked the amounts against the paper receipt",
        onclick: () => toggleReviewed(r),
      }, r.reviewed ? "Unverify" : "Mark verified")),
    h("details", { class: "more" },
      h("summary", {}, "More…"),
      h("div", { class: "actions" },
        h("button", { class: "btn small", onclick: () => saveOriginal(r) }, "Save original to Photos/Files"),
        !r.voided && suggestableCount(r) > 0 && h("button", { class: "btn small", onclick: () => applySuggestions(r) }, "✨ Apply Claude's tags"),
        !r.voided && h("button", { class: "btn small", onclick: () => setAll(r, "kids") }, "All kids"),
        !r.voided && h("button", { class: "btn small", onclick: () => setAll(r, "not") }, "None kids"),
        !r.voided && tagged && h("button", { class: "btn small", onclick: () => setAll(r, "review") }, "Clear tags"),
        !r.voided && h("button", { class: "btn small", onclick: () => editReceipt(r) }, "Fix details"),
        h("button", { class: "btn small ghost danger", onclick: () => toggleVoid(r) }, r.voided ? "Restore" : "Void"))),
  );
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
function openSettings() {
  $("#apiKey").value = settings.apiKey;
  $("#model").value = settings.model;
  $("#defaultEmail").value = settings.defaultEmail;
  $("#defaultCurrency").value = store.get("defaultCurrency");
  $("#kidsContext").value = settings.kidsContext;
  $("#splitDefault").value = store.get("splitDefault");
  $("#autoTag").checked = settings.autoTag;
  $("#settingsDialog").showModal();
}

$("#settingsDialog").addEventListener("close", () => {
  if ($("#settingsDialog").returnValue !== "save") return;
  store.set("apiKey", $("#apiKey").value.trim());
  store.set("model", $("#model").value);
  store.set("defaultEmail", $("#defaultEmail").value.trim());
  store.set("defaultCurrency", $("#defaultCurrency").value.trim().toUpperCase());
  store.set("kidsContext", $("#kidsContext").value.trim());
  store.set("splitDefault", $("#splitDefault").value.trim());
  store.set("autoTag", $("#autoTag").checked ? "1" : "");
  if (!$("#emailTo").value) $("#emailTo").value = settings.defaultEmail;
  toast("Settings saved.");
  render();
});

$("#wipeBtn").addEventListener("click", async () => {
  if (!confirm("Erase ALL receipts, original files and history from this device? Export an evidence pack first if you need it.")) return;
  if (prompt('Type ERASE to confirm.') !== "ERASE") return;
  await Promise.all(["files", "receipts", "log", "meta"].map((s) => db.clear(s)));
  files = []; receipts = []; logEntries = []; seq = 0;
  thumbs.forEach((u) => URL.revokeObjectURL(u));
  thumbs.clear();
  $("#settingsDialog").close("cancel");
  toast("All data erased.");
  render();
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$("#settingsBtn").addEventListener("click", openSettings);
document.querySelectorAll("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));

for (const id of ["#cameraInput", "#galleryInput", "#pdfInput"]) {
  $(id).addEventListener("change", async (e) => {
    const list = [...e.target.files];
    e.target.value = "";
    await addFiles(list);
  });
}

const dz = $("#dropZone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

$("#processBtn").addEventListener("click", processAll);
$("#applyAllBtn").addEventListener("click", applyAllSuggestions);
$("#backupBtn").addEventListener("click", async () => {
  try { await shareOrDownload(await buildPack({ full: true }), "Receipts backup"); render(); }
  catch (err) { console.error(err); toast("Couldn't build the backup."); }
});
$("#restoreInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  $("#settingsDialog").close("cancel");
  try { await restorePack(f); } catch (err) { console.error(err); alert(`Restore failed: ${err.message}`); }
});
document.querySelectorAll(".chip-filter").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; render(); }));
$("#search").addEventListener("input", (e) => { query = e.target.value.trim(); render(); });
$("#periodFrom").addEventListener("change", render);
$("#periodTo").addEventListener("change", render);

$("#emailSubject").addEventListener("input", (e) => { e.target.dataset.edited = "1"; });
$("#emailBtn").addEventListener("click", sendEmail);
$("#shareBtn").addEventListener("click", sharePack);
$("#zipBtn").addEventListener("click", async () => {
  try { download(await buildPack()); render(); } catch (err) { console.error(err); toast("Couldn't build the pack."); }
});
$("#csvBtn").addEventListener("click", () => {
  download(new File([buildItemsCsv()], `child-expenses-${new Date().toISOString().slice(0, 10)}.csv`, { type: "text/csv" }));
});
$("#copyBtn").addEventListener("click", async () => {
  toast((await copyText(buildReport())) ? "Report copied." : "Copy failed.");
});

$("#emailTo").value = store.get("lastEmail") || settings.defaultEmail;

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    await addFiles(await Promise.all(params.files.map((f) => f.getFile())));
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
}

// Ask the browser not to evict our stored evidence when space runs low.
navigator.storage?.persist?.().catch(() => {});

try {
  await loadState();
} catch (err) {
  console.error(err);
  toast("Couldn't open local storage — private browsing? Data won't be saved.", 6000);
}
render();
