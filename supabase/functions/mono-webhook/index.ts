import { createClient } from "npm:@supabase/supabase-js@2";

const responseHeaders = { "Content-Type":"application/json" };

function hex(bytes: ArrayBuffer){ return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
async function sign(secret:string, body:string){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));
}
function safeEqual(a:string,b:string){
  if(a.length!==b.length) return false;
  let n=0; for(let i=0;i<a.length;i++) n|=a.charCodeAt(i)^b.charCodeAt(i); return n===0;
}
function accountIdFromPayload(payload:any){
  return String(payload?.data?.account_id || payload?.data?.account?.id || payload?.account_id || payload?.account?.id || "");
}

Deno.serve(async(req)=>{
  if(req.method!=="POST") return new Response("Method not allowed",{status:405,headers:responseHeaders});
  const raw=await req.text();
  const secret=Deno.env.get("MONO_WEBHOOK_SECRET");
  const signature=req.headers.get("x-mono-signature") || req.headers.get("mono-signature") || req.headers.get("x-webhook-signature") || "";
  if(!secret) return new Response(JSON.stringify({error:"MONO_WEBHOOK_SECRET is not configured"}),{status:503,headers:responseHeaders});
  const expected=await sign(secret,raw);
  const provided=signature.replace(/^sha256=/i,"").trim().toLowerCase();
  if(!provided || !safeEqual(provided,expected.toLowerCase()))
    return new Response(JSON.stringify({error:"Invalid webhook signature"}),{status:401,headers:responseHeaders});

  const payload=JSON.parse(raw);
  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const eventId=String(payload?.id || payload?.event_id || req.headers.get("x-event-id") || crypto.randomUUID());
  const eventType=String(payload?.event || payload?.type || "unknown");
  const monoAccountId=accountIdFromPayload(payload);
  let connectionId:string|null=null;
  if(monoAccountId){
    const {data}=await supabase.from("bank_connections").select("id").eq("mono_account_id",monoAccountId).maybeSingle();
    connectionId=data?.id || null;
  }
  const {error}=await supabase.from("bank_webhook_events").upsert({
    provider:"mono",event_id:eventId,event_type:eventType,signature_valid:true,connection_id:connectionId,payload:payload,processed_at:new Date().toISOString()
  },{onConflict:"provider,event_id"});
  if(error) console.error("Webhook event persistence failed",error);
  if(connectionId){
    await supabase.from("bank_connections").update({sync_status:"syncing",status:"active",last_sync_error:null}).eq("id",connectionId);
  }
  return new Response(JSON.stringify({received:true,eventId,eventType,connectionId,syncRequired:Boolean(connectionId)}),{headers: responseHeaders});
});