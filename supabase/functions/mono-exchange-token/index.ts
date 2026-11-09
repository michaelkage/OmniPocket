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
  return null;
}
function providerBalanceMinor(value: any, unit: string): number | null {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const minor = Math.round((unit === "major" ? amount : amount / 100) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}
function transactionAmountMinor(value: any, unit: string) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const minor = Math.round((unit === "major" ? n : n / 100) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}
function normalizeTransaction(tx: any, amountUnit: string) {
  return {
    mono_transaction_id: tx?._id || tx?.id || tx?.transaction_id ? String(tx._id || tx.id || tx.transaction_id) : null,
    type: String(tx?.type || "").toLowerCase(),
    amount_minor: transactionAmountMinor(tx?.amount, amountUnit),
    currency: String(tx?.currency || "NGN").toUpperCase(),
    narration: tx?.narration || tx?.description || tx?.remark || null,
    category: tx?.category || null,
    bank_status: ["pending", "posted", "reversed", "failed"].includes(String(tx?.status || "").toLowerCase())
      ? String(tx.status).toLowerCase() : null,
    balance_minor: providerBalanceMinor(tx?.balance, amountUnit),
    transaction_at: tx?.date || tx?.created_at || tx?.createdAt || null,
    raw: tx || {},
  };
}

async function syncAccount(supabase: any, userId: string, monoAccountId: string, connectionId?: string) {
  const amountUnit = Deno.env.get("MONO_AMOUNT_UNIT") || "minor";
  if (!["minor", "major"].includes(amountUnit)) throw new Error("MONO_AMOUNT_UNIT must be either minor or major.");
  const startedAt = new Date().toISOString();
  const accountPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}`, { headers: { "x-real-time": "true" } });
  const txPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}/transactions?paginate=false`, { headers: { "x-real-time": "true" } });
  const account = unwrapAccount(accountPayload);
  const transactions = unwrapTransactions(txPayload);
  const transactionMeta = txPayload?.meta || txPayload?.data?.meta || txPayload?.data?.paging || txPayload?.paging || {};
  const totalValue = transactionMeta.total ?? transactionMeta.total_count ?? transactionMeta.totalCount ?? transactionMeta.count;
  const reportedTransactionTotal = totalValue == null || (typeof totalValue === "string" && !totalValue.trim()) ? null : Number(totalValue);
  const hasReportedTransactionTotal = reportedTransactionTotal != null && Number.isSafeInteger(reportedTransactionTotal) && reportedTransactionTotal >= 0;
  const invalidReportedTotal = totalValue != null && !hasReportedTransactionTotal;
  const pageValue = transactionMeta.page ?? transactionMeta.current_page ?? transactionMeta.currentPage;
  const pagesValue = transactionMeta.total_pages ?? transactionMeta.totalPages ?? transactionMeta.pages;
  const page = pageValue == null ? null : Number(pageValue);
  const pages = pagesValue == null ? null : Number(pagesValue);
  const explicitHasNext = transactionMeta.has_next ?? transactionMeta.hasNext;
  const invalidPageMetadata = (pageValue != null && (!Number.isSafeInteger(page) || page < 1))
    || (pagesValue != null && (!Number.isSafeInteger(pages) || pages < 1))
    || (page != null && pages != null && page > pages)
    || (explicitHasNext != null && typeof explicitHasNext !== "boolean");
  const hasNextTransactionPage = Boolean(transactionMeta.next || transactionMeta.next_page || transactionMeta.nextPage)
    || explicitHasNext === true || (page != null && pages != null && page < pages);
  const dataStatus = String(accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || "").toUpperCase();
  let transactionFeedComplete = !hasNextTransactionPage && !invalidReportedTotal && !invalidPageMetadata
    && (!hasReportedTransactionTotal || reportedTransactionTotal === transactions?.length)
    && !["PARTIAL", "UNAVAILABLE", "PROCESSING", "FAILED"].includes(dataStatus);
  if (!Array.isArray(transactions)) {
    const topLevelKeys = txPayload && typeof txPayload === "object" ? Object.keys(txPayload).slice(0, 12) : [];
    console.error("Mono transactions response had an unexpected shape", { topLevelKeys });
    throw new Error("Mono returned an unexpected transaction response. The account balance was not changed; retry sync or check the Mono transaction feed.");
  }
  const now = new Date().toISOString();
  const providerBalance = account?.balance == null ? null : providerBalanceMinor(account.balance, amountUnit);
  if (account?.balance != null && providerBalance == null) throw new Error("Mono returned an invalid account balance; the stored balance was not changed. Retry sync or check the provider response.");
  const row = {
    user_id: userId, provider: "mono", mono_account_id: monoAccountId, status: "active",
    institution_name: account?.institution?.name || null, account_name: account?.name || "Connected bank",
    account_number_last4: account?.account_number ? String(account.account_number).slice(-4) : null,
    currency: String(account?.currency || "NGN").toUpperCase(), account_type: account?.type || null,
    ...(providerBalance == null ? {} : { balance_minor: providerBalance, provider_balance_minor: providerBalance, provider_balance_at: now }),
    data_status: accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || null,
    sync_status: transactionFeedComplete ? "healthy" : "warning",
    last_synced_at: now, last_sync_error: transactionFeedComplete ? null : "Mono transaction history is incomplete; balance reconciliation is deferred.",
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

  // A provider feed can repeat records (including across page boundaries).
  // Collapse by the stable Mono ID before querying or writing so one sync has
  // deterministic counts and the final provider copy wins.
  const normalizedById = new Map<string, any>();
  let duplicateTransactionCount = 0;
  let invalidDirectionCount = 0;
  let invalidAmountCount = 0;
  let missingProviderIdCount = 0;
  for (const tx of transactions.map((item: any) => normalizeTransaction(item, amountUnit))) {
    if (tx.amount_minor == null) {
      invalidAmountCount++;
      continue;
    }
    if (!["credit", "debit"].includes(tx.type)) {
      invalidDirectionCount++;
      continue;
    }
    if (!tx.mono_transaction_id) {
      missingProviderIdCount++;
      console.warn("Skipping Mono transaction without a stable provider ID");
      continue;
    }
    if (normalizedById.has(tx.mono_transaction_id)) duplicateTransactionCount++;
    normalizedById.set(tx.mono_transaction_id, tx);
  }
  const normalized = [...normalizedById.values()];
  const feedQualityIssues = [];
  if (duplicateTransactionCount) feedQualityIssues.push(`${duplicateTransactionCount} duplicate provider transaction record(s) were returned.`);
  if (invalidDirectionCount) feedQualityIssues.push(`${invalidDirectionCount} transaction(s) had an unsupported direction.`);
  if (invalidAmountCount) feedQualityIssues.push(`${invalidAmountCount} transaction(s) had an invalid amount.`);
  if (missingProviderIdCount) feedQualityIssues.push(`${missingProviderIdCount} transaction(s) had no stable provider ID.`);
  if (invalidReportedTotal || invalidPageMetadata) feedQualityIssues.push("Mono returned invalid pagination metadata.");
  if (hasNextTransactionPage) feedQualityIssues.push("Mono indicated additional transaction pages.");
  if (hasReportedTransactionTotal && reportedTransactionTotal !== transactions.length) feedQualityIssues.push(`Mono reported ${reportedTransactionTotal} transactions but returned ${transactions.length}.`);
  if (["PARTIAL", "UNAVAILABLE", "PROCESSING", "FAILED"].includes(dataStatus)) feedQualityIssues.push(`Mono account data status is ${dataStatus}.`);
  if (feedQualityIssues.length) {
    transactionFeedComplete = false;
    row.sync_status = "warning";
    row.last_sync_error = feedQualityIssues.join(" ");
    const { error: qualityUpdateError } = await supabase.from("bank_connections").update({
      sync_status: "warning", last_sync_error: row.last_sync_error
    }).eq("id", connection.id).eq("user_id", userId).eq("status", "active");
    if (qualityUpdateError) throw qualityUpdateError;
  }
  const transactionIds = normalized.map((tx: any) => tx.mono_transaction_id);
  const { data: existingRows, error: existingRowsError } = transactionIds.length
    ? await supabase.from("bank_transactions").select("mono_transaction_id").eq("connection_id", connection.id).in("mono_transaction_id", transactionIds)
    : { data: [], error: null };
  if (existingRowsError) throw existingRowsError;
  const existingIds = new Set((existingRows || []).map((row: any) => row.mono_transaction_id));
  let insertedCount = 0;
  let updatedCount = 0;
  for (const tx of normalized) {
    // The provider schema calls this field provider_status; keep bank_status
    // in the response contract consumed by the local PWA ledger.
    const { bank_status, ...databaseTransaction } = tx;
    const { error } = await supabase.from("bank_transactions").upsert(
      { user_id: userId, connection_id: connection.id, ...databaseTransaction, provider_status: bank_status, provenance: "bank_sync" },
      { onConflict: "connection_id,mono_transaction_id" }
    );
    if (error) throw error;
    if (existingIds.has(tx.mono_transaction_id)) updatedCount++;
    else {
      insertedCount++;
      existingIds.add(tx.mono_transaction_id);
    }
  }

  const { error: eventError } = await supabase.from("bank_sync_events").insert({
    user_id: userId, connection_id: connection.id, provider: "mono",
    event_type: "account_sync", status: transactionFeedComplete ? "success" : "warning", started_at: startedAt, completed_at: now,
    imported_count: insertedCount,
    metadata: { transaction_feed_complete: transactionFeedComplete, data_status: row.data_status, amount_unit: amountUnit, fetched_count: transactions.length, inserted_count: insertedCount, updated_count: updatedCount, skipped_count: transactions.length - normalized.length, duplicate_count: duplicateTransactionCount, invalid_direction_count: invalidDirectionCount, invalid_amount_count: invalidAmountCount, missing_provider_id_count: missingProviderIdCount, feed_incomplete_reason: feedQualityIssues.join(" ") || null }
  });
  if (eventError) console.warn("Could not record bank sync event:", eventError.message);

  return {
    connection, account, transactionsImported: insertedCount, transactionsFetched: transactions.length,
    transactionsInserted: insertedCount, transactionsUpdated: updatedCount, transactionsSkipped: transactions.length - normalized.length,
    duplicateTransactionCount, invalidTransactionCount: invalidDirectionCount + invalidAmountCount + missingProviderIdCount, transactions: normalized, dataStatus: row.data_status, amountUnit,
    transactionFeedComplete, transactionFeedIncompleteReason: feedQualityIssues.join(" ") || null, reportedTransactionTotal: hasReportedTransactionTotal ? reportedTransactionTotal : null
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { supabase, user } = await requireUser(req);
    const { code } = await req.json();
    if (!code) return json({ error: "Mono authorization code is required" }, 400);
    const authPayload = await mono("/accounts/auth", { method: "POST", body: JSON.stringify({ code }) });
    const monoAccountId = authPayload?.data?.id || authPayload?.id;
    if (!monoAccountId) return json({ error: "Mono did not return an account ID" }, 502);
    const result = await syncAccount(supabase, user.id, String(monoAccountId));
    return json({ ...result, monoAccountId: String(monoAccountId) });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Bank connection failed" }, 500);
  }
});
