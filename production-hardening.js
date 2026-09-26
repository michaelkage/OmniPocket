/* OmniPocket production hardening — completes operational gaps without changing accounting semantics. */
(() => {
  "use strict";
  const QUEUE_KEY = "omnipocket.offline.queue.v1";
  const $ = id => document.getElementById(id);
  const toast = message => window.OmniPocketV1?.toast ? window.OmniPocketV1.toast(message) : console.info(message);

  function readQueue() {
    try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); return Array.isArray(q) ? q : []; }
    catch { return []; }
  }
  function writeQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50)));
    updateQueueBadge(q.length);
  }
  function updateQueueBadge(count = readQueue().length) {
    let el = $("offlineQueueStatus");
    if (!el) {
      el = document.createElement("span");
      el.id = "offlineQueueStatus";
      el.className = "status-chip";
      const target = document.querySelector(".dashboard-toolbar .dashboard-toolbar-actions") || document.querySelector(".dashboard-toolbar");
      target?.appendChild(el);
    }
    el.textContent = count ? count + " queued" : "Synced";
    el.title = count ? "Bank refreshes waiting for a connection" : "No offline bank refreshes queued";
  }

  function queueBankSync(accountId) {
    if (!accountId) return;
    const q = readQueue();
    if (!q.some(x => x.type === "bank-sync" && x.accountId === accountId)) {
      q.push({ id: crypto.randomUUID?.() || String(Date.now()), type: "bank-sync", accountId, createdAt: Date.now() });
      writeQueue(q);
    }
  }

  async function flushQueue() {
    if (!navigator.onLine) return;
    const q = readQueue();
    if (!q.length) { updateQueueBadge(0); return; }
    const remaining = [];
    for (const job of q) {
      try {
        if (job.type === "bank-sync") {
          const a = state.accounts.find(x => x.id === job.accountId);
          if (!a || a.archived || a.connection?.status !== "connected") continue;
          if (a.connection.provider === "mono" && a.connection.providerAccountId) {
            await syncMonoAccount(a.connection.providerAccountId, a.name, a.id);
          } else if (a.connection.provider === "mock") {
            await syncMockBankAccount(a.id);
          }
        }
      } catch (error) {
        remaining.push(job);
        console.warn("Queued OmniPocket job failed:", error);
      }
    }
    writeQueue(remaining);
    if (!remaining.length) toast("Offline bank refreshes completed.");
    render();
  }

  async function requestSyncWithOfflineFallback(id, originalRequestSync) {
    if (!navigator.onLine) {
      queueBankSync(id);
      toast("Offline — bank refresh queued.");
      return false;
    }
    try {
      await originalRequestSync(id);
      return true;
    } catch (error) {
      if (!navigator.onLine) queueBankSync(id);
      throw error;
    }
  }

  async function upgradeAnonymousAccount() {
    const client = getSupabaseClient();
    const { data: { user } = {} } = await client.auth.getUser();
    if (!user) throw new Error("No active OmniPocket session.");
    if (!user.is_anonymous) {
      toast("This session is already linked to an account.");
      return;
    }
    const email = prompt("Email to permanently link this OmniPocket account:");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return;
    const { error } = await client.auth.updateUser({ email: email.trim() });
    if (error) throw error;
    localStorage.setItem("omnipocket.accountUpgradePending", "1");
    toast("Confirmation email sent. Confirm it to keep this OmniPocket account.");
    render();
  }

  function installAccountUpgrade() {
    const settings = $("pageMore")?.querySelector(".settings-list");
    if (!settings || $("upgradeAccountButton")) return;
    const b = document.createElement("button");
    b.id = "upgradeAccountButton";
    b.textContent = "Link this device to my email";
    b.onclick = () => upgradeAnonymousAccount().catch(e => toast(e.message || "Could not link account."));
    settings.appendChild(b);
  }

  async function loadOcrEngine() {
    if (window.Tesseract) return window.Tesseract;
    if (window.__omnipocketTesseractPromise) return window.__omnipocketTesseractPromise;
    window.__omnipocketTesseractPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      script.async = true;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => reject(new Error("OCR engine could not be loaded. Check your connection."));
      document.head.appendChild(script);
    });
    return window.__omnipocketTesseractPromise;
  }

  function extractReceiptHints(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    const amountMatches = [...clean.matchAll(/(?:₦|NGN|Naira)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|\b([0-9][0-9,]{2,}(?:\.[0-9]{1,2})?)\b/gi)]
      .map(m => Number(String(m[1] || m[2]).replace(/,/g, "")))
      .filter(Number.isFinite)
      .sort((a,b) => b-a);
    const date = clean.match(/\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]20\d{2})\b/)?.[0] || "";
    const category = typeof suggestTransactionCategory === "function" ? suggestTransactionCategory({description: clean}) : null;
    return { text: clean, amount: amountMatches[0] || 0, date, category: category?.category || "" };
  }

  async function runReceiptOcr(file) {
    const status = $("receiptStatus");
    if (!file) return;
    if (!file.type.startsWith("image/")) { if(status) status.textContent = "Choose an image file."; return; }
    if (status) status.textContent = "Loading local OCR engine…";
    try {
      const Tesseract = await loadOcrEngine();
      const worker = await Tesseract.createWorker("eng");
      const result = await worker.recognize(file);
      await worker.terminate();
      const hints = extractReceiptHints(result?.data?.text || "");
      if (status) status.innerHTML = hints.amount
        ? "OCR found <strong>" + escapeHtml(String(hints.amount)) + "</strong>" + (hints.category ? " · " + escapeHtml(hints.category) : "") + ". Review before logging."
        : "OCR completed, but no confident amount was found. Review the text manually.";
      const input = $("smartReceiptInput");
      if (input) input.dataset.ocrText = result?.data?.text || "";
      if (hints.amount && $("smartTextInput")) {
        $("smartTextInput").value = hints.text;
        if (typeof parseClipboardText === "function") parseClipboardText();
      }
    } catch (error) {
      console.warn("Receipt OCR failed:", error);
      if (status) status.textContent = error.message || "Receipt OCR failed. You can still enter the details manually.";
    }
  }

  function installReceiptOcr() {
    const input = $("smartReceiptInput");
    if (!input || input.dataset.ocrInstalled) return;
    input.dataset.ocrInstalled = "1";
    input.addEventListener("change", () => runReceiptOcr(input.files?.[0]));
  }

  function installNetworkState() {
    const update = () => {
      document.documentElement.dataset.network = navigator.onLine ? "online" : "offline";
      updateQueueBadge();
      if (navigator.onLine) flushQueue();
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  function installErrorGuard() {
    window.addEventListener("error", event => {
      console.error("OmniPocket runtime error:", event.error || event.message);
      toast("OmniPocket hit a UI error. Your saved data is still protected locally.");
    });
    window.addEventListener("unhandledrejection", event => {
      console.error("OmniPocket unhandled promise:", event.reason);
      toast("An operation failed. Check your connection and try again.");
    });
  }

  function installSyncQueueHooks() {
    const original = window.requestBankSync;
    if (typeof original !== "function" || window.__omnipocketQueueWrapped) return;
    window.__omnipocketQueueWrapped = true;
    window.requestBankSync = async id => requestSyncWithOfflineFallback(id, original);
    document.addEventListener("click", event => {
      const button = event.target.closest("[data-sync-account]");
      if (button && !navigator.onLine) {
        queueBankSync(button.dataset.syncAccount);
      }
    }, true);
  }

  function installStatusPanel() {
    const target = document.querySelector(".accounts-control-center .accounts-toolbar");
    if (!target || $("offlineSyncNotice")) return;
    const el = document.createElement("div");
    el.id = "offlineSyncNotice";
    el.className = "detail-callout";
    el.textContent = navigator.onLine
      ? "Connected mode: bank refreshes can run now."
      : "Offline mode: local balances remain available; bank refreshes are queued.";
    target.parentElement?.insertBefore(el, target);
  }

  window.OmniPocketProduction = {
    queueBankSync,
    flushQueue,
    upgradeAnonymousAccount,
    runReceiptOcr,
    queueSize: () => readQueue().length
  };

  window.addEventListener("load", () => {
    installAccountUpgrade();
    installReceiptOcr();
    installNetworkState();
    installErrorGuard();
    installSyncQueueHooks();
    installStatusPanel();
    updateQueueBadge();
    setTimeout(flushQueue, 1200);
  });
})();
