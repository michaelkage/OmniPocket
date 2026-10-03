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

async function syncMonoAccount(monoAccountId,accountName="Connected bank",preferredAccountId=null){const startedAt=Date.now(),preferred=preferredAccountId?account(preferredAccountId):null,payload=await supabaseFunction("mono-account-sync",{accountId:monoAccountId,connectionId:preferred?.connection?.serverConnectionId||null,clientAccountId:preferred?.id||null});const rawAccount=payload?.account?.data?.account||payload?.account?.data||payload?.account?.account||payload?.account,rawTransactions=Array.isArray(payload?.transactions)?payload.transactions:(payload?.transactions?.data||[]);if(!rawAccount)throw new Error("Mono returned no account details.");const currency=CURRENCIES.includes(rawAccount.currency)?rawAccount.currency:"NGN",currentBalance=minorUnitAmount(rawAccount.balance);let local=preferred||state.accounts.find(x=>x.connection?.provider==="mono"&&x.connection.providerAccountId===monoAccountId);if(!local){local={id:uid(),name:accountName||rawAccount.name||"Connected bank",institution:rawAccount.institution?.name||"",type:"bank",currency,openingBalance:currentBalance,balance:currentBalance,archived:false,createdAt:Date.now(),connection:{provider:"mono",providerAccountId:monoAccountId,status:"connected",lastSyncedAt:null,syncStatus:"syncing",lastSyncError:"",lastSyncStartedAt:null,lastSyncCompletedAt:null,lastSyncDurationMs:null,importedTransactionCount:0,totalImportedTransactionCount:0,syncHistory:[],serverConnectionId:payload?.connection?.id||null}};state.accounts.push(local);}const importedAt=Date.now();let importedNet=0,importedCount=0;const isFirstProviderSync=!local.connection?.lastSyncedAt;for(const tx of rawTransactions){const pid=tx.mono_transaction_id||tx.id||tx._id;if(!pid)continue;const amount=tx.amount_minor!=null?minorUnitAmount(tx.amount_minor):minorUnitAmount(tx.amount),credit=String(tx.type||"").toLowerCase()==="credit";if(tx.type!==undefined) importedNet+=credit?amount:-amount;const existing=state.transactions.find(t=>t.external?.provider==="mono"&&t.external.providerTransactionId===String(pid));if(existing){existing.external.lastSeenAt=new Date().toISOString();if(tx.bankStatus)existing.bankStatus=tx.bankStatus;continue;}const suggestion=suggestTransactionCategory({description:tx.narration,providerCategory:tx.category});state.transactions.push({id:uid(),type:credit?"income":"expense",status:tx.bankStatus==="failed"?"recorded":"recorded",bankStatus:tx.bankStatus||"posted",date:String(tx.transaction_at||tx.date||today()).slice(0,10),createdAt:importedAt,sourceAccountId:local.id,destinationAccountId:null,amount,currency:tx.currency||currency,receivedAmount:null,receivedCurrency:null,fxRate:null,fxSource:"bank_import",provenance:{source:"bank_sync",provider:"mono",providerTransactionId:String(pid)},category:tx.category||"Other",suggestedCategory:suggestion?.category||null,categoryConfidence:suggestion?.confidence||null,categoryReason:suggestion?.reason||"",note:tx.narration||"Imported from Mono",linkedGoalIds:[],external:{provider:"mono",providerTransactionId:String(pid),importedAt:new Date(importedAt).toISOString(),lastSeenAt:new Date(importedAt).toISOString()}});importedCount++;}if(isFirstProviderSync){local.openingBalance=currentBalance-importedNet;}rebuildBalances();local.connection={...(local.connection||{}),providerBalance:currentBalance,providerBalanceAt:new Date().toISOString()};local.institution=rawAccount.institution?.name||local.institution;local.currency=currency;const completedAt=Date.now(),durationMs=completedAt-startedAt,total=Number(local.connection?.totalImportedTransactionCount)||0;local.connection={...(local.connection||{}),provider:"mono",providerAccountId:monoAccountId,serverConnectionId:payload?.connection?.id||local.connection?.serverConnectionId||null,status:"connected",lastSyncedAt:new Date(completedAt).toISOString(),lastSyncStartedAt:new Date(startedAt).toISOString(),lastSyncCompletedAt:new Date(completedAt).toISOString(),lastSyncDurationMs:durationMs,importedTransactionCount:importedCount,totalImportedTransactionCount:total+importedCount,syncStatus:"healthy",lastSyncError:"",syncHistory:[{startedAt:new Date(startedAt).toISOString(),completedAt:new Date(completedAt).toISOString(),status:"success",durationMs,importedCount},...(local.connection?.syncHistory||[])].slice(0,20)};saveState();emitStateEvent("account:updated",{accountId:local.id,provider:"mono",importedCount});return local;}

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
  const account = createMockBankDataset();
  const transactions = [];
  for (let i = 0; i < 5; i++) {
    const date = new Date(Date.now() - i * 86400000);
    transactions.push({
      id: uid(),
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
  await persistTransactions(transactions);
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