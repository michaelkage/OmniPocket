/* OmniPocket — domain/wealth engine
 * Pure financial calculations live here so UI code can be replaced without
 * changing the accounting model.
 */
(() => {
  const DAY = 86400000;

  const clone = value => JSON.parse(JSON.stringify(value));

  function accountMap(state) {
    return new Map((state.accounts || []).map(account => [account.id, account]));
  }

  function rate(state, from, to, overrideRate = null) {
    if (from === to) return 1;
    if (Number(overrideRate) > 0) return Number(overrideRate);
    const table = state.settings?.fx?.rates || {};
    const direct = Number(table?.[from]?.[to]);
    return direct > 0 ? direct : 1;
  }

  function convert(state, value, from, to, overrideRate = null) {
    const amount = Number(value) || 0;
    return amount * rate(state, from, to, overrideRate);
  }

  function adjustmentDelta(tx) {
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
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const totals = {};
    let total = 0;
    let income = 0;
    for (const tx of state.transactions || []) {
      if (String(tx.date) < cutoffDate) continue;
      if (tx.type === "expense") {
        const value = convert(state, tx.amount, tx.currency, state.settings.baseCurrency, tx.fxRate);
        const key = tx.category || "Other";
        totals[key] = (totals[key] || 0) + value;
        total += value;
      } else if (tx.type === "income") {
        income += convert(state, tx.amount, tx.currency, state.settings.baseCurrency, tx.fxRate);
      }
    }
    return { totals, total, income, days };
  }

  function flowSummary(state, days = 30, asOf = new Date()) {
    const cutoff = new Date(asOf);
    cutoff.setDate(cutoff.getDate() - days + 1);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const result = { income: 0, expenses: 0, transfers: 0, withdrawals: 0, adjustments: 0, count: 0 };
    for (const tx of state.transactions || []) {
      if (String(tx.date) < cutoffDate || tx.status === "needs_review") continue;
      const amount = convert(state, tx.amount, tx.currency, state.settings.baseCurrency, tx.fxRate);
      result.count++;
      if (tx.type === "income") result.income += amount;
      if (tx.type === "expense") result.expenses += amount;
      if (tx.type === "transfer") result.transfers += amount;
      if (tx.type === "withdrawal") result.withdrawals += amount;
      if (tx.type === "adjustment") result.adjustments += amount;
    }
    result.netFlow = result.income - result.expenses;
    return result;
  }

  function goalContributionHistory(state, goal) {
    const accountIds = new Set(goal.accountIds || []);
    const rows = [];
    for (const tx of state.transactions || []) {
      if (tx.status === "needs_review") continue;
      const sourceIncluded = accountIds.has(tx.sourceAccountId);
      const destinationIncluded = accountIds.has(tx.destinationAccountId);
      if (!sourceIncluded && !destinationIncluded) continue;

      let value = 0;
      if (tx.type === "income" && sourceIncluded) {
        value += convert(state, tx.amount, tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "expense" && sourceIncluded) {
        value -= convert(state, tx.amount, tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "withdrawal" && sourceIncluded) {
        value -= convert(state, tx.amount, tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "adjustment" && sourceIncluded) {
        value += adjustmentDelta(tx);
        value = convert(state, value, tx.currency, goal.currency, tx.fxRate);
      } else if (tx.type === "transfer") {
        if (sourceIncluded) value -= convert(state, tx.amount, tx.currency, goal.currency, tx.fxRate);
        if (destinationIncluded) {
          const received = tx.receivedAmount != null ? tx.receivedAmount : convert(state, tx.amount, tx.currency, tx.receivedCurrency || tx.currency, tx.fxRate);
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
      ? new Date(today.getTime() + projectedDays * DAY).toISOString().slice(0, 10)
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
    const date = new Date(asOf).toISOString().slice(0, 10);
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
    if (compatible.length) return compatible;
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
      const key = date.toISOString().slice(0, 10);
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

  window.OmniPocketEngine = {
    DAY, rate, convert, balancesAt, netWorth, goalProgress,
    spendingSummary, flowSummary, goalProjection, snapshot,
    recordDailySnapshot, historicalNetWorth,
    relatedAccounts, relatedGoals, relatedTransactions, accountExposure,
    goalNetwork, transactionNetwork, goalIntelligence, goalTrajectory, goalHealth
  };
})();
