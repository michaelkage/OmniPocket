// Extracted from app.js: quick entry dialog flow.

function populateAccounts() {
  const active = state.accounts.filter(a => !a.archived);
  $("quickAccount").innerHTML = active.map(a =>
    `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · ${escapeHtml(a.currency)}</option>`
  ).join("");
  if ($("quickDestination")) {
    $("quickDestination").innerHTML = active.map(a =>
      `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · ${escapeHtml(a.currency)}</option>`
    ).join("");
  }
  syncTransferFields();
}

function openQuick(type) {
  quickType = type;
  const titles = {
    income: "Add money",
    expense: "Spend",
    transfer: "Transfer",
    withdrawal: "Withdraw cash",
    adjustment: "Reconcile balance"
  };
  $("quickTitle").textContent = titles[type] || "Quick entry";
  $("quickCategoryWrap").style.display = type === "expense" ? "grid" : "none";
  $("quickDestinationWrap").style.display = type === "transfer" || type === "withdrawal" ? "grid" : "none";
  $("quickReceivedWrap").style.display = type === "transfer" ? "grid" : "none";
  $("quickFxWrap").style.display = type === "transfer" ? "grid" : "none";
  $("quickStatusWrap").style.display = type === "expense" || type === "income" ? "grid" : "none";
  populateTransactionGoals("quickTxGoals");
  populateAccounts();
  $("quickDate").value = today();
  $("quickDialog").showModal();
}

function syncTransferFields() {
  const source = account($("quickAccount")?.value);
  const destination = account($("quickDestination")?.value);
  if ($("quickReceivedCurrency")) $("quickReceivedCurrency").value = destination?.currency || source?.currency || state.settings.baseCurrency;
  if ($("quickAmountLabel")) $("quickAmountLabel").textContent = source ? `Amount (${source.currency})` : "Amount";
  if ($("quickReceivedLabel")) $("quickReceivedLabel").textContent = destination ? `Received (${destination.currency})` : "Received";
}

function handleQuickSubmit(event) {
  event.preventDefault();
  const source = account($("quickAccount").value);
  if (!source) return alert("Add an account first.");

  const amount = Math.abs(Number($("quickAmount").value) || 0);
  if (!(amount > 0)) return alert("Enter an amount greater than zero.");

  const note = $("quickNote").value.trim();
  const date = $("quickDate").value || today();
  const status = $("quickStatus")?.value || "recorded";

  try {
    if (quickType === "adjustment") {
      $("quickDialog").close();
      $("reconcileMeta").textContent = source.name + " · " + source.currency + " · Current " + money(source.balance, source.currency);
      $("reconcileAmount").value = source.balance;
      $("reconcileNote").value = note;
      $("reconcileDialog").dataset.accountId = source.id;
      $("reconcileDialog").showModal();
      return;
    } else if (quickType === "transfer") {
      const destination = account($("quickDestination").value);
      if (!destination || destination.id === source.id) return alert("Choose a different destination account.");
      const receivedRaw = $("quickReceivedAmount").value.trim();
      const fxRaw = $("quickFxRate").value.trim();
      const fx = fxRaw ? Number(fxRaw) : null;
      const received = receivedRaw ? Number(receivedRaw) : convert(amount, source.currency, destination.currency, fx);
      if (!(received >= 0)) return alert("Enter a valid received amount.");
      addTransaction({
        type: "transfer",
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount,
        currency: source.currency,
        receivedAmount: received,
        receivedCurrency: destination.currency,
        fxRate: fx,
        fxSource: fx ? "manual" : "snapshot",
        note,
        date,
        linkedGoalIds: readTransactionGoals("quickTxGoals")
      });
    } else if (quickType === "withdrawal") {
      const destination = account($("quickDestination").value);
      if (!destination || destination.id === source.id) return alert("Choose a different cash destination.");
      if (destination.type !== "cash") return alert("Cash out must land in a Cash account.");
      const receivedRaw = $("quickReceivedAmount")?.value.trim() || "";
      const received = receivedRaw ? Number(receivedRaw) : convert(amount, source.currency, destination.currency);
      if (!(received >= 0)) return alert("Enter a valid received amount.");
      addTransaction({
        type: "withdrawal",
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount,
        currency: source.currency,
        receivedAmount: received,
        receivedCurrency: destination.currency,
        fxRate: source.currency === destination.currency ? 1 : null,
        fxSource: "snapshot",
        note,
        date,
        linkedGoalIds: readTransactionGoals("quickTxGoals")
      });
    } else {
      const type = quickType;
      addTransaction({
        type,
        sourceAccountId: source.id,
        amount,
        currency: source.currency,
        category: type === "expense" ? $("quickCategory").value : "Money added",
        note,
        date,
        status,
        linkedGoalIds: readTransactionGoals("quickTxGoals")
      });
    }
    saveState();
    $("quickDialog").close();
    event.target.reset();
  } catch (error) {
    alert(error.message || "Could not record transaction.");
  }
}

function populateTransactionGoals(containerId, selectedIds = []) {
  const el = $(containerId);
  if (!el) return;
  const selected = new Set(selectedIds || []);
  const goals = state.goals.filter(g => g.status !== "completed");
  const header = '<div class="field-label">Linked goals <span class="muted">(optional)</span></div><div class="muted" style="margin-bottom:8px">Relationships only — linking a transaction does not allocate or double-count money.</div>';
  el.innerHTML = header + (goals.length
    ? goals.map(g => '<label class="check-row"><input type="checkbox" data-transaction-goal="' + escapeHtml(g.id) + '" ' + (selected.has(g.id) ? "checked" : "") + '><span>' + escapeHtml(g.name) + ' · ' + escapeHtml(g.currency) + '</span></label>').join("")
    : '<div class="empty-state">Create a goal first to link activity to it.</div>');
}

function readTransactionGoals(containerId) {
  return [...document.querySelectorAll('#' + containerId + ' [data-transaction-goal]:checked')].map(input => input.dataset.transactionGoal);
}
