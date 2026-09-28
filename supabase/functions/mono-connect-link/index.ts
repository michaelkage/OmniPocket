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
        .from("mono_link_sessions").select("*").eq("reference", reference).eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!session) return json({ error: "Link session not found" }, 404);

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
