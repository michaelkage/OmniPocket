import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
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
    window.omnipocketState.accounts.push({
      id: "e2e-account", name: "E2E", type: "bank", currency: "NGN",
      openingBalance: 500, balance: 500, archived: false,
    });
    window.omnipocketState.schemaVersion = 8;
    if (typeof flushPersistence === "function") await flushPersistence();
    const store = new window.OmniPocketStorage({ dbName: "omnipocket", storeName: "state", legacyKey: "omnipocket.v1" });
    const raw = await store.load();
    return { stored: raw?.accounts?.some(a => a.id === "e2e-account") ?? false, version: raw?.schemaVersion ?? null };
  });
  check("IndexedDB did not persist the mutated account", persisted.stored);
  check("schemaVersion not persisted", persisted.version === 8);

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