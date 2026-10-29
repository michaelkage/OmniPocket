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
assert(/const CACHE="omnipocket-shell-v\\d+"/.test(sw), "service worker must version its shell cache");
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
assert(storage.includes("localStorage.removeItem(this.legacyKey)"), "clearing storage must also remove the legacy fallback to prevent data resurrection");
assert(app.includes("persistenceReady = false;"), "failed IndexedDB saves must switch persistence to local fallback");
assert(app.includes("Could not persist OmniPocket state to local storage."), "local fallback failures must be reported independently");

console.log("OmniPocket static smoke tests passed");