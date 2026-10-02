/* OmniPocket Supabase integration boundary.
 *
 * Owns runtime config, the client singleton, the anonymous bank-sync session
 * and edge-function invocation. Kept separate from app.js so the rest of the
 * UI never touches transport concerns. Loaded before app.js.
 */

const OMNIPOCKET_CONFIG = window.OMNIPOCKET_CONFIG || {};
const OMNIPOCKET_SUPABASE_URL = OMNIPOCKET_CONFIG.supabaseUrl || "";
const OMNIPOCKET_SUPABASE_PUBLISHABLE_KEY = OMNIPOCKET_CONFIG.supabasePublishableKey || "";

let omnipocketSupabase = null;
let omnipocketAuthPromise = null;

function getSupabaseClient() {
  if (omnipocketSupabase) return omnipocketSupabase;
  if (!window.supabase?.createClient) throw new Error("Supabase client failed to load.");
  omnipocketSupabase = window.supabase.createClient(
    OMNIPOCKET_SUPABASE_URL,
    OMNIPOCKET_SUPABASE_PUBLISHABLE_KEY
  );
  return omnipocketSupabase;
}

async function ensureSupabaseSession() {
  const client = getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  if (session?.access_token) return session;
  if (omnipocketAuthPromise) return omnipocketAuthPromise;
  omnipocketAuthPromise = (async () => {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) throw new Error("OmniPocket could not create its secure bank-sync session: " + error.message);
    return data.session;
  })().finally(() => { omnipocketAuthPromise = null; });
  return omnipocketAuthPromise;
}

async function supabaseFunction(path, body) {
  const session = await ensureSupabaseSession();
  const response = await fetch(OMNIPOCKET_SUPABASE_URL + "/functions/v1/" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": OMNIPOCKET_SUPABASE_PUBLISHABLE_KEY,
      "Authorization": "Bearer " + session.access_token
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || payload?.message || ("Supabase function failed (" + response.status + ")"));
  return payload;
}