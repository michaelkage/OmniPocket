import assert from "node:assert/strict";
import fs from "node:fs";

const sync = fs.readFileSync("supabase/functions/mono-account-sync/index.ts","utf8");
const exchange = fs.readFileSync("supabase/functions/mono-exchange-token/index.ts","utf8");
const app = fs.readFileSync("app.js","utf8");
const accounts = fs.readFileSync("accounts-ui.js","utf8");
const config = fs.readFileSync("supabase/config.toml","utf8");
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/mono-transactions.json","utf8"));

assert.match(sync, /const amountUnit = Deno\.env\.get\("MONO_AMOUNT_UNIT"\) \|\| "minor"/);
assert.match(sync, /transactions\.map\(\(tx: any\) => normalizeTransaction\(tx, amountUnit\)\)/);
assert.match(exchange, /const amountUnit = Deno\.env\.get\("MONO_AMOUNT_UNIT"\) \|\| "minor"/);
assert.match(exchange, /transactions\.map\(\(tx: any\) => normalizeTransaction\(tx, amountUnit\)\)/);
assert.match(sync, /provider_balance_minor/);
assert.match(sync, /transactionsInserted: insertedCount/);
assert.match(sync, /transactionsUpdated: updatedCount/);
assert.match(sync, /Skipping Mono transaction without a stable provider ID/);
assert.match(exchange, /transactionsInserted: insertedCount/);
assert.match(exchange, /transactionsUpdated: updatedCount/);
assert.match(exchange, /Skipping Mono transaction without a stable provider ID/);
assert.match(sync, /imported_count: insertedCount/);
assert.match(exchange, /imported_count: insertedCount/);
assert.match(sync, /fetched_count: transactions\.length/);
assert.match(exchange, /fetched_count: transactions\.length/);
assert.doesNotMatch(sync, /crypto\.randomUUID\(\)/);
assert.doesNotMatch(exchange, /crypto\.randomUUID\(\)/);
assert.match(sync, /bank_sync_events/);
assert.doesNotMatch(sync, /amountFromProvider\(account\.balance, amountUnit\).*amountUnit/);

const expectedNgn = Number(fixture.data[0].amount) / 100;
assert.equal(expectedNgn, 15000, "Mono fixture must remain interpreted as minor units");
assert.equal(Number(fixture.data[1].balance) / 100, 243320, "Fixture balance normalization must remain stable");

const bankConnection = fs.readFileSync("bank-connection.js","utf8");
assert.match(bankConnection, /const isFirstProviderSync=!local\.connection\?\.lastSyncedAt/);
assert.match(bankConnection, /if\(isFirstProviderSync\)\{local\.openingBalance=currentBalance-importedNet;\}/);
assert.match(bankConnection, /rebuildBalances\(\);local\.connection=\{/);
assert.match(accounts, /window\.OmniPocketBank\?\.freshness/);
assert.match(config, /\[functions\.mono-webhook\][\s\S]*verify_jwt = false/);
assert.doesNotMatch(sync, /Access-Control-Allow-Origin": "\*"/);
assert.doesNotMatch(exchange, /Access-Control-Allow-Origin": "\*"/);

console.log("OmniPocket bank pipeline contract tests passed");
