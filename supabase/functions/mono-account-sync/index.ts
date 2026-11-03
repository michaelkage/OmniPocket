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
function transactionPageMeta(payload: any) {
  return payload?.meta || payload?.data?.meta || payload?.data?.paging || payload?.paging || payload?.pagination || {};
}

async function monoNextPage(next: string, monoAccountId: string) {
  const secret = Deno.env.get("MONO_SECRET_KEY");
  if (!secret) throw new Error("MONO_SECRET_KEY is not configured in Supabase.");
  const url = new URL(next);
  const accountPath = `/v2/${encodeURIComponent(monoAccountId)}/transactions`;
  const legacyAccountPath = `/v2/accounts/${encodeURIComponent(monoAccountId)}/transactions`;
  if (url.origin !== "https://api.withmono.com" || ![accountPath, legacyAccountPath].includes(url.pathname) || url.username || url.password || url.hash) {
    throw new Error("Mono returned an unsafe transaction pagination URL.");
  }
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", "Content-Type": "application/json", "mono-sec-key": secret, "x-real-time": "true" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Mono transaction page failed (${response.status})`);
  return body;
}

async function collectMonoTransactions(firstPayload: any, monoAccountId: string) {
  const first = unwrapTransactions(firstPayload);
  if (first === null) return { transactions: null, reason: null, pagesFetched: 0, reportedTotal: null };
  const transactions = [...first];
  const seenPages = new Set<string>();
  let meta = transactionPageMeta(firstPayload);
  const firstTotalValue = meta.total ?? meta.total_count ?? meta.totalCount;
  const firstTotal = firstTotalValue == null ? null : Number(firstTotalValue);
  let reportedTotal: number | null = firstTotal != null && Number.isSafeInteger(firstTotal) && firstTotal >= 0 ? firstTotal : null;
  let reason: string | null = firstTotalValue != null && reportedTotal == null ? "Mono returned invalid transaction total metadata." : null;
  const firstStatus = String(firstPayload?.status || "").toLowerCase();
  if (firstStatus && !["successful", "success"].includes(firstStatus)) {
    reason = [reason, `Mono transaction response status was ${firstStatus}.`].filter(Boolean).join(" ");
  }
  let pagesFetched = 1;
  const MAX_TRANSACTION_PAGES = 100;
  while (meta?.next != null && meta.next !== "") {
    if (typeof meta.next !== "string") {
      reason = "Mono returned an invalid transaction page link.";
      break;
    }
    const next = meta.next.trim();
    if (!next || seenPages.has(next)) {
      reason = "Mono returned a repeated transaction page link.";
      break;
    }
    if (pagesFetched >= MAX_TRANSACTION_PAGES) {
      reason = `Mono transaction history exceeded the ${MAX_TRANSACTION_PAGES}-page safety limit.`;
      break;
    }
    seenPages.add(next);
    try {
      const pagePayload = await monoNextPage(next, monoAccountId);
      const pageTransactions = unwrapTransactions(pagePayload);
      if (pageTransactions === null) {
        reason = "Mono returned an unexpected transaction page response.";
        break;
      }
      const pageStatus = String(pagePayload?.status || "").toLowerCase();
      if (pageStatus && !["successful", "success"].includes(pageStatus)) {
        reason = `Mono transaction page status was ${pageStatus}.`;
        break;
      }
      const pageMeta = transactionPageMeta(pagePayload);
      const pageTotalValue = pageMeta.total ?? pageMeta.total_count ?? pageMeta.totalCount;
      if (pageTotalValue != null) {
        const pageTotal = Number(pageTotalValue);
        if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || (reportedTotal != null && reportedTotal !== pageTotal)) {
          reason = "Mono returned inconsistent transaction totals across pages.";
          break;
        }
        reportedTotal = pageTotal;
      }
      transactions.push(...pageTransactions);
      pagesFetched++;
      meta = pageMeta;
    } catch (error) {
      reason = error instanceof Error ? `Could not retrieve the next Mono transaction page: ${error.message}` : "Could not retrieve the next Mono transaction page.";
      break;
    }
  }
  return { transactions, reason, pagesFetched, reportedTotal, finalMeta: meta };
}
function transactionFeedState(payload: any, transactionCount: number, dataStatus: string) {
  const meta = payload?.meta || payload?.data?.meta || payload?.data?.paging || payload?.paging || payload?.pagination || {};
  const totalValue = meta.total ?? meta.total_count ?? meta.totalCount ?? meta.count;
  const totalNumber = totalValue == null || (typeof totalValue === "string" && !totalValue.trim())
    ? null : Number(totalValue);
  const hasReportedTotal = totalNumber != null && Number.isSafeInteger(totalNumber) && totalNumber >= 0;
  const invalidReportedTotal = totalValue != null && !hasReportedTotal;
  const pageValue = meta.page ?? meta.current_page ?? meta.currentPage;
  const pagesValue = meta.total_pages ?? meta.totalPages ?? meta.pages;
  const page = pageValue == null ? null : Number(pageValue);
  const pages = pagesValue == null ? null : Number(pagesValue);
  const invalidPageMetadata = (pageValue != null && (!Number.isSafeInteger(page) || page < 1))
    || (pagesValue != null && (!Number.isSafeInteger(pages) || pages < 1))
    || (page != null && pages != null && page > pages);
  const nextValue = meta.next ?? meta.next_page ?? meta.nextPage ?? meta.next_cursor ?? meta.nextCursor;
  const hasNext = nextValue === true || (nextValue != null && String(nextValue).trim() !== "" && nextValue !== false);
  const explicitHasNext = meta.has_next ?? meta.hasNext;
  const hasNextPage = hasNext || explicitHasNext === true || (page != null && pages != null && page < pages);
  const explicitHasNextInvalid = explicitHasNext != null && typeof explicitHasNext !== "boolean";
  const statusIncomplete = ["PARTIAL", "UNAVAILABLE", "PROCESSING", "FAILED"].includes(dataStatus);
  const totalMismatch = hasReportedTotal && totalNumber !== transactionCount;
  const reasons = [];
  if (hasNextPage) reasons.push("Mono indicated additional transaction pages.");
  if (totalMismatch) reasons.push(`Mono reported ${totalNumber} transactions but returned ${transactionCount}.`);
  if (invalidReportedTotal || invalidPageMetadata || explicitHasNextInvalid) reasons.push("Mono returned invalid pagination metadata.");
  if (statusIncomplete) reasons.push(`Mono account data status is ${dataStatus}.`);
  return {
    complete: reasons.length === 0,
    reportedTotal: hasReportedTotal ? totalNumber : null,
    hasNextPage,
    reason: reasons.join(" ") || null,
    metadata: { page: Number.isSafeInteger(page) ? page : null, totalPages: Number.isSafeInteger(pages) ? pages : null }
  };
}
function amountFromProvider(value: any, unit: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return unit === "major" ? n : n / 100;
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
    balance_minor: tx?.balance == null ? null : Math.round(amountFromProvider(tx.balance, amountUnit) * 100),
    transaction_at: tx?.date || tx?.created_at || tx?.createdAt || null,
    raw: tx || {},
  };
}

async function syncAccount(supabase: any, userId: string, monoAccountId: string, connectionId?: string) {
  if (connectionId) {
    const { data: linked, error } = await supabase.from("bank_connections")
      .select("id, status, mono_account_id").eq("id", connectionId).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (!linked || linked.status !== "active") throw new Error("This bank connection is disconnected. Reconnect it before syncing.");
    if (String(linked.mono_account_id) !== String(monoAccountId)) throw new Error("The requested Mono account does not match this connection.");
  }
  const amountUnit = Deno.env.get("MONO_AMOUNT_UNIT") || "minor";
  const startedAt = new Date().toISOString();
  const accountPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}`, { headers: { "x-real-time": "true" } });
  const txPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}/transactions?paginate=false`, { headers: { "x-real-time": "true" } });
  const account = unwrapAccount(accountPayload);
  const collectedFeed = await collectMonoTransactions(txPayload, monoAccountId);
  const transactions = collectedFeed.transactions;
  const transactionMeta = collectedFeed.finalMeta || transactionPageMeta(txPayload);
  const dataStatus = String(accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || transactionMeta?.data_status || transactionMeta?.dataStatus || "").toUpperCase();
  const feedState = transactionFeedState({ meta: transactionMeta }, transactions?.length ?? 0, dataStatus);
  if (collectedFeed.reportedTotal != null && collectedFeed.reportedTotal !== (transactions?.length ?? 0)) {
    feedState.complete = false;
    feedState.reason = [feedState.reason, `Mono reported ${collectedFeed.reportedTotal} transactions but ${transactions?.length ?? 0} were retrieved across pages.`].filter(Boolean).join(" ");
  }
  if (collectedFeed.reason) {
    feedState.complete = false;
    feedState.reason = [feedState.reason, collectedFeed.reason].filter(Boolean).join(" ");
  }
  const transactionFeedComplete = transactions !== null && feedState.complete;
  const reportedTransactionTotal = collectedFeed.reportedTotal ?? feedState.reportedTotal;
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
    sync_status: transactionFeedComplete ? "healthy" : "warning", provider_balance_minor: providerBalanceMinor, provider_balance_at: now,
    last_synced_at: now, last_sync_error: transactionFeedComplete ? null : (feedState.reason || "Mono transaction history is incomplete; balance reconciliation is deferred."),
  };

  let connection: any;
  if (connectionId) {
    const activeConnectionUpdate = { ...row };
    delete (activeConnectionUpdate as any).status;
    const { data, error } = await supabase.from("bank_connections").update(activeConnectionUpdate)
      .eq("id", connectionId).eq("user_id", userId).eq("status", "active").select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This bank connection was disconnected before sync could update it. Reconnect it before syncing.");
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

  if (connectionId) {
    const { data: stillLinked, error } = await supabase.from("bank_connections")
      .select("status").eq("id", connection.id).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (!stillLinked || stillLinked.status !== "active") throw new Error("Bank connection was disconnected during sync; imported data was not updated.");
  }

  const normalizedById = new Map<string, any>();
  let duplicateTransactionCount = 0;
  let invalidDirectionCount = 0;
  let invalidAmountCount = 0;
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
  if (connectionId) {
    const { data: stillLinked, error } = await supabase.from("bank_connections")
      .select("status").eq("id", connection.id).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (!stillLinked || stillLinked.status !== "active") throw new Error("Bank connection was disconnected during sync; imported data was not updated.");
  }
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

  const completedAt = new Date().toISOString();
  const { error: eventError } = await supabase.from("bank_sync_events").insert({
    user_id: userId, connection_id: connection.id, provider: "mono",
    event_type: "account_sync", status: transactionFeedComplete ? "success" : "warning", started_at: startedAt, completed_at: completedAt,
    imported_count: insertedCount, metadata: { transaction_feed_complete: transactionFeedComplete, data_status: row.data_status, amount_unit: amountUnit, fetched_count: transactions.length, inserted_count: insertedCount, updated_count: updatedCount, skipped_count: transactions.length - normalized.length, duplicate_count: duplicateTransactionCount, invalid_direction_count: invalidDirectionCount, invalid_amount_count: invalidAmountCount, reported_transaction_total: reportedTransactionTotal, pagination: { ...feedState.metadata, pages_fetched: collectedFeed.pagesFetched }, pagination_incomplete: !transactionFeedComplete, feed_incomplete_reason: feedState.reason }
  });
  if (eventError) console.warn("Could not record bank sync event:", eventError.message);

  return {
    connection, account, transactionsImported: insertedCount, transactionsFetched: transactions.length,
    transactionsInserted: insertedCount, transactionsUpdated: updatedCount, transactionsSkipped: transactions.length - normalized.length,
    duplicateTransactionCount, invalidTransactionCount: invalidDirectionCount + invalidAmountCount, transactions: normalized, dataStatus: row.data_status, amountUnit,
    transactionFeedComplete, reportedTransactionTotal, transactionFeedIncompleteReason: feedState.reason, transactionPagination: { ...feedState.metadata, pagesFetched: collectedFeed.pagesFetched }
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
