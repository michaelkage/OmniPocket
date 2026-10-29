/* OmniPocket — IndexedDB persistence adapter */
class OmniPocketStorage {
  constructor({ dbName, storeName, legacyKey }) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.legacyKey = legacyKey;
    this.version = 1;
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
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read OmniPocket data."));
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
