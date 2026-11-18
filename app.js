import Anthropic from "./vendor/anthropic-sdk.js";
import { db } from "./db.js";
import { makeZip, readZip } from "./zip.js";
import { makeXlsx, readXlsx, readCsv, sheetsToText } from "./xlsx.js";
import { t, lang, locale, regionCurrency, actionLabel, applyStatic } from "./i18n.js";

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
  get currency() { return (store.get("defaultCurrency") || regionCurrency()).toUpperCase(); },
  get autoTag() { return store.get("autoTag") === "1"; },
  /** Expense types from Settings, one per line: "Name : examples". */
  get expTypes() {
    const raw = store.get("expTypes").trim() || t("types.default");
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const at = l.indexOf(":");
      return at < 0 ? { name: l, examples: "" } : { name: l.slice(0, at).trim(), examples: l.slice(at + 1).trim() };
    }).filter((x) => x.name);
  },
  get intakePayer() { return store.get("intakePayer") === "other" ? "other" : "me"; },
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

/** Built per request because the expense-type list comes from Settings. */
const receiptSchema = () => JSON.parse(JSON.stringify(RECEIPT_SCHEMA), (k, v) =>
  (k === "expense_type" ? { type: "string", enum: [...settings.expTypes.map((x) => x.name), "unknown"] } : v));

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
          "subtotal", "discount", "tax", "tip", "total", "notes", "document_type", "source_ref",
        ],
        properties: {
          store_name: { type: "string" },
          source_ref: { ...nullable("string"), description: "Spreadsheets only: sheet and row(s), e.g. 'Feuil1 L12'. null for photos/PDFs" },
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
              required: ["description", "quantity", "unit_price", "line_total", "category", "likely_for_children", "expense_type"],
              properties: {
                description: { type: "string" },
                quantity: nullable("number"),
                unit_price: nullable("number"),
                line_total: { type: "number" },
                category: { ...nullable("string"), description: "e.g. Groceries, Clothing, School, Medical, Fuel, Dining" },
                likely_for_children: { type: "string", enum: ["yes", "no", "unsure"] },
                expense_type: "placeholder",
              },
            },
          },
          subtotal: nullable("number"),
          discount: { ...nullable("number"), description: "Total discounts as a positive number" },
          tax: nullable("number"),
          tip: nullable("number"),
          total: nullable("number"),
          notes: { ...nullable("string"), description: "null unless something affects the amounts, date or legibility; then one short sentence (max ~20 words)" },
          document_type: {
            type: "string",
            enum: ["receipt", "invoice", "other"],
            description: "receipt = proof of a completed payment; invoice = bill/quote/statement that does not show the payment was made",
          },
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
- Discounts printed as their own lines (e.g. "LIQUIDATION -132,00") go in items as negative line totals, directly below the item they apply to. Use the discount field only for a discount that is NOT listed as an item line; otherwise discount is null.
- date is the transaction or invoice date printed on the document, never today's date. Use null if none is printed.
- notes: null in the normal case. Only write a note when something could change how the amounts, date or store should be read (ambiguous date, illegible amount, total that doesn't add up, a second receipt cut off in the photo). Then ONE short sentence, max ~20 words. Never restate amounts, taxes, addresses, tracking numbers or other details already captured or not needed, and don't guess who an item is for (that's what likely_for_children is for).
- document_type: "receipt" if it shows a completed payment (e.g. paid, card approved, change given); "invoice" for a bill, amount due, quote or statement without proof of payment; otherwise "other".
- likely_for_children is only a suggestion the user will confirm: "yes" for things clearly for a child (kids' clothing or shoe sizes, diapers, baby food, toys, school supplies, children's medicine, kids' activities or meals); "no" for things clearly for an adult (alcohol, tobacco, adult clothing, adult toiletries, car parts); "unsure" for shared household items such as general groceries, cleaning products, or fuel.
- expense_type is also only a suggestion: for items that are (or may be) for the children, pick the type from the user's list whose examples fit best; use "unknown" when unsure or when the item is not for the children.
- Spreadsheets: each row that records an expense becomes one entry in receipts (one item unless the row clearly lists several), with source_ref set to the sheet and row (e.g. "Feuil1 L12"). Skip headers, totals, subtotals and empty rows. Use the row's own date, description and amount; store_name is the merchant if a column gives it, otherwise a short description. document_type is "other". Amounts in the sheet may use a comma as decimal separator.
- If the file contains no receipt at all, return an empty receipts array.`;

const STATEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["institution", "account_last4", "period_start", "period_end", "currency", "transactions"],
  properties: {
    institution: { ...nullable("string"), description: "Bank or card issuer, e.g. Desjardins Visa" },
    account_last4: { ...nullable("string"), description: "ONLY the last 4 digits of the card/account, never more" },
    period_start: { ...nullable("string"), description: "YYYY-MM-DD" },
    period_end: { ...nullable("string"), description: "YYYY-MM-DD" },
    currency: { type: "string", description: "ISO 4217 code" },
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "description", "amount", "ref"],
        properties: {
          date: { ...nullable("string"), description: "Transaction date YYYY-MM-DD" },
          description: { type: "string", description: "Merchant / description as printed" },
          amount: { type: "number", description: "Positive = money out (purchase, withdrawal, transfer sent). Negative = money in (refund, credit, payment received)" },
          ref: { ...nullable("string"), description: "Where it is: page and line (e.g. 'p.2 #14') or spreadsheet row (e.g. 'L12')" },
        },
      },
    },
  },
};

const STATEMENT_PROMPT = `You read bank and credit-card statements: PDF statements, photos, screenshots of a banking app, or spreadsheet/CSV exports.

Rules:
- List every transaction line, in order. Skip opening/closing balances, totals, interest or fee summaries that are not transactions, and headers.
- Dates must be YYYY-MM-DD. If only day and month are shown, take the year from the statement period (watch for periods spanning December–January).
- amount: positive for money going out (purchases, withdrawals, transfers sent, pre-authorised debits); negative for money coming in (refunds, credits, deposits, card payments received).
- Never output full card or account numbers: account_last4 holds at most the last 4 digits.
- ref tells where the line is: page and line number for PDFs/photos (e.g. "p.2 #14"), row for spreadsheets (e.g. "L12").
- Keep descriptions as printed. Don't invent transactions; if a line is unreadable, skip it.
- If the file is not a statement, return an empty transactions array.`;

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

function fmtMoney(value, currency) {
  if (value == null || Number.isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}
const numFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => (n == null ? "" : numFmt.format(Number(n)));
/** Parses a typed amount: accepts "12.50", "12,50", "1 234,50". */
const parseAmount = (v) => Number(String(v).replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
const fmtQty = (q) => (q == null ? "" : Number.isInteger(q) ? String(q) : String(+q.toFixed(3)));
const fmtTs = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) : "");
const curOf = (r) => r.currency || settings.currency;

// ---------------------------------------------------------------------------
// File intake
// ---------------------------------------------------------------------------
function isSheet(file) {
  return /\.(xlsx|csv)$/i.test(file.name)
    || ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(file.type);
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function addFiles(fileList, { role = "receipt" } = {}) {
  for (const file of [...fileList]) {
    const kind = isPdf(file) ? "pdf" : isSheet(file) ? "sheet"
      : file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name) ? "image" : null;
    if (/\.(xls|numbers|ods)$/i.test(file.name)) { toast(t("t.oldSheet", { name: file.name }), 6000); continue; }
    if (!kind) { toast(t("t.unsupported", { name: file.name })); continue; }
    if (kind === "pdf" && file.size > MAX_PDF_BYTES) { toast(t("t.pdfTooBig", { name: file.name }), 4000); continue; }

    const sha256 = await sha256Hex(file);
    const existing = files.find((f) => f.sha256 === sha256);
    if (existing) {
      const ids = existing.receiptIds?.length ? ` (${existing.receiptIds.join(", ")})` : "";
      toast(t("t.already", { name: existing.name, ids }), 4000);
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
      payer: settings.intakePayer,
      role,
    };
    files.push(rec);
    await saveFile(rec);
    await log("file_added", "", t("lg.fileAdded", { name: rec.name, size: rec.size, sha: sha256 }));
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
    throw new Error(t("e.imageFormat"));
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

/** The file as a content block Claude can read (image, PDF, or spreadsheet as text). */
async function fileSource(file) {
  if (file.kind === "sheet") {
    const sheets = /\.csv$/i.test(file.name) || file.type === "text/csv"
      ? readCsv(await file.blob.text())
      : await readXlsx(file.blob);
    return { type: "text", text: `<spreadsheet name="${file.name}">\n${sheetsToText(sheets)}\n</spreadsheet>` };
  }
  if (file.kind === "pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: await readAsBase64(file.blob) },
    };
  }
  const img = await prepareImage(file.blob, file.type);
  return { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
}

/** One structured-output request; returns the parsed JSON. */
async function askClaude(client, { system, schema, content }) {
  const model = settings.model;
  const params = {
    model,
    max_tokens: 32000,
    system,
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  };
  if (FALLBACK_MODELS.has(model)) {
    // If a safety classifier declines, the API retries on a recommended model in the same call.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const message = await client.beta.messages.stream(params).finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(`${t("e.refused")}${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
  }
  if (message.stop_reason === "max_tokens") throw new Error(t("e.cutoff"));
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t("e.unreadable"));
  }
}

async function extract(client, file) {
  const source = await fileSource(file);
  const kids = settings.kidsContext ? `\nAbout the children: ${settings.kidsContext}` : "";
  const types = `\nExpense types for children's items (expense_type):\n${settings.expTypes.map((x) => `- ${x.name}${x.examples ? `: ${x.examples}` : ""}`).join("\n")}`;
  const what = file.kind === "sheet"
    ? `This spreadsheet lists expenses${file.payer === "other" ? " paid by the children's other parent" : ""}. Turn each expense row into an entry`
    : `Extract every receipt in this ${file.kind === "pdf" ? "PDF" : "image"}`;
  const out = await askClaude(client, {
    system: SYSTEM_PROMPT,
    schema: receiptSchema(),
    content: [source, {
      type: "text",
      text: `${what} (file name: "${file.name}"). If no currency is shown, assume ${settings.currency}.${kids}${types}${t("claude.lang") ? `\n${t("claude.lang")}` : ""}`,
    }],
  });
  return out.receipts || [];
}

async function extractStatement(client, file) {
  const source = await fileSource(file);
  const out = await askClaude(client, {
    system: STATEMENT_PROMPT,
    schema: STATEMENT_SCHEMA,
    content: [source, { type: "text", text: `Read the transactions in this statement (file name: "${file.name}"). If no currency is shown, assume ${settings.currency}.` }],
  });
  return {
    ...out,
    account_last4: out.account_last4 ? String(out.account_last4).replace(/\D/g, "").slice(-4) || null : null,
    transactions: (out.transactions || []).map((x, i) => ({ ...x, id: `T${i + 1}`, use: null })),
  };
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

const SUGGESTION_TO_ALLOC = { yes: "kids", no: "not", unsure: "review" };
const validType = (name) => (name && settings.expTypes.some((x) => x.name === name) ? name : null);
const isKidsLine = (it) => it.alloc === "kids" || it.alloc === "split";
const payerLabel = (r) => t(r.payer === "other" ? "payer.other" : "payer.me");

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
      payer: file.payer || "me",
      declared: file.kind === "sheet",
      items: (x.items || []).map((it) => {
        const alloc = settings.autoTag ? SUGGESTION_TO_ALLOC[it.likely_for_children] || "review" : "review";
        return {
          ...it,
          ai_suggestion: it.likely_for_children,
          ai_type: validType(it.expense_type),
          exp_type: settings.autoTag && (alloc === "kids" || alloc === "split") ? validType(it.expense_type) : null,
          alloc,
          split_pct: settings.splitDefault,
        };
      }),
      reviewed: false,
      note: "",
      voided: false,
      voidReason: "",
    };
    receipts.push(r);
    ids.push(r.id);
    await saveReceipt(r);
    await log("receipt_extracted", r.id,
      t("lg.extracted", { store: r.store_name || t("r.unknown"), date: r.date || t("r.noDate"), total: r.total ?? "?", cur: curOf(r), n: r.items.length, file: file.name }));
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
        if (file.role === "statement") {
          file.statement = await extractStatement(client, file);
          file.status = "done";
          await log("statement_read", "", t("lg.stRead", { name: file.name, n: file.statement.transactions.length }));
          if (!file.statement.transactions.length) toast(t("t.noTx", { name: file.name }), 4000);
        } else {
          const extracted = await extract(client, file);
          file.receiptIds = await createReceipts(file, extracted);
          file.status = "done";
          if (!extracted.length) toast(t("t.noReceipt", { name: file.name }), 4000);
        }
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
// Child-expense math
// ---------------------------------------------------------------------------
/**
 * Lines as they count: a discount line (negative amount, e.g. "LIQUIDATION -132,00") follows the tag
 * of the item just above it, so a rebate on a kids' item reduces the kids' share, not the adult's.
 */
function effectiveItems(r) {
  let prev = null;
  return (r.items || []).map((it) => {
    if ((it.line_total || 0) < 0 && prev) return { ...it, alloc: prev.alloc, split_pct: prev.split_pct, linked: true };
    if ((it.line_total || 0) >= 0) prev = it;
    return it;
  });
}

/**
 * Receipt-level discount that is NOT already listed as negative item lines.
 * (Claude sometimes reports both the rebate lines and their sum in `discount`.)
 */
function extraDiscount(r) {
  if (!r.discount) return 0;
  const listed = -(r.items || []).filter((it) => (it.line_total || 0) < 0).reduce((s, it) => s + it.line_total, 0);
  return Math.abs(listed - Math.abs(r.discount)) < 0.05 ? 0 : Math.abs(r.discount);
}

function receiptTotal(r) {
  if (r.total != null) return r.total;
  const itemsSum = (r.items || []).reduce((s, it) => s + (it.line_total || 0), 0);
  return itemsSum + (r.tax || 0) + (r.tip || 0) - extraDiscount(r);
}

/**
 * Splits a receipt's total into kids / not-kids / unreviewed.
 * Tax, tip and receipt-level discounts are shared out in proportion to the item amounts.
 */
function allocation(r) {
  const total = receiptTotal(r);
  const items = effectiveItems(r);
  let sum = 0, kids = 0, not = 0, review = 0;
  for (const it of items) {
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
    items,
    kids: round2(kids * factor),
    not: round2(not * factor),
    review: round2(review * factor),
    pending: items.filter((i) => i.alloc === "review" && !i.linked).length,
  };
}

function itemKidsAmount(it, factor) {
  const v = (it.line_total || 0) * factor;
  if (it.alloc === "kids") return round2(v);
  if (it.alloc === "split") return round2(v * (it.split_pct ?? 50) / 100);
  return 0;
}

const dupKey = (r) => `${(r.store_name || "").toLowerCase().trim()}|${r.date || ""}|${receiptTotal(r).toFixed(2)}`;

/** Active receipts (not made from a statement) with the same total within ±3 days. */
function sameAmountNearby(amount, date, exceptId) {
  const day = (d) => (d ? Date.parse(d) / 86400000 : NaN);
  return receipts.filter((r) => !r.voided && !r.fromStatement && r.id !== exceptId
    && Math.abs(receiptTotal(r) - amount) < 0.011 && Math.abs(day(r.date) - day(date)) <= 3);
}

function duplicateIds() {
  const groups = new Map();
  for (const r of receipts) {
    if (r.voided || !r.fromStatement) continue;
    for (const x of sameAmountNearby(receiptTotal(r), r.date, r.id)) {
      groups.set(`st|${r.id}`, [...new Set([...(groups.get(`st|${r.id}`) || [r.id]), x.id])]);
    }
  }
  for (const r of receipts) {
    if (r.voided) continue;
    const k = dupKey(r);
    groups.set(k, [...(groups.get(k) || []), r.id]);
  }
  const out = new Map();
  for (const ids of groups.values()) {
    if (ids.length > 1) ids.forEach((id) => out.set(id, [...new Set([...(out.get(id) || []), ...ids.filter((x) => x !== id)])]));
  }
  return out;
}

function totalsFor(list) {
  const byCur = {};
  for (const r of list) {
    const c = curOf(r);
    const a = allocation(r);
    byCur[c] ??= { kids: 0, not: 0, review: 0, total: 0, tax: 0, pending: 0, count: 0 };
    const tot = byCur[c];
    tot.kids += a.kids; tot.not += a.not; tot.review += a.review; tot.total += a.total;
    tot.tax += r.tax || 0; tot.pending += a.pending; tot.count += 1;
  }
  return byCur;
}

const isTagged = (r) => effectiveItems(r).some((i) => !i.linked && i.alloc !== "review");

// ---------------------------------------------------------------------------
// Edits (all logged)
// ---------------------------------------------------------------------------
const ALLOC_LABEL = { kids: t("alloc.kids"), split: t("alloc.split"), not: t("alloc.not"), review: t("alloc.review") };
const NEXT_ALLOC = { review: "kids", kids: "split", split: "not", not: "kids" };
const getReceipt = (id) => receipts.find((r) => r.id === id);

async function setAlloc(r, idx, alloc) {
  const it = r.items[idx];
  if (it.alloc === alloc) return;
  const from = it.alloc;
  it.alloc = alloc;
  // First time a line becomes a kids' line, take Claude's suggested type (logged with the change).
  const autoType = isKidsLine(it) && !it.exp_type && validType(it.ai_type);
  if (autoType) it.exp_type = autoType;
  await saveReceipt(r);
  await log("tag_changed", r.id, t("lg.tag", { desc: it.description, from: ALLOC_LABEL[from], to: `${ALLOC_LABEL[alloc]}${alloc === "split" ? ` (${it.split_pct}%)` : ""}` })
    + (autoType ? ` · ${t("lg.typeAuto", { type: autoType })}` : ""));
  render();
}

async function setType(r, idx, value) {
  const it = r.items[idx];
  const to = value || null;
  if ((it.exp_type || null) === to) return;
  const from = it.exp_type;
  it.exp_type = to;
  await saveReceipt(r);
  await log("type_changed", r.id, t("lg.type", { desc: it.description, from: from || "—", to: to || "—" }));
  render();
}

async function togglePayer(r) {
  const from = payerLabel(r);
  r.payer = r.payer === "other" ? "me" : "other";
  await saveReceipt(r);
  await log("payer_changed", r.id, `${from} → ${payerLabel(r)}`);
  render();
}

async function setSplit(r, idx, pct) {
  const it = r.items[idx];
  const n = Math.max(0, Math.min(100, Number(pct)));
  if (!Number.isFinite(n) || n === it.split_pct) return;
  const from = it.split_pct;
  it.split_pct = n;
  await saveReceipt(r);
  await log("split_changed", r.id, t("lg.split", { desc: it.description, from, to: n }));
  render();
}

async function setAll(r, alloc) {
  const changed = r.items.filter((it) => it.alloc !== alloc);
  if (!changed.length) return;
  changed.forEach((it) => { it.alloc = alloc; });
  await saveReceipt(r);
  await log("tag_changed", r.id, t("lg.tagMany", { n: changed.length, to: ALLOC_LABEL[alloc] }));
  if (alloc === "review") toast(t("t.tagsCleared"));
  render();
}

async function editAmount(r, idx) {
  const it = r.items[idx];
  const v = prompt(t("p.amount", { desc: it.description }), it.line_total == null ? "" : String(it.line_total));
  if (v == null) return;
  const n = parseAmount(v);
  if (!Number.isFinite(n)) { toast(t("t.nan")); return; }
  if (n === it.line_total) return;
  const from = it.line_total;
  it.line_total = n;
  await saveReceipt(r);
  await log("amount_corrected", r.id, t("lg.amount", { desc: it.description, from: fmtNum(from), to: fmtNum(n) }));
  render();
}

async function editReceipt(r) {
  const fields = [
    ["store_name", t("f.store")],
    ["date", t("f.date")],
    ["total", t("f.total")],
  ];
  for (const [key, label] of fields) {
    const cur = r[key] == null ? "" : String(r[key]);
    const v = prompt(`${label}:`, cur);
    if (v == null) return;
    if (v.trim() === cur) continue;
    let val = v.trim() || null;
    if (key === "total" && val != null) {
      val = parseAmount(val);
      if (!Number.isFinite(val)) { toast(t("t.totalNum")); return; }
    }
    if (key === "date" && val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) { toast(t("t.dateFmt")); return; }
    r[key] = val;
    await log("field_corrected", r.id, t("lg.field", { label, from: cur, to: val ?? "" }));
  }
  await saveReceipt(r);
  render();
}

async function editNote(r) {
  const v = prompt(t("p.note"), r.note || "");
  if (v == null || v === r.note) return;
  r.note = v.trim();
  await saveReceipt(r);
  await log("note_set", r.id, r.note || t("lg.cleared"));
  render();
}

async function toggleVoid(r) {
  if (!r.voided) {
    const reason = prompt(t("p.void"));
    if (!reason) return;
    r.voided = true;
    r.voidReason = reason.trim();
    await log("voided", r.id, r.voidReason);
  } else {
    r.voided = false;
    await log("restored", r.id, t("lg.restored", { r: r.voidReason }));
    r.voidReason = "";
  }
  await saveReceipt(r);
  render();
}

/** "Verified" = you checked the amounts against the paper receipt. Independent of tagging. */
async function toggleReviewed(r) {
  r.reviewed = !r.reviewed;
  await saveReceipt(r);
  await log(r.reviewed ? "marked_verified" : "unmarked_verified", r.id, t("lg.verified", { t: fmtNum(receiptTotal(r)), c: curOf(r) }));
  render();
}

/** Applies Claude's yes/no suggestions to untagged items only. Returns how many changed. */
function applySuggestionsTo(r) {
  let n = 0;
  for (const it of r.items) {
    if ((it.line_total || 0) < 0) continue; // discount lines follow the item above them
    let changed = false;
    const to = SUGGESTION_TO_ALLOC[it.ai_suggestion];
    if (it.alloc === "review" && to && to !== "review") { it.alloc = to; changed = true; }
    if (isKidsLine(it) && !it.exp_type && validType(it.ai_type)) { it.exp_type = it.ai_type; changed = true; }
    if (changed) n += 1;
  }
  return n;
}

const suggestableCount = (r) => r.voided ? 0
  : r.items.filter((it) => (it.line_total || 0) >= 0 && (
    (it.alloc === "review" && (it.ai_suggestion === "yes" || it.ai_suggestion === "no"))
    || (isKidsLine(it) && !it.exp_type && validType(it.ai_type)))).length;

async function applySuggestions(r) {
  const n = applySuggestionsTo(r);
  if (!n) { toast(t("t.noSuggest")); return; }
  await saveReceipt(r);
  await log("suggestions_applied", r.id, t("lg.suggest", { n }));
  render();
}

async function applyAllSuggestions() {
  const targets = receipts.filter((r) => suggestableCount(r));
  const total = targets.reduce((s, r) => s + suggestableCount(r), 0);
  if (!total || !confirm(t("c.applyAll", { n: total, r: targets.length }))) return;
  for (const r of targets) {
    const n = applySuggestionsTo(r);
    await saveReceipt(r);
    await log("suggestions_applied", r.id, t("lg.suggestBulk", { n }));
  }
  toast(t("t.tagged", { n: total }));
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
  if (!f?.blob) { toast(t("t.noOriginal")); return; }
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
  if (f.kind !== "image" || !f.blob || f.role === "statement") return null;
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
    ...rs.map((r) => `${r.id} · ${r.store_name || t("unknownStore")} · ${r.date || t("r.noDate")} · ${t("stamp.total", { t: fmtMoney(receiptTotal(r), curOf(r)) })}${r.voided ? t("stamp.voided") : ""}`),
    t("stamp.original", { name: f.name, ts: fmtTs(f.addedAt) }),
    t("stamp.sha"),
    f.sha256.slice(0, 32),
    f.sha256.slice(32),
  ];
  const lines = raw.flatMap((txt) => wrapText(measure, txt, w - pad * 2));
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
  lines.forEach((txt, i) => {
    const mono = i >= lines.length - 2;
    ctx.font = mono ? `500 ${font}px ui-monospace, Menlo, monospace` : `${i < rs.length ? 700 : 500} ${font}px system-ui, sans-serif`;
    ctx.fillText(txt, pad, ih + pad + i * lineH);
  });
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
}

function stampedName(f) {
  const base = safeName(f.name.replace(/\.[a-z0-9]+$/i, ""));
  return `${(f.receiptIds || []).join("+") || f.id}__${base}-stamped.jpg`;
}

async function saveStamped(r) {
  const f = fileOf(r);
  if (!f?.blob) { toast(t("t.noOriginal")); return; }
  if (f.kind !== "image") { toast(t("t.stampPdf")); return; }
  const blob = await stampedImage(f);
  if (!blob) { toast(t("t.stampFormat")); return; }
  await log("stamped_copy", r.id, t("lg.stamped", { name: f.name }));
  await shareOrDownload(new File([blob], stampedName(f), { type: "image/jpeg" }), r.id);
  render();
}

function viewOriginal(r) {
  const f = files.find((x) => x.id === r.fileId);
  if (!f?.blob) { toast(t("t.noOriginal")); return; }
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
  await log("file_removed", "", t("lg.removed", { name: f.name }));
  render();
}

// ---------------------------------------------------------------------------
// Statements: pick lines as expenses, or as proof of payment for a receipt/invoice
// ---------------------------------------------------------------------------
const stLabel = (f) => {
  const s = f.statement || {};
  return `${s.institution || f.name}${s.account_last4 ? ` ••${s.account_last4}` : ""}`;
};

/** A transaction counts as used unless the expense made from it was voided. */
function txUse(tx) {
  if (!tx.use) return null;
  const r = getReceipt(tx.use.receiptId);
  if (!r || (tx.use.type === "expense" && r.voided)) return null;
  return { type: tx.use.type, r };
}

async function addTxAsExpense(f, tx) {
  const same = sameAmountNearby(tx.amount, tx.date);
  if (same.length && !confirm(t("c.txDupe", { ids: same.map((r) => `${r.id} (${r.store_name || ""}, ${r.date || "—"})`).join(", ") }))) return;
  const s = f.statement;
  const r = {
    id: nextReceiptId(),
    fileId: f.id, source: f.name, sha256: f.sha256, addedAt: f.addedAt,
    extractedAt: new Date().toISOString(), model: null,
    store_name: tx.description, store_address: null, date: tx.date, time: null,
    currency: s.currency || settings.currency, receipt_number: null,
    payment_method: stLabel(f), source_ref: tx.ref,
    items: [{
      description: tx.description, quantity: null, unit_price: null, line_total: tx.amount, category: null,
      likely_for_children: null, ai_suggestion: null, ai_type: null, exp_type: null, alloc: "review", split_pct: settings.splitDefault,
    }],
    subtotal: null, discount: null, tax: null, tip: null, total: tx.amount, notes: null,
    document_type: "statement", payer: f.payer || "me", declared: false, fromStatement: true,
    reviewed: false, note: "", voided: false, voidReason: "",
  };
  receipts.push(r);
  f.receiptIds = [...(f.receiptIds || []), r.id];
  tx.use = { type: "expense", receiptId: r.id };
  await saveReceipt(r);
  await saveFile(f);
  await log("statement_expense", r.id, t("lg.stExpense", { desc: tx.description, amt: fmtNum(tx.amount), date: tx.date || "", st: stLabel(f), ref: tx.ref || "" }));
  toast(t("t.txAdded", { id: r.id }));
  render();
}

async function linkProof(f, tx, r) {
  if (r.paymentProof) await unlinkProof(r, { silent: true });
  r.paymentProof = {
    fileId: f.id, txId: tx.id, date: tx.date, amount: tx.amount, description: tx.description,
    ref: tx.ref, source: f.name, sha256: f.sha256, account: stLabel(f),
  };
  tx.use = { type: "proof", receiptId: r.id };
  linkOpen = null;
  await saveReceipt(r);
  await saveFile(f);
  await log("proof_linked", r.id, t("lg.proof", { desc: tx.description, amt: fmtNum(tx.amount), date: tx.date || "", st: stLabel(f), ref: tx.ref || "" }));
  render();
}

async function unlinkProof(r, { silent = false } = {}) {
  const p = r.paymentProof;
  if (!p) return;
  const f = files.find((x) => x.id === p.fileId);
  const tx = f?.statement?.transactions.find((x) => x.id === p.txId);
  if (tx) { tx.use = null; await saveFile(f); }
  delete r.paymentProof;
  await saveReceipt(r);
  await log("proof_unlinked", r.id, t("lg.proof", { desc: p.description, amt: fmtNum(p.amount), date: p.date || "", st: p.account, ref: p.ref || "" }));
  if (!silent) render();
}

async function releaseTx(f, tx) {
  const use = txUse(tx);
  if (!use) return;
  if (use.type === "proof") return unlinkProof(use.r);
  if (!confirm(t("c.releaseTx", { id: use.r.id }))) return;
  use.r.voided = true;
  use.r.voidReason = t("st.released");
  await saveReceipt(use.r);
  await log("voided", use.r.id, use.r.voidReason);
  tx.use = null;
  await saveFile(f);
  render();
}

/** Receipts that could be paid by this transaction: same amount first, then close dates. */
function proofCandidates(tx) {
  const day = (d) => (d ? Date.parse(d) / 86400000 : NaN);
  return receipts
    .filter((r) => !r.voided && !r.fromStatement)
    .map((r) => {
      const days = Math.abs(day(r.date) - day(tx.date));
      const same = Math.abs(receiptTotal(r) - Math.abs(tx.amount)) < 0.011;
      return { r, days: Number.isFinite(days) ? days : 999, same };
    })
    .filter((x) => (x.same ? x.days <= 10 : x.days <= 5))
    .sort((a, b) => (b.same - a.same) || a.days - b.days)
    .slice(0, 6);
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
  if (!from && !to) return t("r.allDates");
  return t("r.range", { from: from || t("r.start"), to: to || t("r.today") });
}

/** First sentence of Claude's note, capped, for the report (the full note is in the Excel file). */
function shortNote(n) {
  const first = String(n).split(/(?<=[.!?])\s+/)[0];
  return first.length > 140 ? `${first.slice(0, 137).trimEnd()}…` : first;
}

function buildReport() {
  const list = reportReceipts();
  const active = list.filter((r) => !r.voided);
  const voided = list.filter((r) => r.voided);
  const totals = totalsFor(active);
  const anyTagged = active.some(isTagged);
  const dupes = duplicateIds();
  const L = [];
  L.push(t(anyTagged ? "r.titleTagged" : "r.title"));
  L.push(t("r.period", { p: periodLabel() }));
  L.push(t("r.generated", { ts: fmtTs(new Date().toISOString()) }));
  L.push(t("r.receipts", { n: active.length }) + (voided.length ? t("r.voidedExcl", { n: voided.length }) : ""));
  L.push("");
  for (const [c, tot] of Object.entries(totals)) {
    L.push(t("r.totalSpent", { c, t: fmtMoney(tot.total, c), x: fmtMoney(tot.tax, c) }));
    if (anyTagged) {
      L.push(t("r.forKids", { t: fmtMoney(tot.kids, c) }));
      L.push(t("r.notKids", { t: fmtMoney(tot.not, c) }));
      if (tot.pending) L.push(t("r.notTagged", { t: fmtMoney(tot.review, c), n: tot.pending }));
    }
    L.push("");
  }

  const byMonth = {};
  const byStore = {};
  for (const r of active) {
    const c = curOf(r);
    const m = `${(r.date || t("r.noDate")).slice(0, 7)}|${c}`;
    byMonth[m] = (byMonth[m] || 0) + receiptTotal(r);
    const st = `${r.store_name || t("r.unknown")}|${c}`;
    byStore[st] = (byStore[st] || 0) + receiptTotal(r);
  }
  const multiCur = Object.keys(totals).length > 1;
  const section = (title, obj, sort) => {
    const rows = Object.entries(obj).sort(sort);
    if (rows.length < 2) return;
    L.push(title);
    for (const [k, v] of rows) {
      const [name, c] = k.split("|");
      L.push(`  ${name}${multiCur ? ` (${c})` : ""}: ${fmtMoney(v, c)}`);
    }
    L.push("");
  };
  section(t("r.byMonth"), byMonth, (a, b) => a[0].localeCompare(b[0]));
  section(t("r.byStore"), byStore, (a, b) => b[1] - a[1]);

  const unverified = active.filter((r) => !r.reviewed).length;
  if (unverified) L.push(t("r.unverified", { n: unverified }), "");
  if (anyTagged) L.push(t("r.legend"), t("r.legend2"), "");
  L.push(t("r.dateLegend"), "");
  L.push(t("r.receiptsHdr"));
  for (const r of active) {
    const a = allocation(r);
    const c = curOf(r);
    const tagged = isTagged(r);
    L.push("");
    L.push(`${r.id} | ${r.date || t("r.noDate")}${r.time ? ` ${r.time}` : ""} | ${r.store_name || t("unknownStore")} | ${fmtMoney(a.total, c)}${r.reviewed ? t("r.verified") : ""}`);
    if (tagged) L.push(t("r.kidsLine", { t: fmtMoney(a.kids, c) }) + (a.pending ? t("r.kidsPending", { n: a.pending }) : ""));
    if (r.payer === "other") L.push(`  ${t("badge.payerOther")}`);
    if (r.declared) L.push(`  ${t("badge.declared")}${r.source_ref ? ` (${r.source_ref})` : ""}`);
    if (r.paymentProof) L.push(`  ${t("r.proof", { st: r.paymentProof.account, date: r.paymentProof.date || "", amt: fmtNum(r.paymentProof.amount), ref: r.paymentProof.ref || "" })}`);
    if (r.fromStatement) L.push(`  ${t("badge.fromStatement")}${r.source_ref ? ` (${r.source_ref})` : ""}`);
    if (r.payment_method) L.push(t("r.paid", { p: r.payment_method }));
    for (const it of a.items) {
      const tag = (!tagged ? "-"
        : it.linked ? "  ↳"
        : it.alloc === "kids" ? t("r.tagKids")
        : it.alloc === "split" ? t("r.tagSplit", { p: it.split_pct })
        : it.alloc === "not" ? t("r.tagNot") : "[ ]") + (isKidsLine(it) && !it.linked && it.exp_type ? ` {${it.exp_type}}` : "");
      const qty = it.quantity != null && it.quantity !== 1 ? `${fmtQty(it.quantity)} x ` : "";
      L.push(`   ${tag} ${qty}${it.description} = ${fmtNum(it.line_total)}`);
    }
    const extra = [
      r.tax != null && t("r.tax", { v: fmtNum(r.tax) }),
      extraDiscount(r) && t("r.discount", { v: fmtNum(extraDiscount(r)) }),
      r.tip && t("r.tip", { v: fmtNum(r.tip) }),
    ].filter(Boolean);
    if (extra.length) L.push(`   (${extra.join(", ")})`);
    if (r.note) L.push(t("r.note", { n: r.note }));
    if (r.notes) L.push(t("r.readingNote", { n: shortNote(r.notes) }));
    if (dupes.has(r.id)) L.push(t("r.dupe", { ids: dupes.get(r.id).join(", ") }));
    L.push(t("r.original", { name: r.source, sha: r.sha256.slice(0, 16), ts: fmtTs(r.addedAt) }));
  }
  if (voided.length) {
    L.push("", t("r.voidedHdr"));
    for (const r of voided) {
      L.push(`${r.id} | ${r.date || t("r.noDate")} | ${r.store_name || t("r.unknown")} | ${fmtMoney(receiptTotal(r), curOf(r))} — ${t("r.voidReason", { r: r.voidReason })}`);
    }
  }
  L.push("", t("r.footer"));
  return L.join("\n");
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
const yesNo = (b) => t(b ? "yes" : "no");
const docLabel = (r) => (r.document_type ? t(`doc.${r.document_type}`) : "");

/** One row per receipt line (header first). Shared by the CSV and the Excel "Items" sheet. */
function itemRows(list) {
  const rows = [t("csv.items")];
  for (const r of list) {
    const a = allocation(r);
    for (const it of a.items.length ? a.items : [null]) {
      rows.push([
        r.id, r.date, r.time, r.store_name, docLabel(r), payerLabel(r), it?.description, it?.category, it?.quantity, it?.unit_price, it?.line_total,
        it ? `${it.linked ? "↳ " : ""}${ALLOC_LABEL[it.alloc]}` : "", it && isKidsLine(it) ? it.exp_type || "" : "",
        it?.alloc === "split" ? it.split_pct : "", it ? itemKidsAmount(it, a.factor) : "",
        it?.ai_suggestion ? t(`sug.${it.ai_suggestion}`) : "", it?.ai_type || "", a.total, a.kids, curOf(r), r.payment_method, yesNo(r.reviewed),
        yesNo(r.voided), r.voidReason, yesNo(r.declared), r.source_ref, r.note, r.source, r.sha256, r.addedAt, proofText(r),
      ]);
    }
  }
  return rows;
}

const proofText = (r) => (r.paymentProof
  ? t("r.proof", { st: r.paymentProof.account, date: r.paymentProof.date || "", amt: fmtNum(r.paymentProof.amount), ref: r.paymentProof.ref || "" })
    + ` · ${r.paymentProof.source} · SHA-256 ${r.paymentProof.sha256}`
  : r.fromStatement ? t("badge.fromStatement") : "");

/** One row per receipt. */
function receiptRows(list) {
  const rows = [t("xl.receiptsHdr")];
  for (const r of list) {
    const a = allocation(r);
    rows.push([
      r.id, r.date, r.time, r.store_name, docLabel(r), payerLabel(r), curOf(r), r.subtotal, r.tax, extraDiscount(r) || null, r.tip, a.total,
      a.kids, a.not, a.review, r.payment_method, yesNo(r.reviewed), yesNo(r.voided), r.voidReason, yesNo(r.declared), r.source_ref,
      r.note, r.notes, r.source, r.sha256, r.addedAt, proofText(r),
    ]);
  }
  return rows;
}

function buildItemsCsv(list = reportReceipts()) {
  return toCsv(itemRows(list));
}

function buildXlsx(list = reportReceipts()) {
  return makeXlsx([
    { name: t("xl.sheetReceipts"), rows: receiptRows(list), money: [7, 8, 9, 10, 11, 12, 13, 14], widths: { 24: 20 } },
    { name: t("xl.sheetItems"), rows: itemRows(list), money: [9, 10, 14, 17, 18], widths: { 28: 20 } },
  ]);
}

function buildLogCsv() {
  return toCsv([t("csv.log"), ...logEntries.map((e) => [e.ts, actionLabel(e.action), e.receiptId, e.detail])]);
}

function safeName(s) {
  return s.replace(/[^\w.\- ]+/g, "_").slice(0, 80);
}

/** Receipt IDs that rely on a statement (expenses made from it, or proofs of payment). */
const statementRefs = (f, list) => list.filter((r) => r.fileId === f.id || r.paymentProof?.fileId === f.id).map((r) => r.id);

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
  toast(t("t.building"), 10000);
  const list = full
    ? receipts.slice().sort((a, b) => a.id.localeCompare(b.id))
    : reportReceipts();
  const ids = new Set(list.map((r) => r.fileId));
  for (const r of list) if (r.paymentProof) ids.add(r.paymentProof.fileId);
  const used = files.filter((f) => f.blob && (full ? f.status === "done" || ids.has(f.id) : ids.has(f.id)));
  // An evidence pack lists every original file with its fingerprint but leaves the files themselves
  // out (they stay on the phone, available on request). A full backup keeps them so it can be restored.
  const pf = full ? used : [];
  const withheld = full ? [] : used;

  const stamped = [];
  for (const f of pf) {
    const blob = await stampedImage(f);
    if (blob) stamped.push({ name: `stamped/${stampedName(f)}`, data: blob });
  }
  const manifest = toCsv([
    t("csv.manifest"),
    ...pf.map((f) => [originalPath(f), f.name, (f.receiptIds || []).join(" "), f.sha256, f.size, f.addedAt, f.lastModified]),
    ...withheld.map((f) => [t("pk.withheld"), f.name, statementRefs(f, list).join(" "), f.sha256, f.size, f.addedAt, f.lastModified]),
  ]);
  const label = full ? t("pk.full") : periodLabel();
  const data = JSON.stringify({
    format: "receipt-mailer-pack",
    version: 2,
    full,
    exportedAt: new Date().toISOString(),
    period: label,
    seq,
    receipts: list,
    files: full
      ? pf.map(({ blob, ...meta }) => ({ ...meta, packPath: originalPath(meta) }))
      : withheld.map(({ blob, ...meta }) => ({ ...meta, withheld: true })),
    log: logEntries.map(({ seq: _s, ...e }) => e),
  }, null, 2);
  const readme = [full ? t("pk.readmeFull") : t("pk.readme", { p: label }), "", ...t(full ? "pk.linesFull" : "pk.lines")].join("\n");

  // The report covers the period, or everything for a full backup.
  const savedFrom = $("#periodFrom").value;
  const savedTo = $("#periodTo").value;
  if (full) { $("#periodFrom").value = ""; $("#periodTo").value = ""; }
  let report, pdf;
  try {
    report = buildReport();
    pdf = await buildPdf(list);
  } finally {
    $("#periodFrom").value = savedFrom;
    $("#periodTo").value = savedTo;
  }

  const zip = await makeZip([
    { name: "README.txt", data: readme },
    { name: "report.txt", data: report },
    { name: `${t("pdf.file")}.pdf`, data: pdf },
    { name: `${t("xl.file")}.xlsx`, data: await buildXlsx(list) },
    { name: "items.csv", data: buildItemsCsv(list) },
    { name: "audit-log.csv", data: buildLogCsv() },
    { name: "manifest.csv", data: manifest },
    { name: "data.json", data },
    ...pf.map((f) => ({ name: originalPath(f), data: f.blob })),
    ...stamped,
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  await log(full ? "backup_exported" : "exported", "", t("lg.export", { p: label, r: list.length, f: pf.length }));
  if (full) store.set("lastBackup", new Date().toISOString());
  toast(t("t.packReady"));
  return new File([zip], `${t(full ? "pk.fileFull" : "pk.file")}-${stamp}.zip`, { type: "application/zip" });
}

/** Restores (merges) a pack made by this app. Existing receipts/files are kept; fingerprints are re-checked. */
async function restorePack(zipFile) {
  toast(t("t.readingBackup"), 10000);
  const zip = await readZip(zipFile);
  const dataName = zip.names.find((n) => n === "data.json" || n.endsWith("/data.json"));
  if (!dataName) throw new Error(t("e.notBackup"));
  const prefix = dataName.slice(0, -"data.json".length);
  const data = JSON.parse(await zip.text(dataName));
  if (!Array.isArray(data.receipts) || !Array.isArray(data.files)) throw new Error(t("e.badBackup"));

  let addedFiles = 0, addedReceipts = 0, badHash = 0, missing = 0;
  for (const meta of data.files) {
    if (files.some((f) => f.id === meta.id || f.sha256 === meta.sha256)) continue;
    if (meta.withheld) continue; // evidence pack: listed with its fingerprint only
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

  const problems = [badHash && t("a.badHash", { n: badHash }), missing && t("a.missing", { n: missing })].filter(Boolean);
  await log("restored_backup", "", t("lg.restoredBackup", { name: zipFile.name, r: addedReceipts, f: addedFiles }) + (problems.length ? `; ${problems.join("; ")}` : ""));
  render();
  alert(t("a.restoreDone", { r: addedReceipts, f: addedFiles }) + (problems.length ? `\n\n⚠ ${problems.join("\n⚠ ")}` : `\n${t("a.allMatched")}`));
}

// ---------------------------------------------------------------------------
// Short email summary + detailed PDF report
// ---------------------------------------------------------------------------
function monthRows(active) {
  const m = {};
  for (const r of active) {
    const k = `${(r.date || "????-??").slice(0, 7)}|${curOf(r)}`;
    const a = allocation(r);
    m[k] ??= { kids: 0, total: 0, n: 0 };
    m[k].kids += a.kids; m[k].total += a.total; m[k].n += 1;
  }
  return Object.entries(m).sort((x, y) => x[0].localeCompare(y[0]))
    .map(([k, v]) => { const [month, c] = k.split("|"); return { month, c, ...v }; });
}

/** Kids' share by expense type and by who paid (only lines counted for the children). */
function typeRows(active) {
  const m = new Map();
  for (const r of active) {
    const a = allocation(r);
    for (const it of a.items) {
      const amt = itemKidsAmount(it, a.factor);
      if (!amt) continue;
      const key = `${it.exp_type || t("type.none")}|${curOf(r)}`;
      const row = m.get(key) || { type: it.exp_type || t("type.none"), c: curOf(r), me: 0, other: 0 };
      row[r.payer === "other" ? "other" : "me"] += amt;
      m.set(key, row);
    }
  }
  return [...m.values()].map((x) => ({ ...x, me: round2(x.me), other: round2(x.other), total: round2(x.me + x.other) }));
}

/** Things a reader should know before relying on the totals. */
function checkLines(list) {
  const active = list.filter((r) => !r.voided);
  const dupes = duplicateIds();
  const dupIds = active.filter((r) => dupes.has(r.id)).map((r) => r.id);
  const out = [];
  const unverified = active.filter((r) => !r.reviewed).length;
  if (unverified) out.push(t("chk.unverified", { n: unverified }));
  if (dupIds.length) out.push(t("chk.dupe", { ids: dupIds.join(", ") }));
  const declared = active.filter((r) => r.declared).length;
  if (declared) out.push(t("chk.declared", { n: declared }));
  const noDate = active.filter((r) => !r.date).length;
  if (noDate) out.push(t("chk.noDate", { n: noDate }));
  const voided = list.length - active.length;
  if (voided) out.push(t("chk.voided", { n: voided }));
  return out;
}

/** Figures shared by the plain-text and the coloured summary. */
function summaryData() {
  const list = reportReceipts();
  const active = list.filter((r) => !r.voided);
  const totals = totalsFor(active);
  const anyTagged = active.some(isTagged);
  const curs = Object.entries(totals).map(([c, tot]) => ({
    c, ...tot,
    untaggedReceipts: active.filter((r) => curOf(r) === c && allocation(r).pending).length,
  }));
  return {
    title: t(anyTagged ? "s.titleKids" : "s.title"),
    period: periodLabel(),
    anyTagged,
    multiCur: curs.length > 1,
    curs,
    months: monthRows(active),
    checks: checkLines(list),
    types: active.some((r) => r.payer === "other") || active.some((r) => r.items.some((it) => it.exp_type)) ? typeRows(active) : [],
    hasOther: active.some((r) => r.payer === "other"),
  };
}

/**
 * The email body as plain text. Gmail on iPhone drops line breaks from shared text, so every line
 * ends with a period or starts with a bullet: it reads correctly whether the breaks survive or not.
 */
function buildSummary({ attached = true } = {}) {
  const d = summaryData();
  const L = [`${d.title} — ${d.period}.`, ""];
  for (const x of d.curs) {
    const cur = d.multiCur ? ` (${x.c})` : "";
    if (d.anyTagged) L.push(`${t("s.kids", { t: fmtMoney(x.kids, x.c) })}${cur}.`);
    L.push(`${t("s.total", { t: fmtMoney(x.total, x.c), n: x.count })}${cur}.`);
    if (d.anyTagged) {
      L.push(`${t("s.not", { t: fmtMoney(x.not, x.c) })}.`);
      if (x.pending) L.push(`${t("s.untagged", { t: fmtMoney(x.review, x.c), n: x.untaggedReceipts })}.`);
    }
    L.push("");
  }
  if (d.months.length) {
    L.push(t(d.anyTagged ? "s.byMonthKids" : "s.byMonth"));
    for (const m of d.months) {
      const cur = d.multiCur ? ` (${m.c})` : "";
      L.push(d.anyTagged
        ? `• ${m.month} : ${fmtMoney(m.kids, m.c)} / ${fmtMoney(m.total, m.c)}${cur};`
        : `• ${m.month} : ${fmtMoney(m.total, m.c)}${cur};`);
    }
    L.push("");
  }
  if (d.types.length) {
    L.push(t("s.byType"));
    for (const x of d.types) {
      const who = d.hasOther ? ` (${t("payer.me")} ${fmtMoney(x.me, x.c)} · ${t("payer.other")} ${fmtMoney(x.other, x.c)})` : "";
      L.push(`• ${x.type} : ${fmtMoney(x.total, x.c)}${who};`);
    }
    L.push("");
  }
  if (d.checks.length) L.push(t("s.checks"), ...d.checks.map((x) => `• ${x};`), "");
  if (attached) L.push(t("s.attached"));
  return L.join("\n").trim();
}

/** The same summary with colours, for pasting into an email (inline styles: mail apps drop <style>). */
function buildSummaryHtml() {
  const d = summaryData();
  const e = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const row = (label, value, strong = false) =>
    `<tr><td style="padding:6px 0;color:#5d6b68;font-size:14px;border-bottom:1px solid #e5ebe9">${e(label)}</td>`
    + `<td style="padding:6px 0;text-align:right;font-size:14px;border-bottom:1px solid #e5ebe9;${strong ? "font-weight:700;" : ""}">${e(value)}</td></tr>`;
  let h = `<div style="${FONT}color:#17201e;max-width:560px">`;
  h += `<div style="font-size:22px;font-weight:700;margin:0">${e(d.title)}</div>`;
  h += `<div style="font-size:13px;color:#5d6b68;margin:2px 0 16px">${e(t("r.period", { p: d.period }))}</div>`;
  for (const x of d.curs) {
    if (d.anyTagged) {
      h += `<div style="background:#0f766e;color:#ffffff;border-radius:12px;padding:14px 16px;margin:0 0 10px">`
        + `<div style="font-size:13px;opacity:.85">${e(t("pdf.kids"))}${d.multiCur ? ` (${e(x.c)})` : ""}</div>`
        + `<div style="font-size:28px;font-weight:700;line-height:1.2">${e(fmtMoney(x.kids, x.c))}</div></div>`;
    }
    h += `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px">`;
    h += row(t("s.totalLabel", { n: x.count }), fmtMoney(x.total, x.c), !d.anyTagged);
    if (d.anyTagged) {
      h += row(t("pdf.not"), fmtMoney(x.not, x.c));
      if (x.pending) h += row(t("s.untaggedLabel", { n: x.untaggedReceipts }), fmtMoney(x.review, x.c));
    }
    h += `</table>`;
  }
  if (d.months.length) {
    const th = "padding:6px 8px;font-size:12px;color:#ffffff;background:#0f766e;";
    h += `<div style="font-size:15px;font-weight:700;margin:0 0 6px">${e(t("r.byMonth"))}</div>`;
    h += `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px">`;
    h += `<tr><th style="${th}text-align:left">${e(t("pdf.month"))}</th>`
      + (d.anyTagged ? `<th style="${th}text-align:right">${e(t("pdf.kids"))}</th>` : "")
      + `<th style="${th}text-align:right">${e(t("pdf.total"))}</th></tr>`;
    d.months.forEach((m, i) => {
      const bg = i % 2 ? "#f4f6f5" : "#ffffff";
      const td = `padding:6px 8px;background:${bg};`;
      h += `<tr><td style="${td}">${e(m.month)}${d.multiCur ? ` (${e(m.c)})` : ""}</td>`
        + (d.anyTagged ? `<td style="${td}text-align:right;font-weight:700;color:#0f766e">${e(fmtMoney(m.kids, m.c))}</td>` : "")
        + `<td style="${td}text-align:right">${e(fmtMoney(m.total, m.c))}</td></tr>`;
    });
    h += `</table>`;
  }
  if (d.types.length) {
    const th = "padding:6px 8px;font-size:12px;color:#ffffff;background:#0f766e;";
    h += `<div style="font-size:15px;font-weight:700;margin:0 0 6px">${e(t("s.byType"))}</div>`;
    h += `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px">`;
    h += `<tr><th style="${th}text-align:left">${e(t("pdf.type"))}</th>`
      + (d.hasOther ? `<th style="${th}text-align:right">${e(t("payer.me"))}</th><th style="${th}text-align:right">${e(t("payer.other"))}</th>` : "")
      + `<th style="${th}text-align:right">${e(t("pdf.total"))}</th></tr>`;
    d.types.forEach((x, i) => {
      const td = `padding:6px 8px;background:${i % 2 ? "#f4f6f5" : "#ffffff"};`;
      h += `<tr><td style="${td}">${e(x.type)}</td>`
        + (d.hasOther ? `<td style="${td}text-align:right">${e(fmtMoney(x.me, x.c))}</td><td style="${td}text-align:right">${e(fmtMoney(x.other, x.c))}</td>` : "")
        + `<td style="${td}text-align:right;font-weight:700;color:#0f766e">${e(fmtMoney(x.total, x.c))}</td></tr>`;
    });
    h += `</table>`;
  }
  if (d.checks.length) {
    h += `<div style="border-left:4px solid #b54708;background:#fff6ed;padding:10px 12px;border-radius:6px;margin:0 0 16px">`
      + `<div style="font-weight:700;color:#b54708;margin-bottom:4px">${e(t("s.checks"))}</div>`
      + d.checks.map((x) => `<div style="font-size:13px">• ${e(x)}</div>`).join("") + `</div>`;
  }
  h += `<div style="font-size:12px;color:#5d6b68">${e(t("s.attached"))}</div></div>`;
  return h;
}

async function copyRichSummary() {
  const html = buildSummaryHtml();
  const text = buildSummary({ attached: true });
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    })]);
    toast(t("t.richCopied"), 5000);
  } catch {
    toast((await copyText(text)) ? t("t.copied") : t("t.copyFail"));
  }
}

/** Attachment names double as the email subject in Gmail, so make them readable. */
function friendlyName(file, kind) {
  const d = new Date().toISOString().slice(0, 10);
  const ext = file.name.split(".").pop();
  const title = t(reportReceipts().filter((r) => !r.voided).some(isTagged) ? "s.titleKids" : "s.title");
  return new File([file], `${title} - ${t(kind)} ${d}.${ext}`, { type: file.type });
}

// jsPDF's built-in fonts only cover Windows-1252: map/replace anything else.
const PDF_OK = /[ -~¡-ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ\n]/;
function pdfText(v) {
  return Array.from(String(v ?? "")
    .replace(/[   ]/g, " ").replace(/≠/g, "<>").replace(/[→↳]/g, "->")
    .replace(/⚠️?/g, "!").replace(/[✓✔]/g, "").replace(/✨|📝/g, ""))
    .map((ch) => (PDF_OK.test(ch) ? ch : "?")).join("");
}

function tagText(it) {
  if (it.linked) return "->";
  if (it.alloc === "split") return `${ALLOC_LABEL.split} ${it.split_pct} %`;
  return it.alloc === "review" ? "—" : ALLOC_LABEL[it.alloc];
}

/** Detailed, printable report: summary, months, checks, then one section per receipt. */
async function buildPdf(list = reportReceipts()) {
  const { jsPDF, autoTable } = await import("./vendor/pdf.js");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const INK = [23, 32, 30], MUTED = [93, 107, 104], WARN = [181, 71, 8], ACCENT = [15, 118, 110];
  let y = M;
  const ensure = (need) => { if (y + need > H - 50) { doc.addPage(); y = M; } };
  const text = (str, { size = 10, bold = false, color = INK, gap = 4 } = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(pdfText(str), W - 2 * M);
    ensure(lines.length * size * 1.25);
    doc.text(lines, M, y + size);
    y += lines.length * size * 1.25 + gap;
  };
  let colStyles = {};
  // Header and footer cells don't inherit columnStyles: right-align them like the amounts below.
  const alignCell = (v, i) => ({ content: pdfText(v), styles: colStyles[i]?.halign ? { halign: colStyles[i].halign } : {} });
  const table = (opts) => {
    colStyles = opts.columnStyles || {};
    autoTable(doc, {
      startY: y, theme: "grid", margin: { left: M, right: M, bottom: 50 },
      styles: { fontSize: 8.5, cellPadding: 3, overflow: "linebreak", textColor: INK, lineColor: [221, 227, 225] },
      headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [244, 246, 245], textColor: INK, fontStyle: "bold" },
      ...opts,
      head: opts.head?.map((r) => r.map((v, i) => alignCell(v, i))),
      body: opts.body.map((r) => r.map(pdfText)),
      foot: opts.foot?.map((r) => r.map((v, i) => alignCell(v, i))),
    });
    y = doc.lastAutoTable.finalY + 10;
  };
  const right = (cols) => Object.fromEntries(cols.map((i) => [i, { halign: "right" }]));

  const active = list.filter((r) => !r.voided);
  const voided = list.filter((r) => r.voided);
  const totals = totalsFor(active);
  const anyTagged = active.some(isTagged);
  const dupes = duplicateIds();
  const title = t(anyTagged ? "s.titleKids" : "s.title");

  text(title, { size: 18, bold: true, gap: 2 });
  text(`${t("r.period", { p: periodLabel() })}  ·  ${t("r.generated", { ts: fmtTs(new Date().toISOString()) })}  ·  ${t("r.receipts", { n: active.length })}`, { size: 9, color: MUTED, gap: 10 });

  // Totals
  const curs = Object.entries(totals);
  if (anyTagged) {
    table({
      head: [[t("pdf.cur"), t("pdf.kids"), t("pdf.not"), t("pdf.untagged"), t("pdf.total"), t("pdf.tax")]],
      body: curs.map(([c, x]) => [c, fmtMoney(x.kids, c), fmtMoney(x.not, c), fmtMoney(x.review, c), fmtMoney(x.total, c), fmtMoney(x.tax, c)]),
      columnStyles: { ...right([1, 2, 3, 4, 5]), 1: { halign: "right", fontStyle: "bold" } },
    });
  } else {
    table({
      head: [[t("pdf.cur"), t("pdf.total"), t("pdf.tax"), t("pdf.receipts")]],
      body: curs.map(([c, x]) => [c, fmtMoney(x.total, c), fmtMoney(x.tax, c), String(x.count)]),
      columnStyles: right([1, 2, 3]),
    });
  }

  // By month
  const months = monthRows(active);
  if (months.length > 1) {
    text(t("r.byMonth"), { size: 11, bold: true });
    table({
      head: [anyTagged ? [t("pdf.month"), t("pdf.kids"), t("pdf.total"), t("pdf.receipts")] : [t("pdf.month"), t("pdf.total"), t("pdf.receipts")]],
      body: months.map((m) => anyTagged
        ? [m.month, fmtMoney(m.kids, m.c), fmtMoney(m.total, m.c), String(m.n)]
        : [m.month, fmtMoney(m.total, m.c), String(m.n)]),
      columnStyles: anyTagged ? right([1, 2, 3]) : right([1, 2]),
    });
  }

  // Kids' share by expense type / who paid
  const types = active.some((r) => r.payer === "other") || active.some((r) => r.items.some((it) => it.exp_type)) ? typeRows(active) : [];
  if (types.length) {
    const other = active.some((r) => r.payer === "other");
    text(t("s.byType"), { size: 11, bold: true });
    table({
      head: [other ? [t("pdf.type"), t("payer.me"), t("payer.other"), t("pdf.total")] : [t("pdf.type"), t("pdf.total")]],
      body: types.map((x) => other
        ? [x.type, fmtMoney(x.me, x.c), fmtMoney(x.other, x.c), fmtMoney(x.total, x.c)]
        : [x.type, fmtMoney(x.total, x.c)]),
      columnStyles: other ? right([1, 2, 3]) : right([1]),
    });
  }

  // Checks + how to read
  const checks = checkLines(list);
  if (checks.length) {
    text(t("s.checks"), { size: 11, bold: true, gap: 2 });
    for (const c of checks) text(`•  ${c}`, { size: 9, color: WARN, gap: 1 });
    y += 8;
  }
  if (anyTagged) text(`${t("pdf.legend")} ${t("r.legend2")}`, { size: 8, color: MUTED, gap: 1 });
  text(t("r.dateLegend"), { size: 8, color: MUTED, gap: 12 });

  // One section per receipt
  text(t("r.receiptsHdr"), { size: 13, bold: true, gap: 6 });
  for (const r of active) {
    const a = allocation(r);
    const c = curOf(r);
    const tagged = isTagged(r);
    ensure(110);
    doc.setDrawColor(221, 227, 225);
    doc.line(M, y, W - M, y);
    y += 6;
    text(`${r.id}   ${r.date || t("r.noDate")}${r.time ? ` ${r.time}` : ""}   ${r.store_name || t("unknownStore")}`, { size: 11, bold: true, gap: 1 });
    const meta = [
      `${t("total")} ${fmtMoney(a.total, c)}`,
      tagged && `${t("pdf.kids")} ${fmtMoney(a.kids, c)}`,
      r.payment_method,
      r.payer === "other" && t("badge.payerOther"),
      r.reviewed ? t("badge.verified") : t("badge.unverified"),
    ].filter(Boolean);
    text(meta.join("   ·   "), { size: 9, color: MUTED, gap: 2 });
    const flags = [
      r.declared && `${t("badge.declared")}${r.source_ref ? ` (${r.source_ref})` : ""}`,
      dupes.has(r.id) && t("badge.dupe", { ids: dupes.get(r.id).join(", ") }),
    ].filter(Boolean);
    if (flags.length) text(flags.join("   ·   "), { size: 9, color: WARN, gap: 2 });
    const good = [
      r.fromStatement && `${t("badge.fromStatement")}${r.source_ref ? ` (${r.source_ref})` : ""}`,
      r.paymentProof && t("r.proof", { st: r.paymentProof.account, date: r.paymentProof.date || "", amt: fmtNum(r.paymentProof.amount), ref: r.paymentProof.ref || "" }),
    ].filter(Boolean);
    if (good.length) text(good.join("   ·   "), { size: 9, color: ACCENT, gap: 2 });

    const foot = [
      r.tax != null && [t("tax"), fmtNum(r.tax)],
      extraDiscount(r) && [t("discount"), `-${fmtNum(extraDiscount(r))}`],
      r.tip && [t("tip"), fmtNum(r.tip)],
      [t("total"), fmtMoney(a.total, c)],
    ].filter(Boolean);
    const qty = (it) => (it.quantity != null && it.quantity !== 1 ? fmtQty(it.quantity) : "");
    if (tagged) {
      table({
        head: [[t("pdf.tag"), t("pdf.item"), t("pdf.qty"), t("pdf.amount"), t("pdf.kidsPart")]],
        body: a.items.map((it) => [tagText(it) + (isKidsLine(it) && !it.linked && it.exp_type ? `\n${it.exp_type}` : ""), it.description, qty(it), fmtNum(it.line_total), fmtNum(itemKidsAmount(it, a.factor))]),
        foot: foot.map(([k, v], i) => ["", k, "", v, i === foot.length - 1 ? fmtMoney(a.kids, c) : ""]),
        showFoot: "lastPage",
        columnStyles: { 0: { cellWidth: 92 }, 2: { cellWidth: 32, halign: "right" }, 3: { cellWidth: 62, halign: "right" }, 4: { cellWidth: 72, halign: "right" } },
      });
    } else {
      table({
        head: [[t("pdf.item"), t("pdf.qty"), t("pdf.amount")]],
        body: a.items.map((it) => [it.description, qty(it), fmtNum(it.line_total)]),
        foot: foot.map(([k, v]) => [k, "", v]),
        showFoot: "lastPage",
        columnStyles: { 1: { cellWidth: 32, halign: "right" }, 2: { cellWidth: 72, halign: "right" } },
      });
    }
    y -= 4;
    if (r.note) text(t("r.note", { n: r.note }).trim(), { size: 9, gap: 1 });
    if (r.notes) text(t("r.readingNote", { n: shortNote(r.notes) }).trim(), { size: 8.5, color: MUTED, gap: 1 });
    text(t("pdf.original", { name: r.source, sha: r.sha256.slice(0, 16), ts: fmtTs(r.addedAt) }), { size: 7.5, color: MUTED, gap: 14 });
  }

  if (voided.length) {
    ensure(80);
    text(t("r.voidedHdr"), { size: 11, bold: true });
    table({
      head: [[t("pdf.id"), t("pdf.date"), t("pdf.store"), t("pdf.total"), t("pdf.voidReason")]],
      body: voided.map((r) => [r.id, r.date || "", r.store_name || "", fmtMoney(receiptTotal(r), curOf(r)), r.voidReason || ""]),
      columnStyles: { 3: { halign: "right" } },
    });
  }
  text(t("r.footer"), { size: 8, color: MUTED });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(pdfText(`${title} — ${periodLabel()}`), M, H - 24);
    doc.text(pdfText(t("pdf.page", { i, n: pages })), W - M, H - 24, { align: "right" });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new File([doc.output("blob")], `${t("pdf.file")}-${stamp}.pdf`, { type: "application/pdf" });
}

async function xlsxFile(list) {
  const blob = await buildXlsx(list);
  return new File([blob], `${t("pk.file")}-${new Date().toISOString().slice(0, 10)}.xlsx`, { type: blob.type });
}

// iOS only lets a page open the share sheet right after a tap. If building the files takes too
// long, the first tap prepares them and asks for a second tap, which then shares instantly.
const prepared = new Map();
const stateKey = () => `${logEntries.length}|${receipts.length}|${$("#periodFrom").value}|${$("#periodTo").value}`;

async function shareFiles(kind, build, { title, text }) {
  const key = stateKey();
  let entry = prepared.get(kind);
  const fresh = entry?.key === key;
  if (!fresh) {
    toast(t("t.building"), 15000);
    entry = { key, files: await build() };
    prepared.set(kind, entry);
  }
  try {
    if (navigator.canShare?.({ files: entry.files })) {
      await navigator.share({ title, text, files: entry.files });
    } else {
      entry.files.forEach(download);
      toast(t("t.shareUnsupported"));
    }
    toast(t("t.packReady"), 1200);
    return true;
  } catch (err) {
    if (err?.name === "AbortError") return false;
    if (err?.name === "NotAllowedError" && !fresh) { toast(t("t.tapAgain"), 6000); return false; }
    console.error(err);
    toast(t("t.shareFailed"));
    return false;
  }
}

async function shareReport() {
  const subject = $("#emailSubject").value.trim() || defaultSubject();
  const ok = await shareFiles("report", async () => {
    const list = reportReceipts();
    return [friendlyName(await buildPdf(list), "share.report"), friendlyName(await xlsxFile(list), "share.data")];
  }, { title: subject, text: buildSummary({ attached: true }) });
  if (ok) {
    await log("shared", "", t("lg.shared", { p: periodLabel(), n: reportReceipts().length }));
    render();
  }
}

function defaultSubject() {
  const active = reportReceipts().filter((r) => !r.voided);
  const totals = totalsFor(active);
  const pick = active.some(isTagged) ? "kids" : "total";
  const amt = Object.entries(totals).map(([c, tot]) => fmtMoney(tot[pick], c)).join(" + ") || fmtMoney(0, settings.currency);
  return pick === "kids"
    ? t("subj.kids", { amt, p: periodLabel() })
    : t("subj.plain", { n: active.length, amt, p: periodLabel() });
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
  const body = buildSummary({ attached: false }).replace(/\r?\n/g, "\r\n");
  if (to) store.set("lastEmail", to);
  let url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (url.length > 30000) {
    const copied = await copyText(body);
    const note = copied
      ? t("mail.copied")
      : t("mail.tooLong");
    url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(note + body.slice(0, 20000))}`;
    toast(copied ? t("t.longCopied") : t("t.longFail"), 4500);
  }
  await log("emailed", "", t("lg.emailed", { to: to ? t("lg.to", { to }) : "", p: periodLabel() }));
  window.location.href = url;
}

async function sharePack() {
  const subject = $("#emailSubject").value.trim() || defaultSubject();
  await shareFiles("pack", async () => [await buildPack()], { title: subject, text: buildSummary({ attached: false }) });
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const STATUS_LABEL = { pending: t("st.pending"), queued: t("st.queued"), working: t("st.working"), error: t("st.error") };

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
      : h("div", { class: "thumb", "aria-hidden": "true" }, f.role === "statement" ? "🏦" : f.kind === "pdf" ? "📄" : f.kind === "sheet" ? "📊" : "🧾"),
    h("div", {},
      h("div", { class: "qname" }, f.name),
      h("div", { class: `qstatus ${f.status}` }, f.status === "error" ? f.error : STATUS_LABEL[f.status])),
    h("button", {
      class: "btn small ghost", "aria-label": t("remove", { name: f.name }),
      disabled: f.status === "working" || f.status === "queued",
      onclick: () => removeFile(f.id),
    }, "✕"))));
  const doneCount = files.length - open.length;
  const last = store.get("lastBackup");
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86_400_000) : null;
  const backupNote = !receipts.length ? ""
    : last === "" ? t("bk.never")
    : days >= 7 ? t("bk.old", { d: days }) : t("bk.last", { ts: fmtTs(last) });
  $("#processedCount").textContent = doneCount ? t("processed", { f: doneCount, r: receipts.length }) + backupNote : "";

  const pending = files.filter((f) => f.status === "pending" || f.status === "error").length;
  const pb = $("#processBtn");
  pb.disabled = processing || pending === 0;
  pb.textContent = processing ? t("process.working") : pending ? t("process.count", { n: pending }) : t("process.idle");

  $("#resultsCard").hidden = receipts.length === 0;
  $("#sendCard").hidden = receipts.length === 0;
  if (!receipts.length) { renderStatements(); return; }

  // Totals (all non-voided receipts)
  const active = receipts.filter((r) => !r.voided);
  const totals = totalsFor(active);
  const stats = [];
  const anyTagged = active.some(isTagged);
  for (const [c, tot] of Object.entries(totals)) {
    stats.push([t("stat.spent", { c }), fmtMoney(tot.total, c), anyTagged ? "" : "accent"]);
    if (anyTagged) {
      stats.push([t("stat.kids", { c }), fmtMoney(tot.kids, c), "accent"]);
      stats.push([t("stat.not", { c }), fmtMoney(tot.not, c)]);
      if (tot.pending) stats.push([t("stat.untagged", { c }), fmtMoney(tot.review, c)]);
    }
  }
  stats.push([t("stat.receipts"), active.length]);

  const suggestable = receipts.reduce((n, r) => n + suggestableCount(r), 0);
  const ab = $("#applyAllBtn");
  ab.hidden = !suggestable;
  ab.textContent = t("applyAll", { n: suggestable });
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
    b.replaceChildren(t(b.dataset.labelKey), h("span", { class: "count" }, counts[key]));
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
  $("#receipts").replaceChildren(...(visible.length ? visible.map((r) => renderReceipt(r, dupes)) : [h("p", { class: "hint" }, t("nothing"))]));

  renderStatements();
  $("#history").replaceChildren(...logEntries.slice(-200).reverse().map((e) =>
    h("div", { class: "log-entry" }, h("time", {}, fmtTs(e.ts)), e.receiptId ? h("b", {}, `${e.receiptId} `) : null, `${actionLabel(e.action)}: ${e.detail}`)));

  if (!$("#emailSubject").dataset.edited) $("#emailSubject").value = defaultSubject();
  $("#emailPreview").textContent = buildSummary({ attached: true });
}

let linkOpen = null;               // "fileId|txId" whose proof picker is open
const openStatements = new Set();  // statements expanded on screen
const stQuery = new Map();         // search text per statement

function renderStatements() {
  const sts = files.filter((f) => f.role === "statement" && f.status === "done" && f.statement);
  $("#statementsCard").hidden = !sts.length;
  if (!sts.length) return;
  $("#statements").replaceChildren(...sts.map((f) => {
    const s = f.statement;
    const used = s.transactions.filter(txUse).length;
    const list = h("div", { class: "tx-list" });
    const fill = () => list.replaceChildren(...renderTxRows(f));
    fill();
    return h("details", {
      class: "statement", open: openStatements.has(f.id) || null,
      ontoggle: (e) => (e.target.open ? openStatements.add(f.id) : openStatements.delete(f.id)),
    },
    h("summary", {},
      h("b", {}, `🏦 ${stLabel(f)}`),
      h("div", { class: "meta" }, [
        s.period_start || s.period_end ? `${s.period_start || "…"} → ${s.period_end || "…"}` : null,
        t("st.count", { n: s.transactions.length, used }),
        f.payer === "other" ? t("badge.payerOther") : null,
      ].filter(Boolean).join(" · "))),
    h("div", { class: "statement-tools" },
      h("input", {
        class: "search", type: "search", placeholder: t("st.search"), value: stQuery.get(f.id) || "",
        oninput: (e) => { stQuery.set(f.id, e.target.value); fill(); },
      }),
      h("button", { class: "btn small", onclick: () => viewFile(f) }, t("btn.view"))),
    list);
  }));
}

function renderTxRows(f) {
  const q = (stQuery.get(f.id) || "").toLowerCase();
  const cur = f.statement.currency || settings.currency;
  const rows = f.statement.transactions.filter((tx) => !q
    || `${tx.date || ""} ${tx.description} ${fmtNum(tx.amount)} ${tx.amount}`.toLowerCase().includes(q));
  if (!rows.length) return [h("p", { class: "hint" }, t("nothing"))];
  return rows.map((tx) => {
    const use = txUse(tx);
    const key = `${f.id}|${tx.id}`;
    const actions = use
      ? [h("span", { class: `tx-used ${use.type}` }, t(use.type === "proof" ? "st.usedProof" : "st.usedExpense", { id: use.r.id })),
        h("button", { class: "btn small ghost", onclick: () => releaseTx(f, tx) }, t("st.release"))]
      : [h("button", { class: "btn small", onclick: () => addTxAsExpense(f, tx) }, t("st.addExpense"))];
    let picker = null;
    if (linkOpen === key && !use) {
      const cands = proofCandidates(tx);
      const others = receipts.filter((r) => !r.voided && !r.fromStatement)
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      picker = h("div", { class: "tx-picker" },
        h("div", { class: "meta" }, cands.length ? t("st.candidates") : t("st.noCandidates")),
        cands.map(({ r, same }) => h("button", { class: `btn small ${same ? "primary" : ""}`, onclick: () => linkProof(f, tx, r) },
          `${r.id} · ${r.date || "—"} · ${r.store_name || ""} · ${fmtMoney(receiptTotal(r), curOf(r))}${r.paymentProof ? " ↺" : ""}`)),
        others.length ? h("select", {
          class: "type-select", onchange: (e) => { const r = getReceipt(e.target.value); if (r) linkProof(f, tx, r); },
        }, h("option", { value: "" }, t("st.otherReceipt")),
        others.map((r) => h("option", { value: r.id }, `${r.id} · ${r.date || "—"} · ${r.store_name || ""} · ${fmtMoney(receiptTotal(r), curOf(r))}`))) : null);
    }
    return h("div", { class: `tx ${use ? "used" : ""} ${tx.amount < 0 ? "credit" : ""}` },
      h("div", { class: "tx-main" },
        h("span", { class: "tx-date" }, tx.date || "—"),
        h("span", { class: "tx-desc" }, tx.description, tx.ref ? h("span", { class: "meta" }, ` · ${tx.ref}`) : null),
        h("span", { class: "tx-amt" }, fmtMoney(tx.amount, cur))),
      h("div", { class: "actions" }, actions),
      picker);
  });
}

function viewFile(f) {
  if (!f?.blob) { toast(t("t.noOriginal")); return; }
  const url = URL.createObjectURL(f.blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function typeSelect(r, idx, it) {
  const names = settings.expTypes.map((x) => x.name);
  if (it.exp_type && !names.includes(it.exp_type)) names.push(it.exp_type); // renamed/removed type stays visible
  return h("select", {
    class: `type-select ${it.exp_type ? "" : "empty"}`, disabled: r.voided, "aria-label": t("type.aria"),
    onchange: (e) => setType(r, idx, e.target.value),
  }, h("option", { value: "" }, t("type.none")),
  names.map((n) => h("option", { value: n, selected: n === it.exp_type }, n)));
}

function renderReceipt(r, dupes) {
  const c = curOf(r);
  const a = allocation(r);
  const itemsSum = r.items.reduce((s, it) => s + (it.line_total || 0), 0);
  const expected = itemsSum + (r.tax || 0) + (r.tip || 0) - extraDiscount(r);
  const mismatch = r.total != null && Math.abs(expected - r.total) > 0.05 && Math.abs(itemsSum - r.total) > 0.05;

  const badges = [];
  if (r.voided) badges.push(h("span", { class: "badge bad" }, t("badge.void", { reason: r.voidReason })));
  else if (r.reviewed) badges.push(h("span", { class: "badge ok" }, t("badge.verified")));
  else badges.push(h("span", { class: "badge warn" }, t("badge.unverified")));
  const tagged = isTagged(r);
  if (tagged && a.pending) badges.push(h("span", { class: "badge warn" }, t("badge.untagged", { n: a.pending })));
  if (dupes.has(r.id)) badges.push(h("span", { class: "badge bad" }, t("badge.dupe", { ids: dupes.get(r.id).join(", ") })));
  if (r.payer === "other") badges.push(h("span", { class: "badge other" }, t("badge.payerOther")));
  if (r.declared) badges.push(h("span", { class: "badge warn" }, t("badge.declared")));
  if (r.fromStatement) badges.push(h("span", { class: "badge ok" }, t("badge.fromStatement")));
  if (r.paymentProof) badges.push(h("span", { class: "badge ok" }, t("badge.proof", { st: r.paymentProof.account, date: r.paymentProof.date || "" })));
  if (mismatch) badges.push(h("span", { class: "badge warn" }, t("badge.mismatch", { a: fmtNum(expected), b: fmtNum(r.total) })));

  const rows = a.items.map((it, idx) => [h("tr", { class: `${it.alloc === "not" ? "not-kids" : ""} ${isKidsLine(it) && !it.linked ? "has-type" : ""}` },
    h("td", { class: "tagcell" },
      it.linked ? h("span", { class: "tag linked", title: t("tag.linked") }, "↳") : h("button", {
        class: `tag ${it.alloc}`, disabled: r.voided,
        title: t("tag.suggested", { s: it.ai_suggestion ? t(`sug.${it.ai_suggestion}`) : "—" }),
        onclick: () => setAlloc(r, idx, NEXT_ALLOC[it.alloc]),
      }, it.alloc === "review" ? t("tag.button") : ALLOC_LABEL[it.alloc]),
      it.alloc === "split" && !it.linked && h("div", {},
        h("input", {
          class: "pct", type: "number", min: 0, max: 100, step: 1, value: it.split_pct, "aria-label": t("pct.aria"),
          onchange: (e) => setSplit(r, idx, e.target.value),
        }), "%")),
    h("td", { class: "desc" }, it.description,
      it.quantity != null && it.quantity !== 1 ? h("div", { class: "meta" }, `${fmtQty(it.quantity)} × ${fmtNum(it.unit_price)}`) : null,
      !it.linked && it.alloc === "review" && (it.ai_suggestion === "yes" || it.ai_suggestion === "no")
        ? h("div", { class: "suggest" }, t(it.ai_suggestion === "yes" ? "suggest.yes" : "suggest.no")
          + (it.ai_suggestion === "yes" && validType(it.ai_type) ? ` · ${it.ai_type}` : "")) : null),
    h("td", { class: "num" },
      h("button", { class: "amount-btn", disabled: r.voided, title: t("amount.title"), onclick: () => editAmount(r, idx) }, fmtNum(it.line_total))),
  ), isKidsLine(it) && !it.linked && h("tr", { class: "type-row" }, h("td", {}), h("td", { colspan: 2 }, typeSelect(r, idx, it)))]);

  const foot = [
    r.subtotal != null && [t("subtotal"), r.subtotal],
    extraDiscount(r) && [t("discount"), -extraDiscount(r)],
    r.tax != null && [t("tax"), r.tax],
    r.tip && [t("tip"), r.tip],
  ].filter(Boolean);

  return h("article", { class: `receipt ${r.voided ? "voided" : ""}` },
    h("header", {},
      h("div", {},
        h("span", { class: "rid" }, r.id),
        h("h3", {}, r.store_name || t("unknownStore")),
        h("div", { class: "meta" }, [r.date ? t("receiptDate", { d: r.date }) : t("noDate"), r.time, r.payment_method].filter(Boolean).join(" · ")),
        h("div", { class: "meta" }, `${r.source}${r.source_ref ? ` (${r.source_ref})` : ""} · ${t("added", { ts: fmtTs(r.addedAt) })} · #${r.sha256.slice(0, 8)}`))),
    h("div", { class: "badges" }, badges),
    tagged
      ? h("div", { class: "kids-line" }, t("forKids"), h("b", {}, fmtMoney(a.kids, c)), t("ofTotal", { t: fmtMoney(a.total, c) }))
      : h("div", { class: "kids-line" }, t("totalLabel"), h("b", {}, fmtMoney(a.total, c)), h("span", { class: "meta" }, t("notSeparated"))),
    r.note && h("div", { class: "meta" }, `📝 ${r.note}`),
    r.notes && h("details", { class: "reading-note" }, h("summary", {}, t("readingNoteToggle")), h("p", {}, r.notes)),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("tbody", {}, rows),
        h("tfoot", {},
          foot.map(([label, v]) => h("tr", {}, h("td", {}), h("td", {}, label), h("td", { class: "num" }, fmtNum(v)))),
          h("tr", { class: "grand" }, h("td", {}), h("td", {}, r.total == null ? t("totalCalc") : t("total")),
            h("td", { class: "num" }, fmtMoney(a.total, c)))))),
    h("div", { class: "actions" },
      h("button", { class: "btn small", onclick: () => viewOriginal(r) }, t("btn.view")),
      fileOf(r)?.kind === "image" && fileOf(r)?.role !== "statement" && h("button", { class: "btn small", onclick: () => saveStamped(r) }, t("btn.stamp")),
      !r.voided && h("button", { class: "btn small", onclick: () => editNote(r) }, t("btn.note")),
      !r.voided && h("button", {
        class: `btn small ${r.reviewed ? "" : "primary"}`, title: t("verify.title"),
        onclick: () => toggleReviewed(r),
      }, r.reviewed ? t("btn.unverify") : t("btn.verify"))),
    h("details", { class: "more" },
      h("summary", {}, t("more")),
      h("div", { class: "actions" },
        h("button", { class: "btn small", onclick: () => saveOriginal(r) }, t("btn.saveOrig")),
        !r.voided && h("button", { class: "btn small", onclick: () => togglePayer(r) }, t("btn.payer", { who: payerLabel(r) })),
        r.paymentProof && h("button", { class: "btn small", onclick: () => unlinkProof(r) }, t("btn.unlinkProof")),
        !r.voided && suggestableCount(r) > 0 && h("button", { class: "btn small", onclick: () => applySuggestions(r) }, t("btn.applyOne")),
        !r.voided && h("button", { class: "btn small", onclick: () => setAll(r, "kids") }, t("btn.allKids")),
        !r.voided && h("button", { class: "btn small", onclick: () => setAll(r, "not") }, t("btn.noneKids")),
        !r.voided && tagged && h("button", { class: "btn small", onclick: () => setAll(r, "review") }, t("btn.clearTags")),
        !r.voided && h("button", { class: "btn small", onclick: () => editReceipt(r) }, t("btn.fix")),
        h("button", { class: "btn small ghost danger", onclick: () => toggleVoid(r) }, r.voided ? t("btn.restore") : t("btn.void")))),
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
  $("#expTypes").value = store.get("expTypes") || t("types.default");
  $("#langSelect").value = store.get("lang") || "auto";
  $("#defaultCurrency").placeholder = regionCurrency();
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
  const typesText = $("#expTypes").value.trim();
  store.set("expTypes", typesText === t("types.default") ? "" : typesText);
  if (!$("#emailTo").value) $("#emailTo").value = settings.defaultEmail;
  const newLang = $("#langSelect").value;
  if (newLang !== (store.get("lang") || "auto")) {
    store.set("lang", newLang);
    location.reload();
    return;
  }
  toast(t("t.saved"));
  render();
});

$("#wipeBtn").addEventListener("click", async () => {
  if (!confirm(t("c.wipe"))) return;
  if ((prompt(t("p.wipe")) || "").trim().toUpperCase() !== t("wipe.word")) return;
  await Promise.all(["files", "receipts", "log", "meta"].map((s) => db.clear(s)));
  files = []; receipts = []; logEntries = []; seq = 0;
  thumbs.forEach((u) => URL.revokeObjectURL(u));
  thumbs.clear();
  $("#settingsDialog").close("cancel");
  toast(t("t.wiped"));
  render();
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

$("#statementInput").addEventListener("change", async (e) => {
  const list = [...e.target.files];
  e.target.value = "";
  await addFiles(list, { role: "statement" });
});

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
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

$("#processBtn").addEventListener("click", processAll);
$("#applyAllBtn").addEventListener("click", applyAllSuggestions);
$("#backupBtn").addEventListener("click", async () => {
  try { await shareOrDownload(await buildPack({ full: true }), t("backup.share")); render(); }
  catch (err) { console.error(err); toast(t("t.backupFail")); }
});
$("#restoreInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  $("#settingsDialog").close("cancel");
  try { await restorePack(f); } catch (err) { console.error(err); alert(t("a.restoreFailed", { msg: err.message })); }
});
document.querySelectorAll(".chip-filter").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; render(); }));
$("#search").addEventListener("input", (e) => { query = e.target.value.trim(); render(); });
$("#periodFrom").addEventListener("change", render);
$("#periodTo").addEventListener("change", render);

$("#emailSubject").addEventListener("input", (e) => { e.target.dataset.edited = "1"; });
$("#emailBtn").addEventListener("click", sendEmail);
$("#shareBtn").addEventListener("click", shareReport);
$("#packShareBtn").addEventListener("click", sharePack);
$("#pdfBtn").addEventListener("click", async () => {
  try { download(await buildPdf()); } catch (err) { console.error(err); toast(t("t.packFail")); }
});
$("#zipBtn").addEventListener("click", async () => {
  try { download(await buildPack()); render(); } catch (err) { console.error(err); toast(t("t.packFail")); }
});
$("#csvBtn").addEventListener("click", async () => {
  const blob = await buildXlsx();
  download(new File([blob], `${t("pk.file")}-${new Date().toISOString().slice(0, 10)}.xlsx`, { type: blob.type }));
});
$("#richCopyBtn").addEventListener("click", copyRichSummary);
$("#copyBtn").addEventListener("click", async () => {
  toast((await copyText(buildSummary({ attached: false }))) ? t("t.copied") : t("t.copyFail"));
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
  toast(t("t.noStorage"), 6000);
}
render();
