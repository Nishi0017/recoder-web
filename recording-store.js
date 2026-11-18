"use strict";

// Recording data lives in IndexedDB, separately from the offline application cache.
const recordingStore = (() => {
  let database;

  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("recoder-recordings", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("recordings", { keyPath: "id" });
        db.createObjectStore("chunks", { keyPath: ["id", "sequence"] });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = () => { database = undefined; reject(request.error); };
      request.onblocked = () => { database = undefined; reject(new Error("Close other Recoder tabs and retry.")); };
    });
    return database;
  }

  async function transaction(stores, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || new Error("Recording storage was interrupted."));
      tx.onerror = () => {};
      try { action(tx, result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  function range(id) {
    return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  }

  return {
    async create(type) {
      const row = {
        id: crypto.randomUUID(), type, createdAt: Date.now(),
        bytes: 0, parts: 0, status: "recording"
      };
      await transaction(["recordings"], "readwrite", (tx, done) => {
        tx.objectStore("recordings").add(row);
        done(row);
      });
      return row;
    },

    append(id, sequence, blob) {
      return transaction(["recordings", "chunks"], "readwrite", tx => {
        const rows = tx.objectStore("recordings");
        const request = rows.get(id);
        request.onsuccess = () => {
          const row = request.result;
          if (!row || row.status !== "recording") { tx.abort(); return; }
          tx.objectStore("chunks").add({ id, sequence, blob });
          row.bytes += blob.size;
          row.parts++;
          if (!row.type) row.type = blob.type;
          rows.put(row);
        };
      });
    },

    finish(id, status, filename) {
      return transaction(["recordings"], "readwrite", tx => {
        const rows = tx.objectStore("recordings");
        const request = rows.get(id);
        request.onsuccess = () => {
          if (!request.result) { tx.abort(); return; }
          rows.put({ ...request.result, status, filename });
        };
      });
    },

    list() {
      return transaction(["recordings"], "readonly", (tx, done) => {
        tx.objectStore("recordings").getAll().onsuccess = event => {
          done(event.target.result.sort((a, b) => b.createdAt - a.createdAt));
        };
      });
    },

    read(id) {
      return transaction(["recordings", "chunks"], "readonly", (tx, done) => {
        const metadata = tx.objectStore("recordings").get(id);
        tx.objectStore("chunks").getAll(range(id)).onsuccess = event => {
          const row = metadata.result;
          if (!row) { done(undefined); return; }
          const parts = event.target.result.map(chunk => chunk.blob);
          done({ row, file: new File(parts, row.filename || recordingFilename(row.type), { type: row.type }) });
        };
      });
    },

    remove(id) {
      return transaction(["recordings", "chunks"], "readwrite", tx => {
        tx.objectStore("recordings").delete(id);
        tx.objectStore("chunks").delete(range(id));
      });
    }
  };
})();
