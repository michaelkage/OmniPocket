/* OmniPocket — domain/wealth engine
 * Pure financial calculations live here so UI code can be replaced without
 * changing the accounting model.
 */
(() => {
  const DAY = 86400000;
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  const clone = value => JSON.parse(JSON.stringify(value));

  function accountMap(state) {
    return new Map((state.accounts || []).map(account => [account.id, account]));
  }

  function rateFromTable(table, from, to, baseCurrency = null) {
    if (from === to) return 1;
    const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
    const direct = positive(table?.[from]?.[to]);
    if (direct) return direct;
    const inverse = positive(table?.[to]?.[from]);
    if (inverse) return 1 / inverse;
    if (baseCurrency && from !== baseCurrency && to !== baseCurrency) {
      const sourceToBase = positive(table?.[from]?.[baseCurrency]);
      const baseToTarget = positive(table?.[baseCurrency]?.[to]);
      if (sourceToBase && baseToTarget) return sourceToBase * baseToTarget;
      const baseToSource = positive(table?.[baseCurrency]?.[from]);
      const targetToBase = positive(table?.[to]?.[baseCurrency]);
      if (baseToSource && targetToBase) return 1 / (baseToSource * targetToBase);
    }
    return null;
  }

  function rate(state, from, to, overrideRate = null) {
    if (from === to) return 1;
    if (Number.isFinite(Number(overrideRate)) && Number(overrideRate) > 0) return Number(overrideRate);
    const table = state.settings?.fx?.rates || {};
    return rateFromTable(table, from, to, state.settings?.baseCurrency) ?? 1;
  }

  function fxFreshness(state, now = Date.now()) {
    const fx = state.settings?.fx || {};
    const updatedAt = Number(fx.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      return { status: fx.source === "bundled" || fx.provider === "cached" ? "bundled" : "unknown", updatedAt: null, ageMs: null };
    }
    const ageMs = Number(now) - updatedAt;
    if (ageMs < -5 * 60000) return { status: "clock_skew", updatedAt, ageMs };
    if (ageMs <= DAY) return { status: "current", updatedAt, ageMs: Math.max(0, ageMs) };
    if (ageMs <= 7 * DAY) return { status: "aging", updatedAt, ageMs };
    return { status: "stale", updatedAt, ageMs };
  }

  function valuationCoverage(state, accounts = null) {
    const rows = (accounts || state.accounts || []).filter(account => !account.archived);
    const base = state.settings?.baseCurrency;
    const rates = state.settings?.fx?.rates || {};
    const unvalued = rows.filter(account => !base || rateFromTable(rates, account.currency || base, base, base) == null)
      .map(account => ({ id: account.id, name: account.name || "Unnamed account", currency: account.currency || null }));
    return { totalCount: rows.length, valuedCount: rows.length - unvalued.length, unvaluedCount: unvalued.length, complete: unvalued.length === 0, unvalued };
  }

  function convertAtRates(value, from, to, rates, fallbackState) {
    const amount = Number(value) || 0;
    if (from === to) return amount;
    const resolved = rateFromTable(rates, from, to, fallbackState?.settings?.baseCurrency);
    if (resolved != null) return amount * resolved;
    return convert(fallbackState, amount, from, to);
  }

  function fxHistory(state, limit = 180) {
    const rows = Array.isArray(state.settings?.fx?.history) ? state.settings.fx.history.slice() : [];
    return rows.sort((a,b)=>Number(a.updatedAt)-Number(b.updatedAt)).slice(-limit);
  }

  function recordFxSnapshot(state, matrix, meta = {}) {
    state.settings.fx = state.settings.fx || {};
    state.settings.fx.history = Array.isArray(state.settings.fx.history) ? state.settings.fx.history : [];
    const base = state.settings.baseCurrency;
    const entry = { updatedAt: Number(meta.updatedAt) || Date.now(), base, source: meta.source || "unknown", rates: clone(matrix) };
    state.settings.fx.history = state.settings.fx.history.filter(x => !(x.base === base && Math.abs(Number(x.updatedAt)-entry.updatedAt) < 60000));
    state.settings.fx.history.push(entry);
    state.settings.fx.history = state.settings.fx.history.slice(-180);
    return entry;
  }

  function wealthChange(state, days = 30) {
    const rows = historicalNetWorth(state, Math.max(days, 2));
    if (rows.length < 2) return { current: netWorth(state), previous: null, change: null, pct: null };
    const previous = Number(rows[0].value) || 0;
    const current = Number(rows[rows.length-1].value) || 0;
    return { current, previous, change: current - previous, pct: previous ? (current - previous) / Math.abs(previous) * 100 : null };
  }

  function convert(state, value, from, to, overrideRate = null) {
    const amount = Number(value) || 0;
    return amount * rate(state, from, to, overrideRate);
  }

  // Keep every financial summary aligned with the balance engine: unposted,
  // failed, reversed, and superseded bank movements must not affect totals.
  function isFinanciallyEffective(tx) {
    const status = String(tx?.status || "").trim().toLowerCase();
    const bankStatus = String(tx?.bankStatus || "").trim().toLowerCase();
    return status !== "needs_review" &&
      status !== "superseded" &&
      !["pending", "failed", "reversed"].includes(bankStatus);
  }

  function adjustmentDelta(tx) {
    if (tx.adjustmentSign === -1) return -Math.abs(Number(tx.amount) || 0);
    if (tx.adjustmentSign === 1) return Math.abs(Number(tx.amount) || 0);
    return String(tx.category || "").toLowerCase().includes("decrease")
      ? -Math.abs(Number(tx.amount) || 0)
      : Math.abs(Number(tx.amount) || 0);
  }

  function sortedTransactions(state, until = null) {
    return (state.transactions || [])
      .filter(tx => !until || String(tx.date) <= String(until.date) &&
        (String(tx.date) < String(until.date) || Number(tx.createdAt) <= Number(until.createdAt)))
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.createdAt) - Number(b.createdAt));
  }

  function balancesAt(state, until = null) {
    const accounts = (state.accounts || []).map(a => ({
      ...a,
      balance: Number(a.openingBalance) || 0
    }));
    const map = accountMap({ accounts });
    for (const tx of sortedTransactions(state, until)) {
      if (!isFinanciallyEffective(tx)) continue;
      const source = map.get(tx.sourceAccountId);
      const destination = map.get(tx.destinationAccountId);
      if (tx.type === "income" && source) source.balance += Math.abs(Number(tx.amount) || 0);
      if (tx.type === "expense" && source) source.balance -= Math.abs(Number(tx.amount) || 0);
      if (tx.type === "adjustment" && source) source.balance += adjustmentDelta(tx);
      if (tx.type === "transfer" || tx.type === "withdrawal") {
        if (source) source.balance -= Math.abs(Number(tx.amount) || 0);
        if (destination) {
          destination.balance += tx.receivedAmount != null
            ? Math.abs(Number(tx.receivedAmount) || 0)
            : convert(state, tx.amount, tx.currency, destination.currency, tx.fxRate);
        }
      }
    }
    return accounts;
  }

  function netWorth(state, accounts = null, currency = state.settings.baseCurrency) {
    const rows = accounts || state.accounts || [];
    return rows.filter(a => !a.archived)
      .reduce((sum, a) => sum + convert(state, a.balance, a.currency, currency), 0);
  }

  function goalProgress(state, goal) {
    const accounts = accountMap(state);
    const current = (goal.accountIds || []).reduce((sum, id) => {
      const a = accounts.get(id);
      return sum + (a ? convert(state, a.balance, a.currency, goal.currency) : 0);
    }, 0);
    const target = Math.max(0, Number(goal.target) || 0);
    return { current, target, remaining: Math.max(0, target - current), pct: target ? Math.min(100, current / target * 100) : 0 };
  }

  function spendingSummary(state, days = 30, asOf = new Date()) {
    const cutoff = new Date(asOf);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - days + 1);
    const cutoffDate = dateKey(cutoff);
    const asOfDate = dateKey(new Date(asOf));
    const totals = {};
    let total = 0;
    let income = 0;
    for (const tx of state.transactions || []) {
      if (String(tx.date) < cutoffDate || String(tx.date) > asOfDate || !isFinanciallyEffective(tx)) continue;
      if (tx.type === "expense") {
        const value = convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, state.settings.baseCurrency, tx.fxRate);
        const key = tx.category || "Other";
        totals[key] = (totals[key] || 0) + value;
        total += value;
      } else if (tx.type === "income") {
        income += convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, state.settings.baseCurrency, tx.fxRate);
      }
    }
    return { totals, total, income, days };
  }

  function flowSummary(state, days = 30, asOf = new Date()) {
    const cutoff = new Date(asOf);
    cutoff.setDate(cutoff.getDate() - days + 1);
    const cutoffDate = dateKey(cutoff);
    const asOfDate = dateKey(new Date(asOf));
    const result = { income: 0, expenses: 0, transfers: 0, withdrawals: 0, adjustments: 0, count: 0 };
    for (const tx of state.transactions || []) {
      if (String(tx.date) < cutoffDate || String(tx.date) > asOfDate || !isFinanciallyEffective(tx)) continue;
      const rawAmount = Math.abs(Number(tx.amount) || 0);
      const amount = convert(state, rawAmount, tx.currency, state.settings.baseCurrency, tx.fxRate);
      result.count++;
      if (tx.type === "income") result.income += amount;
      if (tx.type === "expense") result.expenses += amount;
      if (tx.type === "transfer") result.transfers += amount;
      if (tx.type === "withdrawal") result.withdrawals += amount;
      if (tx.type === "adjustment") {
        result.adjustments += convert(state, adjustmentDelta(tx), tx.currency, state.settings.baseCurrency, tx.fxRate);
      }
    }
    result.netFlow = result.income - result.expenses;
    return result;
  }

  // Learn merchant-specific categories only from transactions explicitly corrected by the user.
  // A single correction can help future repeats; generic narration words are ignored.
  function learnedCategorySuggestion(transactions = [], input = {}) {
    const stop = new Set(["payment","transfer","purchase","transaction","online","mobile","pos","web","card","debit","credit","bank","banking","ref","reference","narration","from","with","the","and","for","via","cash","alert","notification"]);
    const tokens = value => [...new Set(String(value || "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").split(/\s+/)
      .filter(token => token.length >= 4 && !stop.has(token)))];
    const current = tokens([input.description, input.note, input.reference].filter(Boolean).join(" "));
    if (!current.length) return null;
    const history = (transactions || []).filter(tx =>
      tx && tx.categorySource === "user" && String(tx.category || "").trim()
    );
    const votes = new Map();
    for (const tx of history) {
      const prior = tokens([tx.description, tx.note, tx.reference, tx.external?.merchantName].filter(Boolean).join(" "));
      const overlap = current.filter(token => prior.includes(token));
      if (!overlap.length) continue;
      const category = String(tx.category).trim();
      const score = overlap.length / Math.max(current.length, prior.length);
      const existing = votes.get(category) || { category, score: 0, count: 0, matched: new Set() };
      existing.score += score;
      existing.count++;
      overlap.forEach(token => existing.matched.add(token));
      votes.set(category, existing);
    }
    const ranked = [...votes.values()].sort((a, b) => b.score - a.score || b.count - a.count);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best || best.score < 0.35 || (runnerUp && best.score < runnerUp.score * 1.35)) return null;
    const confidence = Math.min(0.94, 0.82 + Math.min(0.08, (best.count - 1) * 0.03) + (best.score >= 0.8 ? 0.04 : 0));
    return {
      category: best.category,
      confidence,
      reason: "Learned from " + best.count + " correction" + (best.count === 1 ? "" : "s") +
        " for " + [...best.matched].slice(0, 3).join(", ")
    };
  }

  // Estimate how long active, non-liability balances could cover historical spending.
  // Essential categories are intentionally conservative; unknown categories stay unclassified.
  function financialRunway(state, asOf = new Date(), lookbackDays = 90) {
    const today = new Date(asOf);
    today.setHours(0, 0, 0, 0);
    const endKey = dateKey(today);
    const start = new Date(today);
    const windowDays = Math.max(1, Math.min(365, Number(lookbackDays) || 90));
    start.setDate(start.getDate() - windowDays + 1);
    const startKey = dateKey(start);
    const essentialPattern = /\b(rent|housing|mortgage|grocer|food|supermarket|market|utility|electric|power|water|internet|data|transport|fuel|petrol|diesel|health|medical|pharmacy|medicine|education|school|childcare)\b/i;
    const totals = { essential: 0, discretionary: 0, unclassified: 0 };
    let sampleTransactions = 0;
    const activeDates = new Set();
    for (const tx of state.transactions || []) {
      const date = String(tx.date || "");
      if (tx.type !== "expense" || !isFinanciallyEffective(tx) || date < startKey || date > endKey) continue;
      const amount = convert(state, Math.abs(Number(tx.amount) || 0), tx.currency || state.settings.baseCurrency, state.settings.baseCurrency, tx.fxRate);
      if (!(amount > 0)) continue;
      const category = String(tx.category || "");
      const bucket = essentialPattern.test(category) ? "essential" : category.trim() ? "discretionary" : "unclassified";
      totals[bucket] += amount;
      sampleTransactions++;
      activeDates.add(date);
    }
    const activeAccounts = balancesAt(state, { date: endKey, createdAt: Number.MAX_SAFE_INTEGER }).filter(account => {
      if (account.archived) return false;
      const kind = String(account.type || account.kind || account.accountType || "").toLowerCase();
      return !/(credit|liabilit|debt|loan)/.test(kind);
    });
    const availableBalance = netWorth(state, activeAccounts, state.settings.baseCurrency);
    const daily = {
      essential: totals.essential / windowDays,
      discretionary: totals.discretionary / windowDays,
      unclassified: totals.unclassified / windowDays
    };
    const dailyTotal = daily.essential + daily.discretionary + daily.unclassified;
    const runwayDays = rate => rate > 0 ? Math.max(0, availableBalance / rate) : null;
    const activeDays = activeDates.size;
    const confidence = sampleTransactions >= 30 && activeDays >= 20 ? "High"
      : sampleTransactions >= 10 && activeDays >= 7 ? "Moderate" : "Low";
    return {
      currency: state.settings.baseCurrency,
      availableBalance,
      essentialSpend: totals.essential,
      discretionarySpend: totals.discretionary,
      unclassifiedSpend: totals.unclassified,
      totalSpend: totals.essential + totals.discretionary + totals.unclassified,
      dailyEssential: daily.essential,
      dailyDiscretionary: daily.discretionary,
      dailyUnclassified: daily.unclassified,
      dailySpend: dailyTotal,
      totalRunwayDays: runwayDays(dailyTotal),
      essentialOnlyRunwayDays: runwayDays(daily.essential),
      lookbackDays: windowDays,
      sampleTransactions,
      activeDays,
      confidence,
      method: "historical daily spend over fixed lookback window"
    };
  }

  // Linear month-end cash-flow estimate from effective month-to-date activity.
  // This is a run-rate projection, not a promise or a scheduled-payment ledger.
  function monthEndForecast(state, asOf = new Date()) {
    const today = new Date(asOf);
    today.setHours(0, 0, 0, 0);
    const todayKey = dateKey(today);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthStartKey = dateKey(monthStart);
    const daysElapsed = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
    const totals = { income: 0, expenses: 0 };
    const activeDates = new Set();
    let sampleTransactions = 0;

    for (const tx of state.transactions || []) {
      const date = String(tx.date || "");
      if (date < monthStartKey || date > todayKey || !isFinanciallyEffective(tx)) continue;
      if (tx.type !== "income" && tx.type !== "expense") continue;
      const amount = convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, state.settings.baseCurrency, tx.fxRate);
      if (!amount) continue;
      totals[tx.type === "income" ? "income" : "expenses"] += amount;
      activeDates.add(date);
      sampleTransactions++;
    }

    const currentBalance = netWorth(state, balancesAt(state, today), state.settings.baseCurrency);
    const dailyIncome = totals.income / daysElapsed;
    const dailyExpenses = totals.expenses / daysElapsed;
    const projectedIncome = dailyIncome * daysRemaining;
    const projectedExpenses = dailyExpenses * daysRemaining;
    const projectedNet = projectedIncome - projectedExpenses;
    const activeDays = activeDates.size;
    const confidence = sampleTransactions >= 12 && activeDays >= 15 ? "High"
      : sampleTransactions >= 5 && activeDays >= 7 ? "Moderate" : "Low";

    return {
      currency: state.settings.baseCurrency,
      currentBalance,
      incomeToDate: totals.income,
      expensesToDate: totals.expenses,
      projectedIncome,
      projectedExpenses,
      projectedNet,
      projectedBalance: currentBalance + projectedNet,
      daysElapsed,
      daysRemaining,
      monthEndDate: dateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
      activeDays,
      sampleTransactions,
      confidence,
      method: "month-to-date daily run rate"
    };
  }

  function goalContributionHistory(state, goal) {
    const accountIds = new Set(goal.accountIds || []);
    const rows = [];
    for (const tx of state.transactions || []) {
      if (!isFinanciallyEffective(tx)) continue;
      const sourceIncluded = accountIds.has(tx.sourceAccountId);
      const destinationIncluded = accountIds.has(tx.destinationAccountId);
      if (!sourceIncluded && !destinationIncluded) continue;

      let value = 0;
      if (tx.type === "income" && sourceIncluded) {
        value += convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "expense" && sourceIncluded) {
        value -= convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "withdrawal" && sourceIncluded) {
        value -= convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "adjustment" && sourceIncluded) {
        value += adjustmentDelta(tx);
        value = convert(state, value, tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "transfer") {
        // fxRate describes source currency → received currency, not source → goal currency.
        // Convert each actual account leg independently into the goal currency so fees,
        // spread and cross-currency valuation remain visible in the net contribution.
        if (sourceIncluded) value -= convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, goal.currency);
        if (destinationIncluded) {
          const received = tx.receivedAmount != null ? Math.abs(Number(tx.receivedAmount) || 0) : convert(state, Math.abs(Number(tx.amount) || 0), tx.currency, tx.receivedCurrency || tx.currency, tx.fxRate);
          value += convert(state, received, tx.receivedCurrency || tx.currency, goal.currency);
        }
      }
      if (value) rows.push({ date: tx.date, value });
    }
    return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function goalProjection(state, goal, asOf = new Date()) {
    const progress = goalProgress(state, goal);
    if (goal.status === "completed" || progress.remaining <= 0) {
      return { ...progress, daysRemaining: 0, dailyRequired: 0, weeklyRequired: 0, projectedDays: 0, projectedDate: null, pace: 0, onTrack: true };
    }
    const today = new Date(asOf);
    today.setHours(0, 0, 0, 0);
    const deadline = goal.deadline ? new Date(goal.deadline + "T00:00:00") : null;
    const daysRemaining = deadline ? Math.max(0, Math.ceil((deadline - today) / DAY)) : null;
    const dailyRequired = daysRemaining > 0 ? progress.remaining / daysRemaining : null;
    const history = goalContributionHistory(state, goal);
    const since = new Date(today);
    since.setDate(since.getDate() - 30);
    const recent = history.filter(item => new Date(item.date + "T00:00:00") >= since);
    const recentNet = recent.reduce((sum, item) => sum + item.value, 0);
    const pace = recentNet > 0 ? recentNet / 30 : 0;
    const projectedDays = pace > 0 ? Math.ceil(progress.remaining / pace) : null;
    const projectedDate = projectedDays != null
      ? dateKey(new Date(today.getTime() + projectedDays * DAY))
      : null;
    return {
      ...progress,
      daysRemaining,
      dailyRequired,
      weeklyRequired: dailyRequired == null ? null : dailyRequired * 7,
      projectedDays,
      projectedDate,
      pace,
      onTrack: dailyRequired == null ? true : pace >= dailyRequired
    };
  }

  function snapshot(state, asOf = new Date()) {
    const date = dateKey(new Date(asOf));
    const balances = balancesAt(state, { date, createdAt: Number.MAX_SAFE_INTEGER });
    const base = state.settings.baseCurrency;
    const rates = clone(state.settings.fx?.rates || {});
    return {
      id: date + ":" + base,
      date,
      capturedAt: Date.now(),
      baseCurrency: base,
      value: netWorth(state, balances, base),
      balances: balances.filter(a => !a.archived).map(a => ({ accountId: a.id, balance: a.balance, currency: a.currency })),
      rates
    };
  }

  function recordDailySnapshot(state, asOf = new Date()) {
    if (!Array.isArray(state.snapshots)) state.snapshots = [];
    const next = snapshot(state, asOf);
    const index = state.snapshots.findIndex(item => item.date === next.date && item.baseCurrency === next.baseCurrency);
    if (index >= 0) state.snapshots[index] = next;
    else state.snapshots.push(next);
    state.snapshots.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (state.snapshots.length > 730) state.snapshots = state.snapshots.slice(-730);
    return next;
  }

  function historicalNetWorth(state, limit = 90) {
    const rows = Array.isArray(state.snapshots) ? state.snapshots.slice() : [];
    const base = state.settings.baseCurrency;
    const compatible = rows.filter(s => s.baseCurrency === base).slice(-limit);
    if (compatible.length) {
      const currentRates = state.settings?.fx?.rates || {};
      return compatible.map(item => {
        if (!Array.isArray(item.balances) || !item.balances.length) return item;
        let value = 0;
        for (const balance of item.balances) {
          const currency = balance.currency || base;
          const resolved = rateFromTable(currentRates, currency, base, base);
          if (resolved == null) return { ...item, recordedValue: item.value, valuationBasis: "historical_rates" };
          value += (Number(balance.balance) || 0) * resolved;
        }
        return { ...item, recordedValue: item.value, value, valuationBasis: "current_rates" };
      });
    }
    return [snapshot(state)];
  }

  function activeAccounts(state) {
    return (state.accounts || []).filter(account => !account.archived);
  }

  function relatedAccounts(state, context = {}) {
    const accounts = activeAccounts(state);
    if (context.scope === "account" && context.accountId) {
      return accounts.filter(account => account.id === context.accountId);
    }
    if (context.scope === "goal" && context.goalId) {
      const goal = (state.goals || []).find(item => item.id === context.goalId);
      const ids = new Set(goal?.accountIds || []);
      return accounts.filter(account => ids.has(account.id));
    }
    if (context.scope === "transaction" && context.transactionId) {
      const tx = (state.transactions || []).find(item => item.id === context.transactionId);
      const ids = new Set([tx?.sourceAccountId, tx?.destinationAccountId].filter(Boolean));
      return accounts.filter(account => ids.has(account.id));
    }
    return accounts;
  }

  function relatedGoals(state, context = {}) {
    const goals = (state.goals || []).filter(goal => goal.status !== "completed");
    if (context.scope === "goal" && context.goalId) {
      const selected = goals.find(goal => goal.id === context.goalId);
      if (!selected) return [];
      const accountIds = new Set(selected.accountIds || []);
      return goals.filter(goal => goal.id === context.goalId || (goal.accountIds || []).some(id => accountIds.has(id)));
    }
    if (context.scope === "account" && context.accountId) {
      return goals.filter(goal => (goal.accountIds || []).includes(context.accountId));
    }
    if (context.scope === "transaction" && context.transactionId) {
      const tx = (state.transactions || []).find(item => item.id === context.transactionId);
      const explicit = new Set(tx?.linkedGoalIds || []);
      const accountIds = new Set([tx?.sourceAccountId, tx?.destinationAccountId].filter(Boolean));
      return goals.filter(goal => explicit.has(goal.id) || (goal.accountIds || []).some(id => accountIds.has(id)));
    }
    return goals;
  }

  function relatedTransactions(state, context = {}) {
    const transactions = (state.transactions || []).slice().sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) || Number(b.createdAt) - Number(a.createdAt)
    );
    if (context.scope === "transaction" && context.transactionId) {
      return transactions.filter(tx => tx.id === context.transactionId);
    }
    if (context.scope === "account" && context.accountId) {
      return transactions.filter(tx => tx.sourceAccountId === context.accountId || tx.destinationAccountId === context.accountId);
    }
    if (context.scope === "goal" && context.goalId) {
      const goal = (state.goals || []).find(item => item.id === context.goalId);
      const ids = new Set(goal?.accountIds || []);
      return transactions.filter(tx =>
        (tx.linkedGoalIds || []).includes(context.goalId) ||
        ids.has(tx.sourceAccountId) ||
        ids.has(tx.destinationAccountId)
      );
    }
    return transactions;
  }

  function accountExposure(state, accountId = null) {
    const accounts = activeAccounts(state);
    const totalBase = netWorth(state, accounts, state.settings.baseCurrency);
    const rows = accounts.reduce((map, account) => {
      const baseValue = convert(state, account.balance, account.currency, state.settings.baseCurrency);
      const row = map.get(account.currency) || { currency: account.currency, balance: 0, baseValue: 0, accounts: 0 };
      row.balance += Number(account.balance) || 0;
      row.baseValue += baseValue;
      row.accounts += 1;
      map.set(account.currency, row);
      return map;
    }, new Map());
    const selected = accountId ? accounts.find(account => account.id === accountId) : null;
    return {
      totalBase,
      selectedBase: selected ? convert(state, selected.balance, selected.currency, state.settings.baseCurrency) : 0,
      selectedShare: selected && totalBase ? convert(state, selected.balance, selected.currency, state.settings.baseCurrency) / totalBase * 100 : 0,
      currencies: [...rows.values()].sort((a, b) => b.baseValue - a.baseValue)
    };
  }

  function goalNetwork(state, goalId) {
    const goal = (state.goals || []).find(item => item.id === goalId);
    if (!goal) return { goal: null, accounts: [], transactions: [] };
    const context = { scope: "goal", goalId };
    return {
      goal,
      accounts: relatedAccounts(state, context),
      transactions: relatedTransactions(state, context)
    };
  }

  function transactionNetwork(state, transactionId) {
    const context = { scope: "transaction", transactionId };
    const tx = (state.transactions || []).find(item => item.id === transactionId) || null;
    return {
      transaction: tx,
      accounts: relatedAccounts(state, context),
      goals: relatedGoals(state, context)
    };
  }

  function goalHealth(state, goal, asOf = new Date()) {
    if (!goal) return { key: "unknown", label: "Unknown", tone: "neutral", reason: "Goal not found." };
    const projection = goalProjection(state, goal, asOf);
    if (goal.status === "completed" || projection.remaining <= 0) return { key: "complete", label: "Complete", tone: "positive", reason: "Target reached." };
    const history = goalContributionHistory(state, goal);
    const today = new Date(asOf); today.setHours(0,0,0,0);
    const since = new Date(today); since.setDate(since.getDate() - 14);
    const recent = history.filter(item => new Date(item.date + "T00:00:00") >= since);
    const recentNet = recent.reduce((sum,item) => sum + item.value, 0);
    if (!history.length || recentNet <= 0) return { key: "inactive", label: "No recent progress", tone: "warning", reason: "No positive net contribution has been recorded recently." };
    if (projection.dailyRequired != null && projection.pace >= projection.dailyRequired) return { key: "ahead", label: "On track", tone: "positive", reason: "Recent contribution pace meets the pace required for the deadline." };
    if (projection.dailyRequired != null && projection.pace > 0) return { key: "attention", label: "Needs attention", tone: "warning", reason: "Recent contribution pace is below the pace required for the deadline." };
    return { key: "active", label: "Active", tone: "neutral", reason: "The goal has recent contribution activity." };
  }

  function goalTrajectory(state, goal, asOf = new Date(), days = 30) {
    if (!goal) return { points: [], actualNet: 0, requiredNet: 0 };
    const today = new Date(asOf);
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - Math.max(1, days - 1));
    const end = new Date(today);
    const history = goalContributionHistory(state, goal).filter(item => {
      const date = new Date(item.date + "T00:00:00");
      return date >= start && date <= end;
    });
    const byDate = new Map();
    history.forEach(item => byDate.set(item.date, (byDate.get(item.date) || 0) + item.value));
    const points = [];
    let cumulative = 0;
    for (let i = 0; i < days; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dateKey(date);
      cumulative += byDate.get(key) || 0;
      points.push({ date: key, value: cumulative });
    }
    const progress = goalProgress(state, goal);
    const projection = goalProjection(state, goal, asOf);
    const actualNet = cumulative;
    const requiredNet = projection.dailyRequired != null ? projection.dailyRequired * Math.max(0, days - 1) : 0;
    return { points, actualNet, requiredNet };
  }

  function goalIntelligence(state, goal, asOf = new Date()) {
    if (!goal) return {
      goal: null,
      progress: { current: 0, target: 0, remaining: 0, pct: 0 },
      projection: null,
      accounts: [],
      transactions: [],
      linkedTransactions: [],
      inferredTransactions: [],
      history: []
    };
    const context = { scope: "goal", goalId: goal.id };
    const transactions = relatedTransactions(state, context).filter(tx => tx.status !== "needs_review");
    const linkedTransactions = transactions.filter(tx => (tx.linkedGoalIds || []).includes(goal.id));
    const linkedIds = new Set(linkedTransactions.map(tx => tx.id));
    return {
      goal,
      progress: goalProgress(state, goal),
      projection: goalProjection(state, goal, asOf),
      accounts: relatedAccounts(state, context),
      transactions,
      linkedTransactions,
      inferredTransactions: transactions.filter(tx => !linkedIds.has(tx.id)),
      history: goalContributionHistory(state, goal)
    };
  }

  // Detect likely recurring expenses without changing or creating transactions.
  // Groups are deliberately conservative: three effective observations, a stable
  // amount, and a recognisable cadence are required before a pattern is surfaced.
  function recurringExpenses(state, asOf = new Date(), lookbackDays = 400) {
    const end = new Date(asOf);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(30, Number(lookbackDays) || 400));
    const endKey = dateKey(end);
    const startKey = dateKey(start);
    const groups = new Map();

    for (const tx of state.transactions || []) {
      if (tx.type !== "expense" || !isFinanciallyEffective(tx)) continue;
      const date = String(tx.date || "");
      if (date < startKey || date > endKey || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) continue;
      const amount = Math.abs(Number(tx.amount) || 0);
      if (!amount) continue;
      const label = String(tx.note || tx.category || "Uncategorised expense")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
      const accountId = tx.sourceAccountId || null;
      const currency = tx.currency || state.settings.baseCurrency;
      const key = [label, accountId || "", currency].join("|");
      if (!groups.has(key)) groups.set(key, { label, accountId, currency, rows: [] });
      groups.get(key).rows.push({ date, amount, id: tx.id });
    }

    const median = values => {
      const sorted = values.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const patterns = [];
    for (const group of groups.values()) {
      const rows = group.rows.sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length < 3) continue;
      const typicalAmount = median(rows.map(row => row.amount));
      const stableRows = rows.filter(row => Math.abs(row.amount - typicalAmount) <= typicalAmount * 0.2);
      if (stableRows.length < 3) continue;
      const gaps = [];
      for (let i = 1; i < stableRows.length; i++) {
        const a = new Date(stableRows[i - 1].date + "T12:00:00");
        const b = new Date(stableRows[i].date + "T12:00:00");
        gaps.push(Math.round((b - a) / DAY));
      }
      const typicalGap = median(gaps);
      const cadence = typicalGap >= 6 && typicalGap <= 8 ? "Weekly"
        : typicalGap >= 12 && typicalGap <= 16 ? "Every 2 weeks"
        : typicalGap >= 25 && typicalGap <= 35 ? "Monthly"
        : typicalGap >= 80 && typicalGap <= 100 ? "Quarterly" : null;
      if (!cadence || gaps.some(gap => Math.abs(gap - typicalGap) > Math.max(3, typicalGap * 0.25))) continue;
      const last = stableRows[stableRows.length - 1];
      const next = new Date(last.date + "T12:00:00");
      next.setDate(next.getDate() + Math.round(typicalGap));
      patterns.push({
        label: group.label,
        accountId: group.accountId,
        currency: group.currency,
        cadence,
        averageAmount: stableRows.reduce((sum, row) => sum + row.amount, 0) / stableRows.length,
        occurrences: stableRows.length,
        lastDate: last.date,
        nextDate: dateKey(next),
        transactionIds: stableRows.map(row => row.id).filter(Boolean)
      });
    }
    return patterns.sort((a, b) => b.averageAmount - a.averageAmount);
  }

  // Flag unusually large expenses against the user's own recent history.
  // Requires four earlier comparable expenses; never mutates transaction data.
  function unusualSpending(state, asOf = new Date(), lookbackDays = 30, baselineDays = 120) {
    const end = new Date(asOf);
    end.setHours(0, 0, 0, 0);
    const endKey = dateKey(end);
    const alertStart = new Date(end);
    alertStart.setDate(alertStart.getDate() - Math.max(1, Number(lookbackDays) || 30));
    const baselineStart = new Date(end);
    baselineStart.setDate(baselineStart.getDate() - Math.max(30, Number(baselineDays) || 120));
    const alertKey = dateKey(alertStart);
    const baselineKey = dateKey(baselineStart);
    const groups = new Map();
    const expenses = [];

    for (const tx of state.transactions || []) {
      if (tx.type !== "expense" || !isFinanciallyEffective(tx)) continue;
      const date = String(tx.date || "");
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || date < baselineKey || date > endKey) continue;
      const amount = Math.abs(Number(tx.amount) || 0);
      if (!amount) continue;
      const category = String(tx.category || "Uncategorised").trim() || "Uncategorised";
      const currency = tx.currency || state.settings.baseCurrency;
      const accountId = tx.sourceAccountId || null;
      const key = [category.toLowerCase(), accountId || "", currency].join("|");
      const row = { id: tx.id, date, amount, category, currency, accountId, note: tx.note || "" };
      expenses.push(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const median = values => {
      const sorted = values.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const alerts = [];
    for (const row of expenses) {
      if (row.date < alertKey) continue;
      const key = [row.category.toLowerCase(), row.accountId || "", row.currency].join("|");
      const history = (groups.get(key) || []).filter(item =>
        item.date < row.date && item.date >= baselineKey
      );
      if (history.length < 4) continue;
      const typicalAmount = median(history.map(item => item.amount));
      const deviations = history.map(item => Math.abs(item.amount - typicalAmount));
      const medianDeviation = median(deviations);
      const threshold = Math.max(typicalAmount * 2, typicalAmount + medianDeviation * 3);
      if (row.amount < threshold) continue;
      alerts.push({
        transactionId: row.id || null,
        date: row.date,
        category: row.category,
        note: row.note,
        currency: row.currency,
        accountId: row.accountId,
        amount: row.amount,
        typicalAmount,
        multiple: typicalAmount ? row.amount / typicalAmount : null,
        baselineCount: history.length
      });
    }
    return alerts.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
  }

  window.OmniPocketEngine = {
    DAY, rate, convert, fxFreshness, valuationCoverage, balancesAt, netWorth, goalProgress,
    spendingSummary, flowSummary, recurringExpenses, unusualSpending, learnedCategorySuggestion, financialRunway, monthEndForecast, goalProjection, goalContributionHistory, snapshot,
    recordDailySnapshot, historicalNetWorth, fxHistory, recordFxSnapshot, wealthChange,
    relatedAccounts, relatedGoals, relatedTransactions, accountExposure,
    goalNetwork, transactionNetwork, goalIntelligence, goalTrajectory, goalHealth
  };
})();
