import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

process.env.TZ = "Africa/Lagos";
const context = { console, Date, Math, Number, String, Set, Map, JSON, Intl, structuredClone };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("importer.js", "utf8"), context);

assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeStatementDate("2026-10-29"))), {
  valid: true, date: "2026-10-29"
});
assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeStatementDate("29/10/2026"))), {
  valid: true, date: "2026-10-29"
});
assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeStatementDate("2026-02-30"))), {
  valid: false
});
console.log("OmniPocket statement date tests passed");
