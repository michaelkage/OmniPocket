/* OmniPocket — V1 financial domain + UI engine */
const STORAGE_KEY = "omnipocket.v1";
const storage = new OmniPocketStorage({ dbName: "omnipocket", storeName: "state", legacyKey: STORAGE_KEY });
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
    fx: { provider: "cached", updatedAt: null, rates: clone(DEFAULT_RATES), source: "bundled", base: "NGN" },
    dashboard: { layout: ["networth","trend","goals","accounts","activity","quick","fx"], hidden: [], order: ["networth","trend","goals","accounts","activity","quick","fx"] }
  },
  accounts: [],
  transactions: [],
  goals: []
};

let state = clone(DEFAULT_STATE);
let persistTimer = null;
let persistenceReady = false;
let quickType = "expense";

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return migrateState(raw);
  } catch {
    return clone(DEFAULT_STATE);
  }
}

async function bootstrapStorage() {
  try {
    const loaded = await storage.load();
    state = migrateState(loaded || loadState());
    persistenceReady = true;
    rebuildBalances();
    if (!loaded) await storage.save(state);
  } catch (error) {
    console.warn("IndexedDB unavailable; using local fallback.", error);
    state = loadState();
  }
  render();
}

function migrateState(raw) {
  if (!raw || typeof raw !== "object") return clone(DEFAULT_STATE);

  const next = clone(DEFAULT_STATE);
  next.settings = { ...next.settings, ...(raw.settings || {}) };
  next.settings.fx = {
    ...clone(DEFAULT_STATE.settings.fx),
    ...(raw.settings?.fx || {})
  };
  next.settings.dashboard = {
    ...clone(DEFAULT_STATE.settings.dashboard),
    ...(raw.settings?.dashboard || {})
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
  render();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      if (persistenceReady) await storage.save(state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn("Could not persist OmniPocket state.", error);
    }
  }, 0);
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

function adjustmentDelta(t) {
  const label = (t.category || "").toLowerCase();
  return label.includes("decrease") ? -Math.abs(t.amount) : Math.abs(t.amount);
}

function rebuildBalances() {
  state.accounts.forEach(a => { a.balance = Number(a.openingBalance) || 0; });
  const txs = state.transactions.slice().sort((a,b) => {
    const dateCompare = String(a.date).localeCompare(String(b.date));
    return dateCompare || a.createdAt - b.createdAt;
  });
  for (const tx of txs) {
    const source = account(tx.sourceAccountId);
    const destination = account(tx.destinationAccountId);
    if (tx.type === "income" && source) source.balance += tx.amount;
    if (tx.type === "expense" && source) source.balance -= tx.amount;
    if (tx.type === "withdrawal") {
      if (source) source.balance -= tx.amount;
      if (destination) destination.balance += tx.receivedAmount ?? convert(tx.amount, tx.currency, destination.currency, tx.fxRate);
    }
    if (tx.type === "transfer") {
      if (source) source.balance -= tx.amount;
      if (destination) destination.balance += tx.receivedAmount ?? convert(tx.amount, tx.currency, destination.currency, tx.fxRate);
    }
    if (tx.type === "adjustment" && source) source.balance += adjustmentDelta(tx);
  }
}

function openTransactionDetail(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  const source = account(t.sourceAccountId);
  const dest = account(t.destinationAccountId);
  const incoming = t.type !== "income" && dest && !source ? dest : null;
  const displayAmount = t.receivedAmount != null && t.type !== "expense" && dest ? t.receivedAmount : t.amount;
  const displayCurrency = t.receivedAmount != null && t.type !== "expense" && dest ? (t.receivedCurrency || t.currency) : t.currency;
  $("transactionDetailTitle").textContent = transactionLabel(t);
  $("transactionDetailMeta").textContent = t.date + " · " + t.type;
  $("transactionDetailAmount").textContent = state.settings.privacyHidden ? "••••••" : money(displayAmount, displayCurrency);
  $("transactionDetailContext").textContent = t.type === "transfer" || t.type === "withdrawal"
    ? (source?.name || "Unknown") + " → " + (dest?.name || "Unknown")
    : source?.name || incoming?.name || "Unknown account";
  $("transactionDetailStatus").textContent = t.status === "needs_review" ? "Needs review — handle later" : "Recorded";
  const linkedGoals = state.goals.filter(g => (t.linkedGoalIds || []).includes(g.id));
  $("transactionDetailGoals").innerHTML = linkedGoals.length ? linkedGoals.map(g => '<button class="link-row" data-goal-from-transaction="' + escapeHtml(g.id) + '"><strong>' + escapeHtml(g.name) + "</strong><span>" + escapeHtml(money(goalProgress(g).current, g.currency)) + "</span></button>").join("") : '<div class="empty-state">No goals linked.</div>';
  $("transactionDetailNote").textContent = t.note || "No note.";
  $("transactionReviewButton").textContent = t.status === "needs_review" ? "Mark recorded" : "Mark for review";
  $("transactionDialog").dataset.transactionId = id;
  $("transactionDialog").showModal();
}

function populateEditTransactionAccounts(t) {
  const active = state.accounts.filter(a => !a.archived);
  $("editTxSource").innerHTML = active.map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + " · " + escapeHtml(a.currency) + "</option>").join("");
  $("editTxDestination").innerHTML = active.map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + " · " + escapeHtml(a.currency) + "</option>").join("");
  $("editTxSource").value = t.sourceAccountId || "";
  $("editTxDestination").value = t.destinationAccountId || "";
}

function syncEditTransactionFields() {
  const type = $("editTxType").value;
  const movement = type === "transfer" || type === "withdrawal";
  $("editTxDestinationWrap").style.display = movement ? "grid" : "none";
  $("editTxReceivedWrap").style.display = movement ? "grid" : "none";
  $("editTxFxWrap").style.display = movement ? "grid" : "none";
}

function editTransaction(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  $("editTxType").value = t.type;
  populateEditTransactionAccounts(t);
  $("editTxAmount").value = t.amount;
  $("editTxReceived").value = t.receivedAmount ?? "";
  $("editTxFxRate").value = t.fxRate ?? "";
  $("editTxDate").value = t.date;
  $("editTxCategory").value = t.category;
  $("editTxNote").value = t.note;
  $("editTxStatus").value = t.status;
  $("editTransactionDialog").dataset.transactionId = id;
  syncEditTransactionFields();
  $("transactionDialog").close();
  $("editTransactionDialog").showModal();
}


function deleteTransaction(id) {
  const index = state.transactions.findIndex(x => x.id === id);
  if (index < 0) return;
  const t = state.transactions[index];
  if (!confirm("Delete this transaction? The account balance will be recalculated.")) return;
  state.transactions.splice(index, 1);
  rebuildBalances();
  saveState();
  $("transactionDialog")?.close();
}

function parseMoneyText(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const currencyMatch = raw.match(/(?:NGN|N|₦|USD|US\$|\$|GBP|£|EUR|€)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i)
    || raw.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:NGN|Naira|USD|GBP|EUR)/i);
  if (!currencyMatch) return null;
  const amount = Number(String(currencyMatch[1]).replace(/,/g, ""));
  if (!(amount > 0)) return null;
  const upper = raw.toUpperCase();
  let currency = "NGN";
  if (/USD|US\$|\$/.test(upper)) currency = "USD";
  else if (/GBP|£/.test(upper)) currency = "GBP";
  else if (/EUR|€/.test(upper)) currency = "EUR";
  let type = /SALARY|PAYROLL|WAGE|CREDITED|CR\b/i.test(raw) ? "income" : "expense";
  let category = "Other";
  const categories = [
    ["TRANSFER", "Transfer"], ["AIRTIME|DATA|MTN|GLO|AIRTEL|9MOBILE", "Bills & telecom"],
    ["FUEL|PETROL|DIESEL|TOTAL|OANDO", "Transport"], ["UBER|BOLT|RIDE", "Transport"],
    ["SHOP|STORE|MART|SUPERMARKET|GROCERY", "Shopping"], ["RESTAURANT|FOOD|CHICKEN|PIZZA|EAT", "Food"],
    ["SALARY|PAYROLL|WAGE", "Income"], ["ATM|CASH WITHDRAWAL", "Cash withdrawal"]
  ];
  for (const [pattern, label] of categories) if (new RegExp(pattern, "i").test(raw)) { category = label; break; }
  if (category === "Transfer") type = "transfer";
  if (category === "Income") type = "income";
  const dateMatch = raw.match(/\b(20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2})\b/);
  return { amount, currency, category, type, date: dateMatch ? dateMatch[1].replace(/\//g, "-") : today(), raw };
}

function parseClipboardText() {
  const text = $("smartTextInput")?.value || "";
  const parsed = parseMoneyText(text);
  if (!parsed) return alert("I couldn't find a clear amount in that text.");
  $("smartAmount").textContent = money(parsed.amount, parsed.currency);
  $("smartCategory").textContent = parsed.category;
  $("smartDate").textContent = parsed.date;
  $("smartApprove").textContent = parsed.type === "income" ? "Approve & add" : parsed.type === "transfer" ? "Review transfer" : "Approve & log expense";
  $("smartResult").hidden = false;
  $("smartApprove").dataset.amount = parsed.amount;
  $("smartApprove").dataset.currency = parsed.currency;
  $("smartApprove").dataset.category = parsed.category;
  $("smartApprove").dataset.type = parsed.type;
  $("smartApprove").dataset.date = parsed.date;
}

function renderNetWorthTrend() {
  const el = $("netWorthTrend");
  if (!el) return;
  const points = [];
  const ordered = state.transactions.slice().sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.createdAt - b.createdAt);
  const snapshots = [{ date: state.accounts.reduce((d,a) => a.createdAt < d ? a.createdAt : d, Date.now()), value: state.accounts.reduce((s,a) => s + convert(Number(a.openingBalance)||0,a.currency,state.settings.baseCurrency),0) }];
  for (const tx of ordered) {
    const accounts = clone(state.accounts).map(a => ({...a, balance:Number(a.openingBalance)||0}));
    for (const prior of ordered) {
      if (String(prior.date) > String(tx.date) || (String(prior.date) === String(tx.date) && prior.createdAt > tx.createdAt)) break;
      const src = accounts.find(a => a.id === prior.sourceAccountId), dst = accounts.find(a => a.id === prior.destinationAccountId);
      if (prior.type === "income" && src) src.balance += prior.amount;
      if (prior.type === "expense" && src) src.balance -= prior.amount;
      if ((prior.type === "transfer" || prior.type === "withdrawal")) { if (src) src.balance -= prior.amount; if (dst) dst.balance += prior.receivedAmount ?? convert(prior.amount,prior.currency,dst.currency,prior.fxRate); }
      if (prior.type === "adjustment" && src) src.balance += adjustmentDelta(prior);
    }
    snapshots.push({date:tx.date,value:accounts.filter(a=>!a.archived).reduce((s,a)=>s+convert(a.balance,a.currency,state.settings.baseCurrency),0)});
  }
  const unique = snapshots.reduce((acc,p)=> { const last=acc[acc.length-1]; if(last && last.date===p.date) last.value=p.value; else acc.push(p); return acc; }, []).slice(-30);
  const width=720,height=240,pad=28;
  const values=unique.map(p=>p.value), min=Math.min(...values,0), max=Math.max(...values,1), range=max-min||1;
  const coords=unique.map((p,i)=>[(unique.length===1?width/2:pad+i*(width-pad*2)/(unique.length-1)),height-pad-(p.value-min)/range*(height-pad*2)]);
  const path=coords.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
  el.innerHTML=unique.length>1 ? '<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Net worth trend"><path class="trend-line" d="'+path+'"></path>'+coords.map(p=>'<circle class="trend-dot" cx="'+p[0]+'" cy="'+p[1]+'" r="3"></circle>').join("")+'</svg><div class="trend-meta"><span>'+escapeHtml(unique[0].date)+'</span><strong>'+money(unique[unique.length-1].value)+'</strong><span>'+escapeHtml(unique[unique.length-1].date)+'</span></div>' : '<div class="empty-state">Log transactions to build your wealth trend.</div>';
}

function renderDashboard() {
  const root=$("dashboardGalaxy");
  if(!root) return;
  const widgets={
    networth:$("widgetNetWorth"), trend:$("widgetTrend"), goals:$("widgetGoals"), accounts:$("widgetAccounts"),
    activity:$("widgetActivity"), quick:$("widgetQuick"), fx:$("widgetFx")
  };
  const defaultOrder=["networth","trend","goals","accounts","activity","quick","fx","insights","spending"];\n  const order=[...(state.settings.dashboard.order || [])];\n  defaultOrder.forEach(id=>{ if(!order.includes(id)) order.push(id); });
  root.innerHTML="";
  order.filter(id=>widgets[id] && !(state.settings.dashboard.hidden||[]).includes(id)).forEach(id=>{ const widget=widgets[id]; widget.draggable=true; widget.dataset.widgetId=id; root.appendChild(widget); });
  const galaxyNetWorth=$("galaxyNetWorth"); if(galaxyNetWorth) galaxyNetWorth.textContent=state.settings.privacyHidden ? "•••••••" : money(netWorth());
  renderNetWorthTrend();
  const count=$("reviewCount"); if(count) count.textContent=state.transactions.filter(t=>t.status==="needs_review").length+" review";
  const fxStatus=$("fxCacheStatus"); if(fxStatus) fxStatus.textContent=state.settings.fx.updatedAt ? "Cached "+new Date(state.settings.fx.updatedAt).toLocaleString() : "Bundled rates";
}

async function refreshFxRates() {
  if (state.settings.mode === "offline") return alert("Offline mode keeps the last cached FX matrix.");
  const base=state.settings.baseCurrency;
  try {
    const response=await fetch("https://open.er-api.com/v6/latest/"+encodeURIComponent(base), {cache:"no-store"});
    if(!response.ok) throw new Error("FX service unavailable");
    const data=await response.json();
    if(!data.rates) throw new Error("No FX matrix returned");
    const rates={};
    for(const from of CURRENCIES){
      rates[from]={};
      for(const to of CURRENCIES){
        if(from===to) rates[from][to]=1;
        else if(from===base && data.rates[to]) rates[from][to]=Number(data.rates[to]);
        else if(to===base && data.rates[from]) rates[from][to]=1/Number(data.rates[from]);
        else if(data.rates[from] && data.rates[to]) rates[from][to]=Number(data.rates[to])/Number(data.rates[from]);
        else rates[from][to]=DEFAULT_RATES[from][to];
      }
    }
    state.settings.fx={provider:"live",updatedAt:Date.now(),rates,source:"open.er-api.com",base};
    saveState();
  } catch(error) {
    alert("Live FX refresh failed. OmniPocket will keep using its cached rates.");
  }
}

function openSmartParser() {
  $("smartTextInput").value="";
  $("smartResult").hidden=true;
  $("smartParserDialog").showModal();
}

function approveSmartParse() {
  const button=$("smartApprove"), amount=Number(button.dataset.amount), currency=button.dataset.currency;
  if(!(amount>0)) return;
  const source=state.accounts.find(a=>!a.archived && a.currency===currency) || state.accounts.find(a=>!a.archived);
  if(!source) return alert("Add an account first.");
  const type = button.dataset.type || "expense";
  if(type === "transfer") {
    $("smartParserDialog").close();
    openQuick("transfer");
    $("quickAccount").value = source.id;
    syncTransferFields();
    $("quickAmount").value = amount;
    $("quickNote").value = "Imported from pasted alert — review destination before recording.";
    $("quickStatus").value = "needs_review";
    return;
  }
  addTransaction({
    type:type==="income"?"income":"expense",
    sourceAccountId:source.id,
    amount,
    currency:source.currency,
    category:button.dataset.category||"Other",
    date:button.dataset.date||today(),
    note:"Imported from pasted alert",
    status:"recorded"
  });
  saveState();
  $("smartParserDialog").close();
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
  renderDashboard();
}

function renderAccounts() {
  const el = $("accountList");
  const accounts = state.accounts.filter(a => !a.archived).slice(0, 5);
  if (!accounts.length) {
    el.innerHTML = '<div class="empty-state">No money nodes yet. Add your first account.</div>';
    return;
  }
  el.innerHTML = accounts.map(a => `
    <div class="account-row interactive-row" data-account-id="${escapeHtml(a.id)}" tabindex="0" role="button" aria-label="Open account">
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
      <div class="activity-row interactive-row" data-transaction-id="${escapeHtml(t.id)}" tabindex="0" role="button">
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
  el.innerHTML = `<div class="interactive-row" data-goal-id="${escapeHtml(goal.id)}" tabindex="0" role="button">
    <strong>${escapeHtml(goal.name)}</strong>
    <div class="muted">${escapeHtml(money(current, goal.currency))} of ${escapeHtml(money(goal.target, goal.currency))}</div>
    <div style="height:10px;background:rgba(255,255,255,.08);border-radius:99px;margin:14px 0 8px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:inherit"></div>
    </div>
    <div class="muted">${pct.toFixed(0)}%${goal.deadline ? ` · Deadline ${escapeHtml(goal.deadline)}` : ""}</div>
  </div>`;
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
        date
      });
      source.balance -= amount;
      destination.balance += received;
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
      if (type === "expense") source.balance -= amount;
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
    <div class="account-row account-full interactive-row" data-account-id="${escapeHtml(a.id)}" tabindex="0" role="button" aria-label="Open account">
      <div class="account-main"><span class="node">◉</span><div><strong>${escapeHtml(a.name)}</strong><div class="muted">${escapeHtml(a.institution || "Personal")} · ${escapeHtml(a.type)} · ${escapeHtml(a.currency)}</div></div></div>
      <div class="account-tools"><strong>${state.settings.privacyHidden ? "••••" : escapeHtml(money(a.balance,a.currency))}</strong><button data-reconcile="${escapeHtml(a.id)}">Reconcile</button></div>
    </div>`).join("") || '<div class="empty-state">No accounts yet.</div>';

  const goalsEl = $("goalsFullList");
  if (goalsEl) goalsEl.innerHTML = state.goals.map(g => {
    const p = goalProgress(g);
    return `<div class="goal-row interactive-row" data-goal-id="${escapeHtml(g.id)}" tabindex="0" role="button" aria-label="Open goal"><div><strong>${escapeHtml(g.name)}</strong><div class="muted">${escapeHtml(money(p.current,g.currency))} of ${escapeHtml(money(g.target,g.currency))} · ${p.pct.toFixed(0)}%${g.deadline ? " · "+escapeHtml(g.deadline) : ""}</div></div><span class="status-chip">${escapeHtml(g.status)}</span></div>`;
  }).join("") || '<div class="empty-state">No goals yet.</div>';

  const search = ($("activitySearch")?.value || "").toLowerCase();
  const activityEl = $("activityFullList");
  if (activityEl) activityEl.innerHTML = state.transactions.slice().sort((a,b)=>b.createdAt-a.createdAt).filter(t => {
    const s = `${transactionLabel(t)} ${t.note} ${t.date} ${t.status} ${t.type} ${account(t.sourceAccountId)?.name || ""} ${account(t.destinationAccountId)?.name || ""}`.toLowerCase();
    return s.includes(search);
  }).map(t => {
    const source = account(t.sourceAccountId), dest = account(t.destinationAccountId);
    const direction = transactionDirection(t);
    const sign = direction === "out" ? "−" : direction === "in" ? "+" : "";
    const detail = t.type === "transfer" ? `${source?.name || "Unknown"} → ${dest?.name || "Unknown"}` : source?.name || "Unknown";
    return `<div class="activity-row interactive-row" data-transaction-id="${escapeHtml(t.id)}" tabindex="0" role="button"><div><strong>${escapeHtml(transactionLabel(t))}</strong><div class="muted">${escapeHtml(t.date)} · ${escapeHtml(detail)}${t.note ? " · "+escapeHtml(t.note) : ""}</div></div><div class="activity-value"><strong>${sign}${escapeHtml(money(t.amount,t.currency))}</strong><span class="muted">${escapeHtml(t.status)}</span></div></div>`;
  }).join("") || '<div class="empty-state">No matching activity.</div>';

  document.querySelectorAll("[data-reconcile]").forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      const a = account(button.dataset.reconcile);
      if (!a) return;
      $("reconcileMeta").textContent = a.name + " · " + a.currency + " · Current " + money(a.balance, a.currency);
      $("reconcileAmount").value = a.balance;
      $("reconcileNote").value = "";
      $("reconcileDialog").dataset.accountId = a.id;
      $("reconcileDialog").showModal();
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

document.addEventListener("click", event => {
  const accountRow = event.target.closest("[data-account-id]");
  if (accountRow && !event.target.closest("button")) openAccountDetail(accountRow.dataset.accountId);
  const goalRow = event.target.closest("[data-goal-id]");
  if (goalRow && !event.target.closest("button")) openGoalDetail(goalRow.dataset.goalId);
  const goalLink = event.target.closest("[data-goal-from-account]");
  if (goalLink) { $("accountDetailDialog")?.close(); openGoalDetail(goalLink.dataset.goalFromAccount); }
  const accountLink = event.target.closest("[data-account-from-goal]");
  if (accountLink) { $("goalDetailDialog")?.close(); openAccountDetail(accountLink.dataset.accountFromGoal); }
});

document.addEventListener("click", event => {
  const txRow = event.target.closest("[data-transaction-id]");
  if (txRow && !event.target.closest("button")) openTransactionDetail(txRow.dataset.transactionId);
});

$("transactionEditButton")?.addEventListener("click", () => editTransaction($("transactionDialog").dataset.transactionId));
$("transactionDeleteButton")?.addEventListener("click", () => deleteTransaction($("transactionDialog").dataset.transactionId));
document.addEventListener("click", event => { const goalLink = event.target.closest("[data-goal-from-transaction]"); if (goalLink) { $("transactionDialog")?.close(); openGoalDetail(goalLink.dataset.goalFromTransaction); } });

$("transactionReviewButton")?.addEventListener("click", () => {
  const t = state.transactions.find(x => x.id === $("transactionDialog").dataset.transactionId);
  if (!t) return;
  t.status = t.status === "needs_review" ? "recorded" : "needs_review";
  saveState();
  openTransactionDetail(t.id);
});

$("editTxType")?.addEventListener("change", syncEditTransactionFields);

$("editTransactionForm")?.addEventListener("submit", event => {
  event.preventDefault();
  const t = state.transactions.find(x => x.id === $("editTransactionDialog").dataset.transactionId);
  if (!t) return;
  const amount = Number($("editTxAmount").value);
  const type = $("editTxType").value;
  const source = account($("editTxSource").value);
  const destination = account($("editTxDestination").value);
  if (!(amount > 0) || !source) return alert("Enter a valid amount and account.");
  if ((type === "transfer" || type === "withdrawal") && (!destination || destination.id === source.id)) return alert("Choose a different destination.");
  if (type === "withdrawal" && destination.type !== "cash") return alert("Cash out must land in a Cash account.");
  t.type = type;
  t.sourceAccountId = source.id;
  t.destinationAccountId = type === "transfer" || type === "withdrawal" ? destination.id : null;
  t.amount = amount;
  t.receivedAmount = type === "transfer" || type === "withdrawal" ? (Number($("editTxReceived").value) || convert(amount, source.currency, destination.currency, Number($("editTxFxRate").value) || null)) : null;
  t.receivedCurrency = type === "transfer" || type === "withdrawal" ? destination.currency : null;
  t.fxRate = type === "transfer" || type === "withdrawal" ? (Number($("editTxFxRate").value) || null) : null;
  t.fxSource = t.fxRate ? "manual" : (type === "transfer" || type === "withdrawal" ? "snapshot" : null);
  t.date = $("editTxDate").value || t.date;
  t.category = $("editTxCategory").value.trim();
  t.note = $("editTxNote").value.trim();
  t.status = $("editTxStatus").value;
  t.createdAt = Date.now();
  rebuildBalances();
  saveState();
  $("editTransactionDialog").close();
});

$("goalDetailEdit")?.addEventListener("click", () => {
  const g = state.goals.find(x => x.id === $("goalDetailDialog").dataset.goalId);
  if (!g) return;
  $("goalDetailDialog").close();
  $("goalName").value = g.name;
  $("goalTarget").value = g.target;
  $("goalCurrency").value = g.currency;
  $("goalDeadline").value = g.deadline || "";
  populateGoalAccounts(g.accountIds);
  $("goalDialog").dataset.editingId = g.id;
  $("goalDialog").showModal();
});

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

function openAccountDetail(id) {
  const a = account(id);
  if (!a) return;
  const txs = state.transactions.filter(t => t.sourceAccountId === id || t.destinationAccountId === id).sort((x,y) => y.createdAt - x.createdAt);
  const goals = state.goals.filter(g => g.accountIds.includes(id));
  $("accountDetailTitle").textContent = a.name;
  $("accountDetailMeta").textContent = [a.institution || "Personal", a.type, a.currency].join(" · ");
  $("accountDetailBalance").textContent = state.settings.privacyHidden ? "••••••" : money(a.balance, a.currency);
  $("accountDetailConverted").textContent = state.settings.privacyHidden ? "••••••" : "≈ " + money(convert(a.balance, a.currency, state.settings.baseCurrency), state.settings.baseCurrency);
  $("accountDetailStats").innerHTML = "<span>" + txs.length + " transaction" + (txs.length === 1 ? "" : "s") + "</span><span>" + (a.archived ? "Archived" : "Active") + "</span>";
  $("accountDetailGoals").innerHTML = goals.length ? goals.map(g => '<button class="link-row" data-goal-from-account="' + escapeHtml(g.id) + '"><strong>' + escapeHtml(g.name) + "</strong><span>" + escapeHtml(money(goalProgress(g).current, g.currency)) + "</span></button>").join("") : '<div class="empty-state">This account is not contributing to a goal.</div>';
  $("accountDetailActivity").innerHTML = txs.slice(0,8).map(t => {
    const incoming = t.destinationAccountId === id && t.sourceAccountId !== id;
    const sign = incoming ? "+" : transactionDirection(t) === "out" ? "−" : "";
    const other = t.sourceAccountId === id ? account(t.destinationAccountId) : account(t.sourceAccountId);
    const displayAmount = incoming && t.receivedAmount != null ? t.receivedAmount : t.amount;
    const displayCurrency = incoming && t.receivedCurrency ? t.receivedCurrency : t.currency;
    return '<div class="activity-row"><div><strong>' + escapeHtml(transactionLabel(t)) + "</strong><div class=\"muted\">" + escapeHtml(t.date) + " · " + escapeHtml(other?.name || "") + "</div></div><span class=\"amount\">" + sign + escapeHtml(money(displayAmount, displayCurrency)) + "</span></div>";
  }).join("") || '<div class="empty-state">No activity yet.</div>';
  $("accountDetailDialog").dataset.accountId = id;
  $("accountDetailDialog").showModal();
}

function editAccount(id) {
  const a = account(id);
  if (!a) return;
  $("editAccountName").value = a.name;
  $("editAccountInstitution").value = a.institution;
  $("editAccountType").value = a.type;
  $("editAccountCurrency").value = a.currency;
  $("editAccountDialog").dataset.accountId = id;
  $("editAccountDialog").showModal();
}

function archiveAccount(id) {
  const a = account(id);
  if (!a) return;
  if (!confirm("Archive " + a.name + "? Its history will be kept.")) return;
  a.archived = true;
  saveState();
  $("accountDetailDialog")?.close();
}

function openGoalDetail(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  const p = goalProgress(g);
  const days = g.deadline ? Math.max(0, Math.ceil((new Date(g.deadline) - new Date(today())) / 86400000)) : null;
  $("goalDetailTitle").textContent = g.name;
  $("goalDetailProgress").textContent = state.settings.privacyHidden ? "••••••" : money(p.current, g.currency) + " of " + money(g.target, g.currency);
  $("goalDetailBar").style.width = p.pct + "%";
  $("goalDetailMeta").textContent = p.pct.toFixed(0) + "% complete" + (days !== null ? " · " + days + " day" + (days === 1 ? "" : "s") + " remaining" : "");
  $("goalDetailAccounts").innerHTML = g.accountIds.map(id => account(id)).filter(Boolean).map(a => '<button class="link-row" data-account-from-goal="' + escapeHtml(a.id) + '"><strong>' + escapeHtml(a.name) + "</strong><span>" + escapeHtml(money(a.balance, a.currency)) + "</span></button>").join("") || '<div class="empty-state">No contributing accounts selected.</div>';
  const pace = days && p.current < g.target ? (g.target - p.current) / days : 0;
  $("goalDetailPace").textContent = pace > 0 ? "Needed pace: " + money(pace, g.currency) + " / day" : p.current >= g.target ? "Target reached." : "No deadline set.";
  $("goalDetailDialog").dataset.goalId = id;
  $("goalDetailDialog").showModal();
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

$("dashboardAddGoal")?.addEventListener("click", createGoal);
$("dashboardAddAccount")?.addEventListener("click", () => $("accountDialog").showModal());
$("fab").onclick = () => openQuick("expense");
document.querySelectorAll("[data-quick]").forEach(button => {
  button.addEventListener("click", () => openQuick(button.dataset.quick));
});
$("addAccountButton").onclick = () => $("accountDialog").showModal();
$("addAccountPageButton")?.addEventListener("click", () => $("accountDialog").showModal());
$("addGoalPageButton")?.addEventListener("click", () => $("addGoalButton").click());
$("menuButton")?.addEventListener("click", () => navigate("More"));

$("modeButton")?.addEventListener("click", () => {
  state.settings.mode = state.settings.mode === "offline" ? "hybrid" : "offline";
  $("modeButton").textContent = `Mode · ${state.settings.mode === "offline" ? "Offline" : "Hybrid"}`;
  saveState();
});

$("privacySettingsButton")?.addEventListener("click", () => {
  state.settings.privacyHidden = !state.settings.privacyHidden;
  $("privacySettingsButton").textContent = `Privacy · ${state.settings.privacyHidden ? "Hidden" : "Visible"}`;
  saveState();
});

$("exportButton")?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `omnipocket-backup-${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

$("importButton")?.addEventListener("click", () => $("importFile")?.click());
$("importFile")?.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = migrateState(JSON.parse(await file.text()));
    if (!confirm("Replace current OmniPocket data with this backup?")) return;
    state = imported;
    saveState();
    alert("Backup imported.");
  } catch {
    alert("That file is not a valid OmniPocket backup.");
  } finally {
    event.target.value = "";
  }
});

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
  $("baseCurrencySelect").value = state.settings.baseCurrency;
  $("currencyDialog").showModal();
};

$("currencyForm")?.addEventListener("submit", event => {
  event.preventDefault();
  state.settings.baseCurrency = $("baseCurrencySelect").value;
  saveState();
  $("currencyDialog").close();
});

$("reconcileForm")?.addEventListener("submit", event => {
  event.preventDefault();
  const a = account($("reconcileDialog").dataset.accountId);
  if (!a) return;
  const target = Number($("reconcileAmount").value);
  if (!Number.isFinite(target) || target < 0) return alert("Enter a valid balance.");
  if (target === a.balance) return $("reconcileDialog").close();
  const delta = target - a.balance;
  addTransaction({
    type:"adjustment",
    sourceAccountId:a.id,
    amount:Math.abs(delta),
    currency:a.currency,
    category:delta > 0 ? "Reconciliation increase" : "Reconciliation decrease",
    note:$("reconcileNote").value.trim() || "Balance reconciliation",
    date:today()
  });
  a.balance = target;
  saveState();
  $("reconcileDialog").close();
});

$("addGoalButton").onclick = () => createGoal();

$("smartParseButton")?.addEventListener("click", parseClipboardText);
$("smartPasteButton")?.addEventListener("click", async () => {
  try { $("smartTextInput").value = await navigator.clipboard.readText(); parseClipboardText(); }
  catch { alert("Clipboard access was blocked. Paste the alert into the box instead."); }
});
$("smartApprove")?.addEventListener("click", approveSmartParse);
$("smartReceiptInput")?.addEventListener("change", event => {
  const file=event.target.files?.[0];
  if(file) { $("receiptStatus").textContent="Receipt selected. Local OCR adapter is ready for a bundled OCR engine; no image is uploaded by OmniPocket."; }
});
$("refreshFxButton")?.addEventListener("click", refreshFxRates);
let draggedWidgetId=null;
document.addEventListener("dragstart", event => { const widget=event.target.closest("[data-widget-id]"); if(!widget) return; draggedWidgetId=widget.dataset.widgetId; widget.classList.add("dragging"); });
document.addEventListener("dragend", event => { const widget=event.target.closest("[data-widget-id]"); widget?.classList.remove("dragging"); draggedWidgetId=null; });
document.addEventListener("dragover", event => { const target=event.target.closest("[data-widget-id]"); if(!target || !draggedWidgetId || target.dataset.widgetId===draggedWidgetId) return; event.preventDefault(); const root=$("dashboardGalaxy"); const dragged=root.querySelector("[data-widget-id='"+draggedWidgetId+"']"); if(!dragged) return; const rect=target.getBoundingClientRect(); root.insertBefore(dragged,event.clientY < rect.top+rect.height/2 ? target : target.nextSibling); });
document.addEventListener("drop", event => { if(!draggedWidgetId) return; const order=[...document.querySelectorAll("#dashboardGalaxy [data-widget-id]")].map(el=>el.dataset.widgetId); state.settings.dashboard.order=order; saveState(); });
$("dashboardCustomizeButton")?.addEventListener("click", () => {
  const hidden=state.settings.dashboard.hidden||[];
  document.querySelectorAll("[data-widget-hidden]").forEach(el=>el.checked=!hidden.includes(el.dataset.widgetHidden));
  const current=(state.settings.dashboard.order||["networth","trend","goals","accounts","activity","quick","fx","insights","spending"]).slice();
  const select=$("widgetOrderSelect");
  if(select){
    const value=current.join(",");
    let option=[...select.options].find(o=>o.value===value);
    if(!option){ option=document.createElement("option"); option.value=value; option.textContent="Current workspace order"; select.appendChild(option); }
    select.value=value;
  }
  $("dashboardSettingsDialog").showModal();
});
$("dashboardSettingsForm")?.addEventListener("submit", event => {
  event.preventDefault();
  const order=($("widgetOrderSelect")?.value || "networth,trend,goals,accounts,activity,quick,fx,insights,spending").split(",");
  const hidden=[...document.querySelectorAll("[data-widget-hidden]:not(:checked)")].map(el=>el.dataset.widgetHidden);
  state.settings.dashboard={...state.settings.dashboard,order,hidden};
  saveState();
  $("dashboardSettingsDialog").close();
});
document.addEventListener("click", event => {
  const widgetQuick=event.target.closest("[data-dashboard-quick]");
  if(widgetQuick) openQuick(widgetQuick.dataset.dashboardQuick);
});
setupDynamicFields();
document.querySelectorAll(".nav-item[data-page]").forEach(button => {
  button.addEventListener("click", () => navigate(button.dataset.page));
});
$("activitySearch")?.addEventListener("input", renderFullViews);
$("clearReviewButton")?.addEventListener("click", () => {
  navigate("Activity");
  const review = state.transactions.filter(t => t.status === "needs_review");
  $("activitySearch").value = "";
  renderFullViews();
  if (!review.length) return alert("No transactions need review.");
  $("activitySearch").value = "review";
  renderFullViews();
});
window.addEventListener("load", async () => {
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js");
  await bootstrapStorage();
});
