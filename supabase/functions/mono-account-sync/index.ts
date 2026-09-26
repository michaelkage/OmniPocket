import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
function unwrapTransactions(payload: any) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.transactions)) return data.transactions;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  return [];
}
function normalizeTransaction(tx: any) {
  return {
    mono_transaction_id: String(tx?._id || tx?.id || tx?.transaction_id || crypto.randomUUID()),
    type: String(tx?.type || "").toLowerCase() === "credit" ? "credit" : "debit",
    amount_minor: Math.round(Number(tx?.amount) || 0),
    currency: String(tx?.currency || "NGN").toUpperCase(),
    narration: tx?.narration || tx?.description || tx?.remark || null,
    category: tx?.category || null,
    balance_minor: tx?.balance == null ? null : Math.round(Number(tx.balance) || 0),
    transaction_at: tx?.date || tx?.created_at || tx?.createdAt || null,
    raw: tx || {},
  };
}
async function syncAccount(supabase: any, userId: string, monoAccountId: string, connectionId?: string) {
  const accountPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}`, { headers: { "x-real-time": "true" } });
  const txPayload = await mono(`/accounts/${encodeURIComponent(monoAccountId)}/transactions?paginate=false`, { headers: { "x-real-time": "true" } });
  const account = unwrapAccount(accountPayload), transactions = unwrapTransactions(txPayload);
  const row = {
    user_id: userId, provider: "mono", mono_account_id: monoAccountId, status: "active",
    institution_name: account?.institution?.name || null, account_name: account?.name || "Connected bank",
    account_number_last4: account?.account_number ? String(account.account_number).slice(-4) : null,
    currency: String(account?.currency || "NGN").toUpperCase(), account_type: account?.type || null,
    balance_minor: account?.balance == null ? null : Math.round(Number(account.balance) || 0),
    data_status: accountPayload?.data?.meta?.data_status || accountPayload?.data?.meta?.dataStatus || null,
    last_synced_at: new Date().toISOString(), last_sync_error: null,
  };
  let connection: any;
  if (connectionId) {
    const { data, error } = await supabase.from("bank_connections").update(row).eq("id", connectionId).eq("user_id", userId).select().single();
    if (error) throw error; connection = data;
  } else {
    const { data: existing } = await supabase.from("bank_connections").select("id").eq("user_id", userId).eq("mono_account_id", monoAccountId).maybeSingle();
    if (existing?.id) {
      const { data, error } = await supabase.from("bank_connections").update(row).eq("id", existing.id).eq("user_id", userId).select().single();
      if (error) throw error; connection = data;
    } else {
      const { data, error } = await supabase.from("bank_connections").insert(row).select().single();
      if (error) throw error; connection = data;
    }
  }
  for (const tx of transactions.map(normalizeTransaction)) {
    const { error } = await supabase.from("bank_transactions").upsert({ user_id: userId, connection_id: connection.id, ...tx }, { onConflict: "connection_id,mono_transaction_id" });
    if (error) throw error;
  }
  return { connection, account, transactionsImported: transactions.length, dataStatus: row.data_status };
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
