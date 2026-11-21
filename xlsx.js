// Minimal .xlsx writer: real Excel files (no CSV separator/decimal problems), bold frozen header,
// numbers stored as numbers. Built on the ZIP writer.
import { makeZip, readZip } from "./zip.js";

const esc = (s) => String(s)
  // Strip characters XML 1.0 doesn't allow.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * @param {{name: string, rows: any[][], money?: number[], widths?: number[]}} sheet
 * rows[0] is the header. `money` lists column indexes shown with 2 decimals.
 */
function sheetXml({ rows, money = [], widths = [] }) {
  const moneySet = new Set(money);
  const cols = (rows[0] || []).map((_, i) => {
    const w = widths[i] ?? Math.min(48, Math.max(8, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length + 2)));
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join("");
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v == null || v === "") return "";
      const ref = `${colName(c)}${r + 1}`;
      if (r === 0) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(v)}</t></is></c>`;
      if (typeof v === "number" && Number.isFinite(v)) {
        return `<c r="${ref}"${moneySet.has(c) ? ' s="2"' : ""}><v>${v}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** @param {{name: string, rows: any[][], money?: number[]}[]} sheets */
export async function makeXlsx(sheets) {
  const safe = (n, i) => (n.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`);
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(safe(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  const zip = await makeZip(files);
  return new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ---------------------------------------------------------------------------
// Reading spreadsheets (to import a grid of expenses someone else kept)
// ---------------------------------------------------------------------------
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const all = (node, tag) => (node ? [...node.getElementsByTagNameNS("*", tag)] : []);
const textOf = (node) => all(node, "t").map((x) => x.textContent).join("");

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function isDateFormat(id, custom) {
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
  const code = custom.get(id);
  if (!code) return false;
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return /[dy]/i.test(bare) || /m{3,}/i.test(bare);
}

const serialToIso = (v) => new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)).toISOString().slice(0, 10);

/** Returns [{name, rows: any[][]}] for every sheet of an .xlsx file. Dates come back as YYYY-MM-DD. */
export async function readXlsx(blob) {
  const zip = await readZip(blob);
  const xml = async (name) => {
    const s = await zip.text(name);
    return s ? new DOMParser().parseFromString(s, "application/xml") : null;
  };
  const wb = await xml("xl/workbook.xml");
  if (!wb) throw new Error("Not an Excel workbook.");
  const rels = await xml("xl/_rels/workbook.xml.rels");
  const target = new Map(all(rels, "Relationship").map((r) => [r.getAttribute("Id"), r.getAttribute("Target")]));
  const shared = all(await xml("xl/sharedStrings.xml"), "si").map(textOf);
  const styles = await xml("xl/styles.xml");
  const custom = new Map(all(styles, "numFmt").map((n) => [Number(n.getAttribute("numFmtId")), n.getAttribute("formatCode")]));
  const xfs = all(all(styles, "cellXfs")[0], "xf").map((x) => Number(x.getAttribute("numFmtId") || 0));

  const out = [];
  for (const sh of all(wb, "sheet")) {
    let path = target.get(sh.getAttributeNS(REL_NS, "id") || sh.getAttribute("r:id")) || "";
    path = path.startsWith("/") ? path.slice(1) : `xl/${path}`;
    const doc = await xml(path);
    if (!doc) continue;
    const rows = [];
    for (const row of all(doc, "row")) {
      const r = Number(row.getAttribute("r")) - 1;
      const cells = [];
      for (const c of all(row, "c")) {
        const i = colIndex(c.getAttribute("r") || "A");
        const tp = c.getAttribute("t");
        const v = all(c, "v")[0]?.textContent;
        let val = null;
        if (tp === "s") val = shared[Number(v)] ?? "";
        else if (tp === "inlineStr") val = textOf(all(c, "is")[0]);
        else if (tp === "str" || tp === "e") val = v ?? "";
        else if (tp === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (v != null) {
          const n = Number(v);
          val = isDateFormat(xfs[Number(c.getAttribute("s") || 0)] ?? 0, custom) ? serialToIso(n) : n;
        }
        cells[i] = val;
      }
      rows[r >= 0 ? r : rows.length] = cells;
    }
    out.push({ name: sh.getAttribute("name") || "Sheet", rows: rows.map((r) => r || []) });
  }
  return out;
}

/** CSV with automatic separator detection (comma, semicolon or tab). */
export function readCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = [";", "\t", ","].map((s) => [s, firstLine.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return [{ name: "CSV", rows }];
}

/** Turns sheets into compact text for Claude: one line per row, with sheet name and row number. */
export function sheetsToText(sheets, maxRows = 1500) {
  const lines = [];
  for (const s of sheets) {
    const rows = s.rows.map((r, i) => [i + 1, r]).filter(([, r]) => r.some((v) => v != null && String(v).trim() !== ""));
    if (!rows.length) continue;
    lines.push(`### Sheet: ${s.name}`);
    for (const [n, r] of rows.slice(0, maxRows)) {
      lines.push(`L${n}: ${Array.from(r, (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim())).join(" | ")}`);
    }
    if (rows.length > maxRows) lines.push(`… ${rows.length - maxRows} more rows not shown`);
  }
  return lines.join("\n");
}

/** Resolves a relationship target ("../media/image1.jpeg") against the part that holds it. */
function resolvePart(from, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
const relsPath = (part) => part.replace(/([^/]+)$/, "_rels/$1.rels");
const MEDIA_TYPES = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic" };

/**
 * Pictures placed on the sheets of an .xlsx (e.g. a tab of receipt photos), with the text of the
 * text boxes laid over each one (people often number their receipts that way: "14", "2@7").
 * Returns [{sheet, pictures: [{name, type, blob, labels: string[]}]}] in reading order, one entry per
 * sheet that has pictures. Charts, icons and non-raster images are skipped.
 */
export async function readXlsxPictures(blob) {
  const zip = await readZip(blob);
  const xml = async (name) => {
    const s = await zip.text(name);
    return s ? new DOMParser().parseFromString(s, "application/xml") : null;
  };
  const relMap = async (part) => new Map(all(await xml(relsPath(part)), "Relationship")
    .map((r) => [r.getAttribute("Id"), resolvePart(part, r.getAttribute("Target") || "")]));
  const wb = await xml("xl/workbook.xml");
  if (!wb) return [];
  const wbRels = await relMap("xl/workbook.xml");
  const out = [];
  for (const sh of all(wb, "sheet")) {
    const sheetPart = wbRels.get(sh.getAttributeNS(REL_NS, "id") || sh.getAttribute("r:id"));
    if (!sheetPart) continue;
    const sheetRels = await relMap(sheetPart);
    const pics = [];
    const labels = [];
    for (const drawingPart of [...sheetRels.values()].filter((p) => /drawings\/[^/]+\.xml$/.test(p))) {
      const doc = await xml(drawingPart);
      if (!doc) continue;
      const media = await relMap(drawingPart);
      const cell = (anchor, tag) => {
        const n = all(anchor, tag)[0];
        if (!n) return null;
        const num = (k) => Number(all(n, k)[0]?.textContent || 0);
        return { col: num("col"), row: num("row") };
      };
      for (const anchor of [...all(doc, "twoCellAnchor"), ...all(doc, "oneCellAnchor")]) {
        const from = cell(anchor, "from");
        if (!from) continue;
        const to = cell(anchor, "to") || { col: from.col + 4, row: from.row + 20 };
        const box = { c0: from.col, r0: from.row, c1: Math.max(to.col, from.col), r1: Math.max(to.row, from.row) };
        for (const pic of all(anchor, "pic")) {
          const blip = all(pic, "blip")[0];
          const path = media.get(blip?.getAttributeNS(REL_NS, "embed") || blip?.getAttribute("r:embed"));
          const ext = (path?.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
          if (!path || !MEDIA_TYPES[ext]) continue;
          const descr = all(pic, "cNvPr")[0]?.getAttribute("descr") || "";
          pics.push({ ...box, path, type: MEDIA_TYPES[ext], descr, labels: [] });
        }
        for (const sp of all(anchor, "sp")) {
          const text = all(sp, "t").map((x) => x.textContent).join("").trim();
          if (text) labels.push({ col: from.col, row: from.row, text });
        }
      }
    }
    if (!pics.length) continue;
    // A label belongs to the smallest picture it sits on, otherwise to the nearest one.
    for (const l of labels) {
      const on = pics.filter((p) => l.col >= p.c0 && l.col <= p.c1 && l.row >= p.r0 && l.row <= p.r1)
        .sort((a, b) => (a.c1 - a.c0) * (a.r1 - a.r0) - (b.c1 - b.c0) * (b.r1 - b.r0));
      const dist = (p) => Math.hypot(Math.max(p.c0 - l.col, 0, l.col - p.c1), Math.max(p.r0 - l.row, 0, l.row - p.r1) / 4);
      const near = on[0] || pics.slice().sort((a, b) => dist(a) - dist(b)).find((p) => dist(p) <= 3);
      near?.labels.push(l.text);
    }
    const seen = new Set();
    const pictures = [];
    for (const p of pics.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)) {
      if (seen.has(p.path)) continue; // the same image placed twice
      seen.add(p.path);
      const data = await zip.blob(p.path, p.type);
      if (!data?.size) continue;
      pictures.push({ name: p.descr || p.path.split("/").pop(), type: p.type, blob: data, labels: p.labels });
    }
    out.push({ sheet: sh.getAttribute("name") || "Sheet", pictures });
  }
  return out;
}

/**
 * Invoice numbers in a reference such as "14", "27-76-77", "2@7" (2 to 7), "8 à 11", "n/a".
 * Returns a Set of numbers as strings (empty when there is none).
 */
export function refNumbers(ref) {
  const out = new Set();
  const s = String(ref ?? "");
  const re = /(\d+)\s*(?:@|à|\.\.|\bto\b|\bau\b)\s*(\d+)|\d+/gi;
  for (let m; (m = re.exec(s));) {
    if (m[2]) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b >= a && b - a <= 60) for (let i = a; i <= b; i++) out.add(String(i));
      else { out.add(String(a)); out.add(String(b)); }
    } else out.add(String(Number(m[0])));
  }
  return out;
}
