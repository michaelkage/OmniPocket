/* OmniPocket architecture services. Loaded after the legacy UI layers so it can
 * normalize existing records without changing the public UI contract. */
(function(){
  const Bank = window.OmniPocketBank;
  function currentState(){ return window.omnipocketState || null; }

  function inferProvenance(t){
    if (t?.provenance?.source) return t.provenance;
    if (t?.external?.provider) return Bank.provenance("bank_sync", { provider:t.external.provider, providerTransactionId:t.external.providerTransactionId || null });
    if (t?.fxSource === "bank_import") return Bank.provenance("bank_sync");
    if (t?.type === "adjustment") return Bank.provenance("adjustment");
    if (t?.type === "transfer") return Bank.provenance("transfer");
    return Bank.provenance("manual");
  }

  function ensureProvenance(state){
    if (!state) return 0;
    let changed = 0;
    for(const t of state.transactions || []){
      const p = inferProvenance(t);
      if(JSON.stringify(t.provenance) !== JSON.stringify(p)){ t.provenance = p; changed++; }
    }
    for(const a of state.accounts || []){
      if(!a.identity) {
        a.identity = {
          provider: a.connection?.provider || null,
          providerAccountId: a.connection?.providerAccountId || null,
          institution: a.institution || "",
          displayName: a.name || "",
          last4: a.connection?.last4 || null
        };
        changed++;
      }
      if(a.connection?.lastSyncedAt){
        const f=Bank.freshness(a.connection.lastSyncedAt);
        if(a.connection.syncStatus === "healthy" && f.state === "stale"){ a.connection.syncStatus="stale"; changed++; }
      }
    }
    return changed;
  }

  function reconciliationReport(state){
    const reports=[];
    for(const a of state?.accounts || []){
      if(a.connection?.provider && a.connection.providerBalance != null){
        reports.push(Bank.reconcile(a,a.connection.providerBalance,a.balance));
      }
    }
    return reports;
  }

  function makeBackup(state){
    const data = structuredClone(state);
    const payload = { format:"omnipocket-backup", version:2, schemaVersion:data.schemaVersion || null, exportedAt:new Date().toISOString(), data };
    const json=JSON.stringify(payload);
    let hash=0;
    for(let i=0;i<json.length;i++) hash=((hash<<5)-hash+json.charCodeAt(i))|0;
    payload.checksum=String(hash >>> 0);
    return payload;
  }

  function validateBackup(payload){
    if(!payload || payload.format!=="omnipocket-backup" || !payload.data) return {ok:false,error:"Invalid OmniPocket backup format."};
    if(!payload.checksum) return {ok:false,error:"Backup checksum missing."};
    const copy={...payload}; delete copy.checksum;
    const json=JSON.stringify(copy); let hash=0;
    for(let i=0;i<json.length;i++) hash=((hash<<5)-hash+json.charCodeAt(i))|0;
    return {ok:String(hash >>> 0)===String(payload.checksum), schemaVersion:payload.schemaVersion, exportedAt:payload.exportedAt};
  }

  function diagnostics(){
    const state=currentState();
    const client=window.getSupabaseClient?.();
    return {
      build: window.OMNIPOCKET_BUILD || "unknown",
      online:navigator.onLine,
      serviceWorker:"serviceWorker" in navigator,
      indexedDB:"indexedDB" in window,
      supabaseLoaded:Boolean(window.supabase),
      supabaseConfigured:Boolean(client),
      bank:Bank.diagnoseState(state),
      reconciliation:reconciliationReport(state),
      fx:state?.settings?.fx ? {provider:state.settings.fx.provider,updatedAt:state.settings.fx.updatedAt,base:state.settings.fx.base} : null
    };
  }

  window.OmniPocketArchitecture={ensureProvenance,reconciliationReport,makeBackup,validateBackup,diagnostics};
  document.addEventListener("DOMContentLoaded",()=>{
    const state=currentState();
    if(!state) return;
    const changed=ensureProvenance(state);
    if(changed && typeof window.saveState==="function") window.saveState();
  });
})();