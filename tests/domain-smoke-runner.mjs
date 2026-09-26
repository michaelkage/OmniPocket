import fs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const context = { console, JSON, Date, Math, Intl, structuredClone };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("domain.js", "utf8"), context);

const E = context.OmniPocketEngine;
assert(E, "Engine should initialize");

const state = {
  settings: { baseCurrency: "NGN", fx: { rates: { NGN: { NGN: 1, USD: 1 / 1500 }, USD: { NGN: 1500, USD: 1 } } } },
  accounts: [
    { id: "a", currency: "NGN", openingBalance: 1000, balance: 1000, archived: false },
    { id: "b", currency: "NGN", openingBalance: 0, balance: 0, archived: false }
  ],
  transactions: [
    { id: "pending", type: "expense", status: "recorded", bankStatus: "pending", date: "2026-09-25", createdAt: 1, sourceAccountId: "a", amount: 200, currency: "NGN" },
    { id: "posted", type: "expense", status: "recorded", bankStatus: "posted", date: "2026-09-25", createdAt: 2, sourceAccountId: "a", amount: 100, currency: "NGN" },
    { id: "failed", type: "expense", status: "recorded", bankStatus: "failed", date: "2026-09-25", createdAt: 3, sourceAccountId: "a", amount: 50, currency: "NGN" }
  ],
  goals: [],
  snapshots: []
};

assert.equal(E.balancesAt(state).find(a => a.id === "a").balance, 900);
const materialized = E.balancesAt(state);
state.accounts = materialized;
assert.equal(E.netWorth(state), 900);
assert.equal(E.convert(state, 1500, "NGN", "USD"), 1);
assert.equal(E.recordDailySnapshot(state, new Date("2026-09-25T12:00:00Z")).value, 900);
console.log("OmniPocket domain smoke tests passed");
