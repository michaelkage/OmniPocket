import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const context={console,JSON,Date,Math,Intl,structuredClone,crypto:{randomUUID:()=> "fixture-id"}};
context.window=context; vm.createContext(context);
vm.runInContext(fs.readFileSync("bank-core.js","utf8"),context);
const B=context.OmniPocketBank;
assert(B,"Bank architecture must initialize");
assert.equal(B.amountFromProvider(1500000),15000);
assert.equal(B.amountToProvider(15000),1500000);
const n=B.normalizeTransaction({ _id:"abc", type:"debit", amount:250000, currency:"NGN", narration:"MTN DATA", date:"2026-09-27" });
assert.equal(n.providerTransactionId,"abc");
assert.equal(n.amount,2500);
assert.equal(n.type,"expense");
const normalizedMono = B.normalizeTransaction({
  mono_transaction_id:"mono-pending-1", type:"debit", amount_minor:12500,
  currency:"NGN", bank_status:"pending", balance_minor:500000
});
assert.equal(normalizedMono.amount,125);
assert.equal(normalizedMono.bankStatus,"pending","Normalized Mono bank_status must survive provider normalization");
assert.equal(normalizedMono.providerBalance,5000);
assert.equal(B.normalizeTransaction({type:"credit",amount_minor:10000,bankStatus:"reversed"}).bankStatus,"reversed");
assert.equal(B.reconcile({id:"a",currency:"NGN"},10000,9000).difference,1000);
assert.equal(B.freshness(new Date().toISOString()).state,"healthy");
console.log("OmniPocket bank architecture tests passed");