/* OmniPocket bank connection helpers.
 * Extracted from app.js to reduce size; preserves globals (state, account, etc).
 */

async function exchangeMonoCode(code, accountName, preferredAccountId = null) {
  const data = await supabaseFunction("mono-exchange-token", { code, accountName, clientAccountId: preferredAccountId || null });
  if (!data?.connection?.id || !data?.monoAccountId) throw new Error("Mono linked the account but OmniPocket did not save the connection.");
  const local = preferredAccountId ? account(preferredAccountId) : null;
  if (local) { local.connection = { ...(local.connection || {}), provider: "mono", providerAccountId: data.monoAccountId, serverConnectionId: data.connection.id, status: "connected", syncStatus: "syncing", lastSyncError: "" }; saveState(); }
  return data;
}

async function syncMonoAccountUnlocked(monoAccountId,accountName="Connected bank",preferredAccountId=null){const startedAt=Date.now(),preferred=preferredAccountId?account(preferredAccountId):null,payload=await supabaseFunction("mono-account-sync",{accountId:monoAccountId,connectionId:preferred?.connection?.serverConnectionId||null,clientAccountId:preferred?.id||null});const rawAccount=payload?.account?.data?.account||payload?.account?.data||payload?.account?.account||payload?.account,transactionPayload=payload?.transactions,rawTransactions=Array.isArray(transactionPayload)?transactionPayload:(Array.isArray(transactionPayload?.data)?transactionPayload.data:null);if(!rawAccount)throw new Error("Mono returned no account details.");if(!rawTransactions)throw new Error("Mono returned an unexpected transaction feed; the account was not updated.");const currency=String(rawAccount.currency||"NGN").toUpperCase();if(!CURRENCIES.includes(currency))throw new Error("Mono returned an unsupported account currency; the account was not updated.");const currentBalance=minorUnitAmount(rawAccount.balance);if(!Number.isFinite(currentBalance))throw new Error("Mono returned an invalid account balance; the account was not updated.");let local=preferred||state.accounts.find(x=>x.connection?.provider==="mono"&&x.connection.providerAccountId===monoAccountId);if(!local){local={id:uid(),name:accountName||rawAccount.name||"Connected bank",institution:rawAccount.institution?.name||"",type:"bank",currency,openingBalance:currentBalance,balance:currentBalance,archived:false,createdAt:Date.now(),connection:{provider:"mono",providerAccountId:monoAccountId,status:"connected",lastSyncedAt:null,syncStatus:"syncing",lastSyncError:"",lastSyncStartedAt:null,lastSyncCompletedAt:null,lastSyncDurationMs:null,importedTransactionCount:0,totalImportedTransactionCount:0,syncHistory:[],serverConnectionId:payload?.connection?.id||null}};state.accounts.push(local);}const importedAt=Date.now();let importedNet=0,importedCount=0,ownershipConflictCount=0,currencyMismatchCount=0,invalidTransactionCount=0,duplicateTransactionCount=Number(payload?.duplicateTransactionCount)||0;const seenProviderIds=new Set();const isFirstProviderSync=!local.connection?.lastSyncedAt,openingBalanceReconciliationPending=Boolean(local.connection?.openingBalanceReconciliationPending),transactionFeedComplete=payload?.transactionFeedComplete===true;for(const tx of rawTransactions){const pid=tx.mono_transaction_id||tx.id||tx._id;if(!pid){invalidTransactionCount++;continue;}const direction=String(tx.type||"").toLowerCase(),rawAmount=tx.amount_minor!=null?tx.amount_minor:tx.amount,amount=minorUnitAmount(rawAmount);if(!["credit","debit"].includes(direction)||rawAmount==null||!Number.isFinite(amount)||amount<0){invalidTransactionCount++;continue;}const txCurrency=String(tx.currency||currency).toUpperCase();if(!CURRENCIES.includes(txCurrency)){invalidTransactionCount++;continue;}if(txCurrency!==currency){currencyMismatchCount++;continue;}const rawDate=tx.transaction_at||tx.date||null,txDate=String(rawDate||"").slice(0,10),dateParts=txDate.split("-").map(Number),dateCheck=dateParts.length===3?new Date(Date.UTC(dateParts[0],dateParts[1]-1,dateParts[2])):null;if(!dateCheck||!/^\d{4}-\d{2}-\d{2}$/.test(txDate)||dateCheck.getUTCFullYear()!==dateParts[0]||dateCheck.getUTCMonth()!==dateParts[1]-1||dateCheck.getUTCDate()!==dateParts[2]){invalidTransactionCount++;continue;}const credit=direction==="credit",bankStatus=String(tx.bank_status||tx.bankStatus||"posted").toLowerCase();if(!["pending","posted","failed","reversed"].includes(bankStatus)){invalidTransactionCount++;continue;}const providerId=String(pid);if(seenProviderIds.has(providerId)){duplicateTransactionCount++;continue;}seenProviderIds.add(providerId);const existing=state.transactions.find(t=>t.external?.provider==="mono"&&t.external.providerTransactionId===String(pid));if(existing){if(existing.sourceAccountId&&existing.sourceAccountId!==local.id){ownershipConflictCount++;continue;}if(!["pending","failed","reversed"].includes(bankStatus))importedNet+=credit?amount:-amount;existing.external.lastSeenAt=new Date().toISOString();const manualEdits=new Set(existing.external.manualEdits||[]);existing.bankStatus=bankStatus;if(!manualEdits.has("type"))existing.type=credit?"income":"expense";if(!manualEdits.has("amount"))existing.amount=amount;if(!manualEdits.has("currency"))existing.currency=txCurrency;if(!manualEdits.has("date"))existing.date=txDate;continue;}if(!["pending","failed","reversed"].includes(bankStatus))importedNet+=credit?amount:-amount;const suggestion=suggestTransactionCategory({description:tx.narration,providerCategory:tx.category});state.transactions.push({id:uid(),type:credit?"income":"expense",status:"recorded",bankStatus,date:txDate,createdAt:importedAt,sourceAccountId:local.id,destinationAccountId:null,amount,currency:txCurrency,receivedAmount:null,receivedCurrency:null,fxRate:null,fxSource:"bank_import",provenance:{source:"bank_sync",provider:"mono",providerTransactionId:String(pid)},category:tx.category||"Other",suggestedCategory:suggestion?.category||null,categoryConfidence:suggestion?.confidence||null,categoryReason:suggestion?.reason||"",note:tx.narration||"Imported from Mono",linkedGoalIds:[],external:{provider:"mono",providerTransactionId:String(pid),importedAt:new Date(importedAt).toISOString(),lastSeenAt:new Date(importedAt).toISOString(),manualEdits:[]}});importedCount++;}if((isFirstProviderSync||openingBalanceReconciliationPending)&&transactionFeedComplete){local.openingBalance=currentBalance-importedNet;}rebuildBalances();local.connection={...(local.connection||{}),providerBalance:currentBalance,providerBalanceAt:new Date().toISOString()};local.institution=rawAccount.institution?.name||local.institution;local.currency=currency;const balanceDifference=currentBalance-Number(local.balance),balanceMismatch=!Number.isFinite(balanceDifference)||Math.abs(balanceDifference)>=0.005,completedAt=Date.now(),durationMs=completedAt-startedAt,total=Number(local.connection?.totalImportedTransactionCount)||0,warningMessages=[...(ownershipConflictCount?[`${ownershipConflictCount} transaction(s) skipped because their provider IDs are linked to another account.`]:[]),...(balanceMismatch?[`Provider and OmniPocket balances differ by ${Number.isFinite(balanceDifference)?balanceDifference.toFixed(2):"an unknown amount"} ${currency}.`]:[]),...(currencyMismatchCount?[`${currencyMismatchCount} transaction(s) skipped because their currency differs from the linked account currency (${currency}).`]:[]),...(invalidTransactionCount?[`${invalidTransactionCount} transaction(s) skipped because their ID, amount, currency, date, direction, or bank status was invalid.`]:[]),...(duplicateTransactionCount?[`${duplicateTransactionCount} duplicate provider transaction(s) were ignored.`]:[]),...((isFirstProviderSync||openingBalanceReconciliationPending)&&!transactionFeedComplete?["Mono did not confirm a complete transaction history. Opening-balance reconciliation is deferred until a complete feed is available."]:[])],syncWarning=warningMessages.length>0;local.connection={...(local.connection||{}),provider:"mono",providerAccountId:monoAccountId,serverConnectionId:payload?.connection?.id||local.connection?.serverConnectionId||null,status:"connected",openingBalanceReconciliationPending:(isFirstProviderSync||openingBalanceReconciliationPending)&&!transactionFeedComplete,lastSyncedAt:new Date(completedAt).toISOString(),lastSyncStartedAt:new Date(startedAt).toISOString(),lastSyncCompletedAt:new Date(completedAt).toISOString(),lastSyncDurationMs:durationMs,importedTransactionCount:importedCount,totalImportedTransactionCount:total+importedCount,syncStatus:syncWarning?"warning":"healthy",lastSyncError:warningMessages.join(" "),syncHistory:[{startedAt:new Date(startedAt).toISOString(),completedAt:new Date(completedAt).toISOString(),status:syncWarning?"warning":"success",durationMs,importedCount,ownershipConflictCount,currencyMismatchCount,invalidTransactionCount,duplicateTransactionCount,balanceMismatch,balanceDifference},...(local.connection?.syncHistory||[])].slice(0,20)};saveState();emitStateEvent("account:updated",{accountId:local.id,provider:"mono",importedCount});return local;}


async function syncMonoAccount(monoAccountId, accountName = "Connected bank", preferredAccountId = null) {
  // A single tab can trigger refresh from multiple UI surfaces. Lock both the
  // provider account and local account so overlapping requests cannot race.
  const locks = window.__omnipocketMonoSyncLocks
    || (window.__omnipocketMonoSyncLocks = new Set());
  const keys = [
    monoAccountId ? `mono:${String(monoAccountId)}` : null,
    preferredAccountId ? `local:${String(preferredAccountId)}` : null,
  ].filter(Boolean);
  if (!keys.length) throw new Error("A Mono account ID is required to sync.");
  if (keys.some(key => locks.has(key))) {
    throw new Error("A sync for this bank account is already in progress. Please wait for it to finish.");
  }
  keys.forEach(key => locks.add(key));
  try {
    return await syncMonoAccountUnlocked(monoAccountId, accountName, preferredAccountId);
  } finally {
    keys.forEach(key => locks.delete(key));
  }
}

function createMockBankDataset(connection = null) {
  const account = {
    id: uid(),
    name: "Demo Bank",
    institution: "OmniPocket Demo",
    type: "bank",
    currency: "NGN",
    openingBalance: 5000,
    balance: 5000,
    archived: false,
    createdAt: Date.now(),
    connection: connection || {
      provider: "mock",
      providerAccountId: "demo-" + Date.now(),
      status: "connected",
      lastSyncedAt: new Date().toISOString(),
      syncStatus: "connected",
      lastSyncError: "",
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncCompletedAt: new Date().toISOString(),
      lastSyncDurationMs: 100,
    },
  };
  state.accounts.push(account);
  return account;
}

async function simulateDemoBankScenario(scenario) {
  const account = createMockBankDataset();
  const transactions = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.now() - i * 86400000);
    transactions.push({
      id: uid(),
      connectionId: account.id,
      type: "income",
      amount: 5000 + Math.random() * 10000,
      currency: "NGN",
      narration: `Demo income ${i + 1}`,
      category: "salary",
      balance: null,
      transaction_at: date.toISOString(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  await persistTransactions(transactions);
  account.balance = 5000;
  saveState();
  return { account, transactions };
}

async function syncMockBankAccount(preferredAccountId = null) {
  // Reuse the connected demo account and stable transaction IDs on every sync.
  // A refresh should update the demo feed, not create five new rows and an account.
  const account = state.accounts.find(a => a.id === preferredAccountId && a.connection?.provider === "mock")
    || createMockBankDataset();
  const transactions = [];
  for (let i = 0; i < 5; i++) {
    const id = "mock-" + account.id + "-" + (i + 1);
    if (state.transactions.some(tx => tx.id === id)) continue;
    const date = new Date(Date.now() - i * 86400000);
    transactions.push({
      id,
      connectionId: account.id,
      type: "income",
      amount: 1000,
      currency: "NGN",
      narration: `Mock income ${i + 1}`,
      category: "salary",
      balance: null,
      transaction_at: date.toISOString(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  if (transactions.length) await persistTransactions(transactions);
  account.balance = 1000;
  saveState();
  return account;
}

async function connectBankAccount() {
  let config = integrationSettings();
  if (!config.supabaseUrl) {
    config = configureBankIntegration();
    if (!config) return false;
  }
  const accountName = ($("accountName")?.value || "Connected bank").trim();
  const email = localStorage.getItem("omnipocket.monoEmail") || prompt("Email to associate with this bank connection:", "")?.trim();
  if (!email) return;
  const result = await supabaseFunction("mono-connect-link", {
    action: "initiate",
    accountName: accountName || "OmniPocket user",
    customer: { name: accountName || "OmniPocket user", email },
    clientAccountId: window.__omnipocketReconnectAccountId || null,
  });
  if (!result?.link_id) throw new Error("Mono failed to create connect link.");
  const linkUrl = `https://connect.withmono.com/links/${result.link_id}`;
  window.open(linkUrl, "_blank");
  localStorage.setItem("omnipocket.monoEmail", email);
}