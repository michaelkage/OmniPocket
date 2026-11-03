import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const state = {
  transactions: [{
    id: "mono-row",
    external: { provider: "mono", providerTransactionId: "a|2026-10-29|-250.00|market purchase|ref-1" },
  }],
};
const imported = [];
const context = {
  console, Date, Math, Number, String, Set, Map, JSON, Intl,
  state,
  account: id => id === "cash" ? { id: "cash", currency: "NGN" } : null,
  suggestTransactionCategory: () => null,
  suggestTransactionHandling: () => null,
  findTransferCounterpart: () => null,
  importTransaction: tx => {
    const record = { id: "statement-" + (imported.length + 1), ...tx };
    state.transactions.push(record);
    imported.push(record);
    return { transaction: record };
  },
  refreshTransferPairSuggestions: () => {},
  rebuildBalances: () => {},
  saveState: () => {},
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("importer.js", "utf8"), context);

// CSV parsing preserves quoted commas and escaped quotes.
const parsed = context.parseStatementCsv('Date,Description,Amount,Reference\n29/10/2026,"MARKET, ""IKEJA""",-250.00,REF-1');
assert.equal(parsed.rows[0].Description, 'MARKET, "IKEJA"');

const csv = [
  "Date,Description,Amount,Reference",
  "29/10/2026,Market purchase,-250.00,REF-1",
  "29/10/2026,Market purchase,-250.00,REF-1",
  "not-a-date,Invalid row,-10.00,REF-2",
].join("\n");
const preview = context.previewStatementImport(csv, "cash");
assert.equal(preview.invalidCount, 1);
assert.equal(preview.duplicateCount, 0, "a matching Mono provider ID must not be mistaken for a statement-import duplicate");
assert.equal(preview.rows.length, 3);

// Both identical rows in one file can be safely committed once.
const firstCommit = context.commitStatementImport(preview.rows);
assert.deepEqual({ ...firstCommit }, { imported: 1, duplicates: 1, invalid: 1 });
assert.equal(imported.length, 1);
assert.equal(imported[0].external.provider, "statement_import");

// A repeat preview/commit must recognize the already-imported statement row.
const repeatPreview = context.previewStatementImport(csv, "cash");
assert.equal(repeatPreview.duplicateCount, 2);
const repeatCommit = context.commitStatementImport(repeatPreview.rows);
assert.deepEqual({ ...repeatCommit }, { imported: 0, duplicates: 2, invalid: 1 });

// Legacy statement_csv records remain recognized as duplicates.
const legacyRow = imported[0];
legacyRow.external.provider = "statement_csv";
const legacyPreview = context.previewStatementImport(csv, "cash");
assert.equal(legacyPreview.duplicateCount, 2);
const legacyCommit = context.commitStatementImport(legacyPreview.rows);
assert.deepEqual({ ...legacyCommit }, { imported: 0, duplicates: 2, invalid: 1 });

// A malformed amount/date cannot be imported or mutate the ledger.
const beforeInvalidOnly = state.transactions.length;
const invalidOnly = context.previewStatementImport("Date,Description,Amount\n31/02/2026,Impossible,-20", "cash");
assert.equal(invalidOnly.invalidCount, 1);
assert.deepEqual({ ...context.commitStatementImport(invalidOnly.rows) }, { imported: 0, duplicates: 0, invalid: 1 });
assert.equal(state.transactions.length, beforeInvalidOnly);

console.log("OmniPocket statement import deduplication tests passed");
