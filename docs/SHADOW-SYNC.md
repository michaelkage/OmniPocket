# Project Shadow-Sync — implementation design

## Objective

Make OmniPocket reliable under intermittent connectivity without weakening its accounting invariants. Local writes must be durable before the UI reports that they were saved. Sync must be idempotent, resumable, observable, and safe when the same work is delivered more than once.

## What exists today

- `storage.js` already persists the application state asynchronously in IndexedDB and migrates the legacy `omnipocket.v1` localStorage snapshot after the IndexedDB commit.
- `app.js` still stores the domain state as one serialized snapshot under one IndexedDB key. This avoids synchronous localStorage writes but makes every save proportional to the full state size.
- `production-hardening.js` still stores its bank-refresh queue in localStorage and caps it at 50 jobs. This is a small but important durability gap.
- Supabase already owns the provider-data boundary: `bank_connections`, `bank_transactions`, `bank_sync_runs`, webhook/event tables and reconciliation/payment tables exist. Do not create a competing copy of provider bank data.
- Mono transaction import already has provider identity/deduplication and explicit reconciliation state. Preserve these semantics.

## Architectural decision

**Phase 1: normalized IndexedDB + durable outbox.** Do this before adopting SQLite/WASM. IndexedDB is already asynchronous, supported by the PWA target, and avoids shipping a second database engine. The current bottleneck is the monolithic snapshot and the localStorage queue, not the absence of SQL.

**Phase 2: append-only local operation journal and Supabase ingestion.** Treat immutable financial facts as events/operations. Use deterministic IDs and idempotency keys. Sync operations in batches, acknowledge only after the server transaction commits, then advance a per-user/device cursor. Keep the current Supabase provider tables canonical for Mono data.

**Phase 3: evaluate SQLite WASM + OPFS only if profiling justifies it.** Compare startup cost, storage quotas, Safari/iOS PWA behavior, backup/restore, worker integration, and large-ledger query performance against normalized IndexedDB. Do not promise gigabytes: browser quota and eviction remain browser-controlled and vary by device.

## Local schema proposal

Use a versioned IndexedDB database with stores along these lines:

| Store | Key | Purpose |
|---|---|---|
| `accounts` | accountId | Account metadata and materialized balance |
| `transactions` | transactionId | Immutable ledger facts and provenance |
| `transaction_events` | eventId | Append-only corrections, reversals, review and reconciliation events |
| `goals` | goalId | Goal configuration |
| `snapshots` | snapshotId | Historical wealth snapshots |
| `attachments` | attachmentId | Receipt/OCR metadata and blob references |
| `outbox` | operationId | Durable unsent local operations |
| `sync_meta` | scope/deviceId | Cursor, last attempt, last success, schema version |

Create indexes for account/date, transaction date, provider transaction identity, sync status, and outbox creation order. Keep large OCR text and image blobs out of the frequently rewritten account/transaction records. Apply related local changes in one IndexedDB transaction.

## Ledger and conflict rules

1. Generate a stable UUID for every local operation before persisting it. Reuse it on every retry.
2. Never use last-write-wins for amount, currency, account, or transaction identity.
3. A posted financial fact is immutable. Corrections are compensating entries or explicit amendment events with actor, timestamp, reason, and links to the original.
4. Concurrent independent additions commute because they have distinct operation IDs.
5. Duplicate delivery is a no-op enforced by a unique server-side idempotency constraint.
6. Account balances are projections derived from accepted ledger facts and adjustments; they are not independently merged as authoritative facts.
7. Conflicting edits to descriptive metadata may use a deterministic policy, but financial fields must enter a review/conflict state.
8. Provider transactions remain separate from user-authored ledger transactions until matching/reconciliation rules confirm the relationship.

This is an event-log/idempotency design with CRDT-like properties for independent additions. A general-purpose CRDT is not appropriate for silently merging financial values.

## Supabase ingestion contract

- Authenticate every batch and derive `user_id` from the verified session on the server; never trust a client-supplied owner ID.
- Accept a bounded batch of operations with `operation_id`, `device_id`, `schema_version`, `operation_type`, `entity_id`, `payload`, and client creation time.
- Enforce uniqueness on `(user_id, operation_id)`; a retry returns the original acknowledgement.
- Validate payload shape, supported currency, amount precision, ownership of referenced accounts, and allowed operation transitions.
- Commit each accepted batch atomically. Return per-operation accepted/duplicate/rejected outcomes.
- Do not expose service-role credentials to the browser. Apply RLS to exposed tables and ensure policies scope rows to the authenticated owner.
- Use a server-controlled cursor or acknowledged operation IDs. Do not advance the client cursor on a timeout or partial response.
- Keep provider webhooks and provider transaction ingestion on their existing trusted server path.

## Mono / USSD timeout recovery

A timeout means **outcome unknown**, not failed and not successful. Never create a second payment or mark the first as complete merely because the client timed out.

Recommended payment-intent lifecycle:

`draft → awaiting_user → initiated → pending_verification → completed | failed | needs_reconciliation`

- Persist the intent and provider reference before the external handoff.
- On timeout, preserve the same intent/reference and show a clear “Checking with your bank” / “Outcome not confirmed” state.
- Retry status lookup with bounded exponential backoff and jitter; retry reads freely within provider limits, but do not repeat a non-idempotent payment initiation.
- Use webhook events as reconciliation signals, not as proof without signature verification and idempotent event processing.
- After a defined verification window, move to `needs_reconciliation` and provide a manual refresh/support path. Do not leave an unbounded generic pending state.
- Only mark `completed` after authoritative provider/bank evidence is matched to the intent. A failed lookup remains unknown.
- Record every transition in an audit/event table with timestamps, provider reference, attempt count, and safe error classification.

## Delivery plan

### 1. Inventory and guardrails
- Map every direct `localStorage` read/write and classify it as preference, transient UI state, legacy migration, or durable work queue.
- Add tests proving no ledger transaction is reported saved before the IndexedDB transaction completes.
- Add a test proving a failed IndexedDB write never silently falls back to a stale snapshot and overwrites newer data.

### 2. Normalize IndexedDB
- Introduce a new database version and object stores.
- Migrate the existing snapshot in one resumable, idempotent migration.
- Keep the legacy snapshot until record counts and checksums match; only then mark migration complete and retire it.
- Add indexes and paginated reads so the UI does not load the entire history for every view.
- Move the bank-sync queue to the durable outbox; do not truncate queued work.

### 3. Implement outbox sync
- Add a sync worker/service module with single-flight locking, bounded batches, retry/backoff, jitter, online/visibility triggers, and an explicit manual retry.
- Keep local writes available while sync is offline.
- Add server-side idempotency and per-operation acknowledgements.
- Persist the last successful sync separately from last attempted sync.

### 4. Verify under failure
- Simulate offline → online, browser close during write, close during upload, duplicated batch, out-of-order batch, expired auth, provider 429/5xx, and two tabs editing concurrently.
- Verify no duplicated ledger entries, no lost outbox items, no balance drift, and no false provider success.
- Run the existing `npm test` suite plus migration, storage, and sync contract tests.

## Exit criteria

- No financial history or durable sync queue is stored in localStorage.
- A local transaction is acknowledged only after its IndexedDB transaction commits.
- Replaying any operation/batch produces no duplicate effect.
- A network timeout never advances the sync cursor or implies provider success.
- Conflicts in financial fields are surfaced for review; no silent overwrite.
- Migration is restart-safe and retains a recoverable source until verification passes.
- Large transaction lists are paginated and do not require serializing the full ledger on every save.

## Explicit non-goals for the first release

- No Rust rewrite.
- No custom general-purpose CRDT framework.
- No SQLite/WASM dependency until benchmark evidence supports it.
- No client-side access to Mono secret keys or Supabase service-role keys.
- No automatic retry of non-idempotent payment initiation.
