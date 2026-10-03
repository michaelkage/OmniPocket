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

async function syncMonoAccount(monoAccountId, accountName = "Connected bank", preferredAccountId = null) {
  const startedAt = Date.now(), preferred = preferredAccountId ? account(preferredAccountId) : null;
  const payload = await supabaseFunction("mono-account-sync", {
    accountId: monoAccountId,
    connectionId: preferred?.connection?.serverConnectionId || null,
    clientAccountId: preferred?.id || null,
  });
  const rawAccount = payload?.account?.data?.account || payload?.account?.data || payload?.account?.account || payload?.account;
  const rawTransactions = Array.isArray(payload?.transactions) ? payload.transactions : (payload?.transactions?.data || []);
  if (!rawAccount) throw new Error("Mono returned no account details.");
  const currency = CURRENCIES.includes(rawAccount.currency) ? rawAccount.currency : "NGN";
  const currentBalance = minorUnitAmount(rawAccount.balance);
  let local = preferred || state.accounts.find(x => x.connection?.provider === "mono" && x.connection.providerAccountId === monoAccountId);
  if (!local) {
    local = {
      id: uid(), name: accountName || rawAccount.name || "Connected bank", institution: rawAccount.institution?.name || "", type: "bank", currency,
      openingBalance: currentBalance, balance: currentBalance, archived: false, createdAt: Date.now(),
      connection: {
        provider: "mono", providerAccountId: monoAccountId, status: "connected", lastSyncedAt: null, syncStatus: "syncing", lastSyncError: "",
        lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncDurationMs: null, importedTransactionIds: [], rawRetainedUntil: null,
        needsReauth: false, disconnectedAt: null, providerStatus: null, provenance: "bank_sync",
      },
    };
    state.accounts.push(local);
  }
  const transactions = rawTransactions.map(tx => {
    const currency = CURRENCIES.includes(tx.currency) ? tx.currency : "NGN";
    return {
      id: uid(),
      connectionId: local.id,
      mono_transaction_id: tx.id,
      type: tx.type === "debit" ? "expense" : "income",
      amount: minorUnitAmount(tx.amount),
      currency,
      narration: tx.narration || tx.description || "",
      category: tx.category || "other",
      balance: tx.balance ? minorUnitAmount(tx.balance) : null,
      transaction_at: new Date(tx.date).toISOString(),
      raw: tx,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  });
  await persistTransactions(transactions);
  local.balance = currentBalance;
  local.connection.syncStatus = "connected";
  local.connection.lastSyncedAt = new Date().toISOString();
  local.connection.lastSyncCompletedAt = new Date().toISOString();
  local.connection.lastSyncDurationMs = Date.now() - startedAt;
  saveState();
  return { account: local, transactions };
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

async function syncConnectedBankAccounts() {
  const connected = state.accounts.filter(a => !a.archived && a.connection?.status === "connected" && a.connection.provider);
  for (const a of connected) {
    try {
      if (a.connection.provider === "mock") {
        await syncMockBankAccount(a.id);
      } else if (a.connection.provider === "mono" && a.connection.providerAccountId) {
        await syncMonoAccount(a.connection.providerAccountId, a.name, a.id);
      }
    } catch (error) {
      console.warn("Bank sync failed for " + a.name, error);
      a.connection.syncStatus = "error";
      a.connection.lastSyncError = error.message || "Sync failed";
      saveState();
    }
  }
}

async function connectDemoBankAccount() {
  const account = await syncMockBankAccount();
  $("accountDialog")?.close();
  alert("Demo bank connected. A realistic balance and sample transactions are now flowing through the same account pipeline.");
  openAccountDetail(account.id);
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