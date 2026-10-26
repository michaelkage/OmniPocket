import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mono(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("MONO_SECRET_KEY");
  if (!key) throw new Error("MONO_SECRET_KEY is not configured.");
  const response = await fetch("https://api.withmono.com/v2" + path, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", "mono-sec-key": key, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Mono API failed (${response.status})`);
  return body;
}

const unwrapAccount = (payload: any) => payload?.data?.account || payload?.data || payload?.account || payload;

function unwrapTransactions(payload: any): any[] | null {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  return null;
}

const normalizeTransaction = (tx: any) => ({
  mono_transaction_id: String(tx?._id || tx?.id || tx?.transaction_id || ""),
  type: String(tx?.type || "").toLowerCase() === "credit" ? "credit" : "debit",
  amount_minor: Math.round(Number(tx?.amount) || 0),
  currency: String(tx?.currency || "NGN").toUpperCase(),
  narration: tx?.narration || tx?.description || tx?.remark || null,
  category: tx?.category || null,
  balance_minor: tx?.balance == null ? null : Math.round(Number(tx.balance) || 0),
  transaction_at: tx?.date || tx?.created_at || tx?.createdAt || null,
  raw: tx || {},
});

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ ok: true });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const suppliedSecret = request.headers.get("x-omnipocket-cron-secret");
    const { data: cronSecret } = await admin.rpc("omnipocket_get_cron_secret");
    if (!cronSecret || suppliedSecret !== cronSecret) return json({ error: "Unauthorized" }, 401);

    const { data: connections, error: connectionsError } = await admin
      .from("bank_connections").select("*").eq("provider", "mono").eq("status", "active").limit(50);
    if (connectionsError) throw connectionsError;

    const results = [];
    for (const connection of connections || []) {
      const startedAt = Date.now();
      const { data: run } = await admin.from("bank_sync_runs").insert({
        user_id: connection.user_id, connection_id: connection.id, provider: "mono", status: "running",
      }).select().single();

      try {
        const accountPayload = await mono("/accounts/" + encodeURIComponent(connection.mono_account_id), { headers: { "x-real-time": "true" } });
        const transactionsPayload = await mono("/accounts/" + encodeURIComponent(connection.mono_account_id) + "/transactions?paginate=false", { headers: { "x-real-time": "true" } });
        const account = unwrapAccount(accountPayload);
        const transactions = unwrapTransactions(transactionsPayload);
        if (transactions === null) {
          const topLevelKeys = transactionsPayload && typeof transactionsPayload === "object" ? Object.keys(transactionsPayload).slice(0, 12) : [];
          console.error("Mono scheduled transactions response had an unexpected shape", { topLevelKeys, connectionId: connection.id });
          throw new Error("Mono returned an unexpected transaction response. The account balance was not changed; retry sync or check the Mono transaction feed.");
        }

        const normalizedTransactions = transactions.map(normalizeTransaction).filter((tx: any) => {
          if (tx.mono_transaction_id) return true;
          console.warn("Skipping Mono transaction without a stable provider ID", { connectionId: connection.id });
          return false;
        });

        // Only update the balance after validating the transaction feed shape.
        const syncTime = new Date().toISOString();
        const connectionUpdate = {
          status: "active",
          provider_status: accountPayload?.data?.meta?.data_status || "connected",
          institution_name: account?.institution?.name || connection.institution_name,
          account_name: account?.name || connection.account_name,
          account_number_last4: account?.account_number ? String(account.account_number).slice(-4) : connection.account_number_last4,
          currency: String(account?.currency || connection.currency || "NGN").toUpperCase(),
          account_type: account?.type || connection.account_type,
          balance_minor: account?.balance == null ? connection.balance_minor : Math.round(Number(account.balance) || 0),
          data_status: accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || null,
          last_synced_at: syncTime,
          last_successful_sync_at: syncTime,
          last_sync_error: null,
        };
        const { error: connectionUpdateError } = await admin.from("bank_connections").update(connectionUpdate).eq("id", connection.id);
        if (connectionUpdateError) throw connectionUpdateError;

        const transactionIds = normalizedTransactions.map((tx: any) => tx.mono_transaction_id);
        const { data: existingRows, error: existingError } = transactionIds.length
          ? await admin.from("bank_transactions").select("mono_transaction_id").eq("connection_id", connection.id).in("mono_transaction_id", transactionIds)
          : { data: [], error: null };
        if (existingError) throw existingError;
        const existingIds = new Set((existingRows || []).map((row: any) => row.mono_transaction_id));
        let imported = 0;
        let duplicates = 0;

        for (const tx of normalizedTransactions) {
          if (existingIds.has(tx.mono_transaction_id)) {
            duplicates++;
            continue;
          }

          let matchedPayment: any = null;
          if (tx.type === "debit" && connection.client_account_id) {
            const paymentQuery = await admin.from("omnipocket_payments").select("id")
              .eq("user_id", connection.user_id).eq("source_account_id", connection.client_account_id)
              .eq("amount_minor", tx.amount_minor).eq("currency", tx.currency)
              .in("status", ["awaiting_user", "initiated", "pending", "needs_reconciliation"])
              .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
              .order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (!paymentQuery.error) matchedPayment = paymentQuery.data || null;
          }

          const { error: insertError } = await admin.from("bank_transactions").insert({
            user_id: connection.user_id,
            connection_id: connection.id,
            ...tx,
            dedupe_key: "mono:" + tx.mono_transaction_id,
            reconciliation_status: matchedPayment ? "matched_payment" : "unmatched",
            matched_payment_id: matchedPayment?.id || null,
            is_pending: false,
            posted_at: tx.transaction_at,
          });
          if (insertError) {
            // A concurrent sync may have inserted this provider ID after the pre-check.
            if (String(insertError.code || "") === "23505") {
              duplicates++;
              existingIds.add(tx.mono_transaction_id);
              continue;
            }
            throw insertError;
          }

          imported++;
          existingIds.add(tx.mono_transaction_id);
          if (matchedPayment) {
            await admin.from("omnipocket_payments").update({
              status: "completed", completed_at: new Date().toISOString(), last_verified_at: new Date().toISOString(),
            }).eq("id", matchedPayment.id).eq("user_id", connection.user_id);
          }
        }

        const durationMs = Date.now() - startedAt;
        if (run) await admin.from("bank_sync_runs").update({
          status: "success", completed_at: new Date().toISOString(), imported_count: imported,
          duplicate_count: duplicates, duration_ms: durationMs,
          metadata: { scheduled: true, dataStatus: connectionUpdate.data_status, totalSeen: transactions.length, skippedCount: transactions.length - normalizedTransactions.length },
        }).eq("id", run.id);
        results.push({ connectionId: connection.id, status: "success", imported, duplicates });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sync failed";
        await admin.from("bank_connections").update({ status: "error", last_sync_error: message }).eq("id", connection.id);
        if (run) await admin.from("bank_sync_runs").update({
          status: "error", completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt, error: message,
        }).eq("id", run.id);
        results.push({ connectionId: connection.id, status: "error", error: message });
      }
      await sleep(50);
    }

    return json({ ok: true, processed: results.length, results });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Scheduled sync failed" }, 500);
  }
});
