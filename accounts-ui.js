// Extracted from app.js: accounts UI.

function renderAccountCard(a){const c=accountConnectionStatus(a),tone=connectionTone(a),x=a.connection||{},sync=x.providerAccountId&&!a.archived?'<button type="button" class="text-button account-inline-sync" data-sync-account="'+escapeHtml(a.id)+'">'+(tone==="syncing"?"Syncing…":"Sync now")+"</button>":"",action=a.archived?'<button type="button" class="text-button" data-restore-account="'+escapeHtml(a.id)+'">Restore</button>':'<button type="button" class="text-button account-open-action" data-open-account="'+escapeHtml(a.id)+'">Manage</button>',imported=Number(x.importedTransactionCount)||0,totalImported=Number(x.totalImportedTransactionCount)||0,err=x.lastSyncError?'<div class="account-sync-error">'+escapeHtml(x.lastSyncError)+"</div>":"";return'<div class="account-control-card '+(a.archived?"is-archived":"")+'"><div class="account-control-main"><div class="account-main"><span class="node">◉</span><div class="truncate"><strong>'+escapeHtml(a.name)+'</strong><div class="muted">'+escapeHtml(a.institution||"Personal")+" · "+escapeHtml(a.currency)+" · "+escapeHtml(a.type)+'</div></div></div><span class="amount">'+(state.settings.privacyHidden?"••••":escapeHtml(money(a.balance,a.currency)))+'</span></div><div class="account-control-meta"><span class="provider-badge">'+providerLabel(a)+'</span><span class="account-status-chip" data-tone="'+tone+'">'+escapeHtml(c.label)+'</span><span class="muted">Last sync · '+relativeSyncTime(x.lastSyncedAt)+'</span><span class="muted">'+(x.provider?"Imported "+imported+" last sync · "+totalImported+" total":"Local only")+'</span>'+sync+action+'</div>'+(x.provider?'<div class="account-health-row"><span>Last run '+relativeSyncTime(x.lastSyncCompletedAt||x.lastSyncedAt)+'</span><span>Duration '+formatSyncDuration(x.lastSyncDurationMs)+'</span><span>'+((x.syncHistory||[]).length)+' recorded runs</span></div>':"")+err+"</div>";}

function accountGalaxyIcon(a){const type=String(a?.type||"bank").toLowerCase();return type==="cash"?"◌":type==="wallet"?"◈":type==="locked"?"◆":"◉";}

function renderAccountGalaxy(){
  const el=$("accountList"),allowed=new Set(contextAccountIds());
  const accounts=state.accounts.filter(a=>!a.archived&&allowed.has(a.id));
  if(!el) return;
  if(!accounts.length){el.innerHTML='<div class="empty-state">No money nodes yet. Add your first account.</div>';return;}
  const total=Math.max(1,accounts.length);
  const nodes=accounts.map((a,i)=>{
    const angle=(i/total)*Math.PI*2-Math.PI/2;
    const x=50+Math.cos(angle)*38;
    const y=50+Math.sin(angle)*34;
    const balance=state.settings.privacyHidden?"••••":money(a.balance,a.currency);
    const provider=a.connection?.provider==="mono"?"MONO":"LOCAL";
    const tone=a.connection?.syncStatus==="error"?"error":a.connection?.syncStatus==="syncing"?"syncing":"connected";
    return '<button type="button" class="galaxy-account-node" data-open-account="'+escapeHtml(a.id)+'" style="--gx:'+x.toFixed(2)+'%;--gy:'+y.toFixed(2)+'%;--ga:'+((angle*180/Math.PI)+90).toFixed(1)+'deg" aria-label="'+escapeHtml(a.name)+'">'+
      '<span class="galaxy-orbit-link" aria-hidden="true"></span>'+
      '<span class="galaxy-account-core" data-tone="'+tone+'">'+accountGalaxyIcon(a)+'</span>'+
      '<span class="galaxy-account-label"><strong>'+escapeHtml(a.name)+'</strong><small>'+escapeHtml(a.institution||"Personal")+' · '+escapeHtml(provider)+'</small><b>'+escapeHtml(balance)+'</b></span></button>';
  }).join("");
  const totalLabel=state.settings.privacyHidden?"••••":money(netWorth());
  el.innerHTML='<div class="account-galaxy"><div class="galaxy-stars" aria-hidden="true"></div><div class="account-galaxy-center"><span class="galaxy-core-ring"></span><span class="galaxy-core-pulse"></span><strong>'+escapeHtml(totalLabel)+'</strong><small>'+total+' active node'+(total===1?"":"s")+'</small></div>'+nodes+'</div>';
}

function renderAccounts(){renderAccountGalaxy();}

function renderAccountsControlCenter(){const overview=$("accountsOverview"),connections=$("bankConnectionsList"),full=$("accountsFullList"),archivedEl=$("accountsArchivedList");if(!overview||!connections||!full)return;const active=state.accounts.filter(a=>!a.archived),archived=state.accounts.filter(a=>a.archived),connected=active.filter(a=>a.connection?.provider&&a.connection.status==="connected"),attention=active.filter(a=>a.connection?.syncStatus==="error"||a.connection?.lastSyncError),imported=active.reduce((sum,a)=>sum+(Number(a.connection?.importedTransactionCount)||0),0),total=active.reduce((sum,a)=>sum+convert(a.balance,a.currency,state.settings.baseCurrency),0);overview.innerHTML='<div class="account-overview-card"><span class="eyebrow">ACTIVE NODES</span><strong>'+active.length+'</strong><small>accounts</small></div><div class="account-overview-card"><span class="eyebrow">CONNECTED BANKS</span><strong>'+connected.length+'</strong><small>live sources</small></div><div class="account-overview-card"><span class="eyebrow">IMPORTED</span><strong>'+imported+'</strong><small>new rows on latest sync</small></div><div class="account-overview-card '+(attention.length?"has-attention":"")+'"><span class="eyebrow">SYNC ATTENTION</span><strong>'+attention.length+'</strong><small>accounts needing review</small></div><div class="account-overview-card"><span class="eyebrow">CONTROLLED WEALTH</span><strong>'+(state.settings.privacyHidden?"••••••":money(total,state.settings.baseCurrency))+'</strong><small>active balances</small></div>';const banks=active.filter(a=>a.connection?.provider);connections.innerHTML=banks.length?banks.map(renderAccountCard).join(""):'<div class="empty-state bank-empty"><strong>No bank connections yet.</strong><span>Use Demo Bank to test the full sync pipeline, or connect a real provider when credentials are available.</span></div>';full.innerHTML=active.length?active.map(renderAccountCard).join(""):'<div class="empty-state"><strong>No money nodes yet.</strong><span>Add an account or connect a bank to start tracking your wealth.</span></div>';if(archivedEl)archivedEl.innerHTML=archived.length?archived.map(renderAccountCard).join(""):'<div class="empty-state">Archived accounts will appear here.</div>';}

function accountConnectionStatus(a){const c=a?.connection;if(!c||!c.provider)return{label:"Local account",tone:"local",detail:"Managed entirely on this device."};if(a.archived)return{label:"Archived",tone:"warning",detail:"Account is archived. History is preserved and syncing is paused."};if(c.status!=="connected")return{label:"Disconnected",tone:"warning",detail:"Bank connection is disconnected. Imported history remains available."};if(c.syncStatus==="syncing")return{label:"Syncing",tone:"syncing",detail:"Bank data is being refreshed."};if(c.syncStatus==="error")return{label:"Sync failed",tone:"error",detail:c.lastSyncError||"The latest bank refresh failed."};const freshness=window.OmniPocketBank?.freshness?.(c.lastSyncedAt);if(c.syncStatus==="healthy"&&freshness?.state==="stale")return{label:"Stale",tone:"warning",detail:c.lastSyncedAt?"Last synced "+new Date(c.lastSyncedAt).toLocaleString()+" — refresh recommended.":"Bank connection is stale."};if(c.syncStatus==="healthy")return{label:"Connected",tone:"connected",detail:c.lastSyncedAt?"Last synced "+new Date(c.lastSyncedAt).toLocaleString():"Bank connection active."};return{label:"Connection needs attention",tone:"warning",detail:"The bank connection is not currently healthy."};}

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
  if (syncMeta) {
    const providerBalance = Number(a.connection?.providerBalance);
    const localBalance = Number(a.balance);
    const difference = Number.isFinite(providerBalance) && Number.isFinite(localBalance) ? providerBalance - localBalance : null;
    const reconciliation = difference == null ? "" : (Math.abs(difference) < 0.005
      ? '<div class="detail-callout reconciliation-match"><strong>Reconciled</strong><span>Provider and OmniPocket balance match.</span></div>'
      : '<div class="detail-callout reconciliation-warning"><strong>Balance mismatch</strong><span>Provider ' + escapeHtml(money(providerBalance,a.currency)) + ' · OmniPocket ' + escapeHtml(money(localBalance,a.currency)) + ' · Difference ' + escapeHtml(money(difference,a.currency)) + '</span></div>');
    syncMeta.innerHTML = '<strong>' + escapeHtml(connection.detail) + '</strong>' + (a.connection?.lastSyncError ? '<div class="account-sync-error">' + escapeHtml(a.connection.lastSyncError) + '</div>' : '') + reconciliation;
  }
  const historyHost=$("accountDetailSyncHistory"), history=a.connection?.syncHistory||[];
  if(historyHost){
    historyHost.hidden=!a.connection?.provider;
    historyHost.innerHTML=a.connection?.provider ? '<div class="eyebrow">SYNC HISTORY</div><div class="sync-history-list">'+(history.length?history.slice(0,8).map(h=>'<div class="sync-history-row"><span><strong>'+escapeHtml(h.status==="success"?"Successful sync":"Failed sync")+'</strong><small>'+escapeHtml(h.completedAt?new Date(h.completedAt).toLocaleString():"Unknown time")+'</small></span><span><strong>'+escapeHtml(String(h.importedCount||0))+'</strong><small>imported · '+escapeHtml(formatSyncDuration(h.durationMs))+'</small></span></div>').join(""):'<div class="empty-state">No sync runs yet.</div>')+'</div>' : "";
  }
  const syncButton = $("accountDetailSync");
  if (syncButton) { syncButton.hidden = !a.connection?.providerAccountId; syncButton.disabled = a.connection?.syncStatus === "syncing"; syncButton.textContent = a.connection?.syncStatus === "syncing" ? "Syncing…" : "Sync now"; }
  const disconnectButton = $("accountDetailDisconnect");
  if (disconnectButton) { disconnectButton.hidden = !a.connection?.provider; disconnectButton.textContent = a.connection?.status === "connected" ? "Disconnect bank" : "Reconnect bank"; }
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

function saveEditedAccount(id, data) {
  const a = account(id);
  if (!a) return false;
  a.name = data.name;
  a.institution = data.institution;
  a.type = data.type;
  a.currency = data.currency;
  return true;
}
