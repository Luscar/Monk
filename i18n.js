// English / French. Language follows the phone unless overridden in Settings.
const DICT = {
  en: {
    "app.title": "Receipts",
    "settings": "Settings",
    "setup.title": "Add your Anthropic API key to get started.",
    "setup.body": "It is stored only on this device and sent only to api.anthropic.com.",
    "setup.open": "Open settings",

    "add.title": "1. Add receipts",
    "add.camera": "Camera",
    "add.gallery": "Gallery",
    "add.pdf": "PDF",
    "add.drop": "…or drop files here",
    "payer.label": "Paid by:",
    "payer.me": "Me",
    "payer.other": "Other parent",
    "process.idle": "Extract with Claude",
    "process.count": "Extract {n} file(s) with Claude",
    "process.working": "Working…",
    "q.pending": "Ready to extract",
    "q.queued": "Waiting…",
    "q.working": "Reading…",
    "remove": "Remove {name}",

    "list.title": "2. Tag the kids' lines",
    "list.hint": "Claude pre-tags each line. Tap a tag to change it: Kids → Split % → Not kids → ?",
    "list.untagged": "{n} line(s) still need a tag",
    "unknownStore": "Unknown store",
    "noDate": "No date",
    "tag.kids": "Kids",
    "tag.split": "Split",
    "tag.not": "Not kids",
    "tag.review": "?",
    "forKids": "For the kids:",
    "ofTotal": "of {t}",
    "tax": "Tax",
    "total": "Total",
    "btn.view": "View",
    "btn.payer": "Paid by: {who}",
    "btn.allKids": "All kids",
    "btn.noneKids": "None kids",
    "btn.edit": "Edit",
    "btn.delete": "Delete",
    "c.delete": "Delete {id} ({store})? The original file is deleted too.",
    "p.amount": "New amount for “{d}”:",
    "p.store": "Store:",
    "p.date": "Date (YYYY-MM-DD):",
    "p.total": "Total:",

    "split.title": "3. Split",
    "split.from": "From",
    "split.to": "To",
    "split.paidMe": "Kids' expenses paid by me",
    "split.paidOther": "Paid by the other parent",
    "split.total": "Total kids' expenses",
    "split.shareMe": "My share ({p} %)",
    "split.shareOther": "Their share ({p} %)",
    "split.otherOwes": "The other parent owes me",
    "split.iOwe": "I owe the other parent",
    "split.even": "Even — nobody owes anything",
    "split.none": "No kids' lines in this period yet.",
    "split.pending": "{n} line(s) in this period are not tagged yet and are not counted.",
    "btn.export": "Download spreadsheet (.xlsx)",

    "set.lang": "Language",
    "lang.auto": "Automatic (phone setting)",
    "set.key": "Anthropic API key",
    "set.model": "Model",
    "model.opus": "Claude Opus 5.5 (most accurate)",
    "model.sonnet": "Claude Sonnet 5.5 (balanced)",
    "model.haiku": "Claude Haiku 5.5 (cheapest)",
    "set.kids": "About the children (helps Claude tag lines), e.g. “2 boys, 6 and 9”",
    "set.share": "My share of the kids' expenses (%)",
    "set.currency": "Default currency",
    "set.save": "Save",
    "set.cancel": "Cancel",
    "backup.title": "Backup",
    "backup.hint": "Everything lives only in this browser. Back up regularly.",
    "backup.btn": "Back up everything (.zip)",
    "restore.btn": "Restore from backup…",
    "wipe.btn": "Erase all data on this device…",
    "c.wipe": "Erase every receipt and file on this device? This cannot be undone.",

    "t.saved": "Saved",
    "t.done": "Done",
    "t.failed": "{n} file(s) failed — tap Extract to retry",
    "t.noReceipt": "No receipt found in {name}",
    "t.already": "{name} was already added",
    "t.unsupported": "{name}: not a photo or PDF",
    "t.pdfTooBig": "{name}: PDF over 25 MB",
    "t.wiped": "All data erased",
    "t.noStorage": "Storage unavailable in this browser",
    "a.restoreDone": "Restored {r} receipt(s) and {f} file(s).",
    "a.restoreFailed": "Restore failed: {msg}",
    "e.notBackup": "Not a backup from this app",
    "e.imageFormat": "Unsupported image format",
    "e.refused": "Claude declined to read this file",
    "e.cutoff": "Response cut off",
    "e.unreadable": "Unreadable response",
    "e.auth": "Invalid API key",
    "e.perm": "This API key is not allowed to use that model",
    "e.rate": "Rate limited — try again in a minute",
    "e.bad": "Request rejected: {msg}",
    "e.net": "Network error",
    "e.api": "API error {status}: {msg}",

    "xl.file": "kids-expenses",
    "xl.lines": "Kids' lines",
    "xl.account": "Split",
    "xl.hdr": ["ID", "Date", "Store", "Paid by", "Item", "Amount", "% kids", "Kids' amount", "Currency"],
    "xl.period": "Period",
    "xl.all": "All dates",
    "xl.currency": "Currency",
  },
  fr: {
    "app.title": "Reçus",
    "settings": "Réglages",
    "setup.title": "Ajoutez votre clé API Anthropic pour commencer.",
    "setup.body": "Elle reste sur cet appareil et n'est envoyée qu'à api.anthropic.com.",
    "setup.open": "Ouvrir les réglages",

    "add.title": "1. Ajouter des reçus",
    "add.camera": "Caméra",
    "add.gallery": "Photos",
    "add.pdf": "PDF",
    "add.drop": "…ou déposez des fichiers ici",
    "payer.label": "Payé par :",
    "payer.me": "Moi",
    "payer.other": "L'autre parent",
    "process.idle": "Extraire avec Claude",
    "process.count": "Extraire {n} fichier(s) avec Claude",
    "process.working": "En cours…",
    "q.pending": "Prêt à extraire",
    "q.queued": "En attente…",
    "q.working": "Lecture…",
    "remove": "Retirer {name}",

    "list.title": "2. Marquer les lignes des enfants",
    "list.hint": "Claude pré-marque chaque ligne. Touchez une étiquette pour la changer : Enfants → Partagé % → Pas enfants → ?",
    "list.untagged": "{n} ligne(s) à marquer",
    "unknownStore": "Magasin inconnu",
    "noDate": "Sans date",
    "tag.kids": "Enfants",
    "tag.split": "Partagé",
    "tag.not": "Pas enfants",
    "tag.review": "?",
    "forKids": "Pour les enfants :",
    "ofTotal": "sur {t}",
    "tax": "Taxes",
    "total": "Total",
    "btn.view": "Voir",
    "btn.payer": "Payé par : {who}",
    "btn.allKids": "Tout enfants",
    "btn.noneKids": "Rien enfants",
    "btn.edit": "Corriger",
    "btn.delete": "Supprimer",
    "c.delete": "Supprimer {id} ({store}) ? Le fichier original est supprimé aussi.",
    "p.amount": "Nouveau montant pour « {d} » :",
    "p.store": "Magasin :",
    "p.date": "Date (AAAA-MM-JJ) :",
    "p.total": "Total :",

    "split.title": "3. Partage",
    "split.from": "Du",
    "split.to": "Au",
    "split.paidMe": "Dépenses des enfants payées par moi",
    "split.paidOther": "Payées par l'autre parent",
    "split.total": "Total des dépenses des enfants",
    "split.shareMe": "Ma part ({p} %)",
    "split.shareOther": "Sa part ({p} %)",
    "split.otherOwes": "L'autre parent me doit",
    "split.iOwe": "Je dois à l'autre parent",
    "split.even": "À égalité — personne ne doit rien",
    "split.none": "Aucune ligne des enfants pour cette période.",
    "split.pending": "{n} ligne(s) de cette période ne sont pas encore marquées et ne sont pas comptées.",
    "btn.export": "Télécharger le tableur (.xlsx)",

    "set.lang": "Langue",
    "lang.auto": "Automatique (réglage du téléphone)",
    "set.key": "Clé API Anthropic",
    "set.model": "Modèle",
    "model.opus": "Claude Opus 5.5 (le plus précis)",
    "model.sonnet": "Claude Sonnet 5.5 (équilibré)",
    "model.haiku": "Claude Haiku 5.5 (le moins cher)",
    "set.kids": "Les enfants (aide Claude à marquer les lignes), p. ex. « 2 garçons, 6 et 9 ans »",
    "set.share": "Ma part des dépenses des enfants (%)",
    "set.currency": "Devise par défaut",
    "set.save": "Enregistrer",
    "set.cancel": "Annuler",
    "backup.title": "Sauvegarde",
    "backup.hint": "Tout reste dans ce navigateur seulement. Sauvegardez régulièrement.",
    "backup.btn": "Tout sauvegarder (.zip)",
    "restore.btn": "Restaurer une sauvegarde…",
    "wipe.btn": "Effacer toutes les données de cet appareil…",
    "c.wipe": "Effacer tous les reçus et fichiers de cet appareil ? C'est irréversible.",

    "t.saved": "Enregistré",
    "t.done": "Terminé",
    "t.failed": "{n} fichier(s) en échec — touchez Extraire pour réessayer",
    "t.noReceipt": "Aucun reçu trouvé dans {name}",
    "t.already": "{name} a déjà été ajouté",
    "t.unsupported": "{name} : ni photo ni PDF",
    "t.pdfTooBig": "{name} : PDF de plus de 25 Mo",
    "t.wiped": "Toutes les données ont été effacées",
    "t.noStorage": "Stockage indisponible dans ce navigateur",
    "a.restoreDone": "{r} reçu(s) et {f} fichier(s) restaurés.",
    "a.restoreFailed": "Échec de la restauration : {msg}",
    "e.notBackup": "Ce n'est pas une sauvegarde de cette appli",
    "e.imageFormat": "Format d'image non pris en charge",
    "e.refused": "Claude a refusé de lire ce fichier",
    "e.cutoff": "Réponse tronquée",
    "e.unreadable": "Réponse illisible",
    "e.auth": "Clé API invalide",
    "e.perm": "Cette clé API n'a pas accès à ce modèle",
    "e.rate": "Trop de requêtes — réessayez dans une minute",
    "e.bad": "Requête refusée : {msg}",
    "e.net": "Erreur réseau",
    "e.api": "Erreur API {status} : {msg}",

    "xl.file": "depenses-enfants",
    "xl.lines": "Lignes enfants",
    "xl.account": "Partage",
    "xl.hdr": ["ID", "Date", "Magasin", "Payé par", "Article", "Montant", "% enfants", "Montant enfants", "Devise"],
    "xl.period": "Période",
    "xl.all": "Toutes les dates",
    "xl.currency": "Devise",
  },
};

function detect() {
  let pref = "auto";
  try { pref = localStorage.getItem("lang") || "auto"; } catch { /* ignore */ }
  if (pref === "en" || pref === "fr") return pref;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  return String(langs[0]).toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const lang = detect();

/** Locale for numbers/currency: the phone's own locale when it matches the app language. */
export const locale = (() => {
  const phone = navigator.language || "";
  if (phone.toLowerCase().startsWith(lang)) return phone;
  return lang === "fr" ? "fr-CA" : "en-US";
})();

/** Currency guess from the phone's region, used when Settings has none. */
export function regionCurrency() {
  const region = (navigator.language || "").split("-")[1]?.toUpperCase();
  const map = { CA: "CAD", US: "USD", GB: "GBP", CH: "CHF", AU: "AUD", NZ: "NZD", MA: "MAD", SN: "XOF", CI: "XOF", HT: "HTG" };
  const euro = ["FR", "BE", "LU", "MC", "DE", "ES", "IT", "PT", "NL", "IE", "AT", "FI", "GR"];
  return map[region] || (euro.includes(region) ? "EUR" : lang === "fr" ? "CAD" : "USD");
}

export function t(key, vars = {}) {
  const v = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (typeof v !== "string") return v;
  return v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
}

/** Fills elements marked data-i18n (text), data-i18n-ph (placeholder) and data-i18n-aria (label). */
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  document.title = t("app.title");
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); el.title = t(el.dataset.i18nAria); });
}
