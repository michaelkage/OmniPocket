import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "https://michaelkage.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function supabaseForRequest(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth) throw new Error("Authorization required");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
}

async function requireUser(req: Request) {
  const supabase = supabaseForRequest(req);
  const token = req.headers.get("Authorization")!.replace(/^Bearer\s+/i, "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) throw new Error("Invalid Supabase session");
  return { supabase, user };
}

async function mono(path: string, init: RequestInit = {}) {
  const secret = Deno.env.get("MONO_SECRET_KEY");
  if (!secret) throw new Error("MONO_SECRET_KEY is not configured in Supabase.");
  const response = await fetch("https://api.withmono.com/v2" + path, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", "mono-sec-key": secret, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Mono API request failed (${response.status})`);
  return body;
}

function unwrapAccount(payload: any) { return payload?.data?.account || payload?.data || payload?.account || payload; }
function unwrapTransactions(payload: any): any[] | null {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.transactions)) return data.transactions;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  // A valid empty array is different from an unexpected API response shape.
  return null;
}
function amountFromProvider(value: any, unit: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return unit === "major" ? n : n / 100;
}
function normalizeTransaction(tx: any, amountUnit: string) {
  return {
    mono_transaction_id: tx?._id || tx?.id || tx?.transaction_id ? String(tx._id || tx.id || tx.transaction_id) : null,
    type: String(tx?.type || "").toLowerCase() === "credit" ? "credit" : "debit",
    amount_minor: Math.round(amountFromProvider(tx?.amount, amountUnit) * 100),
    currency: String(tx?.currency || "NGN").toUpperCase(),
    narration: tx?.narration || tx?.description || tx?.remark || null,
    category: tx?.category || null,
    bank_status: ["pending", "posted", "reversed", "failed"].includes(String(tx?.status || "").toLowerCase())
      ? String(tx.status).toLowerCase() : null,
    balance_minor: tx?.balance == null ? null : Math.round(amountFromProvider(tx.balance, amountUnit) * 100),
    transaction_at: tx?.date || tx?.created_at || tx?.createdAt || null,
    raw: tx || {},
  };
}

async function syncAccount(supabase: any, userId: string, monoAccountId: string, connectionId?: string) {
  const amountUnit = Deno.env.get("MONO_AMOUNT_UNIT") || "minor";
  const startedAt = new Date().toISOString();
  const accountPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}`, { headers: { "x-real-time": "true" } });
  const txPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}/transactions?paginate=false`, { headers: { "x-real-time": "true" } });
  const account = unwrapAccount(accountPayload);
  const transactions = unwrapTransactions(txPayload);
  const transactionMeta = txPayload?.meta || txPayload?.data?.meta || txPayload?.data?.paging || txPayload?.paging || {};
  const reportedTransactionTotal = Number(transactionMeta.total);
  const hasReportedTransactionTotal = Number.isFinite(reportedTransactionTotal) && reportedTransactionTotal >= 0;
  const hasNextTransactionPage = Boolean(transactionMeta.next);
  const transactionFeedComplete = !hasNextTransactionPage && (!hasReportedTransactionTotal || reportedTransactionTotal === transactions?.length);
  if (transactions === null) {
    const topLevelKeys = txPayload && typeof txPayload === "object" ? Object.keys(txPayload).slice(0, 12) : [];
    console.error("Mono transactions response had an unexpected shape", { topLevelKeys });
    throw new Error("Mono returned an unexpected transaction response. The account balance was not changed; retry sync or check the Mono transaction feed.");
  }
  const now = new Date().toISOString();
  const providerBalanceMinor = account?.balance == null ? null : Math.round(amountFromProvider(account.balance, amountUnit) * 100);
  const row = {
    user_id: userId, provider: "mono", mono_account_id: monoAccountId, status: "active",
    institution_name: account?.institution?.name || null, account_name: account?.name || "Connected bank",
    account_number_last4: account?.account_number ? String(account.account_number).slice(-4) : null,
    currency: String(account?.currency || "NGN").toUpperCase(), account_type: account?.type || null,
    balance_minor: providerBalanceMinor, data_status: accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || null,
    sync_status: "healthy", provider_balance_minor: providerBalanceMinor, provider_balance_at: now,
    last_synced_at: now, last_sync_error: null,
  };

  let connection: any;
  if (connectionId) {
    const { data, error } = await supabase.from("bank_connections").update(row).eq("id", connectionId).eq("user_id", userId).select().single();
    if (error) throw error;
    connection = data;
  } else {
    const { data: existing, error: existingError } = await supabase.from("bank_connections").select("id").eq("user_id", userId).eq("mono_account_id", monoAccountId).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.id) {
      const { data, error } = await supabase.from("bank_connections").update(row).eq("id", existing.id).eq("user_id", userId).select().single();
      if (error) throw error;
      connection = data;
    } else {
      const { data, error } = await supabase.from("bank_connections").insert(row).select().single();
      if (error) throw error;
      connection = data;
    }
  }

  const normalizedById = new Map<string, any>();
  let duplicateTransactionCount = 0;
  for (const tx of transactions.map((item: any) => normalizeTransaction(item, amountUnit))) {
    if (!tx.mono_transaction_id) {
      console.warn("Skipping Mono transaction without a stable provider ID");
      continue;
    }
    if (normalizedById.has(tx.mono_transaction_id)) duplicateTransactionCount++;
    normalizedById.set(tx.mono_transaction_id, tx);
  }
  const normalized = [...normalizedById.values()];
  const transactionIds = normalized.map((tx: any) => tx.mono_transaction_id);
  const { data: existingRows, error: existingRowsError } = transactionIds.length
    ? await supabase.from("bank_transactions").select("mono_transaction_id").eq("connection_id", connection.id).in("mono_transaction_id", transactionIds)
    : { data: [], error: null };
  if (existingRowsError) throw existingRowsError;
  const existingIds = new Set((existingRows || []).map((row: any) => row.mono_transaction_id));
  let insertedCount = 0;
  let updatedCount = 0;
  for (const tx of normalized) {
    const { error } = await supabase.from("bank_transactions").upsert(
      { user_id: userId, connection_id: connection.id, ...tx, provenance: "bank_sync" },
      { onConflict: "connection_id,mono_transaction_id" }
    );
    if (error) throw error;
    if (existingIds.has(tx.mono_transaction_id)) updatedCount++;
    else {
      insertedCount++;
      existingIds.add(tx.mono_transaction_id);
    }
  }

  const completedAt = new Date().toISOString();
  const { error: eventError } = await supabase.from("bank_sync_events").insert({
    user_id: userId, connection_id: connection.id, provider: "mono",
    event_type: "account_sync", status: "success", started_at: startedAt, completed_at: completedAt,
    imported_count: insertedCount, metadata: { data_status: row.data_status, amount_unit: amountUnit, fetched_count: transactions.length, inserted_count: insertedCount, updated_count: updatedCount, skipped_count: transactions.length - normalized.length, duplicate_count: duplicateTransactionCount }
  });
  if (eventError) console.warn("Could not record bank sync event:", eventError.message);

  return {
    connection, account, transactionsImported: insertedCount, transactionsFetched: transactions.length,
    transactionsInserted: insertedCount, transactionsUpdated: updatedCount, transactionsSkipped: transactions.length - normalized.length,
    duplicateTransactionCount, transactions: normalized, dataStatus: row.data_status, amountUnit,
    transactionFeedComplete, reportedTransactionTotal: hasReportedTransactionTotal ? reportedTransactionTotal : null
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { supabase, user } = await requireUser(req);
    const { accountId, connectionId } = await req.json();
    if (!accountId && !connectionId) return json({ error: "accountId or connectionId is required" }, 400);
    let monoAccountId = accountId;
    if (!monoAccountId) {
      const { data, error } = await supabase.from("bank_connections").select("mono_account_id").eq("id", connectionId).eq("user_id", user.id).single();
      if (error) throw error;
      monoAccountId = data.mono_account_id;
    }
    return json(await syncAccount(supabase, user.id, String(monoAccountId), connectionId));
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Bank sync failed" }, 500);
  }
});
