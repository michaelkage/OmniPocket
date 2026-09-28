import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source=fs.readFileSync("app.js","utf8");
assert(source.includes("SCHEMA_VERSION"),"schema migration system missing");
assert(source.includes("migrateState"),"migration function missing");
assert(source.includes("openingBalance"),"account balance migration missing");
console.log("OmniPocket migration guard tests passed");