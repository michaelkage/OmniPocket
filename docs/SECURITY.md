# Security

Never place Mono secrets or Supabase service-role keys in the PWA. Privileged operations stay in Edge Functions.

Authenticated Edge Functions require user JWTs. External webhook functions disable platform JWT verification and verify their own provider signature.

CORS is restricted to the configured production origin.

Canonical financial fields are retained; raw provider payloads have a raw_retained_until field for retention policy. Webhook payload storage is service-role-only.

Backups include schema version, export timestamp and checksum. Reconciliation never silently rewrites opening balance or historical transactions.