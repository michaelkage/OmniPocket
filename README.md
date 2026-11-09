# OmniPocket

OmniPocket is a local-first, multi-currency wealth tracker designed to give a single connected view of money across bank accounts, cash, digital wallets, and locked savings.

## V1 foundation

- Multiple supported account types and currencies
- Base-currency net worth aggregation
- Income, expense, transfer, withdrawal, and reconciliation transactions
- Two-sided transfers between accounts
- Cross-currency transfers with calculated or manually supplied FX
- Historical transaction dates
- `Handle later` status for quick entries
- Multiple goals with account selection
- Hideable financial values
- Local-first persistence with a versioned state migration path
- PWA shell and offline mode foundation

## Architecture direction

The financial state is treated as a domain model rather than a collection of UI counters. Transactions describe money movement; account balances are maintained as the current materialized state; reconciliation is recorded as an adjustment rather than silently changing history.

The current browser persistence adapter is **IndexedDB** (`storage.js`), with a one-time migration path from the legacy V1 localStorage snapshot. The domain model is intentionally separated from the UI. localStorage remains in use for small preferences and a few legacy integration/queue values; it is not the primary financial-state database.

The next storage milestone is to replace the single serialized state snapshot with indexed, independently committed local records and a durable outbox. See [Project Shadow-Sync](docs/SHADOW-SYNC.md). SQLite/WASM is an evaluated future option, not a prerequisite: the existing IndexedDB foundation should be normalized and measured before adding another database runtime.

## Status

Active V1 development.

## Operational completion

The current build includes historical wealth snapshots, cached/live FX handling, dashboard workspace controls, account connection lifecycle, payment intents and reconciliation, local CSV/XLSX statement import, local receipt OCR, offline bank-sync queueing, anonymous-session email linking, PWA health handling, exports, and static/domain smoke checks.

Production provider credentials remain server-side. OmniPocket does not treat an external bank-app or USSD handoff as successful until provider/bank activity can be reconciled.

## Production hardening

The bank pipeline uses Supabase as the canonical provider-data boundary and the PWA as a local projection. Bank sync has explicit freshness/reconciliation state, transaction provenance, duplicate fingerprints, provider adapters, webhook event persistence and operational diagnostics. See [docs/IMPLEMENTATION-40.md](docs/IMPLEMENTATION-40.md) for the complete 40-item implementation map.

## Deployment

`pages.yml` generates `_build.js` at deploy time and **fails the build** if these GitHub repository variables are missing (Settings → Secrets and variables → Actions → Variables):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `MONO_PUBLIC_KEY` (optional)

Locally, `_build.js` carries committed defaults so the app runs without setup.

Database changes are applied with `supabase db push`; migrations are the only source of truth for the schema, and `npm test` fails if an edge function writes a column no migration creates.
