/* OmniPocket — V1 financial domain + UI engine */
const STORAGE_KEY = "omnipocket.v1";
const storage = new OmniPocketStorage({ dbName: "omnipocket", storeName: "state", legacyKey: STORAGE_KEY });
const SCHEMA_VERSION = 6;
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
    dashboard: { layout: ["networth","trend","goals","accounts","activity","quick","fx","relations"], hidden: [], order: ["networth","trend","goals","accounts","activity","quick","fx","relations"] },
    integrations: { supabaseUrl: "", monoPublicKey: "" }
  },
  accounts: [],
  transactions: [],
  goals: [],
  snapshots: []
};

let state = clone(DEFAULT_STATE);
let persistTimer = null;
let persistenceReady = false;
let quickType = "expense";

function emitStateEvent(event, detail = {}) { if (window.OmniPocketBus) OmniPocketBus.emit(event, { state, ...detail }); }
function bindOmniPocketBus() { if (!window.OmniPocketBus || window.__omnipocketBusBound) return; window.__omnipocketBusBound = true; OmniPocketBus.on("account:updated", () => { renderAccounts(); renderFullViews(); renderGoal(); renderDashboard(); }); OmniPocketBus.on("transaction:updated", () => { rebuildBalances(); renderActivity(); renderGoal(); renderDashboard(); renderFullViews(); }); OmniPocketBus.on("goal:updated", () => { renderGoal(); renderFullViews(); renderDashboard(); }); OmniPocketBus.on("fx:updated", () => render()); OmniPocketBus.on("privacy:updated", () => render()); OmniPocketBus.on("dashboard:updated", () => renderDashboard()); OmniPocketBus.on("context:changed", payload => { renderContextBar(payload.context); renderAccounts(); renderGoal(); renderActivity(); renderDashboardContextWidgets(payload.context); }); OmniPocketBus.on("context:cleared", payload => { renderContextBar(payload.context); renderAccounts(); renderGoal(); renderActivity(); renderDashboardContextWidgets(payload.context); }); }

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
    bindOmniPocketBus();
    OmniPocketEngine.recordDailySnapshot(state);
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
  next.settings.integrations = {
    ...clone(DEFAULT_STATE.settings.integrations),
    ...(raw.settings?.integrations || {})
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
    createdAt: Number(a.createdAt) || Date.now(),
    connection: a.connection && typeof a.connection === "object" ? {
      provider: a.connection.provider || null,
      providerAccountId: a.connection.providerAccountId || null,
      status: a.connection.status || "disconnected",
      lastSyncedAt: a.connection.lastSyncedAt || null,
      syncStatus: a.connection.syncStatus || null
    } : null
  })) : [];

  next.transactions = Array.isArray(raw.transactions) ? raw.transactions.map(t => ({
    id: t.id || uid(),
    type: TX_TYPES.includes(t.type) ? t.type : "adjustment",
    status: t.status === "needs_review" ? "needs_review" : (t.status === "superseded" ? "superseded" : "recorded"),
    adjustmentSign: t.adjustmentSign === -1 ? -1 : (t.adjustmentSign === 1 ? 1 : (String(t.category || "").toLowerCase().includes("decrease") ? -1 : 1)),
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
    suggestedCategory: String(t.suggestedCategory || "") || null,
    categoryConfidence: Number.isFinite(Number(t.categoryConfidence)) ? Number(t.categoryConfidence) : null,
    categoryReason: String(t.categoryReason || ""),
    suggestedType: ["income","expense","transfer","withdrawal","adjustment"].includes(t.suggestedType) ? t.suggestedType : null,
    suggestedSourceAccountId: t.suggestedSourceAccountId || null,
    suggestedPairTransactionId: t.suggestedPairTransactionId || null,
    suggestedPairCandidates: Array.isArray(t.suggestedPairCandidates) ? t.suggestedPairCandidates.filter(id => typeof id === "string") : [],
    suggestedPairCandidateMeta: t.suggestedPairCandidateMeta && typeof t.suggestedPairCandidateMeta === "object" ? t.suggestedPairCandidateMeta : {},
    suggestedPairConfidence: Number.isFinite(Number(t.suggestedPairConfidence)) ? Number(t.suggestedPairConfidence) : null,
    suggestedPairReason: String(t.suggestedPairReason || ""),
    pairedTransactionId: t.pairedTransactionId || null,
    suggestedDestinationAccountId: t.suggestedDestinationAccountId || null,
    handlingConfidence: Number.isFinite(Number(t.handlingConfidence)) ? Number(t.handlingConfidence) : null,
    handlingReason: String(t.handlingReason || ""),
    note: String(t.note || ""),
    linkedGoalIds: Array.isArray(t.linkedGoalIds) ? t.linkedGoalIds : [],
    external: t.external && typeof t.external === "object" ? {
      provider: t.external.provider || null,
      providerTransactionId: t.external.providerTransactionId || null,
      importedAt: t.external.importedAt || null,
      lastSeenAt: t.external.lastSeenAt || null
    } : null
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

  next.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots.filter(s => s && s.date).map(s => ({ id: String(s.id || `${s.date}:${s.baseCurrency || next.settings.baseCurrency}`), date: String(s.date), capturedAt: Number(s.capturedAt) || Date.now(), baseCurrency: CURRENCIES.includes(s.baseCurrency) ? s.baseCurrency : next.settings.baseCurrency, value: Number(s.value) || 0, balances: Array.isArray(s.balances) ? s.balances.map(b => ({ accountId: b.accountId, balance: Number(b.balance) || 0, currency: CURRENCIES.includes(b.currency) ? b.currency : "NGN" })) : [], rates: s.rates && typeof s.rates === "object" ? s.rates : clone(DEFAULT_RATES) })).slice(-730) : [];

  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

function saveState() {
  if (window.OmniPocketEngine) OmniPocketEngine.recordDailySnapshot(state);
  render();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPersistence, 50);
}

let persistenceRevision = 0;
let persistenceInFlight = false;

async function flushPersistence() {
  persistTimer = null;
  const revision = ++persistenceRevision;
  const snapshot = structuredClone(state);
  persistenceInFlight = true;
  try {
    if (persistenceReady) await storage.save(snapshot);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("Could not persist OmniPocket state.", error);
  } finally {
    persistenceInFlight = false;
    if (revision !== persistenceRevision) {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(flushPersistence, 0);
    }
  }
}
function account(id) {
  return state.accounts.find(a => a.id === id) || null;
}

function rate(from, to) { return OmniPocketEngine.rate(state, from, to); }

function convert(value, from, to, overrideRate = null) { return OmniPocketEngine.convert(state, value, from, to, overrideRate); }

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

function netWorth() { return OmniPocketEngine.netWorth(state); }

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

/* Local, deterministic transaction categorization. Suggestions never change
 * accounting semantics and imported rows remain in the review queue. */
function suggestTransactionCategory(input = {}) {
  const text = String([input.description, input.note, input.reference, input.providerCategory]
    .filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const rules = [
    { pattern: /\b(SALARY|PAYROLL|WAGES?|MONTHLY PAY|CREDIT SALARY)\b/i, category: "Salary / income", confidence: 0.98 },
    { pattern: /\b(UBER|BOLT|INDRIVE|INDRIVER|TAXIFY)\b/i, category: "Transport", confidence: 0.98 },
    { pattern: /\b(MTN|AIRTEL|GLO|9MOBILE|ETISALAT)\b.*\b(AIRTIME|DATA|BUNDLE|RECHARGE|TOP.?UP)\b|\b(AIRTIME|DATA|BUNDLE|RECHARGE|TOP.?UP)\b.*\b(MTN|AIRTEL|GLO|9MOBILE|ETISALAT)\b/i, category: "Mobile & telecom", confidence: 0.97 },
    { pattern: /\b(MTN|AIRTEL|GLO|9MOBILE|ETISALAT)\b/i, category: "Mobile & telecom", confidence: 0.90 },
    { pattern: /\b(PHED|PHCN|AEDC|EKEDC|IKEDC|EKO ELECTRIC|EEDC|JEDC|KEDCO)\b/i, category: "Utilities", confidence: 0.97 },
    { pattern: /\b(NETFLIX|SPOTIFY|YOUTUBE PREMIUM|YOUTUBE MUSIC|APPLE MUSIC|SHOWMAX|DSTV|GOtv|AMAZON PRIME)\b/i, category: "Subscriptions", confidence: 0.97 },
    { pattern: /\b(OPAY|PALMPAY)\b/i, category: "Digital wallet", confidence: 0.96 },
    { pattern: /\b(SHOPRITE|SPAR|JUSTRITE|PICK N PAY|GAME STORE|MARKET SQUARE)\b/i, category: "Groceries", confidence: 0.96 },
    { pattern: /\b(JUMIA|KONGA)\b/i, category: "Shopping", confidence: 0.96 },
    { pattern: /\b(PAYSTACK|FLUTTERWAVE|MONIEPOINT)\b/i, category: "Payments", confidence: 0.93 },
    { pattern: /\b(SCHOOL|SCHOOL FEES|TUITION|UNIVERSITY|COLLEGE|WAEC|NECO|JAMB)\b/i, category: "Education", confidence: 0.94 },
    { pattern: /\b(TRANSFER TO|TRANSFER FROM|NIP|NIP TRANSFER|INWARD TRANSFER|OUTWARD TRANSFER|TRF TO|TRF FROM)\b/i, category: "Bank transfer", confidence: 0.92 },
    { pattern: /\b(GTBANK|GTB|ACCESS BANK|ZENITH|UBA|FIRSTBANK|FIRST BANK|STERLING BANK|FCMB|KUDA)\b/i, category: "Banking / transfer", confidence: 0.88 },
    { pattern: /\b(TOTAL|OANDO|MRS|ARDOVA|CONOIL|FUEL|PETROL|DIESEL|FILLING STATION)\b/i, category: "Fuel", confidence: 0.95 },
    { pattern: /\b(RESTAURANT|FOOD|CHICKEN|PIZZA|BURGER|CAFE|EATERY|KFC|DOMINO)\b/i, category: "Food & dining", confidence: 0.93 },
    { pattern: /\b(ATM|CASH WITHDRAWAL|CASH ADVANCE)\b/i, category: "Cash withdrawal", confidence: 0.98 },
    { pattern: /\b(PHARMACY|HOSPITAL|CLINIC|MEDICAL|HEALTH)\b/i, category: "Health", confidence: 0.94 },
    { pattern: /\b(RENT|LANDLORD|PROPERTY|ESTATE)\b/i, category: "Housing", confidence: 0.91 },
    { pattern: /\b(BET9JA|SPORTYBET|BETKING|BETWAY)\b/i, category: "Gambling", confidence: 0.99 }
  ];
  const match = rules.find(rule => rule.pattern.test(text));
  if (!match) return null;
  const matched = text.match(match.pattern)?.[0] || "transaction narration";
  return { category: match.category, confidence: match.confidence, reason: "Matched " + matched };
}

function suggestTransactionHandling(input = {}) {
  const text = String([input.description, input.note, input.reference, input.providerCategory]
    .filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
  if (!text || !input.accountId) return null;
  const amount = Math.abs(Number(input.signedAmount ?? input.amount) || 0);
  if (!amount) return null;
  const source = account(input.accountId);
  const accounts = state.accounts.filter(a => !a.archived && a.id !== input.accountId);
  const normalized = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const haystack = normalized(text);
  const direction = Number(input.signedAmount ?? 0) >= 0 ? "in" : "out";
  const transferIn = /\b(TRANSFER FROM|TRF FROM|FROM\s+(?:MY\s+)?ACCOUNT|INWARD TRANSFER|CREDIT TRANSFER|NIP CREDIT|NIP INWARD)\b/i.test(text);
  const transferOut = /\b(TRANSFER TO|TRF TO|TO\s+(?:MY\s+)?ACCOUNT|OUTWARD TRANSFER|DEBIT TRANSFER|NIP DEBIT|NIP OUTWARD)\b/i.test(text);
  const genericTransfer = /\b(TRANSFER|TRF|NIP)\b/i.test(text);
  if (!(transferIn || transferOut || genericTransfer)) return null;
  let best = null;
  for (const candidate of accounts) {
    const aliases = [candidate.name, candidate.institution].flatMap(v => {
      const n = normalized(v);
      return n ? [n, ...n.split(" ").filter(part => part.length >= 4)] : [];
    }).filter(Boolean);
    let score = 0, matched = "";
    for (const alias of aliases) {
      if (alias.length >= 4 && haystack.includes(alias)) {
        const points = alias.includes(" ") ? 0.96 : 0.9;
        if (points > score) { score = points; matched = alias; }
      }
    }
    if (score > (best?.score || 0)) best = { account: candidate, score, matched };
  }
  if (best && best.score >= 0.9) {
    const incoming = transferIn || (genericTransfer && direction === "in");
    return {
      type: "transfer",
      destinationAccountId: incoming ? source.id : best.account.id,
      suggestedSourceAccountId: incoming ? best.account.id : source.id,
      confidence: Math.min(0.99, best.score + (transferIn || transferOut ? 0.02 : 0)),
      reason: "Matched local account " + best.account.name
    };
  }
  if (transferIn || transferOut) {
    return { type:"transfer", destinationAccountId: transferIn ? source.id : null, suggestedSourceAccountId: transferIn ? null : source.id, confidence:0.84, reason:"Transfer language detected, but the other account could not be matched locally" };
  }
  return { type:"transfer", destinationAccountId:null, suggestedSourceAccountId:direction === "out" ? source.id : null, confidence:0.72, reason:"Possible transfer detected from the transaction narration" };
}



function adjustmentDelta(t) {
  const label = (t.category || "").toLowerCase();
  return label.includes("decrease") ? -Math.abs(t.amount) : Math.abs(t.amount);
}

function rebuildBalances() { const balances = OmniPocketEngine.balancesAt(state); const byId = new Map(balances.map(a => [a.id, a.balance])); state.accounts.forEach(a => { a.balance = byId.has(a.id) ? byId.get(a.id) : (Number(a.openingBalance) || 0); }); }

function pairCandidateConfidence(t, id) {
  const index = (t.suggestedPairCandidates || []).indexOf(id);
  if (index === -1) return Number(t.suggestedPairConfidence) || 0;
  if (t.suggestedPairCandidateMeta?.[id]?.confidence != null) return Number(t.suggestedPairCandidateMeta[id].confidence) || 0;
  return id === t.suggestedPairTransactionId ? Number(t.suggestedPairConfidence) || 0 : 0;
}

function pairCandidateReason(t, id) {
  return t.suggestedPairCandidateMeta?.[id]?.reason || (id === t.suggestedPairTransactionId ? t.suggestedPairReason : "Possible transfer match");
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
  $("transactionDetailMeta").textContent = t.date + " · " + t.type + (t.external?.provider ? " · Imported from " + t.external.provider : "");
  $("transactionDetailAmount").textContent = state.settings.privacyHidden ? "••••••" : money(displayAmount, displayCurrency);
  $("transactionDetailContext").textContent = t.type === "transfer" || t.type === "withdrawal"
    ? (source?.name || "Unknown") + " → " + (dest?.name || "Unknown")
    : source?.name || incoming?.name || "Unknown account";
  $("transactionDetailStatus").textContent = t.status === "needs_review" ? "Needs review — handle later" : t.status === "superseded" ? "Paired transfer leg — excluded from ledger" : "Recorded";
  const suggestionWrap = $("transactionSuggestionSection");
  const suggestionBox = $("transactionSuggestion");
  const suggestionButton = $("transactionAcceptSuggestion");
  if (suggestionWrap && suggestionBox && suggestionButton) {
    if (t.suggestedCategory) {
      suggestionWrap.hidden = false;
      suggestionBox.innerHTML = "<strong>" + escapeHtml(t.suggestedCategory) + "</strong> · " +
        Math.round((Number(t.categoryConfidence) || 0) * 100) + "% confidence" +
        (t.categoryReason ? "<div class=\"muted\" style=\"margin-top:4px\">" + escapeHtml(t.categoryReason) + "</div>" : "");
      suggestionButton.hidden = t.category === t.suggestedCategory;
    } else {
      suggestionWrap.hidden = true;
      suggestionBox.textContent = "";
      suggestionButton.hidden = true;
    }
  }
  const handlingWrap = $("transactionHandlingSection");
  const handlingBox = $("transactionHandling");
  const handlingButton = $("transactionAcceptHandling");
  if (handlingWrap && handlingBox && handlingButton) {
    if (t.suggestedType === "transfer") {
      const suggestedSource = account(t.suggestedSourceAccountId);
      const suggestedDestination = account(t.suggestedDestinationAccountId);
      const label = suggestedSource && suggestedDestination
        ? suggestedSource.name + " → " + suggestedDestination.name
        : suggestedDestination
          ? "Matched destination: " + suggestedDestination.name
          : "Transfer detected, destination not matched locally";
      handlingWrap.hidden = false;
      handlingBox.innerHTML = "<strong>Likely transfer</strong> · " +
        Math.round((Number(t.handlingConfidence) || 0) * 100) + "% confidence" +
        "<div style=\"margin-top:4px\">" + escapeHtml(label) + "</div>" +
        (t.handlingReason ? "<div class=\"muted\" style=\"margin-top:4px\">" + escapeHtml(t.handlingReason) + "</div>" : "");
      handlingButton.disabled = !(suggestedSource && suggestedDestination && suggestedSource.id !== suggestedDestination.id);
      handlingButton.textContent = handlingButton.disabled ? "Choose destination in Edit" : "Accept transfer";
    } else {
      handlingWrap.hidden = true;
      handlingBox.textContent = "";
    }
  }
  const pairCandidates = Array.isArray(t.suggestedPairCandidates)
    ? t.suggestedPairCandidates.map(id => state.transactions.find(x => x.id === id)).filter(Boolean)
    : [];
  const pair = t.suggestedPairTransactionId
    ? state.transactions.find(x => x.id === t.suggestedPairTransactionId)
    : null;
  const pairWrap = $("transactionPairSection");
  const pairBox = $("transactionPair");
  const pairButton = $("transactionAcceptPair");
  if (pairWrap && pairBox && pairButton) {
    if (pairCandidates.length) {
      pairWrap.hidden = false;
      const selected = pair ? pair.id : "";
      pairBox.innerHTML = "<strong>" + (pair ? "Selected transfer match" : "Possible transfer matches") + "</strong>" +
        (pair ? " · " + Math.round((Number(t.suggestedPairConfidence) || 0) * 100) + "% confidence" : "") +
        '<div class="transfer-candidate-list">' +
        pairCandidates.map(candidate => {
          const candidateAccount = account(candidate.sourceAccountId);
          const isSelected = candidate.id === selected;
          return '<button type="button" class="review-queue-item transfer-candidate' + (isSelected ? ' is-selected' : '') + '" data-transfer-candidate="' + escapeHtml(candidate.id) + '">' +
            '<span><strong>' + escapeHtml(candidateAccount?.name || "Another account") + '</strong><small>' +
            escapeHtml(money(candidate.amount, candidate.currency)) + ' · ' + escapeHtml(candidate.date) + ' · ' +
            escapeHtml(pairCandidateReason(t, candidate.id)) + '</small></span><strong>' +
            Math.round(pairCandidateConfidence(t, candidate.id) * 100) + '%</strong></button>';
        }).join("") + '</div>' +
        (pair ? '<div class="muted" style="margin-top:6px">Choose a different match above if this one is not correct.</div>' : '<div class="muted" style="margin-top:6px">No match is merged automatically. Choose a candidate, then confirm.</div>');
      pairButton.textContent = pair ? "Merge selected transfer" : "Choose a match";
      pairButton.disabled = !pair;
    } else {
      pairWrap.hidden = true;
      pairBox.textContent = "";
      pairButton.disabled = true;
    }
  }
  const linkedGoals = state.goals.filter(g => (t.linkedGoalIds || []).includes(g.id));
  $("transactionDetailGoals").innerHTML = linkedGoals.length
    ? linkedGoals.map(g => '<button class="link-row" data-goal-from-transaction="' + escapeHtml(g.id) + '"><strong>' + escapeHtml(g.name) + '</strong><span><span class="context-link-badge">Linked</span> ' + escapeHtml(money(goalProgress(g).current, g.currency)) + '</span></button>').join("")
    : '<div class="empty-state">No goals explicitly linked to this transaction.</div>';
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
  populateTransactionGoals("editTxGoals", t.linkedGoalIds || []);
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
  emitStateEvent("transaction:updated", { action: "deleted", transactionId: id });
  saveState();
  $("transactionDialog")?.close();
}

function parseStatementCsv(text) {
  const input = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i], next = input[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell.trim()); cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell.trim());
    if (row.some(value => value !== "")) rows.push(row);
  }
  if (rows.length < 2) return { headers: [], rows: [] };
  const headers = rows[0].map((h, i) => String(h || "Column " + (i + 1)).trim());
  return { headers, rows: rows.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]))) };
}

function statementColumn(headers, patterns) {
  return headers.find(h => patterns.some(pattern => pattern.test(String(h)))) || "";
}

function normalizeStatementDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(raw)) {
    const parts = raw.split(/[-/]/).map(Number);
    return parts[0] + "-" + String(parts[1]).padStart(2,"0") + "-" + String(parts[2]).padStart(2,"0");
  }
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    let year = Number(dmy[3]); if (year < 100) year += 2000;
    const d = new Date(year, Number(dmy[2]) - 1, Number(dmy[1]));
    if (d.getFullYear() === year && d.getMonth() === Number(dmy[2]) - 1 && d.getDate() === Number(dmy[1])) return d.toISOString().slice(0,10);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0,10);
}

function parseStatementAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const negative = /^-/.test(raw) || /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[₦$£€NGNUSDGBP,\s]/gi, "").replace(/[()]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) && number !== 0 ? Math.abs(number) * (negative ? -1 : 1) : null;
}

function statementHeaderOptions(headers, selected, emptyLabel) {
  return '<option value="">' + escapeHtml(emptyLabel) + '</option>' +
    headers.map(h => '<option value="' + escapeHtml(h) + '" ' + (h === selected ? "selected" : "") + '>' + escapeHtml(h) + '</option>').join("");
}

function previewStatementImport(text, accountId, mapping = {}) {
  const parsed = parseStatementCsv(text);
  if (!parsed.rows.length) throw new Error("The CSV needs a header row and at least one transaction.");
  const headers = parsed.headers;
  const dateCol = mapping.date || statementColumn(headers, [/^date$/i, /transaction.*date/i, /posting.*date/i, /value.*date/i]);
  const descCol = mapping.description || statementColumn(headers, [/description/i, /narration/i, /details/i, /memo/i, /particular/i]);
  const refCol = mapping.reference || statementColumn(headers, [/reference/i, /ref\.?\s*(no|number)?$/i, /transaction.*id/i]);
  const amountCol = mapping.amount || statementColumn(headers, [/^amount$/i, /transaction.*amount/i, /value/i]);
  const debitCol = mapping.debit || statementColumn(headers, [/debit/i, /withdrawal/i, /paid.*out/i]);
  const creditCol = mapping.credit || statementColumn(headers, [/credit/i, /deposit/i, /paid.*in/i]);
  if (!dateCol || (!amountCol && !debitCol && !creditCol)) throw new Error("Map a Date and either Amount or Debit/Credit before previewing.");
  if (amountCol && (debitCol || creditCol)) {
    // A signed Amount column takes precedence; Debit/Credit are ignored.
  }
  const accountTarget = account(accountId);
  if (!accountTarget) throw new Error("Choose an account for this statement first.");
  const rows = parsed.rows.map((row, index) => {
    const rawAmount = amountCol ? parseStatementAmount(row[amountCol]) : null;
    const debit = debitCol ? parseStatementAmount(row[debitCol]) : null;
    const credit = creditCol ? parseStatementAmount(row[creditCol]) : null;
    let signed = rawAmount;
    if (signed == null) {
      const out = debit == null ? 0 : Math.abs(debit);
      const incoming = credit == null ? 0 : Math.abs(credit);
      signed = incoming - out;
    }
    const date = normalizeStatementDate(row[dateCol]);
    const description = descCol ? String(row[descCol] || "").trim() : "";
    const reference = refCol ? String(row[refCol] || "").trim() : "";
    if (!date && !signed) return { rowNumber:index+2, invalid:true, reason:"Missing date and amount", description };
    if (!date) return { rowNumber:index+2, invalid:true, reason:"Invalid date", description };
    if (!signed) return { rowNumber:index+2, invalid:true, reason:"Missing or zero amount", description };
    const suggestion = suggestTransactionCategory({ description, reference });
    return {
      rowNumber: index + 2,
      date,
      description,
      reference,
      signedAmount: signed,
      type: signed > 0 ? "income" : "expense",
      currency: accountTarget.currency,
      accountId: accountTarget.id,
      suggestedCategory: suggestion?.category || null,
      categoryConfidence: suggestion?.confidence ?? null,
      categoryReason: suggestion?.reason || ""
    };
  });
  return { headers, rows, account: accountTarget, mapping: { date:dateCol, description:descCol, reference:refCol, amount:amountCol, debit:debitCol, credit:creditCol } };
}

function previewStatementImportObjects(parsed, accountId, mapping = {}) {
  const headers = parsed.headers;
  const dateCol = mapping.date || statementColumn(headers, [/^date$/i, /transaction.*date/i, /posting.*date/i, /value.*date/i]);
  const descCol = mapping.description || statementColumn(headers, [/description/i, /narration/i, /details/i, /memo/i, /particular/i]);
  const refCol = mapping.reference || statementColumn(headers, [/reference/i, /ref\\.?\s*(no|number)?$/i, /transaction.*id/i]);
  const amountCol = mapping.amount || statementColumn(headers, [/^amount$/i, /transaction.*amount/i, /value/i]);
  const debitCol = mapping.debit || statementColumn(headers, [/debit/i, /withdrawal/i, /paid.*out/i]);
  const creditCol = mapping.credit || statementColumn(headers, [/credit/i, /deposit/i, /paid.*in/i]);
  if (!dateCol || (!amountCol && !debitCol && !creditCol)) throw new Error("Map a Date and either Amount or Debit/Credit before previewing.");
  const accountTarget = account(accountId);
  if (!accountTarget) throw new Error("Choose an account for this statement first.");
  const rows = parsed.rows.map((row, index) => {
    const rawAmount = amountCol ? parseStatementAmount(row[amountCol]) : null;
    const debit = debitCol ? parseStatementAmount(row[debitCol]) : null;
    const credit = creditCol ? parseStatementAmount(row[creditCol]) : null;
    let signed = rawAmount;
    if (signed == null) signed = (credit == null ? 0 : Math.abs(credit)) - (debit == null ? 0 : Math.abs(debit));
    const date = normalizeStatementDate(row[dateCol]);
    const description = descCol ? String(row[descCol] || "").trim() : "";
    const reference = refCol ? String(row[refCol] || "").trim() : "";
    if (!date) return {rowNumber:index+2, invalid:true, reason:"Invalid date", description};
    if (!signed) return {rowNumber:index+2, invalid:true, reason:"Missing or zero amount", description};
    const suggestion = suggestTransactionCategory({ description, reference });
    const handling = suggestTransactionHandling({ accountId: accountTarget.id, description, reference, signedAmount: signed });
    const pair = findTransferCounterpart({ id: "preview-" + index, type: signed > 0 ? "income" : "expense", sourceAccountId: accountTarget.id, amount: Math.abs(signed), currency: accountTarget.currency, date, description, reference, external: { provider: "statement_import" } });
    return {rowNumber:index+2,date,description,reference,signedAmount:signed,type:signed>0?"income":"expense",currency:accountTarget.currency,accountId:accountTarget.id,suggestedCategory:suggestion?.category||null,categoryConfidence:suggestion?.confidence??null,categoryReason:suggestion?.reason||"",suggestedType:handling?.type||null,suggestedSourceAccountId:handling?.suggestedSourceAccountId||null,suggestedDestinationAccountId:handling?.destinationAccountId||null,handlingConfidence:handling?.confidence??null,handlingReason:handling?.reason||"",suggestedPairTransactionId:pair?.transactionId||null,suggestedPairCandidates:pair?.candidates?.map(candidate=>candidate.transactionId)||[],suggestedPairCandidateMeta:Object.fromEntries((pair?.candidates||[]).map(candidate=>[candidate.transactionId,{confidence:candidate.confidence,reason:candidate.reason}])),suggestedPairConfidence:pair?.confidence??null,suggestedPairReason:pair?.reason||""};
  });
  const analyzedRows = rows.filter(row => !row.invalid);
  const previewFingerprint = row => [row.accountId,row.date,row.signedAmount.toFixed(2),row.description.toLowerCase().replace(/\s+/g," ").trim(),row.reference.toLowerCase().trim()].join("|");
  const duplicateRows = analyzedRows.filter(row => state.transactions.some(t => (t.external?.provider === "statement_import" || t.external?.provider === "statement_csv") && t.external.providerTransactionId === previewFingerprint(row)));
  const duplicateFingerprints = new Set(duplicateRows.map(previewFingerprint));
  analyzedRows.forEach(row => { row.isDuplicate = duplicateFingerprints.has(previewFingerprint(row)); });
  const transferRows = analyzedRows.filter(row => row.suggestedType === "transfer");
  const ambiguousTransferRows = transferRows.filter(row => (row.suggestedPairCandidates?.length > 1) || (!row.suggestedPairTransactionId && row.suggestedType === "transfer"));
  return {headers,rows,account:accountTarget,mapping:{date:dateCol,description:descCol,reference:refCol,amount:amountCol,debit:debitCol,credit:creditCol},stats:{valid:analyzedRows.length,invalid:rows.length-analyzedRows.length,duplicates:duplicateRows.length,likelyTransfers:transferRows.length,ambiguousTransfers:ambiguousTransferRows.length}};
}

function importStatementRows(rows) {
  let imported = 0, duplicates = 0, invalid = 0;
  for (const row of rows) {
    if (row.invalid) { invalid++; continue; }
    const fingerprint = [row.accountId, row.date, row.signedAmount.toFixed(2), row.description.toLowerCase().replace(/\s+/g," ").trim(), row.reference.toLowerCase().trim()].join("|");
    const existing = state.transactions.find(t => (t.external?.provider === "statement_import" || t.external?.provider === "statement_csv") && t.external.providerTransactionId === fingerprint);
    if (existing) {
      existing.external.lastSeenAt = new Date().toISOString();
      duplicates++;
      continue;
    }
    importTransaction({
      type: row.type,
      sourceAccountId: row.accountId,
      amount: Math.abs(row.signedAmount),
      signedAmount: row.signedAmount,
      currency: row.currency,
      suggestedType: row.suggestedType,
      suggestedSourceAccountId: row.suggestedSourceAccountId,
      suggestedDestinationAccountId: row.suggestedDestinationAccountId,
      suggestedPairTransactionId: row.suggestedPairTransactionId,
      suggestedPairCandidates: row.suggestedPairCandidates,
      suggestedPairCandidateMeta: row.suggestedPairCandidateMeta,
      suggestedPairConfidence: row.suggestedPairConfidence,
      suggestedPairReason: row.suggestedPairReason,
      handlingConfidence: row.handlingConfidence,
      handlingReason: row.handlingReason,
      category: row.type === "income" ? "Imported income" : "Other",
      description: row.description,
      reference: row.reference,
      note: row.description || "Imported from bank statement",
      date: row.date,
      external: { provider: "statement_import", providerTransactionId: fingerprint }
    });
    imported++;
  }
  rebuildBalances();
  saveState();
  return { imported, duplicates, invalid };
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

function contextScopedAccountIds(context=getAppContext()) {
  return new Set(contextAccountIds(context));
}

function contextTransactions(context=getAppContext()) {
  const engine=window.OmniPocketEngine;
  return engine?.relatedTransactions ? engine.relatedTransactions(state,context) : state.transactions;
}

function renderNetWorthTrend() {
  const el=$("netWorthTrend"); if(!el) return;
  const context=getAppContext();
  const scoped=contextTransactions(context);
  const relevantIds=contextScopedAccountIds(context);
  const snapshots=OmniPocketEngine.historicalNetWorth(state,90);
  let rows=snapshots;
  if(context.scope==="account"&&context.accountId){
    const a=account(context.accountId);
    if(a){
      let running=Number(a.openingBalance)||0;
      const tx=state.transactions.filter(t=>t.sourceAccountId===a.id||t.destinationAccountId===a.id).sort((x,y)=>String(x.date).localeCompare(String(y.date)));
      const byDate=new Map();
      for(const t of tx){
        if(t.type==="income" || (t.type==="transfer"&&t.destinationAccountId===a.id)) running+=Number(t.receivedAmount??t.amount)||0;
        else if(t.type==="expense" || t.type==="withdrawal" || (t.type==="transfer"&&t.sourceAccountId===a.id)) running-=Number(t.amount)||0;
        else if(t.type==="adjustment") running+=adjustmentDelta(t);
        byDate.set(t.date,running);
      }
      rows=[...byDate.entries()].map(([date,value])=>({date,value}));
    }
  } else if(context.scope==="goal"&&context.goalId){
    const g=state.goals.find(x=>x.id===context.goalId);
    if(g) rows=OmniPocketEngine.goalContributionHistory(state,g).map(x=>({date:x.date,value:x.value}));
  } else if(context.scope==="transaction"&&context.transactionId){
    const t=state.transactions.find(x=>x.id===context.transactionId);
    rows=t?[{date:t.date,value:convert(t.receivedAmount??t.amount,t.receivedCurrency||t.currency,state.settings.baseCurrency)}]:[];
  }
  if(rows.length<2){el.innerHTML='<div class="empty-state">'+escapeHtml(context.scope==="global"?"Log transactions across different days to build your wealth trend.":"Not enough history in this context to draw a trend yet.")+'</div>';return;}
  const unique=rows.reduce((acc,p)=>{const last=acc[acc.length-1];if(last&&last.date===p.date)last.value=p.value;else acc.push({date:p.date,value:p.value});return acc;},[]).slice(-30);
  const width=720,height=240,pad=28,values=unique.map(p=>p.value),min=Math.min(...values,0),max=Math.max(...values,1),range=max-min||1;
  const coords=unique.map((p,i)=>[unique.length===1?width/2:pad+i*(width-pad*2)/(unique.length-1),height-pad-(p.value-min)/range*(height-pad*2)]);
  const path=coords.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
  const scopeLabel=context.scope==="global"?"Global wealth":context.scope==="account"?(account(context.accountId)?.name||"Account")+" balance":context.scope==="goal"?(state.goals.find(g=>g.id===context.goalId)?.name||"Goal")+" contributions":transactionLabel(state.transactions.find(t=>t.id===context.transactionId)||{type:"activity"});
  el.innerHTML='<div class="muted context-value-label">'+escapeHtml(scopeLabel)+'</div><svg viewBox="0 0 '+width+" "+height+'" role="img" aria-label="'+escapeHtml(scopeLabel)+' trend"><path class="trend-line" d="'+path+'"></path>'+coords.map(p=>'<circle class="trend-dot" cx="'+p[0]+'" cy="'+p[1]+'" r="3"></circle>').join("")+'</svg><div class="trend-meta"><span>'+escapeHtml(unique[0].date)+'</span><strong>'+escapeHtml(state.settings.privacyHidden?"••••••":money(unique[unique.length-1].value))+'</strong><span>'+escapeHtml(unique[unique.length-1].date)+'</span></div>';
}

function spendingSummary(days=30,context=getAppContext()) {
  const base=OmniPocketEngine.spendingSummary(state,days);
  if(context.scope==="global") return base;
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-days);
  const tx=contextTransactions(context).filter(t=>t.status!=="needs_review" && new Date(t.date+"T23:59:59")>=cutoff);
  const totals={}; let total=0, income=0;
  for(const t of tx){
    const value=convert(t.receivedAmount??t.amount,t.receivedCurrency||t.currency,state.settings.baseCurrency,t.fxRate);
    if(t.type==="expense" || t.type==="withdrawal"){ total+=value; const key=t.category||"Other"; totals[key]=(totals[key]||0)+value; }
    if(t.type==="income") income+=value;
  }
  return {total,totals,income};
}

function financialInsights() {
  const summary = spendingSummary(30, getAppContext());
  const insights = [];
  const reviewCount = state.transactions.filter(t => t.status === "needs_review").length;
  if (!state.accounts.some(a => !a.archived)) insights.push("Add your first account to start building your wealth graph.");
  if (reviewCount) insights.push(reviewCount + " item" + (reviewCount === 1 ? "" : "s") + " still need review.");
  if (summary.total > 0) insights.push(money(summary.total) + " spent across recorded expenses in the last 30 days.");
  if (summary.income > 0 && summary.total > summary.income) insights.push("Recorded spending is above recorded income for the last 30 days.");
  else if (summary.income > 0) insights.push("Recorded income is above recorded spending for the last 30 days.");
  for (const g of state.goals.filter(g => g.status === "active")) {
    const p = goalProgress(g);
    if (g.deadline && p.current < g.target) {
      const days = Math.max(0, Math.ceil((new Date(g.deadline) - new Date(today())) / 86400000));
      if (days > 0) insights.push(g.name + " needs about " + money((g.target - p.current) / days, g.currency) + " per day to reach its target.");
    }
  }
  if (!insights.length) insights.push("Your financial graph is ready. Add activity to unlock more local insights.");
  return insights.slice(0, 4);
}

function renderIntelligence() {
  const insightsEl = $("insightContent");
  if (insightsEl) {
    insightsEl.innerHTML = financialInsights().map(value => '<div class="insight-row"><span class="node">✦</span><div>' + escapeHtml(value) + '</div></div>').join("");
  }
  const spendingEl = $("spendingContent");
  if (spendingEl) {
    const summary = spendingSummary(30, getAppContext());
    const rows = Object.entries(summary.totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
    spendingEl.innerHTML = rows.length ? rows.map(([label, value]) => {
      const pct = summary.total ? Math.round(value / summary.total * 100) : 0;
      return '<div class="metric-row"><div class="metric-row-head"><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(money(value)) + '</span></div><div class="metric-track"><div class="metric-fill" style="width:' + pct + '%"></div></div></div>';
    }).join("") : '<div class="empty-state">Record expenses to see your spending mix.</div>';
  }
}

function renderDashboard() {
  const root=$("dashboardGalaxy");
  if(!root) return;
  const widgets={
    networth:$("widgetNetWorth"), trend:$("widgetTrend"), goals:$("widgetGoals"), accounts:$("widgetAccounts"),
    activity:$("widgetActivity"), quick:$("widgetQuick"), fx:$("widgetFx"), relations:$("widgetRelations"), insights:$("widgetInsights"), spending:$("widgetSpending")
  };
  const defaultOrder=["networth","trend","goals","accounts","activity","quick","fx","relations","insights","spending"];
  const order=[...(state.settings.dashboard.order || [])];
  defaultOrder.forEach(id=>{ if(!order.includes(id)) order.push(id); });
  root.innerHTML="";
  order.filter(id=>widgets[id] && !(state.settings.dashboard.hidden||[]).includes(id)).forEach(id=>{ const widget=widgets[id]; widget.draggable=true; widget.dataset.widgetId=id; root.appendChild(widget); });
  const galaxyNetWorth=$("galaxyNetWorth"); if(galaxyNetWorth) galaxyNetWorth.textContent=state.settings.privacyHidden ? "•••••••" : money(netWorth());
  renderNetWorthTrend();
  renderIntelligence();
  renderContextBar();
  renderDashboardContextWidgets();
  const count=$("reviewCount"); if(count) count.textContent=state.transactions.filter(t=>t.status==="needs_review").length+" review";
  const fxStatus=$("fxCacheStatus"); if(fxStatus) fxStatus.textContent=state.settings.fx.updatedAt ? "Cached "+new Date(state.settings.fx.updatedAt).toLocaleString() : "Bundled rates";
}

function integrationSettings() {
  const settings = state.settings.integrations || {};
  return {
    supabaseUrl: String(settings.supabaseUrl || localStorage.getItem("omnipocket.supabaseUrl") || "").replace(/\/$/, ""),
    monoPublicKey: String(settings.monoPublicKey || localStorage.getItem("omnipocket.monoPublicKey") || "")
  };
}

function configureBankIntegration() {
  const current = integrationSettings();
  const supabaseUrl = prompt("Supabase project URL (for example https://YOUR_PROJECT.supabase.co):", current.supabaseUrl);
  if (!supabaseUrl) return null;
  const monoPublicKey = prompt("Mono public key (test_pk_... for sandbox or live_pk_... for production):", current.monoPublicKey);
  if (!monoPublicKey) return null;
  state.settings.integrations = { supabaseUrl: supabaseUrl.trim().replace(/\/$/, ""), monoPublicKey: monoPublicKey.trim() };
  localStorage.setItem("omnipocket.supabaseUrl", state.settings.integrations.supabaseUrl);
  localStorage.setItem("omnipocket.monoPublicKey", state.settings.integrations.monoPublicKey);
  saveState();
  return integrationSettings();
}

function minorUnitAmount(value) {
  return (Number(value) || 0) / 100;
}

async function exchangeMonoCode(code, accountName) {
  const config = integrationSettings();
  if (!config.supabaseUrl) throw new Error("Supabase URL is not configured.");
  const response = await fetch(config.supabaseUrl + "/functions/v1/mono-exchange-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || data?.message || "Mono authorization exchange failed.");
  const monoAccountId = data?.data?.id || data?.data?.account?.id || data?.id;
  if (!monoAccountId) throw new Error("Mono linked the account but did not return an account ID.");
  return syncMonoAccount(monoAccountId, accountName);
}

async function syncMonoAccount(monoAccountId, accountName = "Connected bank") {
  const config = integrationSettings();
  const response = await fetch(config.supabaseUrl + "/functions/v1/mono-account-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: monoAccountId, realtime: true })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || "Mono account sync failed.");

  const rawAccount = payload?.account?.data?.account || payload?.account?.data || payload?.account?.account || payload?.account;
  const rawTransactions = payload?.transactions?.data || [];
  if (!rawAccount) throw new Error("Mono returned no account details.");

  const currency = CURRENCIES.includes(rawAccount.currency) ? rawAccount.currency : "NGN";
  const currentBalance = minorUnitAmount(rawAccount.balance);
  let local = state.accounts.find(a => a.connection?.provider === "mono" && a.connection.providerAccountId === monoAccountId);
  if (!local) {
    local = {
      id: uid(),
      name: accountName || rawAccount.name || "Connected bank",
      institution: rawAccount.institution?.name || "",
      type: rawAccount.type?.toLowerCase().includes("savings") ? "bank" : "bank",
      currency,
      openingBalance: currentBalance,
      balance: currentBalance,
      archived: false,
      createdAt: Date.now(),
      connection: { provider: "mono", providerAccountId: monoAccountId, status: "connected", lastSyncedAt: null, syncStatus: "syncing" }
    };
    state.accounts.push(local);
  }

  const importedAt = Date.now();
  let importedNet = 0;
  for (const tx of rawTransactions) {
    const providerTransactionId = tx.id || tx._id;
    if (!providerTransactionId) continue;
    const amount = minorUnitAmount(tx.amount);
    const isCredit = String(tx.type || "").toLowerCase() === "credit";
    importedNet += isCredit ? amount : -amount;
    const existing = state.transactions.find(t => t.external?.provider === "mono" && t.external.providerTransactionId === providerTransactionId);
    if (existing) {
      existing.external.lastSeenAt = new Date().toISOString();
      continue;
    }
    state.transactions.push({
      id: uid(),
      type: isCredit ? "income" : "expense",
      status: "recorded",
      date: String(tx.date || today()).slice(0,10),
      createdAt: importedAt,
      sourceAccountId: local.id,
      destinationAccountId: null,
      amount,
      currency,
      receivedAmount: null,
      receivedCurrency: null,
      fxRate: null,
      fxSource: "bank_import",
      category: tx.category || "Other",
      suggestedCategory: suggestTransactionCategory({
        description: tx.narration,
        providerCategory: tx.category
      })?.category || null,
      categoryConfidence: suggestTransactionCategory({
        description: tx.narration,
        providerCategory: tx.category
      })?.confidence || null,
      categoryReason: suggestTransactionCategory({
        description: tx.narration,
        providerCategory: tx.category
      })?.reason || "",
      note: tx.narration || "Imported from Mono",
      linkedGoalIds: [],
      external: { provider: "mono", providerTransactionId, importedAt: new Date(importedAt).toISOString(), lastSeenAt: new Date(importedAt).toISOString() }
    });
  }

  local.openingBalance = currentBalance - importedNet;
  local.balance = currentBalance;
  local.institution = rawAccount.institution?.name || local.institution;
  local.currency = currency;
  local.connection = {
    provider: "mono",
    providerAccountId: monoAccountId,
    status: "connected",
    lastSyncedAt: new Date().toISOString(),
    syncStatus: "healthy"
  };

  saveState();
  emitStateEvent("account:updated", { accountId: local.id, provider: "mono" });
  return local;
}

async function connectBankAccount() {
  let config = integrationSettings();
  if (!config.supabaseUrl || !config.monoPublicKey) {
    config = configureBankIntegration();
    if (!config) return;
  }
  if (typeof window.Connect !== "function") {
    alert("Mono Connect is still loading. Please try again in a moment.");
    return;
  }

  const accountName = ($("accountName")?.value || "Connected bank").trim();
  const email = localStorage.getItem("omnipocket.monoEmail") || prompt("Email to associate with this bank connection:", "")?.trim();
  if (!email) return;
  localStorage.setItem("omnipocket.monoEmail", email);

  const connect = new window.Connect({
    key: config.monoPublicKey,
    scope: "auth",
    data: { customer: { name: accountName || "OmniPocket user", email } },
    reference: "omnipocket_" + uid(),
    onSuccess: async ({ code }) => {
      try {
        $("accountDialog")?.close();
        const button = $("connectBankButton");
        if (button) button.disabled = true;
        await exchangeMonoCode(code, accountName);
        alert("Bank connected. Balance and transactions have been imported.");
        render();
      } catch (error) {
        console.error(error);
        alert(error.message || "Bank connection completed, but OmniPocket could not import the account.");
      } finally {
        const button = $("connectBankButton");
        if (button) button.disabled = false;
      }
    },
    onClose: () => {}
  });
  connect.setup();
  connect.open();
}

async function refreshFxRates() {
  if (state.settings.mode === "offline") return alert("Offline mode keeps the last cached FX matrix.");
  const base=state.settings.baseCurrency;
  try {
    const integration = integrationSettings();
    const fxUrl = integration.supabaseUrl
      ? integration.supabaseUrl + "/functions/v1/fx-rates?base=" + encodeURIComponent(base)
      : "https://open.er-api.com/v6/latest/" + encodeURIComponent(base);
    const response=await fetch(fxUrl, {cache:"no-store"});
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
    emitStateEvent("fx:updated", { baseCurrency: base });
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

function getAppContext() { return window.OmniPocketBus?.getContext?.() || { scope: "global", accountId: null, goalId: null, transactionId: null }; }
function selectAccountContext(id) { if (window.OmniPocketBus) OmniPocketBus.selectAccount(id); }
function selectGoalContext(id) { if (window.OmniPocketBus) OmniPocketBus.selectGoal(id); }
function selectTransactionContext(id) { const t=state.transactions.find(x=>x.id===id); if(window.OmniPocketBus) OmniPocketBus.selectTransaction(id,t?.sourceAccountId||null); }

function contextNodeLabel(item) { if (!item) return "Global"; if (item.scope === "account") return account(item.accountId)?.name || "Account"; if (item.scope === "goal") return state.goals.find(g => g.id === item.goalId)?.name || "Goal"; if (item.scope === "transaction") return transactionLabel(state.transactions.find(t => t.id === item.transactionId) || { type: "activity" }); return "Global"; }
function renderContextTrail(context = getAppContext()) { const host = $("dashboardContextTrail"); if (!host) return; const history = window.OmniPocketBus?.getHistory?.() || []; const crumbs = [{ scope: "global" }, ...history]; const seen = new Set(); const unique = crumbs.filter(x => { const key = [x.scope,x.accountId||"",x.goalId||"",x.transactionId||""].join(":"); if (seen.has(key)) return false; seen.add(key); return true; }); host.innerHTML = unique.map((item,i) => { const label=escapeHtml(contextNodeLabel(item)); return i < unique.length-1 ? '<button class="context-crumb" data-context-index="'+i+'">'+label+'</button><span class="context-separator">›</span>' : '<strong class="context-current">'+label+'</strong>'; }).join("") + (context.scope !== "global" ? '<button class="context-back" id="contextBackButton">Back</button>' : ""); }

function renderContextBar(context=getAppContext()) { const bar=$("dashboardContext"),label=$("dashboardContextLabel"); if(!bar||!label)return; let text="Viewing · Global"; if(context.scope==="account"&&context.accountId)text="Viewing · Account: "+(account(context.accountId)?.name||"Unknown"); if(context.scope==="goal"&&context.goalId)text="Viewing · Goal: "+(state.goals.find(g=>g.id===context.goalId)?.name||"Unknown"); if(context.scope==="transaction"&&context.transactionId)text="Viewing · Activity: "+transactionLabel(state.transactions.find(t=>t.id===context.transactionId)||{type:"activity"}); label.textContent=text; bar.hidden=context.scope==="global"; renderContextTrail(context); }
function contextConnectionLabel(context=getAppContext()) {
  if (context.scope === "account" && context.accountId) return "Connected to this account";
  if (context.scope === "goal" && context.goalId) return "Connected to this goal";
  if (context.scope === "transaction" && context.transactionId) return "Connected to this activity";
  return "";
}
function contextBadge(context=getAppContext()) {
  const label = contextConnectionLabel(context);
  return label ? '<span class="context-link-badge">↳ '+escapeHtml(label)+'</span>' : "";
}

function contextAccountIds(context=getAppContext()) { if(context.scope==="account"&&context.accountId)return [context.accountId]; if(context.scope==="goal"&&context.goalId)return state.goals.find(g=>g.id===context.goalId)?.accountIds||[]; if(context.scope==="transaction"&&context.transactionId){const t=state.transactions.find(x=>x.id===context.transactionId);return [t?.sourceAccountId,t?.destinationAccountId].filter(Boolean);} return state.accounts.filter(a=>!a.archived).map(a=>a.id); }
function renderDashboardContextWidgets(context=getAppContext()) {
  const el=$("galaxyNetWorth");
  const relationEl=$("relationshipContent");
  const relationTitle=$("relationshipTitle");
  const relationScope=$("relationshipScope");
  const fxContext=$("fxContextContent");
  if(!el || !relationEl) return;

  let value=netWorth(), label="Your global wealth";
  if(context.scope==="account"&&context.accountId){
    const acc=account(context.accountId);
    value=acc?convert(acc.balance,acc.currency,state.settings.baseCurrency):0;
    label=(acc?.name||"Account")+" balance";
  } else if(context.scope==="goal"&&context.goalId){
    const g=state.goals.find(x=>x.id===context.goalId);
    const p=g?goalProgress(g):{current:0};
    value=g?convert(p.current,g.currency,state.settings.baseCurrency):0;
    label=(g?.name||"Goal")+" observed progress";
  } else if(context.scope==="transaction"&&context.transactionId){
    const t=state.transactions.find(x=>x.id===context.transactionId);
    value=t?convert(t.amount,t.currency,state.settings.baseCurrency):0;
    label=t?transactionLabel(t):"Activity";
  }
  el.innerHTML=(state.settings.privacyHidden?"•••••••":escapeHtml(money(value)))+'<div class="muted context-value-label">'+escapeHtml(label)+'</div>';

  const engine=window.OmniPocketEngine;
  const accounts=engine.relatedAccounts(state,context);
  const goals=engine.relatedGoals(state,context);
  const transactions=engine.relatedTransactions(state,context);
  const scopeLabel=context.scope==="account"?"ACCOUNT":context.scope==="goal"?"GOAL":context.scope==="transaction"?"ACTIVITY":"GLOBAL";
  if(relationTitle) relationTitle.textContent=context.scope==="global"?"Financial network":contextNodeLabel(context);
  if(relationScope) relationScope.textContent=scopeLabel;

  const accountButtons=accounts.slice(0,6).map(a=>{
    const valueText=state.settings.privacyHidden?"••••":money(a.balance,a.currency);
    const exposure=context.scope==="account"&&context.accountId===a.id&&!state.settings.privacyHidden?engine.accountExposure(state,a.id).selectedShare.toFixed(1)+"% of wealth":"";
    return '<button class="relationship-node" data-related-account="'+escapeHtml(a.id)+'"><span class="relationship-node-main"><span class="node">◉</span><div><strong>'+escapeHtml(a.name)+'</strong><small>'+escapeHtml(a.currency)+" · "+escapeHtml(a.type)+'</small></div></span><span class="relationship-value">'+escapeHtml(valueText)+(exposure?" · "+escapeHtml(exposure):"")+'</span></button>';
  }).join("");
  const goalButtons=goals.slice(0,6).map(g=>{
    const p=goalProgress(g);
    return '<button class="relationship-node" data-related-goal="'+escapeHtml(g.id)+'"><span class="relationship-node-main"><span class="node">◎</span><div><strong>'+escapeHtml(g.name)+'</strong><small>'+escapeHtml((g.accountIds||[]).length+" account"+((g.accountIds||[]).length===1?"":"s"))+'</small></div></span><span class="relationship-value">'+escapeHtml(state.settings.privacyHidden?"••••":money(p.current,g.currency))+'</span></button>';
  }).join("");
  const txButtons=transactions.slice(0,6).map(t=>{
    const source=account(t.sourceAccountId), dest=account(t.destinationAccountId);
    const detail=t.type==="transfer"?((source?.name||"Unknown")+" → "+(dest?.name||"Unknown")):(source?.name||"Unknown account");
    const linked=context.scope==="goal"&&context.goalId&&(t.linkedGoalIds||[]).includes(context.goalId);
    const relationshipBadge=linked?'<span class="context-link-badge">Linked</span>':'<span class="relationship-inferred-badge">Connected</span>';
    return '<button class="relationship-node" data-related-transaction="'+escapeHtml(t.id)+'"><span class="relationship-node-main"><span class="node">≋</span><div><strong>'+escapeHtml(transactionLabel(t))+'</strong><small>'+escapeHtml(t.date+" · "+detail)+'</small><div class="relationship-mini">'+relationshipBadge+'</div></div></span><span class="relationship-value">'+escapeHtml(state.settings.privacyHidden?"••••":money(t.amount,t.currency))+'</span></button>';
  }).join("");
  const exposure=context.scope==="account"&&context.accountId?engine.accountExposure(state,context.accountId):engine.accountExposure(state);
  const exposureChips=exposure.currencies.slice(0,4).map(row=>{
    const pct=exposure.totalBase?Math.round(row.baseValue/exposure.totalBase*100):0;
    return '<span class="relationship-chip">'+escapeHtml(row.currency)+(state.settings.privacyHidden?"":" · "+pct+"%")+'</span>';
  }).join("");

  const groups=[];
  groups.push('<div class="relationship-group"><h3>Accounts</h3>'+(accountButtons||'<div class="relationship-empty">No connected accounts.</div>')+'</div>');
  groups.push('<div class="relationship-group"><h3>Goals</h3>'+(goalButtons||'<div class="relationship-empty">No connected goals.</div>')+'</div>');
  groups.push('<div class="relationship-group"><h3>Activity</h3>'+(txButtons||'<div class="relationship-empty">No connected activity.</div>')+'</div>');
  relationEl.innerHTML='<div class="relationship-summary"><div><strong>'+escapeHtml(scopeLabel==="GLOBAL"?"Your financial network":"Connected financial nodes")+'</strong><span>'+escapeHtml(accounts.length+" account"+(accounts.length===1?"":"s")+" · "+goals.length+" goal"+(goals.length===1?"":"s")+" · "+transactions.length+" transaction"+(transactions.length===1?"":"s"))+'</span></div><div class="relationship-chips">'+exposureChips+'</div></div><div class="relationship-grid">'+groups.join("")+'</div><div class="relationship-foot">Connections are derived from account ownership, goal account selections, transaction source/destination links, and explicit transaction-goal links. Shared accounts can appear in multiple goals and are not double-counted in net worth.</div>';

  const contextTitle=context.scope==="global"?"Net worth trend":context.scope==="account"?(account(context.accountId)?.name||"Account")+" trend":context.scope==="goal"?(state.goals.find(g=>g.id===context.goalId)?.name||"Goal")+" progress":transactionLabel(state.transactions.find(t=>t.id===context.transactionId)||{type:"activity"});
  const trendWidget=$("widgetTrend")?.querySelector("h2"); if(trendWidget) trendWidget.textContent=contextTitle;
  const spendingWidget=$("widgetSpending")?.querySelector("h2"); if(spendingWidget) spendingWidget.textContent=context.scope==="global"?"Last 30 days":context.scope==="account"?(account(context.accountId)?.name||"Account")+" · 30 days":context.scope==="goal"?(state.goals.find(g=>g.id===context.goalId)?.name||"Goal")+" · 30 days":"Related spending";
  const accountsWidget=$("widgetAccounts")?.querySelector("h2"); if(accountsWidget) accountsWidget.textContent=context.scope==="global"?"Accounts":"Connected accounts";
  const goalsWidget=$("widgetGoals")?.querySelector("h2"); if(goalsWidget) goalsWidget.textContent=context.scope==="global"?"Goals":context.scope==="goal"?(state.goals.find(g=>g.id===context.goalId)?.name||"Goal"):context.scope==="account"?"Connected goals":"Related goals";
  const fxWidget=$("widgetFx")?.querySelector("h2"); if(fxWidget) fxWidget.textContent=context.scope==="global"?"FX cache":context.scope==="account"?"Account currency":context.scope==="goal"?"Goal currency":"Transaction FX";
  if(fxContext){
    if(context.scope==="account"&&context.accountId){
      const a=account(context.accountId);
      fxContext.innerHTML='<span class="relationship-chip">'+escapeHtml(a?.currency||state.settings.baseCurrency)+" account · "+escapeHtml(money(a?convert(a.balance,a.currency,state.settings.baseCurrency):0,state.settings.baseCurrency))+'</span>';
    } else if(context.scope==="transaction"&&context.transactionId){
      const t=state.transactions.find(x=>x.id===context.transactionId);
      const cross=t?.receivedCurrency&&t.receivedCurrency!==t.currency;
      fxContext.innerHTML=cross?'<span class="relationship-chip">FX · '+escapeHtml(t.currency)+" → "+escapeHtml(t.receivedCurrency)+" · "+escapeHtml(t.fxRate?"Actual rate saved":"Snapshot rate")+'</span>':"";
    } else if(context.scope==="goal"&&context.goalId){
      const g=state.goals.find(x=>x.id===context.goalId);
      fxContext.innerHTML=g?'<span class="relationship-chip">Goal currency · '+escapeHtml(g.currency)+'</span>':"";
    } else fxContext.innerHTML="";
  }
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
  const allowed = new Set(contextAccountIds());
  const accounts = state.accounts.filter(a => !a.archived && allowed.has(a.id)).slice(0, 5);
  if (!accounts.length) {
    el.innerHTML = '<div class="empty-state">No money nodes yet. Add your first account.</div>';
    return;
  }
  el.innerHTML = accounts.map(a => `
    <div class="account-row interactive-row" data-account-id="${escapeHtml(a.id)}" tabindex="0" role="button" aria-label="Open account">
      <div class="account-main">
        <span class="node">◉</span>
        <div class="truncate">
          <div class="row-title-with-context"><span>${escapeHtml(a.name)}</span>${context.scope==="account"&&context.accountId===a.id?'<span class="context-link-badge">Selected</span>':""}</div>
          <div class="muted">${escapeHtml(a.currency)} · ${escapeHtml(a.type)}</div>
        </div>
      </div>
      <span class="amount">${state.settings.privacyHidden ? "••••" : escapeHtml(money(a.balance, a.currency))}</span>
    </div>
  `).join("");
}

function renderActivity() {
  const el = $("activityList");
  const context = getAppContext(); const allowed = new Set(contextAccountIds(context));
  const rows = state.transactions.filter(t => context.scope === "transaction" ? t.id === context.transactionId : (!allowed.size || allowed.has(t.sourceAccountId) || allowed.has(t.destinationAccountId))).slice().sort((a,b)=>b.createdAt-a.createdAt).slice(0,5);
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
          <div class="row-title-with-context"><span>${escapeHtml(transactionLabel(t))}</span>${context.scope==="transaction"&&context.transactionId===t.id?'<span class="context-link-badge">Selected</span>':context.scope!=="global"&&((context.scope==="account"&&contextAccountIds(context).includes(t.sourceAccountId))||(context.scope==="goal"&&contextAccountIds(context).some(id=>id===t.sourceAccountId||id===t.destinationAccountId)))?'<span class="context-link-badge">Connected</span>':""}</div>
          <div class="muted">${escapeHtml(t.date)} · ${context}</div>
        </div>
        <span class="amount">${sign}${escapeHtml(money(t.amount, t.currency))}</span>
      </div>
    `;
  }).join("");
}

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

function transactionExternalKey(external) {
  if (!external?.provider || !external?.providerTransactionId) return null;
  return String(external.provider) + ':' + String(external.providerTransactionId);
}

function findImportedTransaction(external) {
  const key = transactionExternalKey(external);
  if (!key) return null;
  return state.transactions.find(t => transactionExternalKey(t.external) === key) || null;
}

function normalizeTransferText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:transfer|trf|nip|inward|outward|credit|debit|from|to|payment|transaction|txn|ref|reference)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedReference(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function accountAliases(a) {
  if (!a) return [];
  const values = [a.name, a.institution];
  return [...new Set(values.flatMap(value => {
    const normalized = normalizeTransferText(value);
    return normalized ? [normalized, ...normalized.split(" ").filter(part => part.length >= 4)] : [];
  }))];
}

function findTransferCounterpart(input) {
  const amount = Math.abs(Number(input.amount) || 0);
  if (!amount || !input.sourceAccountId) return null;
  const source = account(input.sourceAccountId);
  if (!source) return null;

  const targetDate = new Date(String(input.date || today()) + "T00:00:00");
  const inputReference = normalizedReference(input.reference);
  const inputText = normalizeTransferText([input.description, input.note, input.reference].filter(Boolean).join(" "));
  const sourceAliases = accountAliases(source);
  const candidates = [];

  for (const tx of state.transactions) {
    if (tx.status !== "needs_review" || tx.id === input.id || tx.pairedTransactionId) continue;
    if (tx.type !== "income" && tx.type !== "expense") continue;
    if (input.type !== "income" && input.type !== "expense") continue;
    if (tx.type === input.type) continue;

    const other = account(tx.sourceAccountId);
    if (!other || other.id === source.id || other.archived) continue;

    const otherAmount = Math.abs(Number(tx.amount) || 0);
    if (!otherAmount) continue;

    const amountDelta = Math.abs(otherAmount - amount);
    const amountTolerance = Math.max(0.01, amount * 0.005);
    if (amountDelta > amountTolerance) continue;

    const txDate = new Date(String(tx.date || "") + "T00:00:00");
    const dayGap = Math.abs(targetDate - txDate) / 86400000;
    if (!Number.isFinite(dayGap) || dayGap > 2) continue;

    const otherReference = normalizedReference(tx.reference);
    const otherText = normalizeTransferText([tx.description, tx.note, tx.reference].filter(Boolean).join(" "));
    const combinedText = inputText + " " + otherText;

    let score = 0;
    const reasons = [];

    if (amountDelta < 0.000001) {
      score += 0.28;
      reasons.push("exact amount");
    } else {
      score += 0.18;
      reasons.push("near amount");
    }

    if (dayGap === 0) {
      score += 0.15;
      reasons.push("same date");
    } else if (dayGap <= 1) {
      score += 0.10;
      reasons.push("within 1 day");
    } else {
      score += 0.05;
      reasons.push("within 2 days");
    }

    if (source.currency === tx.currency) {
      score += 0.06;
      reasons.push("same currency");
    }

    const exactReference = inputReference && otherReference && inputReference === otherReference;
    if (exactReference) {
      score += 0.42;
      reasons.push("exact reference match");
    } else if (inputReference && otherReference) {
      const inputTokens = new Set(normalizeTransferText(input.reference).split(" ").filter(Boolean));
      const otherTokens = new Set(normalizeTransferText(tx.reference).split(" ").filter(Boolean));
      const overlap = [...inputTokens].filter(token => otherTokens.has(token) && token.length >= 4);
      if (overlap.length) {
        score += 0.16;
        reasons.push("reference tokens overlap");
      }
    }

    if (/\b(?:transfer|trf|nip)\b/i.test(combinedText)) {
      score += 0.08;
      reasons.push("transfer language");
    }

    const otherAliases = accountAliases(other);
    const matchedAlias = [...new Set([...sourceAliases, ...otherAliases])]
      .find(alias => alias.length >= 4 && combinedText.includes(alias));
    if (matchedAlias) {
      score += 0.08;
      reasons.push("account name appears in narration");
    }

    if (input.external?.provider && tx.external?.provider && input.external.provider === tx.external.provider) {
      score += 0.03;
      reasons.push("same import source");
    }

    candidates.push({
      transaction: tx,
      score: Math.min(0.99, score),
      exactReference,
      reasons
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;

  const strong = candidates.filter(candidate => candidate.score >= 0.70).slice(0, 4);
  if (!strong.length) return null;

  const best = strong[0];
  const runnerUp = strong[1];
  const ambiguous = runnerUp && !best.exactReference && Math.abs(best.score - runnerUp.score) < 0.08;

  return {
    transactionId: ambiguous ? null : best.transaction.id,
    confidence: best.score,
    reason: ambiguous ? "Multiple plausible transfer matches require review" : "Matched " + reasonsForTransferPair(best),
    candidates: strong.map(candidate => ({
      transactionId: candidate.transaction.id,
      confidence: candidate.score,
      reason: reasonsForTransferPair(candidate)
    }))
  };
}

function reasonsForTransferPair(candidate) {
  return candidate.reasons.join(", ");
}

function importTransaction(input, options = {}) {
  const handling = input.suggestedType ? { type: input.suggestedType, suggestedSourceAccountId: input.suggestedSourceAccountId || null, destinationAccountId: input.suggestedDestinationAccountId || null, confidence: input.handlingConfidence, reason: input.handlingReason } : suggestTransactionHandling(input);
  const suggestion = input.suggestedCategory
    ? { category: input.suggestedCategory, confidence: input.categoryConfidence, reason: input.categoryReason }
    : suggestTransactionCategory({
        description: input.description,
        note: input.note,
        reference: input.reference,
        providerCategory: input.providerCategory
      });
  const suggestedCategory = suggestion?.category || null;
  const category = input.category && input.category !== "Other" && input.category !== "Imported income"
    ? input.category
    : (suggestedCategory || input.category || "");
  const external = input.external && typeof input.external === 'object' ? {
    provider: input.external.provider || null,
    providerTransactionId: input.external.providerTransactionId || null,
    importedAt: input.external.importedAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  } : null;
  const existing = findImportedTransaction(external);
  if (existing) {
    existing.external = { ...(existing.external || {}), ...external, lastSeenAt: new Date().toISOString() };
    if (options.updateExisting && input.note) existing.note = input.note;
    return { transaction: existing, duplicate: true };
  }
  const pair = input.suggestedPairTransactionId ? {
    transactionId: input.suggestedPairTransactionId,
    confidence: input.suggestedPairConfidence,
    reason: input.suggestedPairReason
  } : findTransferCounterpart(input);
  const transaction = addTransaction({
    ...input,
    category,
    suggestedCategory,
    categoryConfidence: suggestion?.confidence ?? null,
    categoryReason: suggestion?.reason || "",
    suggestedType: handling?.type || null,
    suggestedDestinationAccountId: handling?.destinationAccountId || null,
    suggestedPairTransactionId: pair?.transactionId || null,
    suggestedPairCandidates: pair?.candidates?.map(candidate => candidate.transactionId) || [],
    suggestedPairCandidateMeta: Object.fromEntries((pair?.candidates || []).map(candidate => [candidate.transactionId, { confidence: candidate.confidence, reason: candidate.reason }])),
    suggestedPairConfidence: pair?.confidence ?? null,
    suggestedPairReason: pair?.reason || "",
    handlingConfidence: handling?.confidence ?? null,
    handlingReason: handling?.reason || "",
    status: input.status || 'needs_review',
    external
  });
  return { transaction, duplicate: false };
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
    suggestedCategory: input.suggestedCategory || null,
    categoryConfidence: Number.isFinite(Number(input.categoryConfidence)) ? Number(input.categoryConfidence) : null,
    categoryReason: input.categoryReason || "",
    suggestedType: ["income","expense","transfer","withdrawal","adjustment"].includes(input.suggestedType) ? input.suggestedType : null,
    suggestedSourceAccountId: input.suggestedSourceAccountId || null,
    suggestedPairTransactionId: input.suggestedPairTransactionId || null,
    suggestedPairCandidates: Array.isArray(input.suggestedPairCandidates) ? [...new Set(input.suggestedPairCandidates.filter(Boolean))].slice(0, 4) : [],
    suggestedPairCandidateMeta: input.suggestedPairCandidateMeta && typeof input.suggestedPairCandidateMeta === "object" ? input.suggestedPairCandidateMeta : {},
    suggestedPairConfidence: Number.isFinite(Number(input.suggestedPairConfidence)) ? Number(input.suggestedPairConfidence) : null,
    suggestedPairReason: input.suggestedPairReason || "",
    pairedTransactionId: input.pairedTransactionId || null,
    suggestedDestinationAccountId: input.suggestedDestinationAccountId || null,
    handlingConfidence: Number.isFinite(Number(input.handlingConfidence)) ? Number(input.handlingConfidence) : null,
    handlingReason: input.handlingReason || "",
    note: input.note || "",
    adjustmentSign: input.adjustmentSign === -1 ? -1 : 1,
    linkedGoalIds: Array.isArray(input.linkedGoalIds) ? [...new Set(input.linkedGoalIds)] : [],
    external: input.external && typeof input.external === 'object' ? {
      provider: input.external.provider || null,
      providerTransactionId: input.external.providerTransactionId || null,
      importedAt: input.external.importedAt || new Date().toISOString(),
      lastSeenAt: input.external.lastSeenAt || new Date().toISOString()
    } : null
  };
  state.transactions.push(tx);
  emitStateEvent("transaction:updated", { action: "created", transaction: tx });
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

function renderReviewQueue() {
  const host = $("activityReviewQueue");
  if (!host) return;
  const review = state.transactions.filter(t => t.status === "needs_review").sort((a,b) => {
    const ad = new Date(a.date || 0).getTime(), bd = new Date(b.date || 0).getTime();
    return bd - ad || b.createdAt - a.createdAt;
  });
  host.hidden = !review.length;
  if (!review.length) return;
  host.innerHTML = '<div class="review-queue-head"><div><span class="eyebrow">ACTION NEEDED</span><strong>' + review.length + ' transaction' + (review.length === 1 ? "" : "s") + ' to review</strong><span class="muted">Check imported or deferred activity before treating it as settled.</span></div><button id="reviewQueueOpen" type="button">Review all</button></div>' +
    '<div class="review-queue-list">' + review.slice(0,3).map(t => {
      const source = account(t.sourceAccountId);
      return '<button class="review-queue-item" data-review-transaction="' + escapeHtml(t.id) + '"><span><strong>' + escapeHtml(transactionLabel(t)) + '</strong><small>' + escapeHtml(t.date) + ' · ' + escapeHtml(source?.name || "Unknown account") + '</small></span><strong>' + escapeHtml(money(t.amount,t.currency)) + '</strong></button>';
    }).join("") + '</div>' +
    (review.length > 3 ? '<div class="muted review-queue-more">+' + (review.length - 3) + ' more waiting</div>' : "");
  $("reviewQueueOpen")?.addEventListener("click", () => {
    $("activitySearch").value = "__review__";
    renderFullViews();
  });
  host.querySelectorAll("[data-review-transaction]").forEach(button => {
    button.addEventListener("click", () => openTransactionDetail(button.dataset.reviewTransaction));
  });
}

function renderFullViews() {
  renderReviewQueue();
  const accountsEl = $("accountsFullList");
  if (accountsEl) accountsEl.innerHTML = state.accounts.filter(a => !a.archived).map(a => `
    <div class="account-row account-full interactive-row" data-account-id="${escapeHtml(a.id)}" tabindex="0" role="button" aria-label="Open account">
      <div class="account-main"><span class="node">◉</span><div><div class="row-title-with-context"><strong>${escapeHtml(a.name)}</strong>${a.connection?.provider === "mono" ? '<span class="context-link-badge">Connected</span>' : ""}</div><div class="muted">${escapeHtml(a.institution || "Personal")} · ${escapeHtml(a.type)} · ${escapeHtml(a.currency)}</div></div></div>
      <div class="account-tools"><strong>${state.settings.privacyHidden ? "••••" : escapeHtml(money(a.balance,a.currency))}</strong><button data-reconcile="${escapeHtml(a.id)}">Reconcile</button></div>
    </div>`).join("") || '<div class="empty-state">No accounts yet.</div>';

  const goalsEl = $("goalsFullList");
  if (goalsEl) goalsEl.innerHTML = state.goals.map(g => {
    const p = goalProgress(g);
    return `<div class="goal-row interactive-row" data-goal-id="${escapeHtml(g.id)}" tabindex="0" role="button" aria-label="Open goal"><div><strong>${escapeHtml(g.name)}</strong><div class="muted">${escapeHtml(money(p.current,g.currency))} of ${escapeHtml(money(g.target,g.currency))} · ${p.pct.toFixed(0)}%${g.deadline ? " · "+escapeHtml(g.deadline) : ""}</div></div><span class="status-chip">${escapeHtml(g.status)}</span></div>`;
  }).join("") || '<div class="empty-state">No goals yet.</div>';

  const search = ($("activitySearch")?.value || "").toLowerCase();
  const reviewOnly = search === "__review__";
  const activitySearch = reviewOnly ? "" : search;
  const activityEl = $("activityFullList");
  if (activityEl) activityEl.innerHTML = state.transactions.slice().sort((a,b)=>b.createdAt-a.createdAt).filter(t => {
    const s = `${transactionLabel(t)} ${t.note} ${t.date} ${t.status} ${t.type} ${account(t.sourceAccountId)?.name || ""} ${account(t.destinationAccountId)?.name || ""}`.toLowerCase();
    return reviewOnly ? t.status === "needs_review" : t.status !== "superseded" && s.includes(activitySearch);
  }).map(t => {
    const source = account(t.sourceAccountId), dest = account(t.destinationAccountId);
    const direction = transactionDirection(t);
    const sign = direction === "out" ? "−" : direction === "in" ? "+" : "";
    const detail = t.type === "transfer" ? `${source?.name || "Unknown"} → ${dest?.name || "Unknown"}` : source?.name || "Unknown";
    return `<div class="activity-row interactive-row" data-transaction-id="${escapeHtml(t.id)}" tabindex="0" role="button"><div><strong>${escapeHtml(transactionLabel(t))}</strong><div class="muted">${escapeHtml(t.date)} · ${escapeHtml(detail)}${t.note ? " · "+escapeHtml(t.note) : ""}</div></div><div class="activity-value"><strong>${sign}${escapeHtml(money(t.amount,t.currency))}</strong><span class="muted">${escapeHtml(t.status === "needs_review" ? "Handle later" : "Recorded")}${t.external?.provider ? " · " + escapeHtml(t.external.provider) : ""}</span></div></div>`;
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
  const contextCrumb = event.target.closest("[data-context-index]");
  if (contextCrumb) {
    event.preventDefault();
    window.OmniPocketBus?.restoreHistory?.(Number(contextCrumb.dataset.contextIndex));
    return;
  }
  if (event.target.closest("#contextBackButton")) {
    event.preventDefault();
    window.OmniPocketBus?.goBack?.();
    return;
  }
  const relatedAccount=event.target.closest("[data-related-account]");
  if(relatedAccount){ event.preventDefault(); selectAccountContext(relatedAccount.dataset.relatedAccount); return; }
  const relatedGoal=event.target.closest("[data-related-goal]");
  if(relatedGoal){ event.preventDefault(); selectGoalContext(relatedGoal.dataset.relatedGoal); return; }
  const relatedTransaction=event.target.closest("[data-related-transaction]");
  if(relatedTransaction){ event.preventDefault(); selectTransactionContext(relatedTransaction.dataset.relatedTransaction); return; }
  const accountRow = event.target.closest("[data-account-id]");
  if (accountRow && !event.target.closest("button")) { selectAccountContext(accountRow.dataset.accountId); openAccountDetail(accountRow.dataset.accountId); }
  const goalRow = event.target.closest("[data-goal-id]");
  if (goalRow && !event.target.closest("button")) { selectGoalContext(goalRow.dataset.goalId); openGoalDetail(goalRow.dataset.goalId); }
  const goalLink = event.target.closest("[data-goal-from-account]");
  if (goalLink) { $("accountDetailDialog")?.close(); selectGoalContext(goalLink.dataset.goalFromAccount); openGoalDetail(goalLink.dataset.goalFromAccount); }
  const accountLink = event.target.closest("[data-account-from-goal]");
  if (accountLink) { $("goalDetailDialog")?.close(); selectAccountContext(accountLink.dataset.accountFromGoal); openAccountDetail(accountLink.dataset.accountFromGoal); }
});

document.addEventListener("click", event => {
  const txRow = event.target.closest("[data-transaction-id]");
  if (txRow && !event.target.closest("button")) { selectTransactionContext(txRow.dataset.transactionId); openTransactionDetail(txRow.dataset.transactionId); }
});

$("accountDetailRefresh")?.addEventListener("click", () => refreshLocalAccount($("accountDetailDialog").dataset.accountId));
$("accountDetailSync")?.addEventListener("click", () => requestBankSync($("accountDetailDialog").dataset.accountId));
$("accountDetailReconcile")?.addEventListener("click", () => {
  const id = $("accountDetailDialog").dataset.accountId;
  const a = account(id);
  if (!a) return;
  $("accountDetailDialog").close();
  $("reconcileMeta").textContent = a.name + " · " + a.currency + " · Current " + money(a.balance, a.currency);
  $("reconcileAmount").value = a.balance;
  $("reconcileNote").value = "";
  $("reconcileDialog").dataset.accountId = id;
  $("reconcileDialog").showModal();
});
$("transactionEditButton")?.addEventListener("click", () => editTransaction($("transactionDialog").dataset.transactionId));
$("transactionDeleteButton")?.addEventListener("click", () => deleteTransaction($("transactionDialog").dataset.transactionId));
document.addEventListener("click", event => { const goalLink = event.target.closest("[data-goal-from-transaction]"); if (goalLink) { $("transactionDialog")?.close(); selectGoalContext(goalLink.dataset.goalFromTransaction); openGoalDetail(goalLink.dataset.goalFromTransaction); } });
document.addEventListener("click", event => { const tx = event.target.closest("[data-transaction-from-goal]"); if (tx) { $("goalDetailDialog")?.close(); selectTransactionContext(tx.dataset.transactionFromGoal); openTransactionDetail(tx.dataset.transactionFromGoal); } });
$("clearDashboardContext")?.addEventListener("click", () => window.OmniPocketBus?.clearContext?.());

$("transactionReviewButton")?.addEventListener("click", () => {
  const t = state.transactions.find(x => x.id === $("transactionDialog").dataset.transactionId);
  if (!t) return;
  t.status = t.status === "needs_review" ? "recorded" : "needs_review";
  rebuildBalances();
  saveState();
  openTransactionDetail(t.id);
});

$("transactionAcceptSuggestion")?.addEventListener("click", () => {
  const t = state.transactions.find(x => x.id === $("transactionDialog").dataset.transactionId);
  if (!t?.suggestedCategory) return;
  t.category = t.suggestedCategory;
  t.suggestedCategory = null;
  t.categoryConfidence = null;
  t.categoryReason = "";
  saveState();
  openTransactionDetail(t.id);
});

$("transactionPair")?.addEventListener("click", event => {
  const button = event.target.closest("[data-transfer-candidate]");
  if (!button) return;
  const t = state.transactions.find(x => x.id === $("transactionDialog").dataset.transactionId);
  if (!t) return;
  const candidateId = button.dataset.transferCandidate;
  const candidate = state.transactions.find(x => x.id === candidateId);
  if (!candidate || candidate.status !== "needs_review" || candidate.type === t.type) return;
  t.suggestedPairTransactionId = candidate.id;
  t.suggestedPairConfidence = pairCandidateConfidence(t, candidate.id);
  t.suggestedPairReason = pairCandidateReason(t, candidate.id);
  saveState();
  openTransactionDetail(t.id);
});

$("transactionAcceptPair")?.addEventListener("click", () => {
  const t = state.transactions.find(x => x.id === $("transactionDialog").dataset.transactionId);
  const pair = state.transactions.find(x => x.id === t?.suggestedPairTransactionId);
  if (!t || !pair) return;

  // A transfer pair must be one outgoing leg and one incoming leg.
  if (!["income", "expense"].includes(t.type) || !["income", "expense"].includes(pair.type) || t.type === pair.type) {
    t.suggestedPairTransactionId = null;
    t.suggestedPairConfidence = null;
    t.suggestedPairReason = "";
    t.suggestedPairCandidates = [];
    t.suggestedPairCandidateMeta = {};
    saveState();
    openTransactionDetail(t.id);
    return;
  }

  const sourceTx = t.type === "expense" ? t : pair;
  const destinationTx = t.type === "income" ? t : pair;
  const source = account(sourceTx.sourceAccountId);
  const destination = account(destinationTx.sourceAccountId);
  if (!source || !destination || source.id === destination.id) return;

  t.type = "transfer";
  t.sourceAccountId = source.id;
  t.destinationAccountId = destination.id;
  t.amount = Math.abs(Number(sourceTx.amount) || 0);
  t.currency = sourceTx.currency;
  t.receivedAmount = Math.abs(Number(destinationTx.amount) || 0);
  t.receivedCurrency = destinationTx.currency;
  t.fxRate = t.currency === t.receivedCurrency
    ? 1
    : (t.receivedAmount && t.amount ? t.receivedAmount / t.amount : null);
  t.fxSource = t.currency === t.receivedCurrency ? "matched_statement" : "matched_statement";
  t.category = "Bank transfer";
  t.status = "recorded";
  t.suggestedPairTransactionId = null;
  t.suggestedPairConfidence = null;
  t.suggestedPairReason = "";
  t.suggestedPairCandidates = [];
  t.suggestedPairCandidateMeta = {};
  t.pairedTransactionId = pair.id;
  t.suggestedType = null;
  t.suggestedSourceAccountId = null;
  t.suggestedDestinationAccountId = null;
  t.handlingConfidence = null;
  t.handlingReason = "";

  pair.status = "superseded";
  pair.pairedTransactionId = t.id;
  pair.suggestedPairTransactionId = null;
  pair.suggestedPairConfidence = null;
  pair.suggestedPairReason = "";
  pair.suggestedPairCandidates = [];
  pair.suggestedPairCandidateMeta = {};
  pair.suggestedType = null;
  pair.suggestedSourceAccountId = null;
  pair.suggestedDestinationAccountId = null;
  pair.handlingConfidence = null;
  pair.handlingReason = "";

  rebuildBalances();
  saveState();
  openTransactionDetail(t.id);
});

$("transactionAcceptHandling")?.addEventListener("click", () => {
  const t = state.transactions.find(x => x.id === $("transactionDialog").dataset.transactionId);
  const source = account(t?.sourceAccountId);
  const suggestedSource = account(t?.suggestedSourceAccountId) || source;
  const destination = account(t?.suggestedDestinationAccountId);
  if (!t || t.suggestedType !== "transfer" || !source) return;
  if (!destination || !suggestedSource || suggestedSource.id === destination.id) {
    editTransaction(t.id);
    return;
  }
  t.type = "transfer";
  t.sourceAccountId = suggestedSource.id;
  t.destinationAccountId = destination.id;
  t.category = "Bank transfer";
  t.suggestedType = null;
  t.suggestedSourceAccountId = null;
  t.suggestedDestinationAccountId = null;
  t.handlingConfidence = null;
  t.handlingReason = "";
  t.status = "recorded";
  rebuildBalances();
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
  // Editing a paired transfer re-opens its superseded counterpart so the
  // user does not leave the ledger with a permanently hidden orphan leg.
  if (t.pairedTransactionId) {
    const paired = state.transactions.find(x => x.id === t.pairedTransactionId);
    if (paired) {
      paired.status = "needs_review";
      paired.pairedTransactionId = null;
    }
    t.pairedTransactionId = null;
  }
  t.suggestedPairTransactionId = null;
  t.suggestedPairCandidates = [];
  t.suggestedPairCandidateMeta = {};
  t.suggestedPairConfidence = null;
  t.suggestedPairReason = "";
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
  t.suggestedCategory = null;
  t.categoryConfidence = null;
  t.categoryReason = "";
  t.note = $("editTxNote").value.trim();
  t.status = $("editTxStatus").value;
  t.linkedGoalIds = readTransactionGoals("editTxGoals");
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


function accountConnectionStatus(a) {
  const c = a?.connection;
  if (!c || c.provider !== "mono") return { label: "Local account", tone: "local", detail: "Managed entirely on this device." };
  if (c.status === "connected" && c.syncStatus === "healthy") return { label: "Connected", tone: "connected", detail: c.lastSyncedAt ? "Last synced " + new Date(c.lastSyncedAt).toLocaleString() : "Bank connection active." };
  if (c.syncStatus === "syncing") return { label: "Syncing", tone: "syncing", detail: "Bank data is being refreshed." };
  return { label: "Connection needs attention", tone: "warning", detail: "The bank connection is not currently healthy." };
}
function refreshLocalAccount(id) {
  const a = account(id);
  if (!a) return;
  rebuildBalances();
  saveState();
  openAccountDetail(id);
}
function requestBankSync(id) {
  const a = account(id);
  if (!a?.connection?.providerAccountId) return alert("This account is local. Use Reconcile to match it with your actual balance.");
  alert("Live bank sync is paused for now. Your linked account and imported history remain stored locally. Reconciliation is still available.");
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
  const connection = accountConnectionStatus(a);
  $("accountDetailStats").innerHTML = "<span>" + txs.length + " transaction" + (txs.length === 1 ? "" : "s") + "</span><span>" + (a.archived ? "Archived" : "Active") + "</span><span class=\"account-connection-chip\" data-tone=\"" + escapeHtml(connection.tone) + "\">" + escapeHtml(connection.label) + "</span>";
  const syncMeta = $("accountDetailSyncMeta");
  if (syncMeta) syncMeta.textContent = connection.detail;
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

  const quickGoals = document.createElement("div");
  quickGoals.id = "quickTxGoals";
  quickGoals.className = "check-list";
  quickGoals.innerHTML = '<div class="field-label">Linked goals <span class="muted">(optional)</span></div><div class="muted">Link this movement to one or more goals. This is a relationship, not a separate allocation.</div>';
  $("quickNote").closest("label").after(quickGoals);

  const editGoals = document.createElement("div");
  editGoals.id = "editTxGoals";
  editGoals.className = "check-list";
  editGoals.innerHTML = '<div class="field-label">Linked goals <span class="muted">(optional)</span></div><div class="muted">Links explain which goals this activity relates to; they do not double-count money.</div>';
  $("editTxNote").closest("label").after(editGoals);

  $("quickAccount").addEventListener("change", syncTransferFields);
  $("quickDestination").addEventListener("change", syncTransferFields);
}

$("dashboardAddGoal")?.addEventListener("click", createGoal);
$("dashboardAddAccount")?.addEventListener("click", () => $("accountDialog").showModal());
$("fab")?.addEventListener("click", () => openQuick("expense"));
document.querySelectorAll("[data-dashboard-quick]").forEach(button => {
  button.addEventListener("click", () => openQuick(button.dataset.dashboardQuick));
});
$("addAccountButton")?.addEventListener("click", () => $("accountDialog")?.showModal());
$("addAccountPageButton")?.addEventListener("click", () => $("accountDialog").showModal());
$("connectBankButton")?.addEventListener("click", connectBankAccount);
$("addGoalPageButton")?.addEventListener("click", () => createGoal());
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

let pendingStatementImport = null;
let statementPreviewFilter = "all";

function statementMapping() {
  return {
    date: $("statementMapDate")?.value || "",
    description: $("statementMapDescription")?.value || "",
    reference: $("statementMapReference")?.value || "",
    amount: $("statementMapAmount")?.value || "",
    debit: $("statementMapDebit")?.value || "",
    credit: $("statementMapCredit")?.value || ""
  };
}
function statementProfileKey(accountTarget) {
  const institution = String(accountTarget?.institution || "").trim().toLowerCase();
  const accountName = String(accountTarget?.name || "default").trim().toLowerCase();
  return "omnipocket.statementProfile." + [institution, accountName].filter(Boolean).join("-").replace(/[^a-z0-9]+/g,"-");
}
function readStatementProfile(accountTarget) {
  try { return JSON.parse(localStorage.getItem(statementProfileKey(accountTarget)) || "null"); } catch { return null; }
}
function saveStatementProfile(accountTarget, mapping) {
  try { localStorage.setItem(statementProfileKey(accountTarget), JSON.stringify(mapping)); } catch {}
}
function effectiveStatementMapping(accountTarget, headers) {
  const saved = readStatementProfile(accountTarget);
  if (!saved) return null;
  const valid = Object.values(saved).every(value => !value || headers.includes(value));
  return valid ? saved : null;
}

function renderStatementMapping(headers) {
  const p = $("statementMappingPanel");
  if (!p) return;
  const preview = pendingStatementImport?.preview;
  const map = preview?.mapping || effectiveStatementMapping(account($("statementImportAccount")?.value), headers) || {};
  $("statementMapDate").innerHTML = statementHeaderOptions(headers, map.date, "Select date column");
  $("statementMapDescription").innerHTML = statementHeaderOptions(headers, map.description, "No description");
  $("statementMapReference").innerHTML = statementHeaderOptions(headers, map.reference, "No reference");
  $("statementMapAmount").innerHTML = statementHeaderOptions(headers, map.amount, "No signed amount");
  $("statementMapDebit").innerHTML = statementHeaderOptions(headers, map.debit, "No debit");
  $("statementMapCredit").innerHTML = statementHeaderOptions(headers, map.credit, "No credit");
  p.hidden = false;
}

function statementPreviewRowsForFilter(preview) {
  const rows = preview?.rows || [];
  switch (statementPreviewFilter) {
    case "transfer": return rows.filter(row => !row.invalid && row.suggestedType === "transfer");
    case "ambiguous": return rows.filter(row => !row.invalid && row.suggestedType === "transfer" && (!row.suggestedPairTransactionId || (row.suggestedPairCandidates?.length || 0) > 1));
    case "duplicate": return rows.filter(row => row.isDuplicate);
    case "invalid": return rows.filter(row => row.invalid);
    default: return rows;
  }
}

function renderStatementPreview() {
  const preview = pendingStatementImport?.preview;
  if (!preview) return;
  const rows = preview.rows || [];
  const valid = rows.filter(row => !row.invalid);
  const duplicateRows = valid.filter(row => row.isDuplicate);
  const stats = preview.stats || {
    valid: valid.length,
    invalid: rows.filter(row => row.invalid).length,
    duplicates: duplicateRows.length,
    likelyTransfers: valid.filter(row => row.suggestedType === "transfer").length,
    ambiguousTransfers: valid.filter(row => row.suggestedType === "transfer" && (!row.suggestedPairTransactionId || (row.suggestedPairCandidates?.length || 0) > 1)).length
  };
  const filterRows = statementPreviewRowsForFilter(preview);
  const filterLabels = [["all","All",rows.length],["transfer","Likely transfers",stats.likelyTransfers],["ambiguous","Ambiguous",stats.ambiguousTransfers],["duplicate","Duplicates",stats.duplicates],["invalid","Invalid",stats.invalid]];
  const filteredLabel = filterLabels.find(item => item[0] === statementPreviewFilter)?.[1] || "All";
  const filters = '<div class="statement-preview-filters" role="toolbar" aria-label="Statement preview filters">' +
    filterLabels.map(([key,label,count]) => '<button type="button" class="statement-preview-filter' + (statementPreviewFilter === key ? ' is-active' : '') + '" data-statement-preview-filter="' + key + '">' + escapeHtml(label) + ' <span>' + count + '</span></button>').join("") +
    '</div>';
  const batchActions = '<div class="statement-batch-analysis"><div class="statement-batch-analysis-head"><div><span class="eyebrow">BATCH ANALYSIS</span><strong>Review before importing</strong><span class="muted">Imported rows stay in the review queue until you record them.</span></div><span class="statement-batch-count">' + filterRows.length + ' shown</span></div>' +
    '<div class="statement-batch-metrics">' +
      '<button type="button" data-statement-preview-filter="transfer"><strong>' + stats.likelyTransfers + '</strong><span>likely transfers</span></button>' +
      '<button type="button" data-statement-preview-filter="ambiguous"><strong>' + stats.ambiguousTransfers + '</strong><span>ambiguous</span></button>' +
      '<button type="button" data-statement-preview-filter="duplicate"><strong>' + stats.duplicates + '</strong><span>probable duplicates</span></button>' +
      '<button type="button" data-statement-preview-filter="invalid"><strong>' + stats.invalid + '</strong><span>invalid rows</span></button>' +
    '</div><div class="statement-batch-action-row">' +
      (stats.ambiguousTransfers ? '<button type="button" class="secondary" data-statement-preview-filter="ambiguous">Review ambiguous transfers</button>' : '') +
      (stats.duplicates ? '<button type="button" class="secondary" data-statement-preview-filter="duplicate">Review duplicates</button>' : '') +
      (stats.invalid ? '<button type="button" class="secondary" data-statement-preview-filter="invalid">Show invalid rows</button>' : '') +
      (statementPreviewFilter !== "all" ? '<button type="button" class="text-button" data-statement-preview-filter="all">Show all rows</button>' : '') +
    '</div></div>';

  $("statementImportSummary").innerHTML = '<strong>' + stats.valid + ' valid</strong> · ' + stats.duplicates + ' duplicate' + (stats.duplicates === 1 ? "" : "s") + ' · ' + stats.invalid + ' invalid' +
    (stats.likelyTransfers ? ' · <strong>' + stats.likelyTransfers + ' likely transfer' + (stats.likelyTransfers === 1 ? "" : "s") + '</strong>' : '') +
    (stats.ambiguousTransfers ? ' · <strong>' + stats.ambiguousTransfers + ' need transfer review</strong>' : '');

  const visibleRows = filterRows.slice(0,12);
  $("statementImportPreview").innerHTML = batchActions + filters +
    '<div class="statement-preview-filter-label">' + escapeHtml(filteredLabel) + ' · ' + filterRows.length + ' row' + (filterRows.length === 1 ? "" : "s") + '</div>' +
    '<div class="statement-import-preview">' +
    (visibleRows.length ? visibleRows.map(row => {
      const candidateIds = row.suggestedPairCandidates || [];
      const candidateHtml = row.suggestedType === "transfer" && candidateIds.length ? '<div class="statement-transfer-candidates"><span class="eyebrow">TRANSFER MATCHES</span>' +
        candidateIds.slice(0,4).map(id => {
          const candidate = state.transactions.find(t => t.id === id);
          const confidence = Number(row.suggestedPairCandidateMeta?.[id]?.confidence ?? (id === row.suggestedPairTransactionId ? row.suggestedPairConfidence : 0)) || 0;
          const reason = row.suggestedPairCandidateMeta?.[id]?.reason || "Possible transfer match";
          const candidateAccount = candidate ? account(candidate.sourceAccountId)?.name || "Unknown account" : "Possible match";
          const candidateMeta = candidate ? candidate.date + " · " + money(candidate.amount,candidate.currency) : "Candidate no longer available";
          return '<button type="button" class="statement-transfer-candidate' + (id === row.suggestedPairTransactionId ? ' is-selected' : '') + '" data-transaction-from-statement="' + escapeHtml(id) + '"><span><strong>' + escapeHtml(candidateAccount) + '</strong><small>' + escapeHtml(candidateMeta) + '</small><small>' + escapeHtml(reason) + '</small></span><strong>' + Math.round(confidence * 100) + '%</strong></button>';
        }).join("") + (candidateIds.length > 4 ? '<small class="muted">+' + (candidateIds.length - 4) + ' more candidates</small>' : '') + '</div>' : "";
      const bits = [];
      if (row.suggestedCategory) bits.push('Category: ' + escapeHtml(row.suggestedCategory) + ' · ' + Math.round((Number(row.categoryConfidence) || 0) * 100) + '%');
      if (row.suggestedType === "transfer") bits.push('Handling: likely transfer' + (row.suggestedDestinationAccountId ? ' · matched account' : ' · destination needs review') + ' · ' + Math.round((Number(row.handlingConfidence) || 0) * 100) + '%');
      if (row.isDuplicate) bits.push('Probable duplicate — already imported');
      return '<div class="statement-import-row ' + (row.invalid ? 'statement-import-invalid ' : '') + (row.isDuplicate ? 'statement-import-duplicate' : '') + '"><span><strong>' + escapeHtml(row.date || ("Row " + row.rowNumber)) + '</strong><small>' + escapeHtml(row.description || row.reason || "No description") + '</small>' + bits.map(bit => '<small>' + bit + '</small>').join("") + candidateHtml + '</span><strong>' + (row.invalid ? escapeHtml(row.reason) : escapeHtml((row.signedAmount > 0 ? "+" : "−") + money(Math.abs(row.signedAmount),row.currency))) + '</strong></div>';
    }).join("") : '<div class="empty-state">No rows match this filter.</div>') +
    '</div>' + (filterRows.length > 12 ? '<div class="muted">Showing first 12 of ' + filterRows.length + ' rows.</div>' : '');
  $("statementImportConfirm").disabled = !valid.length;
}


$("statementImportPreview")?.addEventListener("click", event => {
  const filterButton = event.target.closest("[data-statement-preview-filter]");
  if (filterButton) {
    statementPreviewFilter = filterButton.dataset.statementPreviewFilter || "all";
    renderStatementPreview();
    return;
  }
  const candidateButton = event.target.closest("[data-transaction-from-statement]");
  if (candidateButton) {
    const candidateId = candidateButton.dataset.transactionFromStatement;
    const candidate = state.transactions.find(t => t.id === candidateId);
    if (candidate) {
      selectTransactionContext(candidateId);
      openTransactionDetail(candidateId);
    }
  }
});

$("statementImportButton")?.addEventListener("click", () => {
  const active = state.accounts.filter(a => !a.archived);
  if (!active.length) return alert("Add an account before importing a statement.");
  $("statementImportAccount").innerHTML = active.map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' · ' + escapeHtml(a.currency) + '</option>').join("");
  pendingStatementImport = null;
  statementPreviewFilter = "all";
  $("statementMappingPanel").hidden = true;
  $("statementImportSummary").textContent = "Choose an account and statement file.";
  $("statementImportPreview").innerHTML = "";
  $("statementImportConfirm").disabled = true;
  $("statementImportDialog").showModal();
});

$("statementImportFilePicker")?.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const extension = file.name.toLowerCase().split(".").pop();
    let text = "";
    let parsed;
    if (extension === "csv") {
      text = await file.text();
      parsed = parseStatementCsv(text);
    } else {
      if (!window.XLSX) throw new Error("Excel support is still loading. Please try again in a moment.");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      if (!workbook.SheetNames.length) throw new Error("That workbook has no sheets.");
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
      if (matrix.length < 2) throw new Error("That spreadsheet needs a header row and at least one transaction.");
      const headers = matrix[0].map((h, idx) => String(h || "Column " + (idx + 1)).trim());
      parsed = { headers, rows: matrix.slice(1).map(values => Object.fromEntries(headers.map((h, idx) => [h, values[idx] ?? ""]))) };
    }
    if (!parsed.headers.length) throw new Error("That statement does not contain a usable header row.");
    pendingStatementImport = { text, fileName:file.name, workbookSheet: parsed, preview:null };
    if (extension !== "csv") pendingStatementImport.spreadsheetRows = parsed;
    renderStatementMapping(parsed.headers);
    $("statementImportSummary").textContent = parsed.rows.length + " data row" + (parsed.rows.length === 1 ? "" : "s") + " loaded. Check the mapping, then preview.";
  } catch (error) {
    pendingStatementImport = null;
    $("statementMappingPanel").hidden = true;
    $("statementImportSummary").textContent = error.message || "Could not read that CSV.";
    $("statementImportPreview").innerHTML = "";
    $("statementImportConfirm").disabled = true;
  } finally { event.target.value = ""; }
});

$("statementPreviewButton")?.addEventListener("click", () => {
  if (!pendingStatementImport?.workbookSheet) return;
  try {
    const targetAccount = account($("statementImportAccount").value);
    const mapping = statementMapping();
    pendingStatementImport.preview = pendingStatementImport.spreadsheetRows
      ? previewStatementImportObjects(pendingStatementImport.spreadsheetRows, targetAccount.id, mapping)
      : previewStatementImport(pendingStatementImport.text, targetAccount.id, mapping);
    if ($("statementRememberMapping")?.checked) saveStatementProfile(targetAccount, mapping);
    renderStatementPreview();
  } catch (error) {
    $("statementImportSummary").textContent = error.message || "Could not preview the statement.";
    $("statementImportPreview").innerHTML = "";
    $("statementImportConfirm").disabled = true;
  }
});

$("statementImportAccount")?.addEventListener("change", () => {
  if (!pendingStatementImport?.workbookSheet) return;
  try {
    const targetAccountId = $("statementImportAccount").value;
    const mapping = statementMapping();
    pendingStatementImport.preview = pendingStatementImport.spreadsheetRows
      ? previewStatementImportObjects(pendingStatementImport.spreadsheetRows, targetAccountId, mapping)
      : previewStatementImport(pendingStatementImport.text, targetAccountId, mapping);
    renderStatementMapping(pendingStatementImport.preview.headers);
    renderStatementPreview();
  } catch (error) {
    $("statementImportSummary").textContent = error.message || "Choose a valid account.";
  }
});

$("statementImportConfirm")?.addEventListener("click", () => {
  const rows = pendingStatementImport?.preview?.rows;
  if (!rows?.length) return;
  const result = importStatementRows(rows);
  $("statementImportDialog").close();
  pendingStatementImport = null;
  alert(result.imported + " imported to the review queue." + (result.duplicates ? " " + result.duplicates + " duplicate" + (result.duplicates === 1 ? "" : "s") + " skipped." : "") + (result.invalid ? " " + result.invalid + " invalid row" + (result.invalid === 1 ? "" : "s") + " skipped." : ""));
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

$("privacyButton")?.addEventListener("click", () => {
  state.settings.privacyHidden = !state.settings.privacyHidden;
  saveState();
});

$("baseCurrencyButton")?.addEventListener("click", () => {
  $("baseCurrencySelect").value = state.settings.baseCurrency;
  $("currencyDialog").showModal();
});

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
  const current = Number(a.balance) || 0;
  const delta = target - current;
  if (Math.abs(delta) < 0.0000001) {
    $("reconcileDialog").close();
    return;
  }
  const note = $("reconcileNote").value.trim() || "Balance reconciliation";
  addTransaction({
    type:"adjustment",
    sourceAccountId:a.id,
    amount:Math.abs(delta),
    currency:a.currency,
    category:delta > 0 ? "Reconciliation increase" : "Reconciliation decrease",
    adjustmentSign: delta > 0 ? 1 : -1,
    note,
    date:today()
  });
  rebuildBalances();
  saveState();
  $("reconcileDialog").close();
});

$("addGoalButton")?.addEventListener("click", () => createGoal());

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
  const current=(state.settings.dashboard.order||["networth","trend","goals","accounts","activity","quick","fx","relations","insights","spending"]).slice();
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
  const order=($("widgetOrderSelect")?.value || "networth,trend,goals,accounts,activity,quick,fx,relations,insights,spending").split(",");
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
$("activitySearch")?.addEventListener("focus", () => {
  if ($("activitySearch").value === "__review__") $("activitySearch").value = "";
});
$("clearReviewButton")?.addEventListener("click", () => {
  navigate("Activity");
  const review = state.transactions.filter(t => t.status === "needs_review");
  if (!review.length) return alert("No transactions need review.");
  $("activitySearch").value = "__review__";
  renderFullViews();
});
window.addEventListener("load", async () => {
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js");
  await bootstrapStorage();
});
