// Payment detail and read-only account reconciliation UI.

function openPaymentDetail(paymentId) {
  const p = paymentCenterRows.find(x => x.id === paymentId);
  if (!p) return;
  const d = document.createElement("dialog");
  d.className = "app-dialog payment-detail-dialog";
  d.innerHTML = '<div class="dialog-head"><div><span class="eyebrow">PAYMENT INTENT</span><h2>' + escapeHtml(p.recipient_name || "Payment") + '</h2><div class="muted">' + escapeHtml(paymentStatusLabel(p.status)) + '</div></div><button type="button" class="icon-button" data-close>×</button></div><div class="detail-balance"><strong>' + escapeHtml(state.settings.privacyHidden ? "••••••" : money((Number(p.amount_minor) || 0) / 100, p.currency || "NGN")) + '</strong><span class="muted">' + escapeHtml(p.currency || "NGN") + '</span></div><div class="payment-detail-grid"><div><span>From</span><strong>' + escapeHtml(p.source_account_name || "") + '</strong></div><div><span>Reference</span><strong>' + escapeHtml(p.reference || "") + '</strong></div><div><span>Recipient</span><strong>' + escapeHtml(p.recipient_name || "") + '</strong></div></div><div class="payment-detail-actions"><button type="button" class="primary" data-close>Close</button></div>';
  d.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => d.close()));
  document.body.appendChild(d);
  d.showModal();
}

function bindPaymentReconcileUI() {
  document.querySelectorAll("[data-reconcile]").forEach(button => {
    if (button.dataset.reconcileBound) return;
    button.dataset.reconcileBound = "1";
    button.addEventListener("click", () => {
      const a = account(button.dataset.reconcile);
      if (!a) return;
      $("reconcileMeta").textContent = a.name + " · " + a.currency + " · Current ledger " + money(a.balance, a.currency);
      $("reconcileAmount").value = a.balance;
      $("reconcileNote").value = "";
      $("reconcileStatementDate").value = today();
      $("reconcileResult").hidden = true;
      $("reconcileDialog").dataset.accountId = a.id;
      $("reconcileDialog").showModal();
    });
  });
}

function bindReconcileDialog() {
  const form = $("reconcileForm");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "1";
  const dialog = $("reconcileDialog");
  dialog?.addEventListener("show", () => {
    if ($("reconcileStatementDate") && !$("reconcileStatementDate").value) $("reconcileStatementDate").value = today();
    if ($("reconcileResult")) $("reconcileResult").hidden = true;
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const dialog = $("reconcileDialog");
    const accountId = dialog?.dataset?.accountId;
    const amountInput = $("reconcileAmount");
    const statementDate = $("reconcileStatementDate")?.value;
    if (!accountId || !amountInput?.value.trim() || !statementDate) return;
    const result = OmniPocketEngine.reconcileAccount(state, accountId, Number(amountInput.value), statementDate);
    const host = $("reconcileResult");
    if (!host || result.status === "unknown") return;
    const a = account(accountId);
    const hidden = Boolean(state.settings.privacyHidden);
    const amount = value => hidden ? "••••••" : money(value, result.currency);
    const differenceLabel = result.difference > 0 ? "Statement is higher" : result.difference < 0 ? "Ledger is higher" : "Balances match";
    const count = result.counts;
    host.innerHTML = '<div class="detail-callout ' + (result.status === "matched" ? "reconciliation-match" : "reconciliation-warning") + '"><strong>' + (result.status === "matched" ? "Matched" : "Difference: " + escapeHtml(amount(Math.abs(result.difference)))) + '</strong><span>Statement ' + escapeHtml(amount(result.statementBalance)) + ' · Ledger on ' + escapeHtml(result.statementDate) + ' ' + escapeHtml(amount(result.ledgerBalance)) + '</span><span>' + escapeHtml(differenceLabel) + '</span></div>' +
      '<div class="detail-callout"><strong>What went into this comparison</strong><span>' + count.included + ' effective ledger movements included</span><span>' + count.pending + ' pending · ' + count.failed + ' failed · ' + count.reversed + ' reversed · ' + count.needsReview + ' needs review · ' + count.superseded + ' superseded excluded</span><span>' + count.afterStatementDate + ' transaction(s) dated after the statement date</span></div>' +
      '<div class="muted">This is a read-only comparison. No adjustment or transaction was created. The opening balance has no recorded start date, so older missing activity cannot be diagnosed from this comparison alone.</div>';
    host.hidden = false;
  });
}

(function bindReconcileUIOnLoad() {
  const bind = () => { bindPaymentReconcileUI(); bindReconcileDialog(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
