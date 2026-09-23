/* OmniPocket — shared context/event bus
 * Widgets and domain features communicate through named events instead of
 * tightly coupling themselves to each other.
 */
(() => {
  const listeners = new Map();
  let sequence = 0;

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

  function clear(event = null) {
    if (event) listeners.delete(event);
    else listeners.clear();
  }

  window.OmniPocketBus = Object.freeze({ on, once, emit, clear });
})();
