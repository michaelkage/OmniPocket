import { createClient } from "npm:@supabase/supabase-js@2";

const responseHeaders = { "Content-Type": "application/json" };

function accountIdFromPayload(p:any) {
  return String(p?.data?.account_id || p?.data?.account?._id || p?.data?.account?.id || p?.data?.id || p?.account_id || p?.account?.id || "");
}
function referenceFromPayload(p:any) {
  return String(p?.data?.meta?.ref || p?.data?.account?.meta?.ref || p?.meta?.ref || "").trim();
}
function customerIdFromPayload(p:any) {
  return String(p?.data?.customer || p?.data?.account?.customer || p?.customer || "").trim();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed",{status:405,headers:responseHeaders});

  const secret=Deno.env.get("MONO_WEBHOOK_SECRET");
  if (!secret) return new Response(JSON.stringify({error:"MONO_WEBHOOK_SECRET is not configured"}),{status:503,headers:responseHeaders});

  const provided=(req.headers.get("mono-webhook-secret")||"").trim();
  if (!provided || provided!==secret) return new Response(JSON.stringify({error:"Invalid webhook secret"}),{status:401,headers:responseHeaders});

  let payload:any;
  try { payload=await req.json(); }
  catch { return new Response(JSON.stringify({error:"Invalid JSON payload"}),{status:400,headers:responseHeaders}); }

  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const eventId=String(payload?.event_id || payload?.id || req.headers.get("x-event-id") || crypto.randomUUID());
  const eventType=String(payload?.event || payload?.type || "unknown");
  const monoAccountId=accountIdFromPayload(payload);
  const reference=referenceFromPayload(payload);
  const monoCustomerId=customerIdFromPayload(payload);

  let connectionId:string|null=null;
  let linkedSessionId:string|null=null;

  if (eventType==="mono.events.account_connected" && monoAccountId) {
    let session:any=null;

    if (reference) {
      const r=await supabase.from("mono_link_sessions").select("*").eq("reference",reference).maybeSingle();
      if (r.error) {
        console.error("Connect Link reference lookup failed",r.error);
        return new Response(JSON.stringify({error:"Session lookup failed"}),{status:500,headers:responseHeaders});
      }
      session=r.data;
    }

    if (!session && monoCustomerId) {
      const r=await supabase.from("mono_link_sessions").select("*")
        .eq("mono_customer_id",monoCustomerId).in("status",["initiated","linked"])
        .order("created_at",{ascending:false}).limit(1).maybeSingle();
      if (r.error) {
        console.error("Connect Link customer lookup failed",r.error);
        return new Response(JSON.stringify({error:"Customer lookup failed"}),{status:500,headers:responseHeaders});
      }
      session=r.data;
    }

    if (session) {
      linkedSessionId=session.id;

      const existing=await supabase.from("bank_connections").select("id")
        .eq("mono_account_id",monoAccountId).maybeSingle();

      if (existing.error) {
        console.error("Existing connection lookup failed",existing.error);
        return new Response(JSON.stringify({error:"Bank connection lookup failed"}),{status:500,headers:responseHeaders});
      }

      if (existing.data?.id) {
        connectionId=existing.data.id;
        const u=await supabase.from("bank_connections").update({
          client_account_id:session.client_account_id,
          provider_customer_id:session.mono_customer_id || monoCustomerId || null,
          status:"active",sync_status:"syncing",last_sync_error:null,needs_reauth:false
        }).eq("id",connectionId);
        if (u.error) {
          console.error("Existing connection update failed",u.error);
          return new Response(JSON.stringify({error:"Bank connection update failed"}),{status:500,headers:responseHeaders});
        }
      } else {
        const c=await supabase.from("bank_connections").insert({
          user_id:session.user_id,provider:"mono",mono_account_id:monoAccountId,
          client_account_id:session.client_account_id,
          provider_customer_id:session.mono_customer_id || monoCustomerId || null,
          status:"active",sync_status:"syncing",currency:"NGN",
          data_status:payload?.data?.meta?.data_status || "PROCESSING",needs_reauth:false
        }).select("id").single();
        if (c.error) {
          console.error("Bank connection creation failed",c.error);
          return new Response(JSON.stringify({error:"Bank connection creation failed"}),{status:500,headers:responseHeaders});
        }
        connectionId=c.data.id;
      }

      const s=await supabase.from("mono_link_sessions").update({
        status:"linked",mono_account_id:monoAccountId,error_message:null,completed_at:new Date().toISOString()
      }).eq("id",session.id);
      if (s.error) {
        console.error("Connect Link session update failed",s.error);
        return new Response(JSON.stringify({error:"Connect Link session update failed"}),{status:500,headers:responseHeaders});
      }
    }
  }

  if (!connectionId && monoAccountId) {
    const r=await supabase.from("bank_connections").select("id").eq("mono_account_id",monoAccountId).maybeSingle();
    if (!r.error) connectionId=r.data?.id || null;
  }

  const persisted=await supabase.from("bank_webhook_events").upsert({
    provider:"mono",event_id:eventId,event_type:eventType,signature_valid:true,
    connection_id:connectionId,payload,processed_at:new Date().toISOString()
  },{onConflict:"provider,event_id"});

  if (persisted.error) {
    console.error("Webhook event persistence failed",persisted.error);
    return new Response(JSON.stringify({error:"Webhook persistence failed"}),{status:500,headers:responseHeaders});
  }

  if (connectionId) {
    await supabase.from("bank_connections").update({
      sync_status:"syncing",status:"active",last_sync_error:null
    }).eq("id",connectionId);
  }

  return new Response(JSON.stringify({
    received:true,eventId,eventType,connectionId,linkedSessionId,syncRequired:Boolean(connectionId)
  }),{headers:responseHeaders});
});