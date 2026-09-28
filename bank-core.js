/* OmniPocket bank architecture: provider boundary, normalization, provenance, reconciliation. */
(function(){
  const UNIT = "minor";
  const STATES = ["disconnected","connecting","connected","syncing","healthy","stale","error","revoked","needs_reauth"];
  const PROVIDERS = new Map();

  function provider(id, adapter){
    if (!id) throw new Error("Provider id is required");
    PROVIDERS.set(id, { id, ...adapter });
    return PROVIDERS.get(id);
  }
  function getProvider(id){ return PROVIDERS.get(id) || null; }
  function syncState(value){ return STATES.includes(value) ? value : "disconnected"; }

  function amountFromProvider(value, unit = UNIT){
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return unit === "major" ? n : n / 100;
  }
  function amountToProvider(value, unit = UNIT){
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return unit === "major" ? n : Math.round(n * 100);
  }

  function normalizeTransaction(tx, opts = {}){
    const rawAmount = tx?.amount_minor ?? tx?.amount;
    const amount = amountFromProvider(rawAmount, opts.amountUnit || UNIT);
    const type = String(tx?.type || "").toLowerCase();
    const providerId = tx?.mono_transaction_id || tx?.providerTransactionId || tx?.id || tx?._id || null;
    const currency = String(tx?.currency || opts.currency || "NGN").toUpperCase();
    return {
      provider: opts.provider || "mono",
      providerTransactionId: providerId ? String(providerId) : null,
      type: type === "credit" ? "income" : "expense",
      amount: Math.abs(amount),
      currency,
      narration: String(tx?.narration || tx?.description || tx?.remark || ""),
      category: tx?.category || null,
      bankStatus: ["pending","posted","reversed","failed"].includes(String(tx?.status || "").toLowerCase())
        ? String(tx.status).toLowerCase() : null,
      transactionAt: tx?.transaction_at || tx?.date || tx?.created_at || null,
      providerBalance: tx?.balance_minor == null ? null : amountFromProvider(tx.balance_minor, opts.amountUnit || UNIT),
      raw: tx
    };
  }

  function fingerprint(t){
    const norm = v => String(v ?? "").toLowerCase().replace(/\s+/g," ").trim();
    return [
      t.accountId || t.sourceAccountId || "",
      t.date || "",
      Number(t.amount || 0).toFixed(2),
      t.currency || "",
      t.type || "",
      norm(t.category || ""),
      norm(t.note || t.narration || "")
    ].join("|");
  }

  function provenance(source, extra = {}){
    const allowed = ["manual","bank_sync","statement_import","receipt_ocr","smart_parser","payment_reconciliation","adjustment","transfer"];
    return { source: allowed.includes(source) ? source : "manual", ...extra };
  }

  function freshness(lastSyncedAt, now = Date.now()){
    if (!lastSyncedAt) return { state:"stale", ageMs:null, label:"Never synced" };
    const ageMs = Math.max(0, now - new Date(lastSyncedAt).getTime());
    if (ageMs <= 15*60*1000) return { state:"healthy", ageMs, label:"Live" };
    if (ageMs <= 6*60*60*1000) return { state:"stale", ageMs, label:"Stale" };
    return { state:"stale", ageMs, label:"Stale" };
  }

  function reconcile(account, providerBalance, localBalance){
    const providerValue = Number(providerBalance);
    const localValue = Number(localBalance);
    const difference = Number.isFinite(providerValue) && Number.isFinite(localValue) ? providerValue - localValue : null;
    return {
      accountId: account?.id || null,
      currency: account?.currency || null,
      providerBalance: Number.isFinite(providerValue) ? providerValue : null,
      localBalance: Number.isFinite(localValue) ? localValue : null,
      difference,
      status: difference == null ? "unknown" : Math.abs(difference) < 0.005 ? "matched" : "mismatch",
      checkedAt: new Date().toISOString()
    };
  }

  function diagnoseState(state){
    const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
    const tx = Array.isArray(state?.transactions) ? state.transactions : [];
    return {
      schemaVersion: state?.schemaVersion ?? null,
      accounts: accounts.length,
      transactions: tx.length,
      connectedBanks: accounts.filter(a => a.connection?.provider).length,
      healthyBanks: accounts.filter(a => a.connection?.syncStatus === "healthy").length,
      staleBanks: accounts.filter(a => a.connection?.syncStatus === "stale").length,
      erroredBanks: accounts.filter(a => a.connection?.syncStatus === "error").length,
      reviewQueue: tx.filter(t => t.status === "needs_review").length,
      pendingBankTransactions: tx.filter(t => t.bankStatus === "pending").length
    };
  }

  window.OmniPocketBank = {
    UNIT, STATES, provider, getProvider, syncState, amountFromProvider, amountToProvider,
    normalizeTransaction, fingerprint, provenance, freshness, reconcile, diagnoseState
  };
  provider("mono", {
    name:"Mono",
    capabilities:["connect","exchangeToken","getAccount","getTransactions","sync","disconnect","status"]
  });
})();