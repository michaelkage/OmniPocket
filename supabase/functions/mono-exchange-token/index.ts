import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("MONO_SECRET_KEY");
  if (!secret) return json({ error: "MONO_SECRET_KEY is not configured." }, 500);

  try {
    const { code } = await req.json();
    if (!code) return json({ error: "Mono authorization code is required." }, 400);

    const response = await fetch("https://api.withmono.com/v2/accounts/auth", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "mono-sec-key": secret,
      },
      body: JSON.stringify({ code }),
    });

    const data = await response.json();
    return json(data, response.status);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to exchange Mono authorization code." }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
