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
    const { accountId, realtime = false } = await req.json();
    if (!accountId) return json({ error: "accountId is required." }, 400);

    const headers: Record<string, string> = {
      accept: "application/json",
      "mono-sec-key": secret,
    };
    if (realtime) headers["x-realtime"] = "true";

    const [accountResponse, transactionResponse] = await Promise.all([
      fetch("https://api.withmono.com/v2/accounts/" + encodeURIComponent(accountId), { headers }),
      fetch("https://api.withmono.com/v2/accounts/" + encodeURIComponent(accountId) + "/transactions?paginate=false", { headers }),
    ]);

    const account = await accountResponse.json();
    const transactions = await transactionResponse.json();

    return json({
      account,
      transactions,
      syncedAt: new Date().toISOString(),
      realtime,
    }, Math.max(accountResponse.status, transactionResponse.status));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to sync Mono account." }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
