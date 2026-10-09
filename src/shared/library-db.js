// Tiny IndexedDB wrapper. Holds the big files (txt + pdf blobs) for the library.
// The small metadata list lives in chrome.storage.local ("library") instead.
const H5PDB = (() => {
  const DB_NAME = 'h5p-library';
  const STORE = 'files';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  return {
    put: (id, record) => run('readwrite', (s) => s.put(record, id)),
    get: (id) => run('readonly', (s) => s.get(id)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
  };
})();