/* OmniPocket — normalized IndexedDB persistence adapter */
class OmniPocketStorage {
  constructor({ dbName, storeName, legacyKey }) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.legacyKey = legacyKey;
    this.version = 3;
    this.key = "current";
    this.dbPromise = null;
    this.cache = null;
    this.entityStoreNames = [
      "accounts",
      "transactions",
      "goals",
      "snapshots",
      "deletedExternalTransactions"
    ];
    this.metaStoreName = "meta";
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
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("accounts")) {
          const accounts = db.createObjectStore("accounts", { keyPath: "id" });
          accounts.createIndex("currency", "currency", { unique: false });
          accounts.createIndex("archived", "archived", { unique: false });
        }
        if (!db.objectStoreNames.contains("transactions")) {
          const transactions = db.createObjectStore("transactions", { keyPath: "id" });
          transactions.createIndex("date", "date", { unique: false });
          transactions.createIndex("sourceAccountId", "sourceAccountId", { unique: false });
          transactions.createIndex("destinationAccountId", "destinationAccountId", { unique: false });
          transactions.createIndex("sourceAccountDate", ["sourceAccountId", "date"], { unique: false });
          transactions.createIndex("destinationAccountDate", ["destinationAccountId", "date"], { unique: false });
          transactions.createIndex("providerTransactionId", ["external.provider", "external.providerTransactionId"], { unique: false });
        }
        if (!db.objectStoreNames.contains("goals")) {
          const goals = db.createObjectStore("goals", { keyPath: "id" });
          goals.createIndex("status", "status", { unique: false });
        }
        if (!db.objectStoreNames.contains("snapshots")) {
          const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
          snapshots.createIndex("date", "date", { unique: false });
        }
        if (!db.objectStoreNames.contains("deletedExternalTransactions")) {
          const deleted = db.createObjectStore("deletedExternalTransactions", { keyPath: "key" });
          deleted.createIndex("providerTransactionId", "providerTransactionId", { unique: false });
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
          this.cache = null;
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

  _deletedKey(item) {
    return JSON.stringify([
      String(item.provider || ""),
      String(item.providerAccountId || ""),
      String(item.providerTransactionId || "")
    ]);
  }

  _fingerprint(value) {
    return JSON.stringify(value);
  }

  _records(state) {
    const deleted = Array.isArray(state.deletedExternalTransactions)
      ? state.deletedExternalTransactions.map(item => ({ ...item, key: this._deletedKey(item) }))
      : [];
    return {
      accounts: Array.isArray(state.accounts) ? state.accounts : [],
      transactions: Array.isArray(state.transactions) ? state.transactions : [],
      goals: Array.isArray(state.goals) ? state.goals : [],
      snapshots: Array.isArray(state.snapshots) ? state.snapshots : [],
      deletedExternalTransactions: deleted
    };
  }

  _buildCache(records, settings, schemaVersion = 1) {
    const cache = { stores: {}, meta: {} };
    for (const name of this.entityStoreNames) {
      cache.stores[name] = new Map();
      for (const record of records[name] || []) {
        const key = name === "deletedExternalTransactions" ? record.key : record.id;
        cache.stores[name].set(key, this._fingerprint(record));
      }
    }
    cache.meta.settings = this._fingerprint(settings || {});
    cache.meta.stateVersion = this._fingerprint({ key: "stateVersion", value: 1 });
    cache.meta.schemaVersion = this._fingerprint({ key: "schemaVersion", value: schemaVersion });
    return cache;
  }

  async _readNormalized(db) {
    const names = [...this.entityStoreNames, this.metaStoreName];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, "readonly");
      const requests = {};
      for (const name of this.entityStoreNames) {
        requests[name] = tx.objectStore(name).getAll();
      }
      requests.settings = tx.objectStore(this.metaStoreName).get("settings");
      requests.stateVersion = tx.objectStore(this.metaStoreName).get("stateVersion");
      requests.schemaVersion = tx.objectStore(this.metaStoreName).get("schemaVersion");
      const result = { records: {}, settings: null, version: null, schemaVersion: null };
      for (const name of this.entityStoreNames) {
        requests[name].onsuccess = () => { result.records[name] = requests[name].result || []; };
        requests[name].onerror = () => reject(requests[name].error || new Error("Could not read normalized " + name + "."));
      }
      requests.settings.onsuccess = () => { result.settings = requests.settings.result?.value || null; };
      requests.stateVersion.onsuccess = () => { result.version = requests.stateVersion.result?.value || null; };
      requests.schemaVersion.onsuccess = () => { result.schemaVersion = requests.schemaVersion.result?.value ?? null; };
      requests.settings.onerror = () => reject(requests.settings.error || new Error("Could not read OmniPocket settings."));
      requests.stateVersion.onerror = () => reject(requests.stateVersion.error || new Error("Could not read normalized storage version."));
      requests.schemaVersion.onerror = () => reject(requests.schemaVersion.error || new Error("Could not read application schema version."));
      tx.oncomplete = () => {
        if (!result.version) {
          resolve(null);
          return;
        }
        result.records.deletedExternalTransactions = result.records.deletedExternalTransactions.map(({ key, ...item }) => item);
        this.cache = this._buildCache(result.records, result.settings || {}, result.schemaVersion ?? 1);
        resolve({
          schemaVersion: result.schemaVersion ?? null,
          settings: result.settings || {},
          accounts: result.records.accounts,
          transactions: result.records.transactions,
          goals: result.records.goals,
          snapshots: result.records.snapshots,
          deletedExternalTransactions: result.records.deletedExternalTransactions
        });
      };
      tx.onerror = () => reject(tx.error || new Error("Could not read normalized OmniPocket data."));
      tx.onabort = () => reject(tx.error || new Error("Normalized OmniPocket read was aborted."));
    });
  }

  async _readSnapshot(db) {
    return this.read(db);
  }

  async load() {
    const db = await this.open();
    const normalized = await this._readNormalized(db);
    if (normalized) return normalized;

    // V2 stored the complete domain state under one key. Keep that source until
    // every normalized record has committed successfully.
    const snapshot = await this._readSnapshot(db);
    if (snapshot && typeof snapshot === "object") {
      // Return the source to app.js for domain migration first. Some legacy
      // records may lack normalized IDs, so never write this raw shape directly.
      return snapshot;
    }

    // One-time migration from the original V1 localStorage snapshot.
    let legacy = null;
    try {
      legacy = JSON.parse(localStorage.getItem(this.legacyKey) || "null");
    } catch (error) {
      console.warn("Legacy OmniPocket data could not be parsed; the source was left untouched.", error);
      return null;
    }
    if (legacy && typeof legacy === "object") {
      // app.js normalizes IDs and relationships before its first save. The
      // legacy source is removed only by save(), after IndexedDB commits.
      return legacy;
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
    const records = this._records(state);
    const settings = state.settings || {};
    if (!this.cache) {
      const existing = await this._readNormalized(db);
      if (existing) {
        // _readNormalized initializes the cache from the committed database.
      } else {
        this.cache = this._buildCache({}, {});
      }
    }

    const appSchemaVersion = Number.isFinite(Number(state.schemaVersion)) ? Number(state.schemaVersion) : 1;
    const nextCache = this._buildCache(records, settings, appSchemaVersion);
    const storeNames = [...this.entityStoreNames, this.metaStoreName, this.storeName];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, "readwrite");
      for (const name of this.entityStoreNames) {
        const store = tx.objectStore(name);
        const previous = this.cache.stores[name] || new Map();
        const next = nextCache.stores[name];
        for (const [key, fingerprint] of next) {
          if (previous.get(key) !== fingerprint) {
            const record = name === "deletedExternalTransactions"
              ? records[name].find(item => item.key === key)
              : records[name].find(item => item.id === key);
            store.put(record);
          }
        }
        for (const key of previous.keys()) {
          if (!next.has(key)) store.delete(key);
        }
      }
      const meta = tx.objectStore(this.metaStoreName);
      if (this.cache.meta.settings !== nextCache.meta.settings) {
        meta.put({ key: "settings", value: settings });
      }
      meta.put({ key: "stateVersion", value: 1 });
      if (this.cache.meta.schemaVersion !== nextCache.meta.schemaVersion) {
        meta.put({ key: "schemaVersion", value: appSchemaVersion });
      }
      // Remove the old monolithic V2 snapshot only in the same successful
      // transaction that commits its normalized replacement.
      tx.objectStore(this.storeName).delete(this.key);
      tx.oncomplete = () => {
        this.cache = nextCache;
        // Remove the legacy V1 snapshot only after the normalized transaction
        // commits. If the write aborts, the original source remains recoverable.
        try { localStorage.removeItem(this.legacyKey); }
        catch (error) { console.warn("Normalized data is safe in IndexedDB, but the legacy copy could not be removed.", error); }
        resolve();
      };
      tx.onerror = () => reject(tx.error || new Error("Could not save normalized OmniPocket data."));
      tx.onabort = () => reject(tx.error || new Error("Normalized OmniPocket save was aborted."));
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
    const stores = [...this.entityStoreNames, this.metaStoreName, this.storeName, "outbox"];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of stores) tx.objectStore(name).clear();
      tx.oncomplete = () => {
        this.cache = null;
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
