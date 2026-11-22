# Receipts (PWA)

A small installable web app that does three things:

1. **Collect** receipts from the camera, the photo gallery or PDF files (one file can hold several receipts). Pick *Paid by: Me / Other parent* before adding.
   **Excel** imports an expense list someone typed (.xlsx or .csv): only the cell values are sent to Claude. The grid is the source: **each expense row gives exactly one line** (marked with its sheet and row, e.g. `Sheet1 L12`), never merged or split; headers, totals and side calculations are skipped. Rows Claude returns twice or that don't exist in the grid are dropped. **Invoice pictures** pasted in the workbook (floating pictures or Excel 365 *Place in cell* pictures, PNG/JPEG/GIF/WebP/BMP) are kept and attached to a line when possible (a picture never creates a line): Claude sees only *where* each picture sits (e.g. `[picture P2 at E3]`), not its contents, and ties it to the row it is on, or to the row its caption matches when invoices are on a separate sheet. **Identifier above the picture:** when a cell just above a picture (up to 3 rows, in the picture's columns) holds an identifier such as `F-12`, every line that has that identifier in a cell (alone or in a list like `F-3, F-1`) gets that picture, on any sheet; `F-012`, `f 12` and `F12` count as the same. Identifiers made only of digits only count in the column where identifiers match most lines, so they are not confused with amounts. A picture on the same row as an entry is always linked (a floating picture counts for the row its top edge is really on, and one starting on a blank or caption row goes to the first expense row it covers). The same image stored twice in the workbook is one invoice. **Lines still without an invoice** after that: the workbook's pictures are read once (date, store, total, items) and Claude matches those lines to them by store, amount and date; one invoice may back several lines. **Missing dates:** when an Excel line has no date but has an invoice picture, only those pictures are sent to Claude (in a small separate request) to read the printed date, which then fills the line, marked *invoice date*. Linking a picture by hand to a dateless line does the same; unlinking it removes that date again. A date typed in *Edit* always wins. Linked invoices show as thumbnails under the line (tap to open); **Invoices (n/total)** opens every picture of the workbook so you can link or unlink them, and a warning lists pictures linked to no line. The exported spreadsheet gets *Source* (file · line) and *Invoice (SHA-256)* columns: the SHA-256 identifies the invoice, so lines sharing one show the same value. Old .xls/.numbers/.ods files must be saved as .xlsx or .csv first.
2. **Extract only what's needed to split them.** Claude reads each file with your own Anthropic API key and returns just the store, date, currency, each line (name + amount), tax and total. Each line comes back pre-tagged: clearly for a child → **Kids**, clearly for an adult → **Not kids**, shared household items → **?** for you to decide. Tap a tag to cycle *Kids → Split % → Not kids → ?*. Under each kids' line, tap **Base / Particulière** (FR) / **Base / Special** (EN) to choose how it is shared: *Base* is always 50/50, *Particulière* uses my share for the purchase year (Settings → one ratio per year; a year without one uses the previous year's). New lines start as *Base*. Tap an amount to fix it.
3. **Split.** For any date range: kids' expenses paid by you and by the other parent, each parent's share (Base 50 %, Particulière by year) and who owes whom. Tax is shared out in proportion to the line amounts; a discount line follows the item above it. *Download spreadsheet* gives an .xlsx with the split and every kids' line, including each line's invoice SHA-256 fingerprint. *Report + invoices (.zip)* is a separate download (not a backup) for the chosen period: the same .xlsx, the invoices of the kids' lines in `invoices/` (`factures/` in French) — the Excel invoice pictures, or the photo/PDF a receipt was read from — each stored once and named by its SHA-256 (e.g. `3f2a…c9.png`), the same value as in the spreadsheet, and `checksums.sha256` (`empreintes.sha256`), which `sha256sum -c` or `shasum -a 256 -c` checks.

No server, no build step. Everything stays in the browser; the key is stored only in that browser's local storage and sent only to `api.anthropic.com`. Originals are kept on the device (with a SHA-256 fingerprint, so the same file can't be added twice) and can be reopened with *View*. Use Settings → *Back up everything* regularly, because the data lives only in this browser; *Restore* also reads backups made by earlier versions.

The app is in English or French, following the phone's language (override it in Settings).

## Run it

It must be served over HTTPS (or `localhost`) for the camera, install prompt and service worker to work.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

On your phone: enable GitHub Pages for this repo (Settings → Pages → deploy from branch, root folder), open the URL, then *Add to Home Screen* (iPhone) or *Install app* (Android). Open ⚙ Settings and paste your API key (create one at console.anthropic.com; setting a monthly spend limit on it is a good idea).

## Notes

- **Model**: defaults to Claude Opus 5.5 (most accurate on faded/crumpled receipts). Sonnet 5.5 and Haiku 5.5 are cheaper options in Settings. Opus/Sonnet requests opt into server-side refusal fallbacks.
- **Images** are auto-rotated and downscaled to 2400px JPEG before upload to keep requests fast. PDFs are sent as-is (max 25 MB).
- **Up to 3 files** are processed in parallel; failed ones can be retried with the same button.
- **Security**: this calls the API directly from the browser (`dangerouslyAllowBrowser`). That's fine for a personal app with your own key, but don't host it publicly with a key baked in.
- After changing any app file, bump `CACHE` in `sw.js` so installed copies pick up the update.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | UI |
| `i18n.js` | English/French text and language detection |
| `app.js` | File intake, image prep, Claude calls (structured JSON output), tagging, split, export, backup |
| `db.js`, `zip.js`, `xlsx.js` | IndexedDB storage, .zip writer/reader, .xlsx writer and .xlsx/.csv reader |
| `vendor/anthropic-sdk.js` | Bundled official `@anthropic-ai/sdk` 1.10.0 (ESM, browser) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install + offline shell |
