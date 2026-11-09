import assert from "node:assert/strict";
import fs from "node:fs";

const files = [
  "index.html", "styles.css", "sw.js", "manifest.webmanifest", "favicon.svg", "_build.js",
  "app.js", "domain.js", "storage.js", "bus.js", "bank-core.js", "architecture.js",
  "diagnostics.js", "v1-completion.js", "production-hardening.js", "financial-services.js",
  "supabase-client.js",
  "bank-connection.js",
  "bank-sync-ui.js",
  "payments-ui.js",
  "importer.js",
  "quick-entry-ui.js",
  "transfer-helpers.js",
  "goals-ui.js",
  "accounts-ui.js",
];
for (const file of files) assert(fs.existsSync(file), `Missing required asset: ${file}`);

const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const build = fs.readFileSync("_build.js", "utf8");

for (const marker of ["supabase-js", "bank-core.js", "architecture.js", "diagnostics.js"]) {
  assert(html.includes(marker), `Missing integration marker: ${marker}`);
}
const allApp = [app, fs.readFileSync("bank-connection.js", "utf8"), fs.readFileSync("bank-sync-ui.js", "utf8"), fs.readFileSync("payments-ui.js", "utf8"), fs.readFileSync("quick-entry-ui.js", "utf8"), fs.readFileSync("transfer-helpers.js", "utf8"), fs.readFileSync("goals-ui.js", "utf8"), fs.readFileSync("accounts-ui.js", "utf8"), fs.readFileSync("importer.js", "utf8")].join("\n");
for (const marker of ["mono-exchange-token", "mono-account-sync", "omnipocket-payment-initiate"]) {
  assert(allApp.includes(marker), `Missing app integration marker: ${marker}`);
}

// app.js reads window.OMNIPOCKET_CONFIG at parse time, so _build.js must load first.
const buildTag = html.indexOf('src="_build.js"');
const appTag = html.indexOf('src="app.js"');
assert(buildTag !== -1, "_build.js must be loaded by index.html");
assert(appTag !== -1, "app.js must be loaded by index.html");
assert(buildTag < appTag, "_build.js must be loaded before app.js");

// app.js calls supabaseFunction/getSupabaseClient at runtime, so the integration
// boundary must be evaluated first.
const clientTag = html.indexOf('src="supabase-client.js"');
assert(clientTag !== -1, "supabase-client.js must be loaded by index.html");
assert(clientTag < appTag, "supabase-client.js must be loaded before app.js");

const client = fs.readFileSync("supabase-client.js", "utf8");
for (const symbol of ["getSupabaseClient", "ensureSupabaseSession", "supabaseFunction"]) {
  assert(client.includes(`function ${symbol}`), `${symbol} must live in supabase-client.js`);
  assert(!app.includes(`function ${symbol}`), `${symbol} must not remain in app.js`);
}
assert(!/areyxlydzqzlzmgzavpi\.supabase\.co/.test(client + app), "Supabase URL must not be hardcoded");

// Every same-origin script the page loads must be in the service worker cache,
// otherwise the PWA serves index.html in place of the missing JS when offline.
const sw = fs.readFileSync("sw.js", "utf8");
assert(/const CACHE="omnipocket-shell-v\d+"/.test(sw), "service worker must version its shell cache");
assert(sw.includes('const CACHE="omnipocket-shell-v19"'), "shell cache must be bumped when the app shell changes");
const cacheLine = sw.split("\n").find(line => line.includes("const ASSETS="));
assert(cacheLine, "sw.js must declare an ASSETS list");
for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
  const src = match[1];
  if (!src.startsWith(".")) continue; // skip CDN scripts
  assert(cacheLine.includes(`"./${src}"`), `sw.js cache is missing ${src}`);
}
for (const src of files.filter(f => f.endsWith(".js") && f !== "sw.js")) {
  assert(cacheLine.includes(`"./${src}"`), `sw.js cache is missing ${src}`);
}

// Config must not be hardcoded in app.js any more.
assert(build.includes("OMNIPOCKET_CONFIG"), "_build.js must define the runtime config");
assert(!/areyxlydzqzlzmgzavpi\.supabase\.co/.test(app), "Supabase URL must not be hardcoded in app.js");
assert(!/sb_publishable_/.test(app), "Supabase publishable key must not be hardcoded in app.js");
assert(app.includes('merchantName: String(t.external.merchantName || "").trim().slice(0, 160) || null'), "transaction migration must preserve bounded external merchant names for learned categorisation");
assert(app.includes('if (!CURRENCIES.includes(next.settings.baseCurrency)) next.settings.baseCurrency = "NGN";'), "migration must replace unsupported persisted base currencies with NGN");
assert(app.includes("const finiteOrZero = value => Number.isFinite(Number(value)) ? Number(value) : 0;"), "migration must normalize non-finite financial values");
assert(app.includes("balance: finiteOrZero(a.balance)"), "account balances must not retain Infinity or NaN from persisted state");
assert(app.includes("amount: Math.abs(finiteOrZero(t.amount))"), "transaction amounts must be finite after migration");
assert(app.includes("Math.abs(finiteOrZero(t.receivedAmount))"), "received amounts must be finite after migration");
assert(app.includes("Number.isFinite(Number(t.fxRate)) && Number(t.fxRate) > 0"), "invalid or non-positive FX rates must be discarded during migration");
assert(app.includes("value: finiteOrZero(s.value)"), "snapshot values must be finite after migration");
assert(app.includes("const accountIds = new Set(next.accounts.map(account => account.id));"), "migration must build the valid account reference set");
assert(app.includes("const transactionIds = new Set(next.transactions.map(transaction => transaction.id));"), "migration must build the valid transaction reference set");
assert(app.includes("if (transaction.sourceAccountId && !accountIds.has(transaction.sourceAccountId)) transaction.sourceAccountId = null;"), "orphaned transaction source accounts must be cleared");
assert(app.includes("if (transaction.destinationAccountId && !accountIds.has(transaction.destinationAccountId)) transaction.destinationAccountId = null;"), "orphaned transaction destination accounts must be cleared");
assert(app.includes("transaction.suggestedPairCandidates.filter(id => id !== transaction.id && transactionIds.has(id))"), "transfer suggestions must not retain missing or self references");
assert(app.includes("transaction.linkedGoalIds = [...new Set(transaction.linkedGoalIds.filter(id => typeof id === \"string\" && goalIds.has(id)))]"), "transaction goal links must reference existing goals only");
assert(app.includes("goal.accountIds = [...new Set(goal.accountIds.filter(id => typeof id === \"string\" && accountIds.has(id)))]"), "goal account links must reference existing accounts only");
assert(app.includes("transaction.potentialDuplicateStatus = null;"), "orphaned duplicate links must also clear their review status");
// The prompt's help text may mention the test_pk_ prefix; a real key may not be inlined.
assert(!/["']test_pk_\w{8,}["']/.test(app), "Mono public key must not be hardcoded in app.js");
assert(/window\.OMNIPOCKET_CONFIG/.test(app), "app.js must read the runtime config");

// Persistence writes must be serialized to prevent stale IndexedDB snapshots winning races.
assert(app.includes("let persistenceQueue = Promise.resolve()"), "persistence must have a serialized write queue");
assert(app.includes("persistenceQueue = persistenceQueue.catch(() => {}).then(async () =>"), "each persistence snapshot must wait for the prior write");
assert(app.includes("return persistenceQueue;"), "flushPersistence must expose the queued write for deterministic callers");
const storage = fs.readFileSync("storage.js", "utf8");
assert(storage.includes("if (this.dbPromise === tracked) this.dbPromise = null"), "failed IndexedDB opens must be retryable");
assert(storage.includes("if (settled) {\n          db.close();"), "late IndexedDB opens must close their connection");
assert(storage.includes("tx.onabort = () => reject(tx.error || new Error(\"OmniPocket clear was aborted.\"))"), "storage clear must reject on aborted transactions");
assert(storage.includes("OmniPocket read was aborted."), "storage reads must reject on aborted transactions");
assert(storage.includes("tx.oncomplete = () => resolve(result)"), "storage reads must wait for transaction completion before resolving");
assert(storage.includes("localStorage.removeItem(this.legacyKey)"), "clearing and migration must remove the legacy fallback to prevent stale data resurrection");
const legacyMigration = storage.slice(storage.indexOf("// One-time migration from the V1 localStorage snapshot"), storage.indexOf("    return null;", storage.indexOf("// One-time migration from the V1 localStorage snapshot")));
assert(legacyMigration.indexOf("await this.save(legacy);") < legacyMigration.indexOf("localStorage.removeItem(this.legacyKey);"), "legacy localStorage data must only be removed after its IndexedDB write commits");
assert(app.includes("persistenceReady = false;"), "failed IndexedDB saves must switch persistence to local fallback");
const persistenceBlock = app.slice(app.indexOf("function flushPersistence()"), app.indexOf("function account(id)"));
assert(persistenceBlock.includes("await storage.save(snapshot);\n        return;"), "healthy IndexedDB writes must return without a synchronous localStorage mirror");
assert(persistenceBlock.includes("if (persistenceReady)"), "IndexedDB must remain the primary persistence path");
assert(persistenceBlock.includes("localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));"), "localStorage must remain available as a compatibility fallback");
assert(persistenceBlock.indexOf("await storage.save(snapshot);") < persistenceBlock.indexOf("localStorage.setItem(STORAGE_KEY"), "localStorage fallback must only run after IndexedDB is unavailable or fails");
assert(app.includes("Could not persist OmniPocket state to local storage."), "local fallback failures must be reported independently");

// Transaction receipts must remain privacy-aware, safely escaped, and honestly labelled.
const receiptRows = app.slice(app.indexOf("function transactionReceiptRows"), app.indexOf("function openTransactionDetail"));
assert(receiptRows.includes("function transactionReceiptCode(t)"), "receipt record IDs must be generated");
assert(receiptRows.includes("function transactionReceiptText(t)"), "shareable receipt text must be generated");
assert(receiptRows.includes('hidden && (label==="Received" || label==="Exchange rate")'), "shared receipt must mask received amount and FX rate in privacy mode");
assert(receiptRows.includes('const amount=hidden?"Hidden · Privacy mode":money(t.amount,t.currency)'), "shared receipt must mask its primary amount in privacy mode");
assert(receiptRows.includes("Locally generated record. Not bank-issued proof of payment."), "shared receipt must not imply bank-issued proof");
assert(receiptRows.includes('if(navigator.clipboard?.writeText)'), "receipt copy must use the Clipboard API when available");
assert(receiptRows.includes('document.execCommand("copy")'), "receipt copy must retain a legacy-browser fallback");
assert(receiptRows.includes("navigator.share"), "receipt sharing must use the native share API when available");
assert(receiptRows.includes("Sharing is unavailable here. Receipt details copied instead."), "unsupported native sharing must fall back to copying");
assert(receiptRows.includes("escapeHtml(value)"), "receipt row values must be escaped before HTML rendering");
assert(receiptRows.includes('dialog.querySelector("[data-receipt-copy]")'), "receipt copy control must be wired");
assert(receiptRows.includes('dialog.querySelector("[data-receipt-share]")'), "receipt share control must be wired");
assert(receiptRows.includes('dialog.querySelector("[data-receipt-print]")'), "receipt print control must be wired");

console.log("OmniPocket static smoke tests passed");