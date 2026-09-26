/* OmniPocket v1 completion layer — phases 1-15 */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const base = () => state?.settings?.baseCurrency || "NGN";
  const currencies = ["NGN","USD","GBP","EUR"];

  function persist() { try { saveState(); } catch {} }

  function toast(message) {
    let el=$("opToast");
    if(!el){el=document.createElement("div");el.id="opToast";el.className="op-toast";document.body.appendChild(el);}
    el.textContent=message; el.classList.add("show"); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove("show"),2600);
  }

  function installOnboarding() {
    if(localStorage.getItem("omnipocket.onboarding.v1") || state.accounts.length || state.goals.length) return;
    const d=document.createElement("dialog"); d.id="opOnboarding"; d.className="app-dialog";
    d.innerHTML='<div class="dialog-head"><div><span class="eyebrow">WELCOME TO OMNIPOCKET</span><h2>Your wealth command center</h2><div class="muted">Set the basics now. You can change them later.</div></div></div><form class="form-grid" id="opOnboardingForm"><label>Base currency<select id="opBaseCurrency">'+currencies.map(c=>'<option>'+c+'</option>').join("")+'</select></label><label>Dashboard style<select id="opLayout"><option value="balanced">Balanced</option><option value="wealth">Wealth first</option><option value="quick">Quick actions first</option></select></label><label>Primary target <span class="muted">(optional)</span><input id="opTarget" type="number" min="0" step="0.01" placeholder="100000"></label><label>Target deadline <span class="muted">(optional)</span><input id="opDeadline" type="date"></label><div class="detail-callout">You can add bank accounts, cash and wallets after setup. Bank credentials stay with the connected provider.</div><div class="dialog-actions"><button type="submit" class="primary">Build my workspace</button></div></form>';
    document.body.appendChild(d);
    d.querySelector("form").addEventListener("submit",e=>{
      e.preventDefault();
      const c=$("opBaseCurrency").value; state.settings.baseCurrency=c;
      state.settings.fx=state.settings.fx||{}; state.settings.fx.base=c;
      const layout=$("opLayout").value;
      const orders={balanced:["networth","trend","goals","accounts","activity","quick","fx","relations","insights","spending"],wealth:["networth","trend","accounts","goals","activity","spending","quick","fx","relations","insights"],quick:["quick","networth","accounts","activity","goals","trend","fx","insights","spending"]};
      state.settings.dashboard={...(state.settings.dashboard||{}),order:orders[layout]};
      const target=Number($("opTarget").value);
      if(target>0){state.goals.push({id:uid(),name:"Primary target",target,currency:c,deadline:$("opDeadline").value||"",createdAt:Date.now(),archived:false,accountIds:[]});}
      persist(); localStorage.setItem("omnipocket.onboarding.v1","1"); d.close(); render();
    });
    d.showModal();
  }

  function installSettings() {
    const settings=$("pageMore")?.querySelector(".settings-list"); if(!settings) return;
    if(!$("fxSettingsButton")){
      const b=document.createElement("button"); b.id="fxSettingsButton"; b.textContent="Currency & FX"; b.onclick=openFxSettings; settings.appendChild(b);
    }
    if(!$("exportCsvButton")){
      const b=document.createElement("button"); b.id="exportCsvButton"; b.textContent="Export transactions CSV"; b.onclick=exportCsv; settings.appendChild(b);
    }
    if(!$("accountSecurityButton")){
      const b=document.createElement("button"); b.id="accountSecurityButton"; b.textContent="Account & session"; b.onclick=openSecuritySettings; settings.appendChild(b);
    }
  }

  function openFxSettings(){
    const current=state.settings.fx?.rates?.[base()]||{};
    const parts=currencies.filter(c=>c!==base()).map(c=>base()+" → "+c+": "+(Number(current[c])||0).toFixed(6)).join("\n");
    const raw=prompt("Manual FX overrides (one per line: USD=0.001):\n"+parts+"\n\nThese override the cached matrix for conversions.", "");
    if(raw===null)return;
    state.settings.fx=state.settings.fx||{}; state.settings.fx.rates=state.settings.fx.rates||{};
    state.settings.fx.rates[base()]=state.settings.fx.rates[base()]||{};
    raw.split(/\n|,/).forEach(line=>{const m=line.trim().match(/^([A-Z]{3})\s*=\s*([0-9.]+)$/i);if(m&&Number(m[2])>0)state.settings.fx.rates[base()][m[1].toUpperCase()]=Number(m[2]);});
    state.settings.fx.provider="manual_override";state.settings.fx.manualOverrideAt=Date.now();persist();render();toast("FX overrides saved locally.");
  }

  function exportCsv(){
    const rows=[["Date","Type","Account","Amount","Currency","Category","Status","Bank status","Note"]];
    for(const t of (state.transactions||[])){
      const a=state.accounts.find(x=>x.id===t.sourceAccountId);
      rows.push([t.date,t.type,a?.name||"",t.amount,t.currency,t.category||"",t.status||"",t.bankStatus||"",t.note||""]);
    }
    const csv=rows.map(r=>r.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(",")).join("\n");
    const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download="omnipocket-transactions-"+new Date().toISOString().slice(0,10)+".csv";a.click();URL.revokeObjectURL(url);toast("CSV exported.");
  }

  function openSecuritySettings(){
    const client=window.supabase?.createClient?getSupabaseClient():null;
    if(!client){toast("Secure session service is unavailable.");return;}
    client.auth.getUser().then(({data,error})=>{
      if(error){toast(error.message);return;}
      const email=prompt("Optional email for a magic-link sign-in/backup session:", "");
      if(!email)return;
      client.auth.signInWithOtp({email,options:{emailRedirectTo:location.href}}).then(({error:e})=>{
        toast(e?"Could not send sign-in link: "+e.message:"Sign-in link sent. Check your email.");
      });
    });
  }

  function improvePaymentDetail(){
    document.addEventListener("click",async e=>{
      const b=e.target.closest("[data-payment-reconcile]");
      if(!b)return;
      b.disabled=true;
      try{
        const id=b.dataset.paymentReconcile;
        const result=await supabaseFunction("omnipocket-payment-initiate",{action:"reconcile",paymentId:id});
        toast(result?.matchedTransaction?"Payment reconciled.":result?.alreadyCompleted?"Payment already completed.":"No matching bank transaction yet.");
        if(typeof refreshPaymentCenter==="function")await refreshPaymentCenter();
      }catch(err){toast(err.message||"Reconciliation failed.");}finally{b.disabled=false;}
    });
  }

  function addPaymentReconcileAction(){
    const detail=$("paymentDetailDialog"); if(!detail||$("paymentDetailReconcile"))return;
    const actions=detail.querySelector(".dialog-actions"); if(!actions)return;
    const b=document.createElement("button");b.id="paymentDetailReconcile";b.type="button";b.textContent="Reconcile now";b.hidden=true;
    actions.insertBefore(b,actions.firstChild);
    b.addEventListener("click",async()=>{const id=b.dataset.paymentId;if(!id)return;b.disabled=true;try{const r=await supabaseFunction("omnipocket-payment-initiate",{action:"reconcile",paymentId:id});toast(r?.matchedTransaction?"Payment matched.":"No matching bank transaction yet.");await refreshPaymentCenter();}catch(e){toast(e.message||"Reconciliation failed.");}finally{b.disabled=false;}});
  }

  function installPwaHealth(){
    if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
    window.addEventListener("online",()=>toast("Back online — sync is available."));
    window.addEventListener("offline",()=>toast("Offline mode — local data remains available."));
  }

  function installAccessibility(){
    document.querySelectorAll("button").forEach(b=>{if(!b.getAttribute("aria-label")&&b.textContent.trim()==="✕")b.setAttribute("aria-label","Close");});
  }

  window.OmniPocketV1={toast,openFxSettings,exportCsv,openSecuritySettings};
  window.addEventListener("load",()=>{
    installOnboarding();installSettings();improvePaymentDetail();addPaymentReconcileAction();installPwaHealth();installAccessibility();
    setTimeout(()=>{installSettings();addPaymentReconcileAction();},500);
  });
})();