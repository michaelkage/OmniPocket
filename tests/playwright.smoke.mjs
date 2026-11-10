import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const file = normalize(join(root, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
    if (!file.startsWith(root)) throw new Error("bad path");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

await new Promise(resolve => server.listen(4173, "127.0.0.1", resolve));

const failures = [];
const check = (label, condition) => { if (!condition) failures.push(label); };

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();

  // Any uncaught script error means a module failed to evaluate.
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.omnipocketState && document.readyState !== "loading");
  await page.locator("#netWorth").waitFor();
  await page.locator("#dashboardGalaxy").waitFor();

  if ((await page.title()) !== "OmniPocket") failures.push("unexpected page title");

  // The ledger search must remain discoverable and its review/list targets must exist.
  const activityUi = await page.evaluate(() => {
    const search = document.querySelector("#activitySearch");
    return {
      type: search?.getAttribute("type"),
      label: search?.getAttribute("aria-label"),
      fullList: !!document.querySelector("#activityFullList"),
      reviewQueue: !!document.querySelector("#activityReviewQueue"),
    };
  });
  // Assert discoverability, not exact copy, so product wording can evolve safely.\n  check("activity search is not a native search input", activityUi.type === "search");
  check(`activity search has no descriptive accessible label (actual: ${JSON.stringify(activityUi.label)})`, typeof activityUi.label === "string" && activityUi.label.toLowerCase().includes("search transactions") && activityUi.label.toLowerCase().includes("account"));
  check("activity ledger container is missing", activityUi.fullList);
  check("activity review queue container is missing", activityUi.reviewQueue);

  // Focusing a normal search must preserve the query; only the internal review sentinel is cleared.
  const searchFocus = await page.evaluate(() => {
    const search = document.querySelector("#activitySearch");
    search.value = "coffee";
    search.dispatchEvent(new Event("focus"));
    const preserved = search.value;
    search.value = "__review__";
    search.dispatchEvent(new Event("focus"));
    return { preserved, reviewCleared: search.value === "" };
  });
  check("focusing activity search cleared a normal query", searchFocus.preserved === "coffee");
  check("review-only search sentinel was not cleared on focus", searchFocus.reviewCleared);

  // Pasted transaction alerts should retain an explicit ISO-style date instead of silently using today.
  const parsedAlert = await page.evaluate(() => {
    if (typeof window.parseMoneyText !== "function") return null;
    return window.parseMoneyText("Salary credited NGN 15,000 on 2026-10-25");
  });
  check("pasted transaction parser is unavailable", !!parsedAlert);
  check("pasted transaction parser lost the explicit date", parsedAlert?.date === "2026-10-25");
  check("pasted transaction parser changed the amount", parsedAlert?.amount === 15000);

  // Every module must have evaluated and exported its global.
  const globals = await page.evaluate(() =>
    ["OmniPocketStorage", "OmniPocketEngine", "OmniPocketBus", "OmniPocketBank",
     "OmniPocketArchitecture", "OmniPocketDiagnostics", "OmniPocketV1",
     "OmniPocketProduction", "OmniPocketFinancial"].filter(name => !window[name]));
  check(`modules failed to export: ${globals.join(", ")}`, globals.length === 0);

  // _build.js must supply config before app.js consumes it.
  const config = await page.evaluate(() => ({
    build: window.OMNIPOCKET_BUILD,
    url: window.OMNIPOCKET_CONFIG?.supabaseUrl || "",
    key: window.OMNIPOCKET_CONFIG?.supabasePublishableKey || "",
  }));
  check("build identity missing", config.build === "dev");
  check("supabaseUrl not sourced from _build.js", config.url.startsWith("https://"));
  check("supabasePublishableKey not sourced from _build.js", config.key.length > 10);

  // IndexedDB-backed persistence round-trips a real mutation.
  const persisted = await page.evaluate(async () => {
    const state = window.omnipocketState;
    state.accounts.push({
      id: "e2e-account", name: "E2E", type: "bank", currency: "NGN",
      openingBalance: 500, balance: 500, archived: false,
    });
    state.transactions.push({
      id: "e2e-transaction", type: "income", status: "recorded", bankStatus: "posted", amount: 125, currency: "NGN",
      date: "2026-11-09", createdAt: 1, sourceAccountId: "e2e-account",
      destinationAccountId: null, external: { provider: "mono", providerTransactionId: "e2e-provider-tx" },
    });
    state.goals.push({ id: "e2e-goal", name: "E2E goal", target: 1000, currency: "NGN", accountIds: ["e2e-account"], status: "active", createdAt: 1 });
    state.snapshots.push({ id: "e2e-snapshot", date: "2026-11-09", capturedAt: 1, baseCurrency: "NGN", value: 500, balances: [], rates: {} });
    state.deletedExternalTransactions.push({ provider: "mono", providerAccountId: "e2e-provider-account", providerTransactionId: "e2e-deleted-tx", localAccountId: "e2e-account", deletedAt: "2026-11-09T00:00:00.000Z" });
    state.schemaVersion = 8;
    if (typeof rebuildBalances === "function") rebuildBalances();
    if (typeof flushPersistence === "function") await flushPersistence();
    const store = new window.OmniPocketStorage({ dbName: "omnipocket", storeName: "state", legacyKey: "omnipocket.v1" });
    const raw = await store.load();
    const db = await store.open();
    const legacySnapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const request = tx.objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    return {
      stored: raw?.accounts?.some(a => a.id === "e2e-account") ?? false,
      transactionStored: raw?.transactions?.some(t => t.id === "e2e-transaction" && t.external?.providerTransactionId === "e2e-provider-tx") ?? false,
      goalStored: raw?.goals?.some(g => g.id === "e2e-goal") ?? false,
      snapshotStored: raw?.snapshots?.some(s => s.id === "e2e-snapshot") ?? false,
      deletionTombstoneStored: raw?.deletedExternalTransactions?.some(t => t.providerTransactionId === "e2e-deleted-tx") ?? false,
      version: raw?.schemaVersion ?? null,
      legacySnapshotRemoved: legacySnapshot === null,
    };
  });
  check("IndexedDB did not persist the mutated account", persisted.stored);
  check("normalized transaction record was not persisted", persisted.transactionStored);
  check("normalized goal record was not persisted", persisted.goalStored);
  check("normalized snapshot record was not persisted", persisted.snapshotStored);
  check("external transaction deletion tombstone was not persisted", persisted.deletionTombstoneStored);
  check("schemaVersion not persisted", persisted.version === 8);
  check("monolithic IndexedDB snapshot was not removed after normalized commit", persisted.legacySnapshotRemoved);

  // IndexedDB balance projection must be numerically identical to the domain engine.
  const balanceProjection = await page.evaluate(async () => {
    const state = {
      schemaVersion: 9,
      settings: {
        baseCurrency: "NGN",
        fx: { rates: {
          NGN: { USD: 1 / 1500, EUR: 1 / 1700 },
          USD: { NGN: 1500 },
          EUR: { NGN: 1600 }
        } }
      },
      accounts: [
        { id: "projection-ngn", currency: "NGN", openingBalance: 1000, archived: false },
        { id: "projection-usd", currency: "USD", openingBalance: 10, archived: false },
        { id: "projection-eur", currency: "EUR", openingBalance: 5, archived: false }
      ],
      transactions: [
        { id: "p-income", type: "income", amount: 100, currency: "NGN", sourceAccountId: "projection-ngn", status: "recorded", bankStatus: "posted" },
        { id: "p-expense", type: "expense", amount: -20, currency: "NGN", sourceAccountId: "projection-ngn", status: "recorded", bankStatus: "posted" },
        { id: "p-adjustment-sign", type: "adjustment", amount: 10, adjustmentSign: -1, sourceAccountId: "projection-ngn", status: "recorded", bankStatus: "posted" },
        { id: "p-adjustment-category", type: "adjustment", amount: 5, category: "Bank decrease", sourceAccountId: "projection-ngn", status: "recorded", bankStatus: "posted" },
        { id: "p-transfer-direct", type: "transfer", amount: 1500, currency: "NGN", sourceAccountId: "projection-ngn", destinationAccountId: "projection-usd", status: "recorded", bankStatus: "posted" },
        { id: "p-transfer-triangulated", type: "transfer", amount: 2, currency: "USD", sourceAccountId: "projection-usd", destinationAccountId: "projection-eur", status: "recorded", bankStatus: "posted" },
        { id: "p-transfer-received", type: "transfer", amount: 150, currency: "NGN", receivedAmount: 0.09, receivedCurrency: "USD", sourceAccountId: "projection-ngn", destinationAccountId: "projection-usd", status: "recorded", bankStatus: "posted" },
        { id: "p-withdrawal", type: "withdrawal", amount: 50, currency: "NGN", sourceAccountId: "projection-ngn", status: "recorded", bankStatus: "posted" },
        { id: "p-no-currency", type: "transfer", amount: 25, sourceAccountId: "projection-ngn", destinationAccountId: "projection-usd", status: "recorded", bankStatus: "posted" },
        { id: "p-padded-bank-status", type: "expense", amount: 999, sourceAccountId: "projection-ngn", status: "recorded", bankStatus: " pending " },
        { id: "p-padded-review-status", type: "income", amount: 999, sourceAccountId: "projection-ngn", status: " needs_review ", bankStatus: "posted" },
        { id: "p-superseded", type: "income", amount: 999, sourceAccountId: "projection-ngn", status: "superseded", bankStatus: "posted" }
      ],
      goals: [], snapshots: [], deletedExternalTransactions: []
    };
    const store = new window.OmniPocketStorage({
      dbName: "omnipocket-balance-projection-fixture",
      storeName: "state",
      legacyKey: "omnipocket.balance-projection-fixture"
    });
    await store.save(state);
    const projected = await store.getAccountBalanceSummary(state.accounts, state.settings);
    const expected = window.OmniPocketEngine.balancesAt(state);
    const balances = rows => Object.fromEntries(rows.map(row => [row.id, row.balance]));
    const actualBalances = balances(projected.accounts);
    const expectedBalances = balances(expected);
    const matches = Object.keys(expectedBalances).every(id =>
      Math.abs(actualBalances[id] - expectedBalances[id]) < 1e-8);
    return {
      matches,
      actualBalances,
      expectedBalances,
      effectiveTransactionCount: projected.effectiveTransactionCount
    };
  });
  check(`IndexedDB balance projection diverged from domain engine: ${JSON.stringify(balanceProjection)}`, balanceProjection.matches);
  check("balance projection did not exclude padded pending/review statuses", balanceProjection.effectiveTransactionCount === 9);

  // Existing v4 databases must receive all missing transaction indexes on upgrade.
  const indexUpgrade = await page.evaluate(async () => {
    const dbName = "omnipocket-index-upgrade-fixture";
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        const transactions = db.createObjectStore("transactions", { keyPath: "id" });
        transactions.createIndex("date", "date", { unique: false });
        transactions.createIndex("dateId", ["date", "id"], { unique: false });
      };
      request.onsuccess = () => { request.result.close(); resolve(true); };
      request.onerror = () => reject(request.error);
    });
    const storage = new window.OmniPocketStorage({
      dbName,
      storeName: "state",
      legacyKey: "omnipocket.index-upgrade-fixture"
    });
    const db = await storage.open();
    const names = [...db.transaction("transactions").objectStore("transactions").indexNames];
    db.close();
    return {
      legacy,
      hasSourceDateId: names.includes("sourceAccountDateId"),
      hasDestinationDateId: names.includes("destinationAccountDateId"),
      hasProviderIdentity: names.includes("providerTransactionId"),
      hasAccountIndexes: names.includes("sourceAccountDate") && names.includes("destinationAccountDate")
    };
  });
  check(`existing IndexedDB indexes were not upgraded: ${JSON.stringify(indexUpgrade)}`,
    indexUpgrade.hasSourceDateId && indexUpgrade.hasDestinationDateId &&
    indexUpgrade.hasProviderIdentity && indexUpgrade.hasAccountIndexes);

  // V2 monolithic snapshot migration: preserve the source until normalized commit.
  const v2Migration = await page.evaluate(async () => {
    const dbName = "omnipocket-v2-migration-fixture";
    const legacyState = {
      schemaVersion: 8,
      settings: { baseCurrency: "NGN" },
      accounts: [{ id: "v2-account", name: "V2 account", currency: "NGN", openingBalance: 250, balance: 250 }],
      transactions: [{ id: "v2-transaction", type: "income", amount: 25, currency: "NGN", date: "2026-11-08", createdAt: 1, sourceAccountId: "v2-account" }],
      goals: [{ id: "v2-goal", name: "V2 goal", target: 500, currency: "NGN", accountIds: ["v2-account"], status: "active", createdAt: 1 }],
      snapshots: [{ id: "v2-snapshot", date: "2026-11-08", capturedAt: 1, baseCurrency: "NGN", value: 250, balances: [], rates: {} }],
      deletedExternalTransactions: [{ provider: "mono", providerAccountId: "v2-provider-account", providerTransactionId: "v2-deleted", deletedAt: "2026-11-08T00:00:00.000Z" }],
    };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("state", "readwrite");
        tx.objectStore("state").put(legacyState, "current");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      };
    });
    const store = new window.OmniPocketStorage({ dbName, storeName: "state", legacyKey: "omnipocket.v2-fixture" });
    const legacy = await store.load();
    const sourceWasReadable = legacy?.transactions?.some(row => row.id === "v2-transaction") ?? false;
    await store.save(legacy);
    const normalized = await store.load();
    const db = await store.open();
    const oldSnapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const request = tx.objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      sourceWasReadable,
      transaction: normalized?.transactions?.some(row => row.id === "v2-transaction") ?? false,
      goal: normalized?.goals?.some(row => row.id === "v2-goal") ?? false,
      tombstone: normalized?.deletedExternalTransactions?.some(row => row.providerTransactionId === "v2-deleted") ?? false,
      oldSnapshotRemoved: oldSnapshot === null,
    };
  });
  check("V2 migration could not read its source snapshot", v2Migration.sourceWasReadable);
  check("V2 migration lost a transaction", v2Migration.transaction);
  check("V2 migration lost a goal", v2Migration.goal);
  check("V2 migration lost a provider deletion tombstone", v2Migration.tombstone);
  check("V2 migration did not remove the old snapshot after commit", v2Migration.oldSnapshotRemoved);

  // V1 localStorage migration removes the legacy copy only after IndexedDB commits.
  const v1Migration = await page.evaluate(async () => {
    const legacyKey = "omnipocket.e2e.v1-fixture";
    const dbName = "omnipocket-v1-migration-fixture";
    const legacyState = {
      schemaVersion: 7,
      settings: { baseCurrency: "NGN" },
      accounts: [{ id: "v1-account", name: "V1 account", currency: "NGN", openingBalance: 100, balance: 100 }],
      transactions: [], goals: [], snapshots: [], deletedExternalTransactions: [],
    };
    localStorage.setItem(legacyKey, JSON.stringify(legacyState));
    const store = new window.OmniPocketStorage({ dbName, storeName: "state", legacyKey });
    const legacy = await store.load();
    await store.save(legacy);
    const normalized = await store.load();
    return {
      account: normalized?.accounts?.some(row => row.id === "v1-account") ?? false,
      removed: localStorage.getItem(legacyKey) === null,
    };
  });
  check("V1 migration lost the localStorage account", v1Migration.account);
  check("V1 localStorage source was not removed after commit", v1Migration.removed);

  // Two tabs with the same starting version must not silently overwrite each other.
  const concurrentWrites = await page.evaluate(async () => {
    const dbName = "omnipocket-concurrency-fixture";
    const options = { dbName, storeName: "state", legacyKey: "omnipocket.concurrency-legacy" };
    const writerA = new window.OmniPocketStorage(options);
    await writerA.save({
      schemaVersion: 9,
      settings: { baseCurrency: "NGN" },
      accounts: [{ id: "shared-account", name: "Shared", currency: "NGN", openingBalance: 100, balance: 100 }],
      transactions: [], goals: [], snapshots: [], deletedExternalTransactions: [],
    });
    const writerB = new window.OmniPocketStorage(options);
    const stateA = await writerA.load();
    const stateB = await writerB.load();
    stateA.accounts[0].balance = 125;
    await writerA.save(stateA);
    stateB.accounts[0].balance = 150;
    let rejectedAsConflict = false;
    try { await writerB.save(stateB); }
    catch (error) { rejectedAsConflict = error?.code === "OMNI_CONFLICT"; }
    const verifier = new window.OmniPocketStorage(options);
    const latest = await verifier.load();
    const staleBeforeClear = await writerB.load();
    staleBeforeClear.accounts[0].balance = 999;
    const clearer = new window.OmniPocketStorage(options);
    await clearer.clear();
    let staleAfterClearRejected = false;
    let staleAfterClearError = null;
    try { await writerB.save(staleBeforeClear); }
    catch (error) { staleAfterClearError = error?.code || error?.message || String(error); staleAfterClearRejected = error?.code === "OMNI_CONFLICT"; }
    const afterClear = await verifier.load();
    return {
      rejectedAsConflict,
      committedBalance: latest?.accounts?.[0]?.balance ?? null,
      staleAfterClearRejected,
      staleAfterClearError,
      clearStateVersion: afterClear?.stateVersion ?? null,
      recordsAfterClear: afterClear?.accounts?.length ?? -1,
    };
  });
  check("stale second-tab write was not rejected", concurrentWrites.rejectedAsConflict);
  check("stale second-tab write overwrote the first committed balance", concurrentWrites.committedBalance === 125);
  check(`stale tab resurrected the ledger after another tab cleared it (rejected=${concurrentWrites.staleAfterClearRejected}, error=${concurrentWrites.staleAfterClearError}, version=${concurrentWrites.clearStateVersion}, accounts=${concurrentWrites.recordsAfterClear})`, concurrentWrites.staleAfterClearRejected && concurrentWrites.recordsAfterClear === 0);

  // The financial engine runs against live DOM state.
  const engine = await page.evaluate(() => {
    const state = window.omnipocketState;
    const materialized = window.OmniPocketEngine.balancesAt(state);
    return {
      accounts: materialized.length,
      netWorth: window.OmniPocketEngine.netWorth(state, materialized),
      bankTotal: window.OmniPocketFinancial.availableWealth(state).netWorth,
    };
  });
  check("balancesAt lost the injected account", engine.accounts >= 1);
  check("netWorth is not a number", Number.isFinite(engine.netWorth));
  check("availableWealth disagrees with netWorth", Math.abs(engine.bankTotal - engine.netWorth) < 0.01);

  // Activity now reads each bounded page from the normalized IndexedDB cursor.
  const activityPagination = await page.evaluate(async () => {
    const state = window.omnipocketState;
    const original = state.transactions;
    state.transactions = Array.from({ length: 123 }, (_, index) => {
      const id = "TX-" + String(index + 1).padStart(6, "0");
      return {
        id, type: "expense", amount: index + 1, currency: "NGN",
        category: "Test", description: id, date: "2026-10-" + String((index % 28) + 1).padStart(2, "0"),
        createdAt: index + 1, status: "recorded", bankStatus: "posted",
        sourceAccountId: null, destinationAccountId: null,
      };
    });
    const storage = window.OmniPocketStorageInstance;
    await storage.save(state);
    const list = document.getElementById("activityFullList");
    const search = document.getElementById("activitySearch");
    // Force a real filter transition so the cursor is reset after replacing the
    // fixture ledger, even when the prior page already used an empty query.
    search.value = "__activity_refresh__";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return false;
    };
    await waitFor(() => list.querySelectorAll(".activity-row").length === 50);
    const firstPage = list.querySelectorAll(".activity-row").length;
    list.querySelector("[data-activity-load-more]")?.click();
    await waitFor(() => list.querySelectorAll(".activity-row").length === 100);
    const secondPage = list.querySelectorAll(".activity-row").length;
    search.value = "TX-000120";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => list.querySelectorAll(".activity-row").length === 1);
    const filteredPage = list.querySelectorAll(".activity-row").length;
    const filteredText = list.querySelector(".activity-row")?.dataset.transactionId === "TX-000120";
    state.transactions = original;
    await storage.save(state);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    return { firstPage, secondPage, filteredPage, filteredText };
  });
  check("Activity first page should be fetched as 50 indexed rows", activityPagination.firstPage === 50);
  check("Activity load-more should append the next indexed 50 rows", activityPagination.secondPage === 100);
  check("Activity indexed search should reset the cursor and return only matches", activityPagination.filteredPage === 1 && activityPagination.filteredText);

  // The normalized storage API must page by a compound date/id cursor without gaps.
  const indexedTransactionPaging = await page.evaluate(async () => {
    const dbName = "omnipocket-cursor-page-smoke";
    const storage = new window.OmniPocketStorage({
      dbName, storeName: "state", legacyKey: "omnipocket.cursor.page"
    });
    const transactions = Array.from({ length: 123 }, (_, index) => ({
      id: "PAGE-" + String(index + 1).padStart(4, "0"),
      date: "2026-10-15", amount: index + 1, currency: "NGN",
      type: "expense", status: "recorded", category: index % 2 ? "Food" : "Travel",
      sourceAccountId: index % 2 ? "account-a" : "account-b",
    }));
    await storage.save({
      schemaVersion: 8, settings: {}, accounts: [], transactions,
      goals: [], snapshots: [], deletedExternalTransactions: []
    });
    const first = await storage.getTransactionPage({ limit: 50 });
    const second = await storage.getTransactionPage({ limit: 50, cursor: first.nextCursor });
    const third = await storage.getTransactionPage({ limit: 50, cursor: second.nextCursor });
    const ranged = await storage.getTransactionPage({
      limit: 20, fromDate: "2026-10-15", toDate: "2026-10-15",
      accountId: "account-a", category: "Food"
    });
    await storage.save({
      schemaVersion: 8, settings: {}, accounts: [], goals: [], snapshots: [],
      deletedExternalTransactions: [],
      transactions: [
        { id: "FILTER-REVIEW", date: "2026-10-16", type: "expense", status: "needs_review", amount: 10, currency: "NGN", category: "Food", description: "Coffee shop", sourceAccountId: "account-a" },
        { id: "FILTER-PENDING", date: "2026-10-16", type: "expense", status: "recorded", bankStatus: "pending", amount: 11, currency: "NGN", category: "Food", description: "Pending transfer", sourceAccountId: "account-a" },
        { id: "FILTER-LOW-CONFIDENCE", date: "2026-10-16", type: "expense", status: "recorded", amount: 12, currency: "NGN", category: "Other", description: "Unknown merchant", external: { provider: "mono" }, suggestedCategory: "Food", categoryConfidence: 0.4 },
        { id: "FILTER-SUPERSEDED", date: "2026-10-16", type: "expense", status: "superseded", amount: 13, currency: "NGN", description: "Paired leg" }
      ]
    });
    const review = await storage.getTransactionPage({ reviewOnly: true });
    const pending = await storage.getTransactionPage({ status: "pending" });
    const search = await storage.getTransactionPage({ searchTokens: ["coffee", "shop"] });
    const includeSuperseded = await storage.getTransactionPage({ includeSuperseded: true });
    const ids = [...first.items, ...second.items, ...third.items].map(row => row.id);
    return {
      pageSizes: [first.items.length, second.items.length, third.items.length],
      hasMore: [first.hasMore, second.hasMore, third.hasMore],
      uniqueIds: new Set(ids).size,
      totalIds: ids.length,
      cursorOrder: first.items[0]?.id > first.items[49]?.id,
      rangeMatches: ranged.items.every(row => row.sourceAccountId === "account-a" && row.category === "Food"),
      rangeCount: ranged.items.length,
      reviewIds: review.items.map(row => row.id).sort(),
      pendingIds: pending.items.map(row => row.id),
      searchIds: search.items.map(row => row.id),
      supersededIncluded: includeSuperseded.items.some(row => row.id === "FILTER-SUPERSEDED"),
    };
  });
  check("indexed transaction cursor paging returned incorrect page sizes", JSON.stringify(indexedTransactionPaging.pageSizes) === JSON.stringify([50, 50, 23]));
  check("indexed transaction cursor paging has incorrect continuation flags", JSON.stringify(indexedTransactionPaging.hasMore) === JSON.stringify([true, true, false]));
  check("indexed transaction cursor paging repeated or skipped records", indexedTransactionPaging.uniqueIds === 123 && indexedTransactionPaging.totalIds === 123);
  check("compound cursor order is not stable for same-date transactions", indexedTransactionPaging.cursorOrder);
  check("indexed transaction filters returned records outside the requested scope", indexedTransactionPaging.rangeMatches && indexedTransactionPaging.rangeCount > 0);
  check("review-only cursor filter omitted review-flagged records", JSON.stringify(indexedTransactionPaging.reviewIds) === JSON.stringify(["FILTER-LOW-CONFIDENCE", "FILTER-REVIEW"]));
  check("bank pending filter did not use bank lifecycle status", JSON.stringify(indexedTransactionPaging.pendingIds) === JSON.stringify(["FILTER-PENDING"]));
  check("indexed free-text search did not match all tokens", JSON.stringify(indexedTransactionPaging.searchIds) === JSON.stringify(["FILTER-REVIEW"]));
  check("superseded rows could not be explicitly included for review", indexedTransactionPaging.supersededIncluded);

  check("indexed transaction cursor paging returned incorrect page sizes", JSON.stringify(indexedTransactionPaging.pageSizes) === JSON.stringify([50, 50, 23]));
  check("indexed transaction cursor paging has incorrect continuation flags", JSON.stringify(indexedTransactionPaging.hasMore) === JSON.stringify([true, true, false]));
  check("indexed transaction cursor paging repeated or skipped records", indexedTransactionPaging.uniqueIds === 123 && indexedTransactionPaging.totalIds === 123);
  check("compound cursor order is not stable for same-date transactions", indexedTransactionPaging.cursorOrder);
  check("indexed transaction filters returned records outside the requested scope", indexedTransactionPaging.rangeMatches && indexedTransactionPaging.rangeCount > 0);



  // A single-account history is the union of indexed outgoing/incoming streams.
  // Self-transfers appear in both indexes and must be de-duplicated before paging.
  const accountIndexedPaging = await page.evaluate(async () => {
    const storage = new window.OmniPocketStorage({
      dbName: "omnipocket-account-index-page-smoke",
      storeName: "state",
      legacyKey: "omnipocket.account-index-page"
    });
    const date = "2026-11-09";
    await storage.save({
      schemaVersion: 8, settings: {}, accounts: [], goals: [], snapshots: [],
      deletedExternalTransactions: [],
      transactions: [
        { id: "TX-001", date, type: "expense", amount: 1, sourceAccountId: "account-a" },
        { id: "TX-002", date, type: "income", amount: 2, destinationAccountId: "account-a" },
        { id: "TX-003", date, type: "transfer", amount: 3, sourceAccountId: "account-a", destinationAccountId: "account-a" },
        { id: "TX-004", date, type: "expense", amount: 4, sourceAccountId: "account-a" },
        { id: "TX-005", date, type: "expense", amount: 5, sourceAccountId: "account-b" },
        { id: "TX-006", date, type: "transfer", amount: 6, sourceAccountId: "account-a", destinationAccountId: "account-b" },
        { id: "TX-006", date, type: "transfer", amount: 6, sourceAccountId: "account-a", destinationAccountId: "account-b" }
      ]
    });
    const first = await storage.getTransactionPage({ accountId: "account-a", limit: 2 });
    const second = await storage.getTransactionPage({ accountId: "account-a", limit: 2, cursor: first.nextCursor });
    const multi = await storage.getTransactionPage({ accountIds: ["account-a", "account-b"], limit: 10 });

    const multi = await storage.getTransactionPage({ accountIds: ["account-a", "account-b"], limit: 10 });

    const ids = [...first.items, ...second.items].map(item => item.id);
    return {
      firstIds: first.items.map(item => item.id),
      secondIds: second.items.map(item => item.id),
      hasMore: [first.hasMore, second.hasMore],
      ids,
      uniqueCount: new Set(ids).size,
      multiIds: multi.items.map(item => item.id),
      multiUniqueCount: new Set(multi.items.map(item => item.id)).size,
      multiIds: multi.items.map(item => item.id),
      multiUniqueCount: new Set(multi.items.map(item => item.id)).size
    };
  });
  check("account-index page did not merge outgoing and incoming transactions in descending order",
    JSON.stringify(accountIndexedPaging.firstIds) === JSON.stringify(["TX-004", "TX-003"]) &&
    JSON.stringify(accountIndexedPaging.secondIds) === JSON.stringify(["TX-002", "TX-001"]));
  check("account-index paging repeated self-transfers or included another account's transactions",
    accountIndexedPaging.ids.length === 4 && accountIndexedPaging.uniqueCount === 4 &&
    !accountIndexedPaging.ids.includes("TX-005"));
  check("multi-account indexed paging missed transfers or duplicated entries between selected accounts",
    JSON.stringify(accountIndexedPaging.multiIds) === JSON.stringify(["TX-006", "TX-005", "TX-004", "TX-003", "TX-002", "TX-001"]) &&
    accountIndexedPaging.multiUniqueCount === 6);
  check("multi-account indexed paging missed transfers or duplicated entries between selected accounts",
    JSON.stringify(accountIndexedPaging.multiIds) === JSON.stringify(["TX-006", "TX-005", "TX-004", "TX-003", "TX-002", "TX-001"]) &&
    accountIndexedPaging.multiUniqueCount === 6);
  check("account-index cursor did not preserve page continuation",
    JSON.stringify(accountIndexedPaging.hasMore) === JSON.stringify([true, false]));




  // Bank projection helpers expose the Mono adapter.
  const bank = await page.evaluate(() => ({
    states: window.OmniPocketBank.STATES.length,
    provider: window.OmniPocketBank.getProvider("mono")?.name,
    diagnostics: window.OmniPocketArchitecture.diagnostics().build,
  }));
  check("bank-core states missing", bank.states > 0);
  check("mono adapter not registered", bank.provider === "Mono");
  check("architecture build does not come from _build.js", bank.diagnostics === "dev");

  // Goal selection must not inherit a stale account scope.
  const scope = await page.evaluate(() => {
    window.OmniPocketBus.selectAccount("some-account");
    return window.OmniPocketBus.selectGoal("some-goal").scope;
  });
  check(`selectGoal leaked account scope (got "${scope}")`, scope === "goal");

  check(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`, pageErrors.length === 0);

  if (failures.length) {
    throw new Error(`Playwright smoke failed:\n  - ${failures.join("\n  - ")}`);
  }
  console.log("OmniPocket Playwright smoke passed");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}