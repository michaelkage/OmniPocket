// Extracted from app.js: payment detail + reconcile DOM glue.

function openPaymentDetail(paymentId) {
  const p = paymentCenterRows.find(x => x.id === paymentId);
  if (!p) return;

  const d = document.createElement("dialog");
  d.className = "app-dialog payment-detail-dialog";
  d.innerHTML = '<div class="dialog-head"><div><span class="eyebrow">PAYMENT INTENT</span><h2>' + escapeHtml(p.recipient_name || "Payment") + '</h2><div class="muted">' + escapeHtml(paymentStatusLabel(p.status)) + '</div></div><button type="button" class="icon-button" data-close>?</button></div><div class="detail-balance"><strong>' + escapeHtml(state.settings.privacyHidden ? "???????" : money((Number(p.amount_minor) || 0) / 100, p.currency || "NGN")) + '</strong><span class="muted">' + escapeHtml(p.currency || "NGN") + '</span></div><div class="payment-detail-grid"><div><span>From</span><strong>' + escapeHtml(p.source_account_name || "") + '</strong></div><div><span>Reference</span><strong>' + escapeHtml(p.reference || "") + '</strong></div><div><span>Recipient</span><strong>' + escapeHtml(p.recipient_name || "") + '</strong></div></div><div class="payment-detail-actions"><button type="button" class="primary" data-close>Close</button></div>';

  d.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => d.close()));
  document.body.appendChild(d);
  d.showModal();
}

function bindPaymentReconcileUI() {
  document.querySelectorAll("[data-reconcile]").forEach(button => {
    button.addEventListener("click", () => {
      const a = account(button.dataset.reconcile);
      $("reconcileMeta").textContent = a.name + " – " + a.currency + " – Current " + money(a.balance, a.currency);
      $("reconcileAmount").value = a.balance;
      $("reconcileNote").value = "";
      $("reconcileDialog").dataset.accountId = a.id;
      $("reconcileDialog").showModal();
    });
  });
}

function bindReconcileDialog() {
  const reconcileConfirmBtn = $("reconcileConfirm");
  if (reconcileConfirmBtn && !reconcileConfirmBtn.dataset.bound) {
    reconcileConfirmBtn.dataset.bound = "1";
    reconcileConfirmBtn.addEventListener("click", async () => {
      const dialog = $("reconcileDialog");
      const accountId = dialog?.dataset?.accountId;
      const newAmount = Number($("reconcileAmount")?.value || 0);
      const note = ($("reconcileNote")?.value || "").trim();
      if (!accountId) return;

      const a = account(accountId);
      const delta = Number(newAmount) - Number(a.balance);
      if (Math.abs(delta) < 0.000001) {
        dialog.close();
        return;
      }

      importTransaction({
        type: delta >= 0 ? "adjustment" : "adjustment",
        adjustmentSign: delta >= 0 ? 1 : -1,
        amount: Math.abs(delta),
        category: note || "Reconcile balance",
        sourceAccountId: a.id,
        currency: a.currency,
        date: new Date().toISOString().slice(0, 10),
        note,
        bankStatus: "posted",
        external: { provider: "reconcile" },
      });

      refreshTransferPairSuggestions();
      rebuildBalances();
      saveState();
      dialog.close();
      render();
    });
  }
}

(function bindReconcileUIOnLoad() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bindPaymentReconcileUI();
      bindReconcileDialog();
    }, { once: true });
  } else {
    bindPaymentReconcileUI();
    bindReconcileDialog();
  }
})();
