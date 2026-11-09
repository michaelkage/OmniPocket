/* OmniPocket — IndexedDB persistence adapter */
class OmniPocketStorage {
  constructor({ dbName, storeName, legacyKey }) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.legacyKey = legacyKey;
    this.version = 2;
    this.key = "current";
    this.dbPromise = null;
  }

  open() {
    if (this.dbPromise) return this.dbPromise;

    const attempt = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB is not supported."));
        return;
      }

      let settled = false;
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
        if (!db.objectStoreNames.contains("outbox")) {
          const outbox = db.createObjectStore("outbox", { keyPath: "id" });
          outbox.createIndex("createdAt", "createdAt", { unique: false });
          outbox.createIndex("type", "type", { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // A blocked open may eventually succeed after its caller has fallen
        // back. Close that late connection instead of leaking it.
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error || new Error("Could not open IndexedDB."));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error("IndexedDB upgrade is blocked."));
      };
    });

    const tracked = attempt.catch(error => {
      // A transient failure must not permanently poison future open attempts.
      if (this.dbPromise === tracked) this.dbPromise = null;
      throw error;
    });
    this.dbPromise = tracked;
    return tracked;
  }

  async load() {
    const db = await this.open();
    const stored = await this.read(db);

    if (stored) return stored;

    // One-time migration from the V1 localStorage snapshot.
    try {
      const legacy = JSON.parse(localStorage.getItem(this.legacyKey) || "null");
      if (legacy && typeof legacy === "object") {
        await this.save(legacy);
        // Release the old synchronous snapshot only after the IndexedDB
        // transaction has committed, so an interrupted migration is recoverable.
        localStorage.removeItem(this.legacyKey);
        return legacy;
      }
    } catch (error) {
      console.warn("Legacy OmniPocket data could not be migrated.", error);
    }

    return null;
  }

  read(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const request = tx.objectStore(this.storeName).get(this.key);
      let result = null;
      request.onsuccess = () => { result = request.result || null; };
      request.onerror = () => reject(request.error || new Error("Could not read OmniPocket data."));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Could not read OmniPocket data."));
      tx.onabort = () => reject(tx.error || new Error("OmniPocket read was aborted."));
    });
  }

  async save(state) {
    const db = await this.open();
    const snapshot = JSON.parse(JSON.stringify(state));

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(snapshot, this.key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Could not save OmniPocket data."));
      tx.onabort = () => reject(tx.error || new Error("OmniPocket save was aborted."));
    });
  }


  // Durable offline work queue. Each operation is keyed by its stable ID so
  // retrying enqueue after an uncertain response cannot create a duplicate.
  async enqueueOutbox(job) {
    if (!job || !job.id) throw new Error("Outbox jobs require a stable id.");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put({ ...job, createdAt: Number(job.createdAt) || Date.now() });
      tx.oncomplete = () => resolve(job.id);
      tx.onerror = () => reject(tx.error || new Error("Could not enqueue offline work."));
      tx.onabort = () => reject(tx.error || new Error("Outbox enqueue was aborted."));
    });
  }

  async listOutbox() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const request = tx.objectStore("outbox").getAll();
      let result = [];
      request.onsuccess = () => { result = request.result || []; };
      request.onerror = () => reject(request.error || new Error("Could not read offline work."));
      tx.oncomplete = () => resolve(result.sort((a, b) => a.createdAt - b.createdAt));
      tx.onerror = () => reject(tx.error || new Error("Could not read offline work."));
      tx.onabort = () => reject(tx.error || new Error("Outbox read was aborted."));
    });
  }

  async removeOutbox(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Could not acknowledge offline work."));
      tx.onabort = () => reject(tx.error || new Error("Outbox acknowledgement was aborted."));
    });
  }

  async migrateLegacyOutbox(key) {
    let legacy;
    try { legacy = JSON.parse(localStorage.getItem(key) || "[]"); }
    catch (error) { throw new Error("Legacy offline queue is unreadable; it was left untouched.", { cause: error }); }
    if (!Array.isArray(legacy) || legacy.length === 0) return 0;
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      const store = tx.objectStore("outbox");
      for (const job of legacy) {
        if (job && job.id && job.type) store.put({ ...job, createdAt: Number(job.createdAt) || Date.now() });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Could not migrate the legacy offline queue."));
      tx.onabort = () => reject(tx.error || new Error("Legacy outbox migration was aborted."));
    });
    // Delete the old copy only after all records are durably committed.
    localStorage.removeItem(key);
    return legacy.length;
  }

  async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).delete(this.key);
      tx.oncomplete = () => {
        // The localStorage snapshot is also used as a recovery fallback. Leaving
        // it behind would let a later load migrate cleared data back into IndexedDB.
        try {
          localStorage.removeItem(this.legacyKey);
          resolve();
        } catch (error) {
          reject(error || new Error("Could not clear OmniPocket fallback data."));
        }
      };
      tx.onerror = () => reject(tx.error || new Error("Could not clear OmniPocket data."));
      tx.onabort = () => reject(tx.error || new Error("OmniPocket clear was aborted."));
    });
  }
}

window.OmniPocketStorage = OmniPocketStorage;
