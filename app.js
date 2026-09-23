/* OmniPocket — V1 financial domain + UI engine */
const STORAGE_KEY = "omnipocket.v1";
const SCHEMA_VERSION = 2;
const CURRENCIES = ["NGN", "USD", "GBP", "EUR"];
const ACCOUNT_TYPES = ["bank", "cash", "wallet", "locked"];
const TX_TYPES = ["income", "expense", "transfer", "withdrawal", "adjustment"];
const DEFAULT_RATES = {
  NGN: { NGN: 1, USD: 1 / 1500, GBP: 1 / 2020, EUR: 1 / 1750 },
  USD: { NGN: 1500, USD: 1, GBP: 2020 / 1500, EUR: 1750 / 1500 },
  GBP: { NGN: 2020, USD: 1500 / 2020, GBP: 1, EUR: 1750 / 2020 },
  EUR: { NGN: 1750, USD: 1500 / 1750, GBP: 2020 / 1750, EUR: 1 }
};

const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const clone = value => JSON.parse(JSON.stringify(value));

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  settings: {
    baseCurrency: "NGN",
    theme: "dark",
    privacyHidden: false,
    mode: "hybrid",
    fx: { provider: "manual", updatedAt: null, rates: clone(DEFAULT_RATES) }
  },
  accounts: [],
  transactions: [],
  goals: []
};

let state = loadState();
let quickType = "expense";

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return migrateState(raw);
  } catch {
    return clone(DEFAULT_STATE);
  }
}

function migrateState(raw) {
  if (!raw || typeof raw !== "object") return clone(DEFAULT_STATE);

  const next = clone(DEFAULT_STATE);
  next.settings = { ...next.settings, ...(raw.settings || {}) };
  next.settings.fx = {
    ...clone(DEFAULT_STATE.settings.fx),
    ...(raw.settings?.fx || {})
  };
  next.accounts = Array.isArray(raw.accounts) ? raw.accounts.map(a => ({
    id: a.id || uid(),
    name: String(a.name || "Unnamed account"),
    institution: String(a.institution || ""),
    type: ACCOUNT_TYPES.includes(a.type) ? a.type : "bank",
    currency: CURRENCIES.includes(a.currency) ? a.currency : "NGN",
    openingBalance: Number.isFinite(Number(a.openingBalance))
      ? Number(a.openingBalance)
      : Number(a.balance) || 0,
    balance: Number(a.balance) || 0,
    archived: Boolean(a.archived),
    createdAt: Number(a.createdAt) || Date.now()
  })) : [];

  next.transactions = Array.isArray(raw.transactions) ? raw.transactions.map(t => ({
    id: t.id || uid(),
    type: TX_TYPES.includes(t.type) ? t.type : "adjustment",
    status: t.status === "needs_review" ? "needs_review" : "recorded",
    date: t.date || today(),
    createdAt: Number(t.createdAt) || Date.now(),
    sourceAccountId: t.sourceAccountId || t.accountId || null,
    destinationAccountId: t.destinationAccountId || null,
    amount: Math.abs(Number(t.amount) || 0),
    currency: CURRENCIES.includes(t.currency) ? t.currency : "NGN",
    receivedAmount: t.receivedAmount == null ? null : Math.abs(Number(t.receivedAmount) || 0),
    receivedCurrency: t.receivedCurrency && CURRENCIES.includes(t.receivedCurrency) ? t.receivedCurrency : null,
    fxRate: t.fxRate == null ? null : Number(t.fxRate),
    fxSource: t.fxSource || null,
    category: String(t.category || ""),
    note: String(t.note || ""),
    linkedGoalIds: Array.isArray(t.linkedGoalIds) ? t.linkedGoalIds : []
  })) : [];

  next.goals = Array.isArray(raw.goals) ? raw.goals.map(g => ({
    id: g.id || uid(),
    name: String(g.name || "Untitled goal"),
    target: Math.max(0, Number(g.target) || 0),
    currency: CURRENCIES.includes(g.currency) ? g.currency : next.settings.baseCurrency,
    accountIds: Array.isArray(g.accountIds) ? g.accountIds : [],
    deadline: g.deadline || "",
    status: g.status === "completed" ? "completed" : "active",
    createdAt: Number(g.createdAt) || Date.now()
  })) : [];

  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function account(id) {
  return state.accounts.find(a => a.id === id) || null;
}

function rate(from, to) {
  if (from === to) return 1;
  const table = state.settings.fx?.rates || DEFAULT_RATES;
  return Number(table?.[from]?.[to]) || Number(DEFAULT_RATES?.[from]?.[to]) || 1;
}

function convert(value, from, to, overrideRate = null) {
  const amount = Number(value) || 0;
  if (from === to) return amount;
  if (overrideRate && overrideRate > 0) return amount * overrideRate;
  return amount * rate(from, to);
}

function money(value, currency = state.settings.baseCurrency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(Number(value) || 0);
  } catch {
    return `${currency} ${(Number(value) || 0).toLocaleString()}`;
  }
}

function netWorth() {
  return state.accounts
    .filter(a => !a.archived)
    .reduce((sum, a) => sum + convert(a.balance, a.currency, state.settings.baseCurrency), 0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function transactionLabel(t) {
  if (t.type === "income") return t.category || "Money added";
  if (t.type === "expense") return t.category || "Expense";
  if (t.type === "transfer") return "Transfer";
  if (t.type === "withdrawal") return "Cash withdrawal";
  if (t.type === "adjustment") return "Balance adjustment";
  return t.type;
}

function transactionDirection(t) {
  if (t.type === "income") return "in";
  if (t.type === "expense" || t.type === "withdrawal") return "out";
  return "neutral";
}

function render() {
  if (!$("netWorth")) return;
  $("netWorth").textContent = state.settings.privacyHidden ? "•••••••" : money(netWorth());
  $("baseCurrencyButton").textContent = `${state.settings.baseCurrency} · Base currency`;
  $("accountCount").textContent = `${state.accounts.filter(a => !a.archived).length} account${state.accounts.filter(a => !a.archived).length === 1 ? "" : "s"}`;
  $("syncState").textContent = state.settings.mode === "offline" ? "Offline" : "Local-first";
  renderAccounts();
  renderActivity();
  renderGoal();
  renderFullViews();
}

function renderAccounts() {
  const el = $("accountList");
  const accounts = state.accounts.filter(a => !a.archived).slice(0, 5);
  if (!accounts.length) {
    el.innerHTML = '<div class="empty-state">No money nodes yet. Add your first account.</div>';
    return;
  }
  el.innerHTML = accounts.map(a => `
    <div class="account-row">
      <div class="account-main">
        <span class="node">◉</span>
        <div class="truncate">
          <div>${escapeHtml(a.name)}</div>
          <div class="muted">${escapeHtml(a.currency)} · ${escapeHtml(a.type)}</div>
        </div>
      </div>
      <span class="amount">${state.settings.privacyHidden ? "••••" : escapeHtml(money(a.balance, a.currency))}</span>
    </div>
  `).join("");
}

function renderActivity() {
  const el = $("activityList");
  const rows = state.transactions.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">Transactions will appear here.</div>';
    return;
  }
  el.innerHTML = rows.map(t => {
    const source = account(t.sourceAccountId);
    const destination = account(t.destinationAccountId);
    const direction = transactionDirection(t);
    const sign = direction === "out" ? "−" : direction === "in" ? "+" : "";
    const context = t.type === "transfer"
      ? `${source ? escapeHtml(source.name) : "Unknown"} → ${destination ? escapeHtml(destination.name) : "Unknown"}`
      : source ? escapeHtml(source.name) : "";
    return `
      <div class="activity-row">
        <div>
          <div>${escapeHtml(transactionLabel(t))}${t.status === "needs_review" ? ' <span class="muted">· review</span>' : ""}</div>
          <div class="muted">${escapeHtml(t.date)} · ${context}</div>
        </div>
        <span class="amount">${sign}${escapeHtml(money(t.amount, t.currency))}</span>
      </div>
    `;
  }).join("");
}

function goalProgress(goal) {
  const current = goal.accountIds.reduce((sum, id) => {
    const a = account(id);
    return sum + (a ? convert(a.balance, a.currency, goal.currency) : 0);
  }, 0);
  return { current, pct: Math.min(100, goal.target ? current / goal.target * 100 : 0) };
}

function renderGoal() {
  const el = $("goalContent");
  const goal = state.goals.find(g => g.status !== "completed");
  if (!goal) {
    el.innerHTML = state.goals.length
      ? '<div class="empty-state">All goals completed. Create another target.</div>'
      : '<div class="empty-state">Create your first financial target.</div>';
    return;
  }
  const { current, pct } = goalProgress(goal);
  el.innerHTML = `
    <strong>${escapeHtml(goal.name)}</strong>
    <div class="muted">${escapeHtml(money(current, goal.currency))} of ${escapeHtml(money(goal.target, goal.currency))}</div>
    <div style="height:10px;background:rgba(255,255,255,.08);border-radius:99px;margin:14px 0 8px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:inherit"></div>
    </div>
    <div class="muted">${pct.toFixed(0)}%${goal.deadline ? ` · Deadline ${escapeHtml(goal.deadline)}` : ""}</div>
  `;
}

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

function addTransaction(input) {
  const tx = {
    id: uid(),
    type: input.type,
    status: input.status || "recorded",
    date: input.date || today(),
    createdAt: Date.now(),
    sourceAccountId: input.sourceAccountId || null,
    destinationAccountId: input.destinationAccountId || null,
    amount: Math.abs(Number(input.amount) || 0),
    currency: input.currency || state.settings.baseCurrency,
    receivedAmount: input.receivedAmount == null ? null : Math.abs(Number(input.receivedAmount) || 0),
    receivedCurrency: input.receivedCurrency || null,
    fxRate: input.fxRate == null ? null : Number(input.fxRate),
    fxSource: input.fxSource || null,
    category: input.category || "",
    note: input.note || "",
    linkedGoalIds: Array.isArray(input.linkedGoalIds) ? input.linkedGoalIds : []
  };
  state.transactions.push(tx);
  return tx;
}

function applyTransaction(tx) {
  const source = account(tx.sourceAccountId);
  const destination = account(tx.destinationAccountId);

  if (tx.type === "income" && source) source.balance += tx.amount;
  if (tx.type === "expense" && source) source.balance -= tx.amount;
  if (tx.type === "withdrawal" && source) source.balance -= tx.amount;

  if (tx.type === "transfer") {
    if (!source || !destination) throw new Error("Both transfer accounts are required.");
    if (source.id === destination.id) throw new Error("Source and destination must be different.");
    source.balance -= tx.amount;
    const received = tx.receivedAmount ?? convert(tx.amount, tx.currency, destination.currency, tx.fxRate);
    destination.balance += received;
  }

  if (tx.type === "adjustment" && source) {
    source.balance += tx.amount;
  }
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
      const target = Number(prompt(`Actual balance for ${source.name} (${source.currency}):`, String(source.balance)));
      if (!Number.isFinite(target) || target < 0) return;
      const delta = target - source.balance;
      const tx = addTransaction({
        type: "adjustment",
        sourceAccountId: source.id,
        amount: Math.abs(delta),
        currency: source.currency,
        category: delta >= 0 ? "Reconciliation increase" : "Reconciliation decrease",
        note: note || "Balance reconciliation",
        date
      });
      if (delta < 0) tx.amount = Math.abs(delta);
      source.balance = target;
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
        date
      });
      source.balance -= amount;
      destination.balance += received;
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
        status
      });
      if (type === "income") source.balance += amount;
      if (type === "expense" || type === "withdrawal") source.balance -= amount;
    }
    saveState();
    $("quickDialog").close();
    event.target.reset();
  } catch (error) {
    alert(error.message || "Could not record transaction.");
  }
}

function renderFullViews() {
  const accountsEl = $("accountsFullList");
  if (accountsEl) accountsEl.innerHTML = state.accounts.filter(a => !a.archived).map(a => `
    <div class="account-row account-full">
      <div class="account-main"><span class="node">◉</span><div><strong>${escapeHtml(a.name)}</strong><div class="muted">${escapeHtml(a.institution || "Personal")} · ${escapeHtml(a.type)} · ${escapeHtml(a.currency)}</div></div></div>
      <div class="account-tools"><strong>${state.settings.privacyHidden ? "••••" : escapeHtml(money(a.balance,a.currency))}</strong><button data-reconcile="${escapeHtml(a.id)">Reconcile</button></div>
    </div>`).join("") || '<div class="empty-state">No accounts yet.</div>';

  const goalsEl = $("goalsFullList");
  if (goalsEl) goalsEl.innerHTML = state.goals.map(g => {
    const p = goalProgress(g);
    return `<div class="goal-row"><div><strong>${escapeHtml(g.name)}</strong><div class="muted">${escapeHtml(money(p.current,g.currency))} of ${escapeHtml(money(g.target,g.currency))} · ${p.pct.toFixed(0)}%${g.deadline ? " · "+escapeHtml(g.deadline) : ""}</div></div><span class="status-chip">${escapeHtml(g.status)}</span></div>`;
  }).join("") || '<div class="empty-state">No goals yet.</div>';

  const search = ($("activitySearch")?.value || "").toLowerCase();
  const activityEl = $("activityFullList");
  if (activityEl) activityEl.innerHTML = state.transactions.slice().sort((a,b)=>b.createdAt-a.createdAt).filter(t => {
    const s = `${transactionLabel(t)} ${t.note} ${t.date} ${account(t.sourceAccountId)?.name || ""}`.toLowerCase();
    return s.includes(search);
  }).map(t => {
    const source = account(t.sourceAccountId), dest = account(t.destinationAccountId);
    const direction = transactionDirection(t);
    const sign = direction === "out" ? "−" : direction === "in" ? "+" : "";
    const detail = t.type === "transfer" ? `${source?.name || "Unknown"} → ${dest?.name || "Unknown"}` : source?.name || "Unknown";
    return `<div class="activity-row"><div><strong>${escapeHtml(transactionLabel(t))}</strong><div class="muted">${escapeHtml(t.date)} · ${escapeHtml(detail)}${t.note ? " · "+escapeHtml(t.note) : ""}</div></div><div class="activity-value"><strong>${sign}${escapeHtml(money(t.amount,t.currency))}</strong><span class="muted">${escapeHtml(t.status)}</span></div></div>`;
  }).join("") || '<div class="empty-state">No matching activity.</div>';

  document.querySelectorAll("[data-reconcile]").forEach(button => {
    button.onclick = () => {
      const a = account(button.dataset.reconcile);
      if (!a) return;
      const target = Number(prompt(`Actual balance for ${a.name} (${a.currency}):`, String(a.balance)));
      if (!Number.isFinite(target) || target < 0 || target === a.balance) return;
      const delta = target - a.balance;
      addTransaction({type:"adjustment",sourceAccountId:a.id,amount:Math.abs(delta),currency:a.currency,category:delta > 0 ? "Reconciliation increase" : "Reconciliation decrease",note:"Balance reconciliation",date:today()});
      a.balance = target;
      saveState();
    };
  });
}

function navigate(page) {
  const names = ["Home","Accounts","Goals","Activity","More"];
  names.forEach(name => {
    const view = $("page"+name);
    if (view) view.hidden = name !== page;
  });
  document.querySelectorAll(".nav-item[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  document.querySelector(".main-content")?.scrollTo({top:0,behavior:"smooth"});
}

function createGoal() {
  if (!state.accounts.some(a => !a.archived)) return alert("Add an account first.");
  const name = prompt("Goal name:");
  if (!name?.trim()) return;
  const target = Number(prompt("Target amount:", "100000"));
  if (!(target > 0)) return;
  const currency = (prompt("Goal currency (NGN, USD, GBP, EUR):", state.settings.baseCurrency) || state.settings.baseCurrency).toUpperCase();
  if (!CURRENCIES.includes(currency)) return alert("Unsupported currency.");
  const selected = state.accounts.filter(a => !a.archived).filter(a => confirm(`Include ${a.name} (${a.currency}) in this goal?`));
  const deadline = prompt("Deadline (YYYY-MM-DD, optional):", "");
  state.goals.push({id:uid(),name:name.trim(),target,currency,accountIds:selected.map(a=>a.id),deadline:deadline || "",status:"active",createdAt:Date.now()});
  saveState();
}

function setupDynamicFields() {
  const destination = document.createElement("label");
  destination.id = "quickDestinationWrap";
  destination.style.display = "none";
  destination.innerHTML = 'Destination<select id="quickDestination"></select>';
  $("quickAccount").closest("label").after(destination);

  const received = document.createElement("label");
  received.id = "quickReceivedWrap";
  received.style.display = "none";
  received.innerHTML = '<span id="quickReceivedLabel">Received</span><input id="quickReceivedAmount" inputmode="decimal" type="number" min="0" step="0.01" placeholder="Leave blank to calculate">';
  $("quickDate").closest("label").before(received);

  const fx = document.createElement("label");
  fx.id = "quickFxWrap";
  fx.style.display = "none";
  fx.innerHTML = 'Actual FX rate <span class="muted">(optional)</span><input id="quickFxRate" inputmode="decimal" type="number" min="0" step="0.000001" placeholder="Leave blank for snapshot">';
  received.after(fx);

  const status = document.createElement("label");
  status.id = "quickStatusWrap";
  status.style.display = "none";
  status.innerHTML = 'Status<select id="quickStatus"><option value="recorded">Record now</option><option value="needs_review">Handle later</option></select>';
  $("quickNote").closest("label").after(status);

  $("quickAccount").addEventListener("change", syncTransferFields);
  $("quickDestination").addEventListener("change", syncTransferFields);
}

$("fab").onclick = () => openQuick("expense");
document.querySelectorAll("[data-quick]").forEach(button => {
  button.addEventListener("click", () => openQuick(button.dataset.quick));
});
$("addAccountButton").onclick = () => $("accountDialog").showModal();

$("accountForm").addEventListener("submit", event => {
  event.preventDefault();
  const accountData = {
    id: uid(),
    name: $("accountName").value.trim(),
    institution: $("accountInstitution").value.trim(),
    type: $("accountType").value,
    currency: $("accountCurrency").value,
    openingBalance: Number($("accountBalance").value) || 0,
    balance: Number($("accountBalance").value) || 0,
    archived: false,
    createdAt: Date.now()
  };
  if (!accountData.name) return;
  state.accounts.push(accountData);
  saveState();
  $("accountDialog").close();
  event.target.reset();
});

$("quickForm").addEventListener("submit", handleQuickSubmit);

$("privacyButton").onclick = () => {
  state.settings.privacyHidden = !state.settings.privacyHidden;
  saveState();
};

$("baseCurrencyButton").onclick = () => {
  const next = (prompt("Base currency (NGN, USD, GBP, EUR):", state.settings.baseCurrency) || "").toUpperCase();
  if (CURRENCIES.includes(next)) {
    state.settings.baseCurrency = next;
    saveState();
  }
};

$("addGoalButton").onclick = () => {
  if (!state.accounts.length) return alert("Add an account first.");
  const name = prompt("Goal name:");
  if (!name?.trim()) return;
  const target = Number(prompt("Target amount:", "100000"));
  if (!(target > 0)) return;
  const currency = (prompt("Goal currency (NGN, USD, GBP, EUR):", state.settings.baseCurrency) || state.settings.baseCurrency).toUpperCase();
  if (!CURRENCIES.includes(currency)) return alert("Unsupported currency.");
  const selected = state.accounts.filter(a => !a.archived).filter(a =>
    confirm(`Include ${a.name} (${a.currency}) in this goal?`)
  );
  state.goals.push({
    id: uid(),
    name: name.trim(),
    target,
    currency,
    accountIds: selected.map(a => a.id),
    deadline: "",
    status: "active",
    createdAt: Date.now()
  });
  saveState();
};

setupDynamicFields();
window.addEventListener("load", () => {
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js");
  render();
});
