// Real behavioural coverage for the financial engine, storage adapter and bus.
// These previously had no runtime assertions at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function load(files) {
  const context = {
    console,
    JSON,
    Date,
    Math,
    Intl,
    structuredClone,
    crypto: { randomUUID: () => "fixture-id" },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of files) vm.runInContext(fs.readFileSync(file, "utf8"), context);
  return context;
}

// ---------- domain.js ----------

const { OmniPocketEngine: E } = load(["domain.js"]);

function makeState(overrides = {}) {
  return {
    settings: {
      baseCurrency: "NGN",
      fx: { rates: { NGN: { NGN: 1, USD: 1 / 1500 }, USD: { NGN: 1500, USD: 1 } } },
      ...(overrides.settings || {}),
    },
    accounts: overrides.accounts || [],
    transactions: overrides.transactions || [],
    goals: overrides.goals || [],
    snapshots: overrides.snapshots || [],
  };
}

const tx = (o) => ({
  status: "recorded",
  currency: "NGN",
  createdAt: 1,
  ...o,
});

// BalancesAt ignores needs_review and non-posted bank movements.
{
  const state = makeState({
    accounts: [{ id: "a", currency: "NGN", openingBalance: 1000, archived: false }],
    transactions: [
      tx({ id: "1", type: "expense", amount: 100, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-02", createdAt: 2 }),
      tx({ id: "2", type: "expense", amount: 50, bankStatus: "pending", sourceAccountId: "a", date: "2026-01-02", createdAt: 3 }),
      tx({ id: "3", type: "expense", amount: 70, bankStatus: "failed", sourceAccountId: "a", date: "2026-01-02", createdAt: 4 }),
      tx({ id: "4", type: "expense", amount: 80, status: "needs_review", sourceAccountId: "a", date: "2026-01-02", createdAt: 5 }),
      tx({ id: "5", type: "expense", amount: 60, status: "superseded", sourceAccountId: "a", date: "2026-01-02", createdAt: 6 }),
      tx({ id: "6", type: "expense", amount: 90, bankStatus: "reversed", sourceAccountId: "a", date: "2026-01-02", createdAt: 7 }),
    ],
  });
  assert.equal(E.balancesAt(state).find(a => a.id === "a").balance, 900, "only posted expense should apply");
}

// Income adds, expense subtracts. Amounts are sign-normalised via Math.abs, so a
// negative amount is still treated as an expense/withdrawal of that magnitude.
{
  const state = makeState({
    accounts: [{ id: "a", currency: "NGN", openingBalance: 100, archived: false }],
    transactions: [
      tx({ id: "1", type: "income", amount: 500, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-01", createdAt: 1 }),
      tx({ id: "2", type: "expense", amount: -250, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-02", createdAt: 2 }),
    ],
  });
  assert.equal(E.balancesAt(state).find(a => a.id === "a").balance, 350);
}

// A same-currency transfer is net zero on total wealth but moves money between accounts.
{
  const state = makeState({
    accounts: [
      { id: "src", currency: "NGN", openingBalance: 1000, archived: false },
      { id: "dst", currency: "NGN", openingBalance: 0, archived: false },
    ],
    transactions: [
      tx({
        id: "t", type: "transfer", amount: 400, bankStatus: "posted",
        sourceAccountId: "src", destinationAccountId: "dst", date: "2026-01-03", createdAt: 1,
      }),
    ],
  });
  const rows = E.balancesAt(state);
  assert.equal(rows.find(a => a.id === "src").balance, 600);
  assert.equal(rows.find(a => a.id === "dst").balance, 400);
  assert.equal(E.netWorth(state, rows), 1000, "same-currency transfer must not change net worth");
}

// Cross-currency transfer converts into the destination currency.
{
  const state = makeState({
    accounts: [
      { id: "src", currency: "USD", openingBalance: 100, archived: false },
      { id: "dst", currency: "NGN", openingBalance: 0, archived: false },
    ],
    transactions: [
      tx({
        id: "t", type: "transfer", amount: 10, currency: "USD", bankStatus: "posted",
        sourceAccountId: "src", destinationAccountId: "dst", date: "2026-01-04", createdAt: 1,
      }),
    ],
  });
  const rows = E.balancesAt(state);
  assert.equal(rows.find(a => a.id === "src").balance, 90);
  assert.equal(rows.find(a => a.id === "dst").balance, 15000, "10 USD should credit 15000 NGN at 1500");
}

// receivedAmount overrides the derived FX amount.
{
  const state = makeState({
    accounts: [
      { id: "src", currency: "USD", openingBalance: 100, archived: false },
      { id: "dst", currency: "NGN", openingBalance: 0, archived: false },
    ],
    transactions: [
      tx({
        id: "t", type: "transfer", amount: 10, currency: "USD", receivedAmount: 14500,
        bankStatus: "posted", sourceAccountId: "src", destinationAccountId: "dst",
        date: "2026-01-05", createdAt: 1,
      }),
    ],
  });
  assert.equal(E.balancesAt(state).find(a => a.id === "dst").balance, 14500, "manual received amount wins");
}

// Archived accounts are excluded from net worth.
{
  const state = makeState({
    accounts: [
      { id: "a", currency: "NGN", openingBalance: 1000, balance: 1000, archived: false },
      { id: "b", currency: "NGN", openingBalance: 5000, balance: 5000, archived: true },
    ],
  });
  assert.equal(E.netWorth(state), 1000, "archived account must not count toward net worth");
}

// Point-in-time query slices by date and createdAt.
{
  const state = makeState({
    accounts: [{ id: "a", currency: "NGN", openingBalance: 0, archived: false }],
    transactions: [
      tx({ id: "before", type: "income", amount: 100, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-01", createdAt: 1 }),
      tx({ id: "same-day-early", type: "income", amount: 200, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-02", createdAt: 1 }),
      tx({ id: "same-day-late", type: "income", amount: 400, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-02", createdAt: 5 }),
      tx({ id: "after", type: "income", amount: 800, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-03", createdAt: 1 }),
    ],
  });
  const balanceAt = when => E.balancesAt(state, when).find(a => a.id === "a").balance;
  assert.equal(balanceAt({ date: "2026-01-01", createdAt: 99 }), 100);
  assert.equal(balanceAt({ date: "2026-01-02", createdAt: 3 }), 300, "createdAt cut-off must apply within a day");
  assert.equal(balanceAt({ date: "2026-01-04", createdAt: 99 }), 1500);
}

// Adjustment direction comes from adjustmentSign, else the category text.
{
  const state = makeState({
    accounts: [{ id: "a", currency: "NGN", openingBalance: 1000, archived: false }],
    transactions: [
      tx({ id: "1", type: "adjustment", amount: 100, adjustmentSign: -1, bankStatus: "posted", sourceAccountId: "a", date: "2026-01-01", createdAt: 1 }),
      tx({ id: "2", type: "adjustment", amount: 50, category: "Bank decrease", bankStatus: "posted", sourceAccountId: "a", date: "2026-01-01", createdAt: 2 }),
      tx({ id: "3", type: "adjustment", amount: 25, category: "Correction", bankStatus: "posted", sourceAccountId: "a", date: "2026-01-01", createdAt: 3 }),
    ],
  });
  assert.equal(E.balancesAt(state).find(a => a.id === "a").balance, 875);
}

// Snapshots: idempotent per day, capped at 730 entries.
{
  const state = makeState({
    accounts: [{ id: "a", currency: "NGN", openingBalance: 1000, archived: false }],
  });
  const day = new Date("2026-05-05T10:00:00Z");
  const first = E.recordDailySnapshot(state, day);
  assert.equal(first.value, 1000);
  E.recordDailySnapshot(state, new Date("2026-05-05T22:00:00Z"));
  assert.equal(state.snapshots.length, 1, "same calendar day must not duplicate a snapshot");
  for (let i = 0; i < 800; i++) {
    E.recordDailySnapshot(state, new Date(Date.UTC(2020, 0, 1) + i * 86400000));
  }
  assert.ok(state.snapshots.length <= 730, `snapshot history must be capped, got ${state.snapshots.length}`);
}

// FX: rate lookup, override, and history recording with same-window dedupe.
{
  const state = makeState({ accounts: [{ id: "a", currency: "NGN", openingBalance: 0, archived: false }] });
  assert.equal(E.rate(state, "USD", "NGN"), 1500);
  assert.equal(E.convert(state, 1500, "NGN", "USD"), 1);
  assert.equal(E.convert(state, 1500, "NGN", "USD", 1 / 2000), 0.75, "override rate must win");
  assert.equal(E.convert(state, 0, "NGN", "USD"), 0);

  E.recordFxSnapshot(state, { NGN: { NGN: 1, USD: 1 / 1500 } }, { updatedAt: 1000, source: "live" });
  E.recordFxSnapshot(state, { NGN: { NGN: 1, USD: 1 / 1400 } }, { updatedAt: 1000, source: "live" });
  assert.equal(state.settings.fx.history.length, 1, "snapshots within 60s must dedupe");
  assert.equal(state.settings.fx.history[0].rates.NGN.USD, 1 / 1400, "latest matrix must win");
}

// Goal progress sums the selected accounts and clamps at 100%.
{
  const state = makeState({
    accounts: [
      { id: "a", currency: "NGN", openingBalance: 300, balance: 300, archived: false },
      { id: "b", currency: "NGN", openingBalance: 200, balance: 200, archived: false },
      { id: "c", currency: "NGN", openingBalance: 999, balance: 999, archived: false },
    ],
  });
  const progress = E.goalProgress(state, { target: 1000, accountIds: ["a", "b"] });
  assert.equal(progress.current, 500);
  assert.equal(progress.pct, 50);

  const over = E.goalProgress(state, { target: 100, accountIds: ["a", "b", "c"] });
  assert.equal(over.pct, 100, "goal progress must clamp at 100");
}

// Empty state must not throw anywhere in the engine surface.
{
  const empty = makeState();
  assert.equal(E.netWorth(empty), 0);
  assert.deepEqual(E.balancesAt(empty), []);
  assert.equal(E.spendingSummary(empty).total, 0);
  assert.equal(E.wealthChange(empty).change, null);
}

// ---------- storage.js ----------

{
  // Minimal in-memory IndexedDB good enough for the adapter's three calls.
  // Data is partitioned per database name, as a real IndexedDB would be.
  const databases = new Map();
  const makeRequest = value => {
    const request = { onsuccess: null, onerror: null, result: value };
    setTimeout(() => request.onsuccess && request.onsuccess(), 0);
    return request;
  };
  const fakeIndexedDB = {
    open(dbName) {
      if (!databases.has(dbName)) databases.set(dbName, new Map());
      const rows = databases.get(dbName);
      const store = {
        get: key => makeRequest(rows.has(key) ? rows.get(key) : undefined),
        put: (value, key) => { rows.set(key, value); return makeRequest(key); },
        delete: key => { rows.delete(key); return makeRequest(undefined); },
      };
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
          const tx = {
            objectStore: () => store,
            error: null,
            oncomplete: null, onerror: null, onabort: null,
          };
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
          return tx;
        },
      };
      const request = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => request.onsuccess && request.onsuccess(), 0);
      return request;
    },
  };

  const legacy = new Map();
  const context = {
    console, JSON, Date, Math, setTimeout,
    indexedDB: fakeIndexedDB,
    localStorage: {
      getItem: key => (legacy.has(key) ? legacy.get(key) : null),
      setItem: (key, value) => legacy.set(key, value),
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("storage.js", "utf8"), context);

  const Storage = context.OmniPocketStorage;
  assert(Storage, "storage adapter must export OmniPocketStorage");

  const store = new Storage({ dbName: "test", storeName: "state", legacyKey: "omnipocket.main" });

  assert.equal(await store.load(), null, "empty store must load null");

  await store.save({ schemaVersion: 8, accounts: [{ id: "a" }] });
  const loaded = await store.load();
  assert.equal(loaded.schemaVersion, 8);
  assert.deepEqual(loaded.accounts, [{ id: "a" }]);

  // Save must snapshot by value, not alias the caller's object.
  const mutable = { schemaVersion: 8, accounts: [] };
  await store.save(mutable);
  mutable.accounts.push({ id: "b" });
  assert.equal((await store.load()).accounts.length, 0, "save must not alias caller state");

  // Legacy localStorage payload is migrated once.
  const fresh = new Storage({ dbName: "test2", storeName: "state", legacyKey: "omnipocket.v1" });
  legacy.set("omnipocket.v1", JSON.stringify({ schemaVersion: 3, accounts: [{ id: "legacy" }] }));
  const migrated = await fresh.load();
  assert.equal(migrated.schemaVersion, 3, "legacy snapshot must be returned on first load");
  assert.equal((await fresh.load()).schemaVersion, 3, "migrated payload must persist");

  await store.clear();
  assert.equal(await store.load(), null, "clear must remove the stored snapshot");
}

// ---------- bus.js ----------

{
  const context = load(["bus.js"]);
  const bus = context.OmniPocketBus;
  assert(bus, "bus must export OmniPocketBus");

  const seen = [];
  const off = bus.on("ping", payload => seen.push(payload));
  bus.emit("ping", { value: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].value, 1, "detail must be forwarded to listeners");
  assert.ok(seen[0].sequence > 0 && seen[0].at > 0, "payload must carry sequence and timestamp");
  off();
  bus.emit("ping", { value: 2 });
  assert.equal(seen.length, 1, "unsubscribe must detach the handler");

  let onceCount = 0;
  bus.once("boom", () => onceCount++);
  bus.emit("boom");
  bus.emit("boom");
  assert.equal(onceCount, 1, "once must fire exactly one time");

  // A throwing listener must not stop the others. The bus logs the failure, so
// silence console.error for this assertion only.
{
  const order = [];
  const realError = context.console.error;
  context.console.error = () => {};
  try {
    bus.on("multi", () => { throw new Error("listener blew up"); });
    bus.on("multi", () => order.push("second"));
    bus.emit("multi");
  } finally {
    context.console.error = realError;
  }
  assert.deepEqual(order, ["second"], "one bad listener must not break delivery");
}

  // Wildcard receives every event.
  let wildcard = 0;
  bus.on("*", () => wildcard++);
  bus.emit("one");
  bus.emit("two");
  assert.equal(wildcard, 2, "wildcard listener must receive all events");

  // Context scope is derived from whichever id is set.
  assert.equal(bus.getContext().scope, "global");
  assert.equal(bus.selectAccount("a1").scope, "account");
  assert.equal(bus.selectGoal("g1").scope, "goal");
  assert.equal(bus.selectTransaction("t1").scope, "transaction");
  bus.clearContext();
  assert.equal(bus.getContext().scope, "global");

  // Non-global scopes are remembered in history, global resets are not.
  bus.selectAccount("a1");
  bus.selectAccount("a2");
  const history = bus.getHistory();
  assert.ok(history.length >= 2, "scoped context changes must be recorded");
  assert.ok(history.length <= 12, "history must be bounded");
  assert.equal(bus.getContext().scope, "account");
}

console.log("OmniPocket runtime behaviour tests passed");