import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const payload = await req.json().catch(() => null);
  console.log("Mono webhook received", JSON.stringify(payload));

  // Phase 1 intentionally keeps webhook handling stateless.
  // The PWA remains the source of local user state. Once Supabase persistence
  // is connected, this handler can persist sync jobs and account events.
  return new Response(JSON.stringify({ received: true }), {
    headers: { "content-type": "application/json" },
  });
});
