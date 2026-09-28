import { createClient } from "npm:@supabase/supabase-js@2";

const responseHeaders = {
  "Content-Type": "application/json",
};

function accountIdFromPayload(payload: any) {
  return String(
    payload?.data?.account_id ||
      payload?.data?.account?._id ||
      payload?.data?.account?.id ||
      payload?.data?.id ||
      payload?.account_id ||
      payload?.account?.id ||
      ""
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: responseHeaders,
    });
  }

  const secret = Deno.env.get("MONO_WEBHOOK_SECRET");
  if (!secret) {
    return new Response(
      JSON.stringify({ error: "MONO_WEBHOOK_SECRET is not configured" }),
      { status: 503, headers: responseHeaders }
    );
  }

  const provided = (req.headers.get("mono-webhook-secret") || "").trim();
  if (!provided || provided !== secret) {
    return new Response(
      JSON.stringify({ error: "Invalid webhook secret" }),
      { status: 401, headers: responseHeaders }
    );
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON payload" }),
      { status: 400, headers: responseHeaders }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const eventId = String(
    payload?.event_id ||
      payload?.id ||
      req.headers.get("x-event-id") ||
      crypto.randomUUID()
  );
  const eventType = String(payload?.event || payload?.type || "unknown");
  const monoAccountId = accountIdFromPayload(payload);

  let connectionId: string | null = null;
  if (monoAccountId) {
    const { data } = await supabase
      .from("bank_connections")
      .select("id")
      .eq("mono_account_id", monoAccountId)
      .maybeSingle();

    connectionId = data?.id || null;
  }

  const { error } = await supabase
    .from("bank_webhook_events")
    .upsert(
      {
        provider: "mono",
        event_id: eventId,
        event_type: eventType,
        signature_valid: true,
        connection_id: connectionId,
        payload,
        processed_at: new Date().toISOString(),
      },
      { onConflict: "provider,event_id" }
    );

  if (error) {
    console.error("Webhook event persistence failed", error);
    return new Response(
      JSON.stringify({ error: "Webhook persistence failed" }),
      { status: 500, headers: responseHeaders }
    );
  }

  if (connectionId) {
    await supabase
      .from("bank_connections")
      .update({
        sync_status: "syncing",
        status: "active",
        last_sync_error: null,
      })
      .eq("id", connectionId);
  }

  return new Response(
    JSON.stringify({
      received: true,
      eventId,
      eventType,
      connectionId,
      syncRequired: Boolean(connectionId),
    }),
    { headers: responseHeaders }
  );
});
