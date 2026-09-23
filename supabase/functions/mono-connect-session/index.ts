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
    const body = await req.json();
    const response = await fetch("https://api.withmono.com/v2/connect/session", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "mono-sec-key": secret,
      },
      body: JSON.stringify({
        institution: body.institution,
        auth_method: body.auth_method || "internet_banking",
        scope: "financial_data",
        customer: body.customer,
      }),
    });

    const data = await response.json();
    return json(data, response.status);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to create Mono session." }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
