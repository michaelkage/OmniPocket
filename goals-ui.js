// Extracted from app.js: goals UI.

function selectGoalContext(id) { if (window.OmniPocketBus) OmniPocketBus.selectGoal(id); }

function goalProgress(goal) { return OmniPocketEngine.goalProgress(state, goal); }

function renderGoal() {
  const el = $("goalContent"); const context=getAppContext();
  const visibleGoals = context.scope==="goal"&&context.goalId ? (OmniPocketEngine.relatedGoals(state,context).filter(g=>g.id===context.goalId || g.status!=="completed")) : context.scope==="account"&&context.accountId ? state.goals.filter(g=>(g.accountIds||[]).includes(context.accountId)) : state.goals;
  const goal = visibleGoals.find(g=>g.status!=="completed") || visibleGoals[0];
  if (!goal) {
    el.innerHTML = state.goals.length
      ? '<div class="empty-state">All goals completed. Create another target.</div>'
      : '<div class="empty-state">Create your first financial target.</div>';
    return;
  }
  const { current, pct } = goalProgress(goal);
  el.innerHTML = `<div class="interactive-row" data-goal-id="${escapeHtml(goal.id)}" tabindex="0" role="button">
    <div class="row-title-with-context"><strong>${escapeHtml(goal.name)}</strong>${contextBadge(context)}</div>
    <div class="muted">${escapeHtml(money(current, goal.currency))} of ${escapeHtml(money(goal.target, goal.currency))}</div>
    <div style="height:10px;background:rgba(255,255,255,.08);border-radius:99px;margin:14px 0 8px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:inherit"></div>
    </div>
    <div class="muted">${pct.toFixed(0)}%${goal.deadline ? ` · Deadline ${escapeHtml(goal.deadline)}` : ""}</div>
  </div>`;
}

function createGoal() {
  if (!state.accounts.some(a => !a.archived)) return alert("Add an account first.");
  delete $("goalDialog").dataset.editingId;
  $("goalForm")?.reset();
  populateGoalAccounts();
  $("goalDialog")?.showModal();
}

function populateGoalAccounts(selectedIds = []) {
  const el = $("goalAccounts");
  if (!el) return;
  el.innerHTML = state.accounts.filter(a => !a.archived).map(a =>
    '<label class="check-row"><input type="checkbox" name="goalAccount" value="' + escapeHtml(a.id) + '" ' + (selectedIds.includes(a.id) ? "checked" : "") + '><span>' + escapeHtml(a.name) + " · " + escapeHtml(a.currency) + "</span></label>"
  ).join("");
}

function openGoalDetail(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  const health = window.OmniPocketEngine?.goalHealth ? window.OmniPocketEngine.goalHealth(state, g) : { label: "Active", tone: "neutral", reason: "" };
  const intelligence = window.OmniPocketEngine?.goalIntelligence
    ? OmniPocketEngine.goalIntelligence(state, g)
    : { progress: goalProgress(g), projection: null, accounts: g.accountIds.map(account).filter(Boolean), linkedTransactions: [], inferredTransactions: [], transactions: [] };
  const p = intelligence.progress;
  const projection = intelligence.projection || {};
  const privacy = state.settings.privacyHidden;
  const fmt = value => privacy ? "••••••" : money(value, g.currency);
  const dateLabel = value => value ? new Date(value + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
  const accountIds = new Set(g.accountIds || []);

  $("goalDetailHealth").textContent = health.label;
  $("goalDetailHealth").dataset.tone = health.tone;
  $("goalDetailHealthNote").textContent = health.reason;
  $("goalDetailTitle").textContent = g.name;
  $("goalDetailProgress").textContent = privacy ? "••••••" : money(p.current, g.currency) + " of " + money(p.target, g.currency);
  $("goalDetailBar").style.width = p.pct + "%";
  $("goalDetailMeta").textContent = p.pct.toFixed(0) + "% complete" + (projection.daysRemaining != null ? " · " + projection.daysRemaining + " day" + (projection.daysRemaining === 1 ? "" : "s") + " remaining" : "");

  $("goalDetailRemaining").textContent = p.remaining > 0 ? fmt(p.remaining) : "Target reached";
  $("goalDetailRequired").textContent = projection.dailyRequired != null ? fmt(projection.dailyRequired) + " / day" : "No deadline";
  $("goalDetailProjected").textContent = projection.projectedDate ? dateLabel(projection.projectedDate) : "Not enough pace data";
  const trajectory = window.OmniPocketEngine?.goalTrajectory ? OmniPocketEngine.goalTrajectory(state, g) : { points: [] };
  $("goalDetailTrajectory").innerHTML = renderGoalTrajectory(trajectory.points, projection, g.currency, privacy);
  $("goalDetailTrajectoryMeta").textContent = trajectory.actualNet > 0
    ? "Net contribution over the last 30 days: " + fmt(trajectory.actualNet)
    : "No positive net contribution recorded in the last 30 days.";

  $("goalDetailProjectionNote").textContent = projection.pace > 0
    ? "Based on the net contribution pace from the last 30 days."
    : p.current >= p.target
      ? "This goal has reached its target."
      : "Add recorded account activity to build a completion projection.";

  $("goalDetailPace").textContent = projection.dailyRequired > 0
    ? "Required: " + fmt(projection.dailyRequired) + " per day" + (projection.pace > 0 ? " · Recent pace: " + fmt(projection.pace) + " per day" : "")
    : p.current >= p.target ? "Target reached." : "No deadline set.";

  $("goalDetailAccounts").innerHTML = intelligence.accounts.map(a =>
    '<button class="link-row" data-account-from-goal="' + escapeHtml(a.id) + '"><span><strong>' + escapeHtml(a.name) + '</strong><small class="muted">' + escapeHtml(a.currency) + ' · Included in goal progress</small></span><span>' + escapeHtml(fmt(a.balance)) + '</span></button>'
  ).join("") || '<div class="empty-state">No contributing accounts selected.</div>';

  $("goalDetailLinkedActivity").innerHTML = activityRowsForGoal(intelligence.linkedTransactions, g, true) || '<div class="empty-state">No transactions are explicitly linked to this goal.</div>';
  $("goalDetailConnectedActivity").innerHTML = activityRowsForGoal(intelligence.inferredTransactions, g, false) || '<div class="empty-state">No inferred account activity yet.</div>';
  $("goalDetailActivitySummary").textContent = intelligence.transactions.length + " related transaction" + (intelligence.transactions.length === 1 ? "" : "s") + " · " + intelligence.linkedTransactions.length + " explicitly linked";

  $("goalDetailDialog").dataset.goalId = id;
  $("goalDetailDialog").showModal();
}

function activityRowsForGoal(list, goal, linked) {
  const accountIds = new Set(goal.accountIds || []);
  return list.slice(0, 6).map(t => {
    const incoming = accountIds.has(t.destinationAccountId) && !accountIds.has(t.sourceAccountId);
    const displayAmount = incoming && t.receivedAmount != null ? t.receivedAmount : t.amount;
    const displayCurrency = incoming && t.receivedCurrency ? t.receivedCurrency : t.currency;
    return '<button class="link-row goal-activity-row" data-transaction-from-goal="' + escapeHtml(t.id) + '"><span><strong>' + escapeHtml(transactionLabel(t)) + '</strong><small class="muted">' + escapeHtml(t.date) + ' · ' + (linked ? 'Explicitly linked to this goal' : 'Connected through an included account') + '</small></span><span class="goal-activity-right"><span class="' + (linked ? 'context-link-badge' : 'relationship-inferred-badge') + '">' + (linked ? 'Linked' : 'Connected') + '</span><span>' + escapeHtml((incoming ? "+" : transactionDirection(t) === "out" ? "−" : "") + money(displayAmount, displayCurrency)) + '</span></span></button>';
  }).join("");
}

function renderGoalTrajectory(points, projection, currency, privacy) {
  if (!points.length) return '<div class="empty-state">No contribution history yet.</div>';
  const width = 520, height = 150, pad = 16;
  const values = points.map(p => Number(p.value) || 0);
  const target = projection.dailyRequired != null ? projection.dailyRequired * Math.max(0, points.length - 1) : 0;
  const maxAbs = Math.max(1, ...values.map(Math.abs), Math.abs(target));
  const min = Math.min(0, ...values, target);
  const max = Math.max(0, ...values, target);
  const span = Math.max(1, max - min);
  const x = i => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
  const y = value => height - pad - ((value - min) / span) * (height - pad * 2);
  const path = points.map((p,i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1)).join(" ");
  const requiredPath = target ? "M " + x(0).toFixed(1) + " " + y(0).toFixed(1) + " L " + x(points.length - 1).toFixed(1) + " " + y(target).toFixed(1) : "";
  const latest = values[values.length - 1];
  return '<div class="goal-trajectory-chart"><svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Goal contribution trajectory"><path class="goal-trajectory-required" d="'+requiredPath+'"></path><path class="goal-trajectory-line" d="'+path+'"></path><circle class="goal-trajectory-dot" cx="'+x(values.length-1).toFixed(1)+'" cy="'+y(latest).toFixed(1)+'" r="5"></circle></svg><div class="goal-trajectory-legend"><span><i class="trajectory-key actual"></i>Actual net contribution</span><span><i class="trajectory-key required"></i>Required pace</span></div><div class="goal-trajectory-values"><span>Start · '+(privacy ? "••••••" : money(0,currency))+'</span><strong>'+ (privacy ? "••••••" : money(latest,currency)) +'</strong></div></div>';
}

function saveGoalFromForm(event) {
  event.preventDefault();
  const dialog = $("goalDialog");
  const name = $("goalName").value.trim();
  const target = Number($("goalTarget").value);
  const currency = $("goalCurrency").value;
  const deadline = $("goalDeadline").value || "";
  const accountIds = [...document.querySelectorAll('#goalAccounts input[name="goalAccount"]:checked')].map(input => input.value);
  if (!name) return alert("Give this goal a name.");
  if (!Number.isFinite(target) || target <= 0) return alert("Enter a valid target.");
  const editingId = dialog.dataset.editingId;
  if (editingId) {
    const goal = state.goals.find(g => g.id === editingId);
    if (!goal) return;
    Object.assign(goal, { name, target, currency, deadline, accountIds });
  } else {
    state.goals.push({ id: uid(), name, target, currency, accountIds, deadline, status: "active", createdAt: Date.now() });
  }
  delete dialog.dataset.editingId;
  saveState();
  dialog.close();
  event.target.reset();
}
