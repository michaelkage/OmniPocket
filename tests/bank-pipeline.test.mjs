import assert from "node:assert/strict";
import fs from "node:fs";

const sync = fs.readFileSync("supabase/functions/mono-account-sync/index.ts","utf8");
const exchange = fs.readFileSync("supabase/functions/mono-exchange-token/index.ts","utf8");
const app = fs.readFileSync("app.js","utf8");
const accounts = fs.readFileSync("accounts-ui.js","utf8");
const config = fs.readFileSync("supabase/config.toml","utf8");
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/mono-transactions.json","utf8"));

assert.match(sync, /const amountUnit = Deno\.env\.get\("MONO_AMOUNT_UNIT"\) \|\| "minor"/);
assert.match(sync, /transactions\s*\.map\(\(tx: any\) => normalizeTransaction\(tx, amountUnit\)\)/);
assert.match(exchange, /const amountUnit = Deno\.env\.get\("MONO_AMOUNT_UNIT"\) \|\| "minor"/);
assert.match(exchange, /transactions\s*\.map\(\(tx: any\) => normalizeTransaction\(tx, amountUnit\)\)/);
assert.match(sync, /bank_status: \["pending", "posted", "reversed", "failed"\]/);
assert.match(exchange, /bank_status: \["pending", "posted", "reversed", "failed"\]/);
assert.match(exchange, /function unwrapTransactions\(payload: any\): any\[\] \| null/);
assert.match(exchange, /if \(!Array\.isArray\(transactions\)\)/);
assert.match(sync, /provider_balance_minor/);
assert.match(sync, /bank_sync_events/);
assert.match(sync, /function unwrapTransactions\(payload: any\): any\[\] \| null/);
assert.match(sync, /if \(transactions === null\)/);
assert.match(sync, /unexpected transaction response/);
assert.doesNotMatch(sync, /amountFromProvider\(account\.balance, amountUnit\).*amountUnit/);

const expectedNgn = Number(fixture.data[0].amount) / 100;
assert.equal(expectedNgn, 15000, "Mono fixture must remain interpreted as minor units");
assert.equal(Number(fixture.data[1].balance) / 100, 243320, "Fixture balance normalization must remain stable");

const bankConnection = fs.readFileSync("bank-connection.js","utf8");
assert.match(bankConnection, /const isFirstProviderSync=!local\.connection\?\.lastSyncedAt/);
assert.match(bankConnection, /if\(isFirstProviderSync\)\{local\.openingBalance=currentBalance-importedNet;\}/);
assert.match(bankConnection, /bankStatus=tx\.bank_status\|\|tx\.bankStatus\|\|"posted"/);
assert.match(bankConnection, /!\["pending","failed","reversed"\]\.includes\(bankStatus\).*importedNet\+=credit\?amount:-amount/);
assert.match(bankConnection, /Array\.isArray\(transactionPayload\?\.data\)\?transactionPayload\.data:null/);
assert.match(bankConnection, /if\(!rawTransactions\)throw new Error\("Mono returned an unexpected transaction feed/);
assert.match(bankConnection, /Mono returned an invalid account balance; the account was not updated/);
assert.match(bankConnection, /existing\.bankStatus=bankStatus/);
assert.match(bankConnection, /rebuildBalances\(\);local\.connection=\{/);
assert.match(accounts, /window\.OmniPocketBank\?\.freshness/);
assert.match(config, /\[functions\.mono-webhook\][\s\S]*verify_jwt = false/);
assert.doesNotMatch(sync, /Access-Control-Allow-Origin": "\*"/);
assert.doesNotMatch(exchange, /Access-Control-Allow-Origin": "\*"/);

console.log("OmniPocket bank pipeline contract tests passed");
