import Anthropic from "./vendor/anthropic-sdk.js";

// ---------------------------------------------------------------------------
// Settings
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
              required: ["description", "quantity", "unit_price", "line_total", "category"],
              properties: {
                description: { type: "string" },
                quantity: nullable("number"),
                unit_price: nullable("number"),
                line_total: { type: "number" },
                category: { ...nullable("string"), description: "e.g. Groceries, Fuel, Dining, Office" },
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

const SYSTEM_PROMPT = `You extract structured data from photos and PDFs of purchase receipts and invoices.

Rules:
- One file can contain several receipts (several photos stitched, multiple pages, or multiple paper receipts in one shot). Return each one as its own entry, in the order they appear.
- Transcribe every purchased line item. Keep the item description close to the printed text, but expand obvious abbreviations when you are confident.
- Use numbers only for amounts (no currency symbols). Discount lines inside the item list may be negative line totals.
- Dates must be YYYY-MM-DD. Resolve ambiguous day/month order using the store's country or currency when possible, and mention any ambiguity in notes.
- Use null for any field that is not printed or not legible. Never invent values.
- If the printed total does not match the sum of items plus tax, keep the printed values and explain in notes.
- If the file contains no receipt at all, return an empty receipts array.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** @type {{id:string,name:string,kind:'image'|'pdf',file?:File,thumb?:string,status:string,error?:string,receipts:any[]}[]} */
let items = loadSavedItems();

function loadSavedItems() {
  try {
    const saved = JSON.parse(store.get("items", "[]"));
    return Array.isArray(saved) ? saved.filter((i) => i.status === "done") : [];
  } catch { return []; }
}

function persist() {
  const done = items
    .filter((i) => i.status === "done")
    .map(({ id, name, kind, status, receipts }) => ({ id, name, kind, status, receipts }));
  store.set("items", JSON.stringify(done));
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

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------
function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  for (const file of files) {
    const kind = isPdf(file) ? "pdf" : file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name) ? "image" : null;
    if (!kind) { toast(`Skipped unsupported file: ${file.name}`); continue; }
    if (kind === "pdf" && file.size > MAX_PDF_BYTES) { toast(`${file.name} is over 25 MB — split it first.`, 4000); continue; }
    items.push({
      id: uid(),
      name: file.name || (kind === "pdf" ? "document.pdf" : "photo.jpg"),
      kind,
      file,
      thumb: kind === "image" ? URL.createObjectURL(file) : undefined,
      status: "pending",
      receipts: [],
    });
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

/** Downscale + normalise orientation, re-encode as JPEG. Returns {data, media_type}. */
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Browser can't decode (e.g. HEIC outside Safari). Send as-is if the API accepts the type.
    const ok = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (ok.includes(file.type)) return { data: await readAsBase64(file), media_type: file.type };
    throw new Error("This browser can't read that image format. Try exporting it as JPEG.");
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h2 = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h2);
  ctx.drawImage(bitmap, 0, 0, w, h2);
  bitmap.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  return { data: await readAsBase64(blob), media_type: "image/jpeg" };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
function makeClient() {
  return new Anthropic({
    apiKey: settings.apiKey,
    // This is a personal, client-only app: the user supplies their own key.
    dangerouslyAllowBrowser: true,
    maxRetries: 3,
  });
}

async function extract(client, item) {
  let source;
  if (item.kind === "pdf") {
    source = {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: await readAsBase64(item.file) },
    };
  } else {
    const img = await prepareImage(item.file);
    source = { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } };
  }

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
            text: `Extract every receipt in this ${item.kind === "pdf" ? "PDF" : "image"} (file name: "${item.name}"). If no currency is shown, assume ${settings.currency}.`,
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

  const stream = client.beta.messages.stream(params);
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined this file${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Output was cut off — try splitting this file into smaller parts.");
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Couldn't read Claude's response. Try again."); }
  return (parsed.receipts || []).map((r) => ({ ...r, id: uid(), source: item.name }));
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

let processing = false;
async function processAll() {
  if (!settings.apiKey) { openSettings(); return; }
  const todo = items.filter((i) => (i.status === "pending" || i.status === "error") && i.file);
  if (!todo.length) return;
  processing = true;
  const client = makeClient();
  todo.forEach((i) => { i.status = "queued"; i.error = undefined; });
  render();

  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      item.status = "working";
      render();
      try {
        item.receipts = await extract(client, item);
        item.status = "done";
      } catch (err) {
        console.error(err);
        item.status = "error";
        item.error = describeError(err);
      }
      persist();
      render();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  processing = false;
  render();
  const failed = todo.filter((i) => i.status === "error").length;
  toast(failed ? `${failed} file(s) failed — tap Extract to retry.` : "All receipts extracted.");
}

// ---------------------------------------------------------------------------
// Aggregation & output
// ---------------------------------------------------------------------------
function allReceipts() {
  return items.flatMap((i) => i.receipts || []);
}

function receiptTotal(r) {
  if (r.total != null) return r.total;
  const itemsSum = (r.items || []).reduce((s, it) => s + (it.line_total || 0), 0);
  return itemsSum + (r.tax || 0) + (r.tip || 0) - (r.discount || 0);
}

function summarize(receipts) {
  const byCurrency = {};
  const byStore = {};
  const byCategory = {};
  let itemCount = 0;
  const dates = [];
  for (const r of receipts) {
    const cur = r.currency || settings.currency;
    const total = receiptTotal(r);
    byCurrency[cur] ??= { total: 0, tax: 0, count: 0 };
    byCurrency[cur].total += total;
    byCurrency[cur].tax += r.tax || 0;
    byCurrency[cur].count += 1;
    const sk = `${r.store_name || "Unknown"}|${cur}`;
    byStore[sk] ??= { store: r.store_name || "Unknown", currency: cur, total: 0, count: 0 };
    byStore[sk].total += total;
    byStore[sk].count += 1;
    for (const it of r.items || []) {
      itemCount += 1;
      const ck = `${it.category || "Other"}|${cur}`;
      byCategory[ck] ??= { category: it.category || "Other", currency: cur, total: 0 };
      byCategory[ck].total += it.line_total || 0;
    }
    if (r.date) dates.push(r.date);
  }
  dates.sort();
  return {
    count: receipts.length,
    itemCount,
    byCurrency,
    byStore: Object.values(byStore).sort((a, b) => b.total - a.total),
    byCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
    from: dates[0],
    to: dates[dates.length - 1],
  };
}

function sortedReceipts() {
  return allReceipts().slice().sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
}

function buildEmailText() {
  const receipts = sortedReceipts();
  const s = summarize(receipts);
  const L = [];
  const today = new Date().toISOString().slice(0, 10);
  L.push("RECEIPT SUMMARY");
  L.push(`Generated ${today} · ${s.count} receipt(s) · ${s.itemCount} item(s)`);
  if (s.from) L.push(`Dates: ${s.from}${s.to && s.to !== s.from ? ` to ${s.to}` : ""}`);
  L.push("");
  L.push("GRAND TOTAL");
  for (const [cur, v] of Object.entries(s.byCurrency)) {
    L.push(`  ${fmtMoney(v.total, cur)}  (tax ${fmtMoney(v.tax, cur)}, ${v.count} receipt(s))`);
  }
  L.push("");
  L.push("BY STORE");
  for (const st of s.byStore) L.push(`  ${st.store}: ${fmtMoney(st.total, st.currency)} (${st.count})`);
  if (s.byCategory.length > 1) {
    L.push("");
    L.push("BY CATEGORY (items, before tax)");
    for (const c of s.byCategory) L.push(`  ${c.category}: ${fmtMoney(c.total, c.currency)}`);
  }
  L.push("");
  L.push("RECEIPTS");
  receipts.forEach((r, i) => {
    const cur = r.currency || settings.currency;
    L.push("");
    L.push(`#${i + 1}  ${r.store_name || "Unknown store"} — ${r.date || "no date"}${r.time ? ` ${r.time}` : ""}`);
    if (r.store_address) L.push(`    ${r.store_address}`);
    const meta = [r.receipt_number && `Receipt ${r.receipt_number}`, r.payment_method && `Paid: ${r.payment_method}`].filter(Boolean);
    if (meta.length) L.push(`    ${meta.join(" · ")}`);
    for (const it of r.items || []) {
      const qty = it.quantity != null && it.quantity !== 1 ? `${fmtQty(it.quantity)} x ` : "";
      const unit = it.unit_price != null && it.quantity != null && it.quantity !== 1 ? ` @ ${fmtNum(it.unit_price)}` : "";
      L.push(`  - ${qty}${it.description}${unit} = ${fmtNum(it.line_total)}`);
    }
    if (r.subtotal != null) L.push(`    Subtotal: ${fmtMoney(r.subtotal, cur)}`);
    if (r.discount) L.push(`    Discount: -${fmtMoney(r.discount, cur)}`);
    if (r.tax != null) L.push(`    Tax: ${fmtMoney(r.tax, cur)}`);
    if (r.tip) L.push(`    Tip: ${fmtMoney(r.tip, cur)}`);
    L.push(`    TOTAL: ${fmtMoney(receiptTotal(r), cur)}${r.total == null ? " (calculated)" : ""}`);
    if (r.notes) L.push(`    Note: ${r.notes}`);
    L.push(`    Source: ${r.source}`);
  });
  return L.join("\n");
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  const header = [
    "Receipt #", "Date", "Time", "Store", "Address", "Item", "Category", "Qty", "Unit Price",
    "Line Total", "Receipt Subtotal", "Receipt Discount", "Receipt Tax", "Receipt Tip",
    "Receipt Total", "Currency", "Payment", "Receipt No.", "Source", "Notes",
  ];
  const rows = [header];
  sortedReceipts().forEach((r, i) => {
    const base = (it) => [
      i + 1, r.date, r.time, r.store_name, r.store_address,
      it?.description ?? "", it?.category ?? "", it?.quantity ?? "", it?.unit_price ?? "", it?.line_total ?? "",
      r.subtotal, r.discount, r.tax, r.tip, receiptTotal(r), r.currency || settings.currency,
      r.payment_method, r.receipt_number, r.source, r.notes,
    ];
    if (!r.items?.length) rows.push(base(null));
    else r.items.forEach((it) => rows.push(base(it)));
  });
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function defaultSubject() {
  const s = summarize(allReceipts());
  const totals = Object.entries(s.byCurrency).map(([c, v]) => fmtMoney(v.total, c)).join(" + ");
  const range = s.from ? ` (${s.from}${s.to && s.to !== s.from ? ` – ${s.to}` : ""})` : "";
  return `Receipts summary: ${s.count} receipt(s), ${totals}${range}`;
}

function csvFile() {
  const name = `receipts-${new Date().toISOString().slice(0, 10)}.csv`;
  return new File([buildCsv()], name, { type: "text/csv" });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function sendEmail() {
  const to = $("#emailTo").value.trim();
  const subject = $("#emailSubject").value.trim() || defaultSubject();
  const body = buildEmailText();
  if (to) store.set("lastEmail", to);
  let url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  // Very long mailto links get truncated by some mail apps: copy the full text as a fallback.
  if (url.length > 30000) {
    const copied = await copyText(body);
    const note = copied
      ? "The full summary was copied to your clipboard — paste it here.\n\n"
      : "The summary was too long for a mail link — use Share or Copy instead.\n\n";
    url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(note + body.slice(0, 20000))}`;
    toast(copied ? "Long summary copied — paste into the email body." : "Summary too long for a mail link.", 4500);
  }
  window.location.href = url;
}

async function share() {
  const subject = $("#emailSubject").value.trim() || defaultSubject();
  const text = buildEmailText();
  const file = csvFile();
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: subject, text, files: [file] });
    } else if (navigator.share) {
      await navigator.share({ title: subject, text });
    } else {
      toast("Sharing isn't supported here — use Open in Mail or Download CSV.");
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("Share failed.");
  }
}

function downloadCsv() {
  const file = csvFile();
  const a = h("a", { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const STATUS_LABEL = {
  pending: "Ready",
  queued: "Queued…",
  working: "Reading with Claude…",
  done: "Done",
  error: "Failed",
};

function render() {
  $("#setupNotice").hidden = !!settings.apiKey;

  // Queue
  const q = $("#queue");
  q.replaceChildren(
    ...items.map((item) => {
      const statusText = item.status === "done"
        ? `${item.receipts.length} receipt(s) found`
        : item.status === "error" ? item.error : STATUS_LABEL[item.status];
      return h("li", {},
        item.thumb
          ? h("img", { class: "thumb", src: item.thumb, alt: "" })
          : h("div", { class: "thumb", "aria-hidden": "true" }, item.kind === "pdf" ? "📄" : "🧾"),
        h("div", {},
          h("div", { class: "qname" }, item.name),
          h("div", { class: `qstatus ${item.status}` }, statusText)),
        h("button", {
          class: "btn small ghost",
          "aria-label": `Remove ${item.name}`,
          disabled: item.status === "working" || item.status === "queued",
          onclick: () => removeItem(item.id),
        }, "✕"),
      );
    }),
  );

  const pending = items.filter((i) => (i.status === "pending" || i.status === "error") && i.file).length;
  const pb = $("#processBtn");
  pb.disabled = processing || pending === 0;
  pb.textContent = processing ? "Working…" : pending ? `Extract ${pending} file(s) with Claude` : "Extract with Claude";
  $("#clearBtn").disabled = processing || items.length === 0;

  // Results
  const receipts = sortedReceipts();
  $("#resultsCard").hidden = receipts.length === 0;
  $("#sendCard").hidden = receipts.length === 0;
  if (!receipts.length) return;

  const s = summarize(receipts);
  const stats = [
    ["Receipts", s.count],
    ["Items", s.itemCount],
    ...Object.entries(s.byCurrency).map(([c, v]) => [`Total ${c}`, fmtMoney(v.total, c)]),
    ...Object.entries(s.byCurrency).map(([c, v]) => [`Tax ${c}`, fmtMoney(v.tax, c)]),
  ];
  if (s.from) stats.push(["Dates", s.from === s.to ? s.from : `${s.from} → ${s.to}`]);
  $("#totals").replaceChildren(
    ...stats.map(([label, value]) => h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value))),
  );

  $("#receipts").replaceChildren(...receipts.map(renderReceipt));

  if (!$("#emailSubject").dataset.edited) $("#emailSubject").value = defaultSubject();
  $("#emailPreview").textContent = buildEmailText();
}

function renderReceipt(r) {
  const cur = r.currency || settings.currency;
  const itemsSum = (r.items || []).reduce((sum, it) => sum + (it.line_total || 0), 0);
  const expected = itemsSum + (r.tax || 0) + (r.tip || 0) - (r.discount || 0);
  const mismatch = r.total != null && Math.abs(expected - r.total) > 0.05 && Math.abs(itemsSum - r.total) > 0.05;
  const foot = [
    r.subtotal != null && ["Subtotal", r.subtotal],
    r.discount && ["Discount", -r.discount],
    r.tax != null && ["Tax", r.tax],
    r.tip && ["Tip", r.tip],
  ].filter(Boolean);

  return h("article", { class: "receipt" },
    h("header", {},
      h("div", {},
        h("h3", {}, r.store_name || "Unknown store"),
        h("div", { class: "meta" },
          [r.date || "No date", r.time, r.payment_method].filter(Boolean).join(" · ")),
        r.store_address && h("div", { class: "meta" }, r.store_address),
        h("div", { class: "meta" }, `From ${r.source}`)),
      h("button", { class: "btn small ghost", "aria-label": "Remove receipt", onclick: () => removeReceipt(r.id) }, "Remove")),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "Item"), h("th", { class: "num" }, "Qty"),
          h("th", { class: "num" }, "Unit"), h("th", { class: "num" }, "Total"))),
        h("tbody", {}, (r.items || []).map((it) => h("tr", {},
          h("td", {}, it.description),
          h("td", { class: "num" }, fmtQty(it.quantity)),
          h("td", { class: "num" }, fmtNum(it.unit_price)),
          h("td", { class: "num" }, fmtNum(it.line_total))))),
        h("tfoot", {},
          foot.map(([label, v]) => h("tr", {}, h("td", { colspan: 3 }, label), h("td", { class: "num" }, fmtNum(v)))),
          h("tr", { class: "grand" },
            h("td", { colspan: 3 }, r.total == null ? "Total (calculated)" : "Total"),
            h("td", { class: "num" }, fmtMoney(receiptTotal(r), cur)))))),
    mismatch && h("div", { class: "warn" }, `⚠ Items + tax add up to ${fmtNum(expected)}, printed total is ${fmtNum(r.total)}.`),
    r.notes && h("div", { class: "warn" }, `Note: ${r.notes}`),
  );
}

function removeItem(id) {
  const item = items.find((i) => i.id === id);
  if (item?.thumb) URL.revokeObjectURL(item.thumb);
  items = items.filter((i) => i.id !== id);
  persist();
  render();
}

function removeReceipt(id) {
  for (const item of items) item.receipts = (item.receipts || []).filter((r) => r.id !== id);
  persist();
  render();
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
function openSettings() {
  $("#apiKey").value = settings.apiKey;
  $("#model").value = settings.model;
  $("#defaultEmail").value = settings.defaultEmail;
  $("#defaultCurrency").value = store.get("defaultCurrency");
  $("#settingsDialog").showModal();
}

$("#settingsDialog").addEventListener("close", () => {
  if ($("#settingsDialog").returnValue !== "save") return;
  store.set("apiKey", $("#apiKey").value.trim());
  store.set("model", $("#model").value);
  store.set("defaultEmail", $("#defaultEmail").value.trim());
  store.set("defaultCurrency", $("#defaultCurrency").value.trim().toUpperCase());
  if (!$("#emailTo").value) $("#emailTo").value = settings.defaultEmail;
  toast("Settings saved.");
  render();
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$("#settingsBtn").addEventListener("click", openSettings);
document.querySelectorAll("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));

for (const id of ["#cameraInput", "#galleryInput", "#pdfInput"]) {
  $(id).addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
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
$("#clearBtn").addEventListener("click", () => {
  if (!confirm("Remove all files and extracted receipts?")) return;
  items.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb));
  items = [];
  $("#emailSubject").dataset.edited = "";
  persist();
  render();
});

$("#emailSubject").addEventListener("input", (e) => { e.target.dataset.edited = "1"; });
$("#emailBtn").addEventListener("click", sendEmail);
$("#shareBtn").addEventListener("click", share);
$("#csvBtn").addEventListener("click", downloadCsv);
$("#copyBtn").addEventListener("click", async () => {
  toast((await copyText(buildEmailText())) ? "Summary copied." : "Copy failed.");
});

$("#emailTo").value = store.get("lastEmail") || settings.defaultEmail;

// Files shared to the app via the Web Share Target (Android installs).
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    addFiles(await Promise.all(params.files.map((f) => f.getFile())));
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
}

render();
