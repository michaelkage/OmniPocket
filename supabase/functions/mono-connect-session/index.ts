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
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "mono-sec-key": secret,
      ...(init.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `Mono API request failed (${response.status})`);
  return body;
}

Deno.serve(async (req) => { if (req.method === "OPTIONS") return new Response("ok",{headers:corsHeaders}); try { await requireUser(req); const body=await req.json(); const result=await mono("/connect/session",{method:"POST",body:JSON.stringify({institution:body.institution,auth_method:body.auth_method||"internet_banking",scope:"financial_data",customer:body.customer})}); return json(result); } catch(error){ return json({error:error instanceof Error?error.message:"Unable to create Mono session"},500); }});
