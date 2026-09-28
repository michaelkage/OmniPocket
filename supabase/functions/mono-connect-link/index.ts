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

function clientForRequest(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new Error("Authorization required");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
  });
}

async function requireUser(req: Request) {
  const supabase = clientForRequest(req);
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
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "mono-sec-key": secret,
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Mono API request failed (${response.status})`);
  return body;
}

const redirectUrl = () => CORS_ORIGIN.replace(/\/$/, "") + "/OmniPocket/?mono_link=complete";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabase, user } = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "initiate");

    if (action === "status") {
      const reference = String(body?.reference || "").trim();
      if (!reference) return json({ error: "Link reference is required" }, 400);

      const { data: session, error } = await supabase
        .from("mono_link_sessions").select("*")
        .eq("reference", reference).eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!session) return json({ error: "Link session not found" }, 404);

      // Mono normally delivers account_connected through the webhook. As a
      // recovery path, also reconcile against Mono's linked-account list so
      // a delayed/misconfigured webhook cannot leave a successful link stuck.
      if (!session.mono_account_id) {
        try {
          const accountsResult = await mono("/accounts");
          const rawAccounts = accountsResult?.data || accountsResult?.accounts || [];
          const accounts = Array.isArray(rawAccounts)
            ? rawAccounts
            : Array.isArray(rawAccounts?.data) ? rawAccounts.data : [];

          const match = accounts.find((item: any) => {
            const account = item?.account || item;
            const customerId = String(item?.customer || account?.customer || "");
            const ref = String(
              item?.meta?.ref ||
              account?.meta?.ref ||
              "",
            );
            return (session.mono_customer_id && customerId === String(session.mono_customer_id))
              || ref === reference;
          });

          if (match) {
            const account = match?.account || match;
            const monoAccountId = String(
              account?.id || account?._id || match?.id || match?._id || "",
            );

            if (monoAccountId) {
              const details = {
                institutionName: account?.institution?.name || null,
                accountName: account?.name || null,
                last4: account?.account_number
                  ? String(account.account_number).slice(-4)
                  : account?.accountNumber
                    ? String(account.accountNumber).slice(-4)
                    : null,
                currency: String(account?.currency || "NGN").toUpperCase(),
                accountType: account?.type || null,
                balance: account?.balance,
              };

              const { data: existing } = await supabase
                .from("bank_connections").select("id")
                .eq("user_id", user.id).eq("mono_account_id", monoAccountId).maybeSingle();

              let connectionId = existing?.id || null;

              if (existing?.id) {
                const { error: updateError } = await supabase
                  .from("bank_connections").update({
                    client_account_id: session.client_account_id,
                    provider_customer_id: session.mono_customer_id,
                    status: "active",
                    sync_status: "syncing",
                    institution_name: details.institutionName,
                    account_name: details.accountName || session.customer_name,
                    account_number_last4: details.last4,
                    currency: details.currency,
                    account_type: details.accountType,
                    provider_balance_minor: details.balance == null ? null : Math.round(Number(details.balance) * 100),
                    last_sync_error: null,
                    needs_reauth: false,
                  }).eq("id", existing.id);
                if (updateError) throw updateError;
              } else {
                const { data: created, error: createError } = await supabase
                  .from("bank_connections").insert({
                    user_id: session.user_id,
                    provider: "mono",
                    mono_account_id: monoAccountId,
                    client_account_id: session.client_account_id,
                    provider_customer_id: session.mono_customer_id,
                    status: "active",
                    sync_status: "syncing",
                    institution_name: details.institutionName,
                    account_name: details.accountName || session.customer_name,
                    account_number_last4: details.last4,
                    currency: details.currency,
                    account_type: details.accountType,
                    balance_minor: details.balance == null ? null : Math.round(Number(details.balance) * 100),
                    provider_balance_minor: details.balance == null ? null : Math.round(Number(details.balance) * 100),
                    data_status: account?.meta?.data_status || match?.meta?.data_status || "PROCESSING",
                  }).select().single();
                if (createError) throw createError;
                connectionId = created.id;
              }

              const { error: sessionError } = await supabase
                .from("mono_link_sessions").update({
                  status: "linked",
                  mono_account_id: monoAccountId,
                  completed_at: new Date().toISOString(),
                  error_message: null,
                }).eq("id", session.id);
              if (sessionError) throw sessionError;

              const { data: connection, error: connectionError } = await supabase
                .from("bank_connections").select("*").eq("id", connectionId).single();
              if (connectionError) throw connectionError;

              return json({ session: { ...session, status: "linked", mono_account_id: monoAccountId }, connection });
            }
          }
        } catch (recoveryError) {
          // Keep the pending session alive. The webhook may still arrive later.
          console.warn("Mono account-list recovery did not resolve the link:", recoveryError);
        }
      }

      let connection = null;
      if (session.mono_account_id) {
        const result = await supabase.from("bank_connections").select("*")
          .eq("user_id", user.id).eq("mono_account_id", session.mono_account_id).maybeSingle();
        if (result.error) throw result.error;
        connection = result.data;
      }
      return json({ session, connection });
    }

    const name = String(body?.customer?.name || body?.accountName || "OmniPocket user").trim();
    const email = String(body?.customer?.email || "").trim();
    const clientAccountId = body?.clientAccountId ? String(body.clientAccountId) : null;
    if (!email) return json({ error: "Email is required for the bank connection" }, 400);

    const reference = "omnipocket_" + crypto.randomUUID().replaceAll("-", "");
    const { data: pending, error: insertError } = await supabase.from("mono_link_sessions").insert({
      user_id: user.id, reference, customer_name: name || "OmniPocket user",
      customer_email: email, client_account_id: clientAccountId,
    }).select().single();
    if (insertError) throw insertError;

    try {
      const result = await mono("/accounts/initiate", {
        method: "POST",
        body: JSON.stringify({
          customer: { name: name || "OmniPocket user", email },
          meta: { ref: reference },
          scope: "auth",
          redirect_url: redirectUrl(),
        }),
      });
      const data = result?.data || result;
      const monoUrl = data?.mono_url;
      if (!monoUrl) throw new Error("Mono did not return a Connect Link URL.");

      const { error: updateError } = await supabase.from("mono_link_sessions").update({
        mono_customer_id: data?.customer ? String(data.customer) : null,
        mono_url: monoUrl,
      }).eq("id", pending.id).eq("user_id", user.id);
      if (updateError) throw updateError;

      return json({ reference, monoUrl, redirectUrl: redirectUrl(), sessionId: pending.id });
    } catch (error) {
      await supabase.from("mono_link_sessions").update({
        status: "failed",
        error_message: error instanceof Error ? error.message : "Mono link initiation failed",
        completed_at: new Date().toISOString(),
      }).eq("id", pending.id).eq("user_id", user.id);
      throw error;
    }
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Unable to create Mono Connect Link" }, 500);
  }
});
