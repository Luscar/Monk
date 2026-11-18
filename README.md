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
| `app.js` | File intake, image prep, Claude calls (structured JSON output), totals, email/CSV |
| `vendor/anthropic-sdk.js` | Bundled official `@anthropic-ai/sdk` 1.10.0 (ESM, browser) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install + offline shell |
