// Extracted from app.js: bank sync DOM glue.

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

(function bindBankSyncUI() {
  document.addEventListener("DOMContentLoaded", () => {
    $("syncAllBanksButton")?.addEventListener("click", async () => {
      const b = $("syncAllBanksButton");
      if (b) b.disabled = true;
      try {
        await syncConnectedBankAccounts();
        render();
      } finally {
        if (b) b.disabled = false;
      }
    });

    $("bankConnectionsList")?.addEventListener("click", event => {
      const sync = event.target.closest("[data-sync-account]");
      if (sync) {
        requestBankSync(sync.dataset.syncAccount);
        return;
      }
      const manage = event.target.closest("[data-open-account]");
      if (manage) openAccountDetail(manage.dataset.openAccount);
    });
  });
})();
