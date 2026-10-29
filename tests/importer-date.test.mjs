import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

process.env.TZ = "Africa/Lagos";
const context = { console, Date, Math, Number, String, Set, Map, JSON, Intl, structuredClone };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("importer.js", "utf8"), context);

const parsed = JSON.parse(JSON.stringify(context.parseStatementCsv(
  'Date,Description,Amount\\r\\n2026-10-29,"Transfer, savings",1250\\r\\n2026-10-28,"Cafe ""Central""",-450'
)));
assert.deepEqual(parsed.headers, ["Date", "Description", "Amount"]);
assert.equal(parsed.rows.length, 2);
assert.equal(parsed.rows[0].Description, "Transfer, savings");
assert.equal(parsed.rows[1].Description, 'Cafe "Central"');
assert.equal(parsed.rows[1].Amount, "-450");
console.log("OmniPocket statement date tests passed");
