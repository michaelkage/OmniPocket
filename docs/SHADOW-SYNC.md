# Project Shadow-Sync — implementation design

## Objective

Make OmniPocket reliable under intermittent connectivity without weakening its accounting invariants. Local writes must be durable before the UI reports that they were saved. Sync must be idempotent, resumable, observable, and safe when the same work is delivered more than once.

## What exists today

- `storage.js` uses IndexedDB schema v5 with normalized `accounts`, `transactions`, `goals`, `snapshots`, `deletedExternalTransactions`, `meta`, and `outbox` stores. The V2 monolithic `state/current` snapshot remains available as a migration source until the normalized write transaction commits.
- `storage.js` reconstructs the current domain state from those stores on startup. `getTransactionPage()` reads bounded pages from the compound `[date, id]` index with a stable continuation cursor; Activity now uses it for initial results and Load more, including search, date, category, type, lifecycle status, review-only, and account/transaction context filters.
- Activity renders 50 matching rows at a time and rejects stale in-flight filter responses. This bounds Activity's rendered page and query result, but startup still hydrates the full transaction collection for dashboards, reports, edits, imports, and domain calculations; total application memory is not yet bounded.
- IndexedDB schema v5 repairs missing transaction indexes on existing installations and adds stable source/destination account-date-id indexes. A streaming `getAccountBalanceSummary()` projection computes balances without materializing transaction rows; browser tests compare it against the domain engine. The projection is not yet wired into startup.
- Normalized saves compare per-record fingerprints and only `put` changed records or delete removed records, with all related changes committed in one IndexedDB transaction. A monotonic `stateVersion` is checked inside the same read/write transaction; stale tabs abort rather than silently replacing newer state. `BroadcastChannel` notifies other tabs after commit, and conflicted tabs are told to reload instead of writing a stale localStorage fallback. This avoids rewriting every unchanged financial record, although the current app still clones the in-memory state and computes fingerprints across records on save.
- `production-hardening.js` stores offline bank-refresh jobs in the IndexedDB outbox, migrates the legacy localStorage queue after commit, and no longer truncates it at 50 jobs.
- Supabase already owns the provider-data boundary: `bank_connections`, `bank_transactions`, `bank_sync_runs`, webhook/event tables and reconciliation/payment tables exist. Do not create a competing copy of provider bank data.
- Mono transaction import already has provider identity/deduplication and explicit reconciliation state. Preserve these semantics.

## Architectural decision

**Phase 1: normalized IndexedDB + durable outbox.** The initial implementation is now present on the Shadow-Sync branch. IndexedDB is already asynchronous, supported by the PWA target, and avoids shipping a second database engine. The normalized stores, changed-record writes, optimistic multi-tab write guard, cursor-backed Activity, and balance-projection foundation are in place. Full startup hydration and attachment separation remain follow-up work.

**Phase 2: append-only local operation journal and Supabase ingestion.** Treat immutable financial facts as events/operations. Use deterministic IDs and idempotency keys. Sync operations in batches, acknowledge only after the server transaction commits, then advance a per-user/device cursor. Keep the current Supabase provider tables canonical for Mono data.

**Phase 3: evaluate SQLite WASM + OPFS only if profiling justifies it.** Compare startup cost, storage quotas, Safari/iOS PWA behavior, backup/restore, worker integration, and large-ledger query performance against normalized IndexedDB. Do not promise gigabytes: browser quota and eviction remain browser-controlled and vary by device.

## Local schema proposal

Use a versioned IndexedDB database with stores along these lines:

| Store | Key | Purpose |
|---|---|---|
| `accounts` | accountId | Account metadata and materialized balance |
| `transactions` | transactionId | Immutable ledger facts and provenance |
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

### 1. Inventory and guardrails — in progress
- [x] Move the offline bank-refresh queue into the IndexedDB outbox.
- [x] Migrate the legacy queue only after the IndexedDB transaction commits.
- [x] Remove the arbitrary 50-job truncation and acknowledge completed jobs individually.
- [x] Add static contract checks for the durable outbox and service-worker cache version.
- [x] Create normalized IndexedDB stores for accounts, transactions, goals, snapshots, deleted-provider markers, and metadata.
- [x] Add account/date and provider-identity indexes for transaction history.
- [x] Migrate the V2 monolithic snapshot into normalized records atomically, deleting the old snapshot only in the successful transaction.
- [x] Write only changed records and remove deleted records within one atomic transaction.
- [x] Persist the post-migration domain shape during bootstrap.
- [ ] Map every remaining direct `localStorage` read/write and classify it as preference, transient UI state, legacy migration, or durable work queue.
- [ ] Add runtime tests proving no ledger transaction is reported saved before the IndexedDB transaction completes.
- [ ] Add a test proving a failed IndexedDB write never silently falls back to a stale snapshot and overwrites newer data.

### 2. Normalize IndexedDB — foundation implemented; performance work remains
- [x] Introduce database schema v3 and normalized entity stores.
- [x] Migrate the existing snapshot in a single atomic transaction; if it aborts, the old snapshot remains available for retry.
- [x] Add indexes for transaction date, account/date, stable account/date/id cursors, provider transaction identity, account currency, goal status, and snapshot date.
- [x] Upgrade existing transaction stores to schema v5 and create any missing indexes without recreating the store.
- [x] Add a streaming account-balance projection and browser parity test against the domain engine (not yet wired into startup).
- [x] Keep the outbox in the same database and preserve queued work across reloads.
- [x] Add runtime migration fixtures covering populated V2 databases and existing v4 transaction-store index upgrades; empty/interrupted-upgrade fault injection remains follow-up work.
- [x] Add cursor-backed transaction query APIs and migrate Activity filtering/load-more to IndexedDB pages; review and other full-history workflows still use the hydrated domain collection.
- [x] Route single-account transaction history through outgoing/incoming compound account/date/id indexes, merge both streams in descending order, and de-duplicate self-transfers; multi-account queries retain the date-index fallback.
- [x] Progressively render Activity results in 50-row batches from IndexedDB so the DOM does not grow with the full ledger.
- [ ] Move large receipt/OCR text and image blobs into a dedicated attachments store.
- [x] Add optimistic state-version checks to every normalized write; a stale tab aborts instead of overwriting newer ledger records.
- [x] Broadcast committed versions across tabs and warn stale tabs to reload; conflict writes never fall back to localStorage.
- [x] Keep a monotonic version tombstone when clearing the ledger so a stale tab cannot resurrect deleted records.

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

- [x] Durable offline bank-refresh jobs are stored in IndexedDB, not localStorage.
- [x] Financial records are stored in normalized IndexedDB object stores rather than a single serialized snapshot.
- [ ] Activity pages are cursor-paginated; remaining dashboards, reports, and edit/import workflows still hydrate the full ledger.
- [ ] Receipt OCR text and blobs are stored separately from frequently updated transaction metadata.
- [ ] Concurrent tabs cannot silently overwrite financial edits.
- A local transaction is acknowledged only after its IndexedDB transaction commits.
- Replaying any operation/batch produces no duplicate effect.
- A network timeout never advances the sync cursor or implies provider success.
- Conflicts in financial fields are surfaced for review; no silent overwrite.
- Migration is restart-safe and retains the old snapshot until the normalized IndexedDB transaction commits.
- Large transaction lists are paginated and do not require serializing the full ledger on every save.

## Explicit non-goals for the first release

- No Rust rewrite.
- No custom general-purpose CRDT framework.
- No SQLite/WASM dependency until benchmark evidence supports it.
- No client-side access to Mono secret keys or Supabase service-role keys.
- No automatic retry of non-idempotent payment initiation.
