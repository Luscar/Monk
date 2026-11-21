# Receipt Mailer (PWA)

A small installable web app that:

1. Takes receipts from **several sources at once** — the camera, the photo gallery, and PDF files (one file can hold several receipts).
2. Sends each file to **Claude** with your own Anthropic API key and gets back structured data: store, address, date/time, payment method, receipt number, every line item (qty, unit price, line total, category), subtotal, discount, tax, tip and total.
3. Shows a review screen with grand totals (per currency), tax, date range, totals by store and category, and flags receipts whose items don't add up to the printed total.
4. **Emails the summary**: "Open in Mail" pre-fills your mail app (to, subject, full itemized body); "Share + CSV" opens the phone's share sheet with the summary text plus a CSV attachment (one row per item); you can also copy the text or download the CSV.

No server, no build step. Everything runs in the browser; the key is stored only in that browser's local storage and sent only to `api.anthropic.com`.

## Run it

It must be served over HTTPS (or `localhost`) for the camera, install prompt and service worker to work.

**Locally:**

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

**On your phone (free hosting):** enable GitHub Pages for this repo (Settings → Pages → deploy from branch, root folder), or drop the folder onto Netlify/Cloudflare Pages. Open the URL on your phone, then:

- iPhone (Safari): Share → *Add to Home Screen*
- Android (Chrome): menu → *Install app*

Open ⚙ Settings, paste your API key (create one at console.anthropic.com — setting a monthly spend limit on it is a good idea), pick a model and your default recipient.

## Child-expense tracking & traceability

Built for documenting money spent on children (e.g. in a separation or divorce):

- **Permanent receipt IDs** (`R-2026-0001`, …) that are never reused. Refer to them in emails and spreadsheets.
- **Originals kept unmodified** on the device with a **SHA-256 fingerprint** and the time each file was added. Adding the same file twice is blocked.
- **Collect first, separate later.** By default receipts come in untagged and the app simply totals your spending (by month and store). Claude's kids/not-kids guess is saved on every line. When you're ready, one tap ("✨ Tag N items using Claude's suggestions", or per receipt) applies it, and lines Claude was unsure about (e.g. groceries) stay untagged for you to decide. To tag automatically from the start, turn it on in Settings.
- **Item-level tags**: each line is *Kids*, *Split n%*, *Not kids* or untagged. You can describe the children in Settings to improve Claude's suggestions.
- **Verified** marks a receipt whose amounts you've checked against the paper. It's independent of tagging. Tax and receipt discounts are shared out in proportion to the item amounts.
- **Corrections** to amounts, store, date and total, plus **notes** (e.g. which child, why).
- **Audit log** of every action with UTC timestamps. Receipts are **voided with a reason, never deleted**, so they stay visible in the report.
- **Possible-duplicate warning** (same store + date + total).
- **Stamped copies** of each photo with a banner printed underneath: receipt ID(s), store, date, total, the original's file name, the date it was added, and its SHA-256 fingerprint. Share one to save it to Photos or print it; the untouched original is always kept separately. *Save original to Photos/Files* is under "More…".
- **Full backup & restore** (Settings): one .zip with everything. Restoring on a new phone re-checks every fingerprint, merges without duplicates, and carries on with the ID numbering. The app reminds you when the last backup is more than 7 days old.
- **Evidence pack (.zip)** for any date range: `report.txt`, `items.csv`, `audit-log.csv`, `manifest.csv` (fingerprints), `data.json`, `originals/` and `stamped/`, named by receipt ID. It is also your backup, so export one regularly: data lives only in this browser.

## Excel for the other parent (account between parents)

*Send → More options… → Excel for the other parent* builds an .xlsx limited to what concerns the other parent, for the chosen period:

- **Children's lines** sheet: one row per line tagged *Kids* or *Split* (receipt ID, date, store, paid by, item, expense type, line amount, % for the children, children's amount with tax/discounts shared out, currency, and *Accepted/Disputed* for the other parent's expenses). Adult lines, untagged lines, voided receipts, fingerprints, Claude's suggestions, private notes and flags are left out.
- **Account** sheet: per currency, children's expenses paid by me / by the other parent, the total, each parent's share and the balance (who owes whom). Each parent's share comes from Settings → *My share of the children's expenses* (50 % by default). Disputed expenses are shown separately and not counted.

The export is recorded in the audit log.

## Checking the other parent's expenses

Everything marked *Paid by: Other parent* (their Excel/CSV grid and the photos/PDFs they send) gets a **Check (other parent)** box, a summary at the top of "Your receipts", and the *Other parent: to check* filter.

- **Workbooks with several tabs and a tab of photos**: when you add their .xlsx, every tab is read, and the receipt photos pasted into it become files of their own (fingerprinted, read by Claude and checked like any other photo), named after the tab and the number written on each photo (`n° 14`, `n° 2@7`). A tab with a single unnumbered picture beside a table (a prorata calculation, a list of fees) is not treated as a receipt tab: its picture stays in the spreadsheet, which is kept untouched. Side calculations and reference tables next to the list are not imported as expenses.
- **Matched by invoice number**: Claude reads the grid's invoice-number column (`# facture`…). A row is linked to the photo carrying the same number in the same workbook, before any amount-based guess. `27-76-77` links a row to three photos and `2@7` one photo to rows 2 to 7; those groups are checked on their totals.
- **Grid ↔ receipts**: each declared line is matched to one of their photos/PDFs (same amount within 7 days, or same store/description with another amount). A receipt can back up only one line. You can pick the supporting receipt yourself from the menu. The summary shows declared / backed by a receipt / amount higher than the receipt (excess) / no receipt.
- **Flags on declared lines**: no receipt, declared amount ≠ receipt, receipt that also holds non-kids items, dates far apart, the same amount declared twice, the same receipt used for two lines, an expense that matches one of *your* receipts (you paid it), a date in the future, a supporting receipt that is itself suspicious.
- **Their own (adult) expenses passed off as the children's**: lines Claude judged clearly for an adult (alcohol, tobacco, adult clothing…) or that you tagged *Not kids* are flagged, on a grid line itself or on the receipt behind it when the full amount is declared. The summary shows the adult amount to remove.
- **Flags on their photos/PDFs** (computed on the phone, nothing extra sent): EXIF date of the photo *before* the purchase date, photo saved by an editing app (Photoshop, Snapseed, PicsArt…), the same photo sent again resized/cropped/recompressed (picture hash), the same receipt number used twice or also in your expenses, items + tax ≠ printed total, invoice without proof of payment, no date. Claude also reports concrete visible signs of alteration (digits in another font, overwritten amounts…) on new extractions.
- Flags are leads, not proof. **Accept** or **Dispute** (with a reason) each entry; both are logged. The report, PDF, email summary and Excel (*Check (other parent)* column) include the totals and the problems found.

## Sensitive documents (never sent to Claude)

Tap the 🔒 button on a file in the queue before extracting (nothing is sent until you tap *Extract with Claude*). A sensitive file:

- stays on the device with its fingerprint, like every other original, but is **never sent to Claude** ("Extract with Claude" skips it, and the code refuses to build a Claude request for it);
- gets a **✍️ Enter by hand** button: store, date, currency, payment method, lines (description + amount), tax, total, note. *Save & add another* handles a file holding several receipts, and "More… → Add another entry from this file" works later too;
- produces receipts with the same IDs, tags, verification and reports as the others, marked *Entered by hand (sensitive document)*. The audit log records when a file is marked sensitive and each manual entry.

## Language

The app is in **English or French**, following the phone's language (any `fr-*` setting gives French). You can override it in Settings → Language. In French:
- amounts are shown the French way (`1 271,50 $`) and can be typed with a comma
- the default currency is guessed from the phone's region (e.g. CAD for fr-CA, EUR for fr-FR)
- the report, email, CSV headers, file names and audit log are all in French
- the CSV uses `;` separators so French-language Excel opens it in proper columns
- Claude writes categories and notes in French (item descriptions stay as printed)

Receipt IDs, dates (YYYY-MM-DD) and fingerprints are the same in both languages.

## Notes

- **Model**: defaults to Claude Opus 5.5 (most accurate on faded/crumpled receipts). Sonnet 5.5 and Haiku 5.5 are cheaper options in Settings. Opus/Sonnet requests opt into server-side refusal fallbacks.
- **Images** are auto-rotated and downscaled to 2400px JPEG before upload to keep requests fast. PDFs are sent as-is (max 25 MB).
- **Up to 3 files** are processed in parallel; failed ones can be retried with the same button.
- **Extracted results persist** across reloads (the photos themselves don't). Use *Clear all* to start a new batch.
- **Email**: browsers can't send email silently without a server, so the app hands off to your mail app. Very long summaries are copied to the clipboard as a fallback because some mail apps truncate long `mailto:` links. Use *Share + CSV* to attach the spreadsheet.
- **Security**: this calls the API directly from the browser (`dangerouslyAllowBrowser`). That's fine for a personal app with your own key, but don't host it publicly with a key baked in.
- After changing any app file, bump `CACHE` in `sw.js` so installed copies pick up the update.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | UI |
| `i18n.js` | English/French text and language detection |
| `app.js` | File intake, image prep, Claude calls (structured JSON output), totals, email/CSV |
| `vendor/anthropic-sdk.js` | Bundled official `@anthropic-ai/sdk` 1.10.0 (ESM, browser) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install + offline shell |
