/* OmniPocket — shared context/event bus
 * Widgets and domain features communicate through named events instead of
 * tightly coupling themselves to each other.
 */
(() => {
  const listeners = new Map();
  let sequence = 0;
  let context = { scope: "global", accountId: null, goalId: null, transactionId: null, reason: "init" };
  const history = [];
  const MAX_HISTORY = 12;

  function contextKey(value) {
    return [value.scope || "global", value.accountId || "", value.goalId || "", value.transactionId || ""].join(":");
  }

  function pushHistory(value) {
    if (!value || value.scope === "global") return;
    const key = contextKey(value);
    const last = history[history.length - 1];
    if (last && contextKey(last) === key) return;
    history.push({ ...value });
    if (history.length > MAX_HISTORY) history.shift();
  }

  function getHistory() { return history.map(item => ({ ...item })); }

  function on(event, handler) {
    if (typeof handler !== "function") return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function once(event, handler) {
    let off = () => {};
    off = on(event, payload => {
      off();
      handler(payload);
    });
    return off;
  }

  function emit(event, detail = {}) {
    const payload = {
      event,
      sequence: ++sequence,
      at: Date.now(),
      ...detail
    };
    const exact = listeners.get(event);
    exact?.forEach(handler => {
      try { handler(payload); } catch (error) { console.error("OmniPocket bus handler failed:", event, error); }
    });
    listeners.get("*")?.forEach(handler => {
      try { handler(payload); } catch (error) { console.error("OmniPocket bus wildcard handler failed:", error); }
    });
    return payload;
  }

  function getContext() { return { ...context }; }

  function setContext(patch = {}, reason = "context") {
    const previous = { ...context };
    const next = { ...context, ...patch, reason };
    if (next.accountId) next.scope = "account";
    else if (next.goalId) next.scope = "goal";
    else if (next.transactionId) next.scope = "transaction";
    else next.scope = "global";
    const changed = Object.keys(next).some(key => next[key] !== context[key]);
    context = next;
    if (changed && next.scope !== "global") pushHistory(next);
    if (changed) {
      emit("context:changed", { context: getContext(), previous, history: getHistory() });
      if (next.accountId && next.accountId !== previous.accountId) emit("account:selected", { context: getContext(), accountId: next.accountId });
      if (next.goalId && next.goalId !== previous.goalId) emit("goal:selected", { context: getContext(), goalId: next.goalId });
      if (next.transactionId && next.transactionId !== previous.transactionId) emit("transaction:selected", { context: getContext(), transactionId: next.transactionId });
    }
    return getContext();
  }

  function selectAccount(accountId) { return setContext({ scope: "account", accountId: accountId || null, goalId: null, transactionId: null }, "account-selected"); }
  function selectGoal(goalId) { return setContext({ scope: "goal", goalId: goalId || null, transactionId: null }, "goal-selected"); }
  function selectTransaction(transactionId, accountId = null) { return setContext({ scope: "transaction", transactionId: transactionId || null, accountId: accountId || null, goalId: null }, "transaction-selected"); }
  function clearContext(reason = "context-cleared") {
    const previous = { ...context };
    context = { scope: "global", accountId: null, goalId: null, transactionId: null, reason };
    emit("context:cleared", { context: getContext(), previous });
    emit("context:changed", { context: getContext(), previous });
    return getContext();
  }

  function restoreHistory(index = 0) {
    const targetIndex = Math.max(0, Math.min(Number(index) || 0, history.length));
    if (targetIndex === 0) {
      history.length = 0;
      return clearContext("context-history");
    }
    const target = history[targetIndex - 1];
    if (!target) return getContext();
    history.splice(targetIndex);
    const previous = { ...context };
    context = { ...target, reason: "context-history" };
    emit("context:changed", { context: getContext(), previous, history: getHistory() });
    return getContext();
  }

  function goBack() {
    if (history.length > 1) return restoreHistory(history.length - 1);
    return restoreHistory(0);
  }

  function clear(event = null) {
    if (event) listeners.delete(event);
    else listeners.clear();
  }

  window.OmniPocketBus = Object.freeze({ on, once, emit, clear, getContext, getHistory, setContext, selectAccount, selectGoal, selectTransaction, clearContext, restoreHistory, goBack });
})();
