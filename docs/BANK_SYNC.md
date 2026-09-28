# Bank Sync

Mono Connect -> mono-exchange-token -> canonical bank connection -> mono-account-sync -> Supabase bank_transactions -> local projection.

Webhooks are signals. mono-webhook verifies the configured signature, records the event and marks the connection for refresh; it does not directly mutate the ledger.

Canonical amounts are integer minor units. MONO_AMOUNT_UNIT=minor|major controls the provider normalization boundary. Exact Mono fixtures must be checked before production use.

Authenticated functions require Supabase JWTs. The webhook is the exception: platform JWT verification is disabled because the external provider does not send a Supabase JWT, and the function performs its own signature verification. Browser CORS is restricted by ALLOWED_ORIGIN.

Sync states: disconnected, connecting, connected, syncing, healthy, stale, error, revoked, needs_reauth.