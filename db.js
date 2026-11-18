// Minimal IndexedDB wrapper. Stores original files (as Blobs), receipts, the audit log and counters.
const DB_NAME = "receipt-mailer";
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("files", { keyPath: "id" });
      db.createObjectStore("receipts", { keyPath: "id" });
      db.createObjectStore("log", { keyPath: "seq", autoIncrement: true });
      db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  all: (store) => run(store, "readonly", (s) => s.getAll()),
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  put: (store, value, key) => run(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  add: (store, value) => run(store, "readwrite", (s) => s.add(value)),
  del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
  clear: (store) => run(store, "readwrite", (s) => s.clear()),
};
