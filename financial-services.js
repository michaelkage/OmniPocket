(function(){
  const Bank=window.OmniPocketBank;
  function availableWealth(state){
    const active=(state?.accounts||[]).filter(a=>!a.archived);
    let total=0,locked=0,pending=0;
    for(const a of active){const value=window.OmniPocketEngine?.convert?.(state,a.balance,a.currency,state.settings.baseCurrency) ?? a.balance;total+=Number(value)||0;if(a.type==="locked")locked+=Number(value)||0;}
    for(const t of state?.transactions||[]) if(t.bankStatus==="pending"){const value=window.OmniPocketEngine?.convert?.(state,t.amount,t.currency,state.settings.baseCurrency) ?? t.amount;pending+=(t.type==="income"?1:-1)*(Number(value)||0);}
    return {netWorth:total,availableNow:total-pending-locked,pending,locked,currency:state?.settings?.baseCurrency||"NGN"};
  }
  function transactionFingerprint(t){return Bank.fingerprint({accountId:t.sourceAccountId,date:t.date,amount:t.amount,currency:t.currency,type:t.type,category:t.category,note:t.note||t.external?.providerTransactionId||""});}
  function duplicateCandidates(state,transaction,tolerance=.01){const fp=transactionFingerprint(transaction);return (state.transactions||[]).filter(t=>t.id!==transaction.id&&transactionFingerprint(t)===fp&&Math.abs(Number(t.amount)-Number(transaction.amount))<=tolerance);}
  function recurringCandidates(state){const grouped=new Map();for(const t of state?.transactions||[]){if(t.type!=="expense"||t.status==="superseded"||t.bankStatus==="failed")continue;const key=[t.sourceAccountId,t.currency,t.category,Number(t.amount).toFixed(2)].join("|");const list=grouped.get(key)||[];list.push(t);grouped.set(key,list);}return [...grouped.entries()].filter(([,list])=>list.length>=3).map(([key,list])=>({key,count:list.length,transactions:list.sort((a,b)=>String(a.date).localeCompare(String(b.date)))}));}
  function exportCsv(state){const rows=[["Date","Type","Account","Amount","Currency","Category","Status","Bank status","Provenance","Note"]];for(const t of state?.transactions||[])rows.push([t.date,t.type,state.accounts?.find(a=>a.id===t.sourceAccountId)?.name||"",t.amount,t.currency,t.category||"",t.status||"",t.bankStatus||"",t.provenance?.source||"",t.note||""]);return rows.map(row=>row.map(v=>'"'+String(v??"").replaceAll('"','""')+'"').join(",")).join("\n");}
  function migrationCheck(state){return {schemaVersion:state?.schemaVersion||null,accounts:Array.isArray(state?.accounts),transactions:Array.isArray(state?.transactions),goals:Array.isArray(state?.goals),snapshots:Array.isArray(state?.snapshots)};}
  window.OmniPocketFinancial={availableWealth,transactionFingerprint,duplicateCandidates,recurringCandidates,exportCsv,migrationCheck};
})();