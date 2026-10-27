import { createClient } from "npm:@supabase/supabase-js@2";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function mono(path: string) {
  const key = Deno.env.get("MONO_SECRET_KEY");
  if (!key) throw new Error("MONO_SECRET_KEY is not configured.");
  const response = await fetch("https://api.withmono.com/v2" + path, { headers: { Accept: "application/json", "mono-sec-key": key, "x-real-time": "true" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Mono API failed (${response.status})`);
  return body;
}
function transactionsOf(payload: any): any[] | null {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  return null;
}
function amountMinor(value: any, unit: string) { const n = Number(value); return Number.isFinite(n) ? Math.round((unit === "major" ? n : n / 100) * 100) : 0; }
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true });
  let admin: any;
  try {
    admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const supplied = req.headers.get("x-omnipocket-cron-secret");
    const { data: expected, error: secretError } = await admin.rpc("omnipocket_get_cron_secret");
    if (secretError) throw secretError;
    if (!expected || supplied !== expected) return json({ error: "Unauthorized" }, 401);
    const { data: connections, error } = await admin.from("bank_connections").select("*").eq("provider", "mono").eq("status", "active").limit(50);
    if (error) throw error;
    const results = [];
    for (const connection of connections || []) {
      let eventId: string | null = null;
      try {
        const started = new Date().toISOString();
        const event = await admin.from("bank_sync_events").insert({ user_id: connection.user_id, connection_id: connection.id, provider: "mono", event_type: "scheduled_account_sync", status: "running", started_at: started }).select("id").single();
        if (event.error) throw event.error;
        eventId = event.data?.id || null;
        const unit = Deno.env.get("MONO_AMOUNT_UNIT") || "minor";
        const accountPayload = await mono("/accounts/" + encodeURIComponent(connection.mono_account_id));
        const txPayload = await mono("/accounts/" + encodeURIComponent(connection.mono_account_id) + "/transactions?paginate=false");
        const txs = transactionsOf(txPayload);
        if (txs === null) {
          console.error("Mono scheduled transactions response had an unexpected shape", { topLevelKeys: Object.keys(txPayload || {}).slice(0, 12), connectionId: connection.id });
          throw new Error("Mono returned an unexpected transaction response; account balance was not changed.");
        }
        const account = accountPayload?.data?.account || accountPayload?.data || accountPayload?.account || accountPayload;
        const now = new Date().toISOString();
        const balance = account?.balance == null ? connection.provider_balance_minor : amountMinor(account.balance, unit);
        const normalized = txs.map((tx: any) => ({
          mono_transaction_id: tx?._id || tx?.id || tx?.transaction_id ? String(tx._id || tx.id || tx.transaction_id) : null,
          type: String(tx?.type || "").toLowerCase() === "credit" ? "credit" : "debit",
          amount_minor: amountMinor(tx?.amount, unit), currency: String(tx?.currency || "NGN").toUpperCase(),
          narration: tx?.narration || tx?.description || tx?.remark || null, category: tx?.category || null,
          balance_minor: tx?.balance == null ? null : amountMinor(tx.balance, unit),
          transaction_at: tx?.date || tx?.created_at || tx?.createdAt || null, raw: tx || {},
        })).filter((tx: any) => { if (tx.mono_transaction_id) return true; console.warn("Skipping Mono transaction without stable ID", { connectionId: connection.id }); return false; });
        const update = await admin.from("bank_connections").update({ status: "active", institution_name: account?.institution?.name || connection.institution_name, account_name: account?.name || connection.account_name || "Connected bank", account_number_last4: account?.account_number ? String(account.account_number).slice(-4) : connection.account_number_last4, currency: String(account?.currency || connection.currency || "NGN").toUpperCase(), account_type: account?.type || connection.account_type, balance_minor: balance, provider_balance_minor: balance, provider_balance_at: now, data_status: accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || null, sync_status: "healthy", last_synced_at: now, last_sync_error: null }).eq("id", connection.id);
        if (update.error) throw update.error;
        const ids = normalized.map((tx: any) => tx.mono_transaction_id);
        const existing = ids.length ? await admin.from("bank_transactions").select("mono_transaction_id").eq("connection_id", connection.id).in("mono_transaction_id", ids) : { data: [], error: null };
        if (existing.error) throw existing.error;
        const known = new Set((existing.data || []).map((row: any) => row.mono_transaction_id));
        let imported = 0; let updated = 0;
        for (const tx of normalized) {
          const existed = known.has(tx.mono_transaction_id);
          const saved = await admin.from("bank_transactions").upsert({ user_id: connection.user_id, connection_id: connection.id, ...tx, provenance: "bank_sync" }, { onConflict: "connection_id,mono_transaction_id" });
          if (saved.error) throw saved.error;
          if (existed) updated++; else { imported++; known.add(tx.mono_transaction_id); }
        }
        if (eventId) await admin.from("bank_sync_events").update({ status: "success", completed_at: new Date().toISOString(), imported_count: imported, metadata: { scheduled: true, amount_unit: unit, fetched_count: txs.length, inserted_count: imported, updated_count: updated, skipped_count: txs.length - normalized.length } }).eq("id", eventId);
        results.push({ connectionId: connection.id, status: "success", imported, updated, fetched: txs.length });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Scheduled sync failed";
        await admin.from("bank_connections").update({ last_sync_error: message, sync_status: "error" }).eq("id", connection.id);
        if (eventId) await admin.from("bank_sync_events").update({ status: "error", completed_at: new Date().toISOString(), error_message: message }).eq("id", eventId);
        results.push({ connectionId: connection.id, status: "error", error: message });
      }
    }
    return json({ ok: true, processed: results.length, results });
  } catch (e) { console.error(e); return json({ error: e instanceof Error ? e.message : "Scheduled sync failed" }, 500); }
});
