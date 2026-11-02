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

async function requireUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new Error("Authorization required");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
  });
  const token = authorization.replace(/^Bearer\\s+/i, "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) throw new Error("Invalid Supabase session");
  return { supabase, user };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { supabase, user } = await requireUser(req);
    const body = await req.json();
    if (body?.action !== "unlink" || typeof body?.connectionId !== "string" || !body.connectionId.trim()) {
      return json({ error: "A valid connectionId and unlink action are required" }, 400);
    }
    const { data, error } = await supabase
      .from("bank_connections")
      .update({ status: "disconnected", sync_status: "paused", last_sync_error: null })
      .eq("id", body.connectionId)
      .eq("user_id", user.id)
      .select("id, status, sync_status")
      .maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: "Bank connection was not found for this user" }, 404);
    return json({ connection: data, unlinked: true });
  } catch (error) {
    console.error("Mono connection lifecycle error:", error);
    return json({ error: error instanceof Error ? error.message : "Bank connection update failed" }, 500);
  }
});
