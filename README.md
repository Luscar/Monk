# Receipts (PWA)

A small installable web app that does three things:

1. **Collect** receipts from the camera, the photo gallery or PDF files (one file can hold several receipts). Pick *Paid by: Me / Other parent* before adding.
2. **Extract only what's needed to split them.** Claude reads each file with your own Anthropic API key and returns just the store, date, currency, each line (name + amount), tax and total. Each line comes back pre-tagged: clearly for a child → **Kids**, clearly for an adult → **Not kids**, shared household items → **?** for you to decide. Tap a tag to cycle *Kids → Split % → Not kids → ?*. Tap an amount to fix it.
3. **Split.** For any date range: kids' expenses paid by you and by the other parent, each parent's share (Settings → *My share*, 50 % by default) and who owes whom. Tax is shared out in proportion to the line amounts; a discount line follows the item above it. *Download spreadsheet* gives an .xlsx with the split and every kids' line.

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
| `db.js`, `zip.js`, `xlsx.js` | IndexedDB storage, .zip and .xlsx writers |
| `vendor/anthropic-sdk.js` | Bundled official `@anthropic-ai/sdk` 1.10.0 (ESM, browser) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA install + offline shell |
