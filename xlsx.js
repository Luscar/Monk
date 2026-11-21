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
// Reading spreadsheets (data only: pictures in a workbook are ignored)
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
