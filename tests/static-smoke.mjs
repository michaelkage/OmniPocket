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
];
for (const file of files) assert(fs.existsSync(file), `Missing required asset: ${file}`);

const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const build = fs.readFileSync("_build.js", "utf8");

for (const marker of ["supabase-js", "bank-core.js", "architecture.js", "diagnostics.js"]) {
  assert(html.includes(marker), `Missing integration marker: ${marker}`);
}
for (const marker of ["mono-exchange-token", "mono-account-sync", "omnipocket-payment-initiate"]) {
  assert(app.includes(marker), `Missing app integration marker: ${marker}`);
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

console.log("OmniPocket static smoke tests passed");