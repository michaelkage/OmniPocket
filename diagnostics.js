/* Lightweight diagnostics UI. Does not expose secrets. */
(function(){
  function escape(v){return String(v ?? "").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
  function openDiagnostics(){
    const d=window.OmniPocketArchitecture?.diagnostics?.();
    if(!d) return;
    let dialog=document.getElementById("omniDiagnosticsDialog");
    if(!dialog){
      dialog=document.createElement("dialog");
      dialog.id="omniDiagnosticsDialog";
      dialog.className="app-dialog";
      document.body.appendChild(dialog);
    }
    const rows=[
      ["Build",d.build],["Network",d.online?"Online":"Offline"],["IndexedDB",d.indexedDB?"Available":"Unavailable"],
      ["Supabase SDK",d.supabaseLoaded?"Loaded":"Missing"],["Connected banks",d.bank.connectedBanks],
      ["Healthy banks",d.bank.healthyBanks],["Stale banks",d.bank.staleBanks],["Sync errors",d.bank.erroredBanks],
      ["Review queue",d.bank.reviewQueue],["Pending bank transactions",d.bank.pendingBankTransactions]
    ];
    dialog.innerHTML='<div class="dialog-head"><div><span class="eyebrow">SYSTEM</span><h2>Diagnostics</h2><div class="muted">Safe operational checks — no secrets are included.</div></div><button class="icon-button" type="button">✕</button></div><div class="stack">'+rows.map(r=>'<div class="detail-callout"><strong>'+escape(r[0])+'</strong><span>'+escape(r[1])+'</span></div>').join("")+'</div><div class="dialog-actions"><button id="omniCopyDiagnostics">Copy report</button><button class="primary" type="button">Done</button></div>';
    dialog.querySelector(".icon-button").onclick=()=>dialog.close();
    dialog.querySelector(".primary").onclick=()=>dialog.close();
    dialog.querySelector("#omniCopyDiagnostics").onclick=async()=>{try{await navigator.clipboard.writeText(JSON.stringify(d,null,2));dialog.querySelector("#omniCopyDiagnostics").textContent="Copied";}catch{}};
    dialog.showModal();
  }
  window.OmniPocketDiagnostics={open:openDiagnostics};
  document.addEventListener("DOMContentLoaded",()=>{
    const topbar=document.querySelector(".topbar");
    if(!topbar || document.getElementById("omniDiagnosticsButton")) return;
    const b=document.createElement("button"); b.type="button"; b.id="omniDiagnosticsButton"; b.className="icon-button"; b.title="Diagnostics"; b.setAttribute("aria-label","Open diagnostics"); b.textContent="⌁"; b.onclick=openDiagnostics; topbar.appendChild(b);
  });
})();