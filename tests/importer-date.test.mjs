import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

process.env.TZ = "Africa/Lagos";
const context = { console, Date, Math, Number, String, Set, Map, JSON, Intl, structuredClone };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("importer.js", "utf8"), context);

const appSource = fs.readFileSync("app.js", "utf8");
const localDateStart = appSource.indexOf("const localDateString = (date = new Date()) =>");
const localDateEnd = appSource.indexOf("\\nconst today =", localDateStart);
assert(localDateStart >= 0 && localDateEnd > localDateStart);
vm.runInContext(appSource.slice(localDateStart, localDateEnd), context);
assert.equal(context.localDateString(new Date(2026, 9, 29, 0, 15)), "2026-10-29", "local calendar dates must not be shifted through UTC");

const dateStart = appSource.indexOf("function normalizeStatementDate(value) {");
const dateEnd = appSource.indexOf("\n}\n\nfunction parseStatementAmount", dateStart) + 2;
assert(dateStart >= 0 && dateEnd > dateStart);
vm.runInContext(appSource.slice(dateStart, dateEnd), context);
assert.equal(context.normalizeStatementDate("2026-10-29"), "2026-10-29");
assert.equal(context.normalizeStatementDate("29/10/2026"), "2026-10-29");
assert.equal(context.normalizeStatementDate("2026-02-30"), "");
console.log("OmniPocket statement import tests passed");
