-- Reconcile bank-sync/payment schema used by the scheduler with migration history.
-- Idempotent so it is safe on environments where these objects already exist.
create table if not exists public.bank_sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.bank_connections(id) on delete cascade,
  provider text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running','success','error','skipped')),
  imported_count integer not null default 0,
  duplicate_count integer not null default 0,
  reconciled_count integer not null default 0,
  error text,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists bank_sync_runs_connection_started_idx
  on public.bank_sync_runs(connection_id, started_at desc);
create index if not exists bank_sync_runs_user_started_idx
  on public.bank_sync_runs(user_id, started_at desc);
alter table public.bank_sync_runs enable row level security;
drop policy if exists "Users can read own bank sync runs" on public.bank_sync_runs;
create policy "Users can read own bank sync runs" on public.bank_sync_runs
  for select to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.omnipocket_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_account_id text,
  provider text not null default 'demo',
  provider_payment_id text,
  provider_reference text,
  status text not null default 'draft' check (status in ('draft','awaiting_user','initiated','pending','completed','failed','cancelled','needs_reconciliation')),
  amount_minor bigint not null,
  currency text not null default 'NGN',
  recipient_name text,
  recipient_bank_code text,
  recipient_bank_name text,
  recipient_account_number text,
  narration text,
  method text not null default 'external_handoff',
  external_url text,
  created_at timestamptz not null default now(),
  initiated_at timestamptz,
  completed_at timestamptz,
  last_verified_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.omnipocket_payments enable row level security;
drop policy if exists "Users can read own omnipocket payments" on public.omnipocket_payments;
create policy "Users can read own omnipocket payments" on public.omnipocket_payments
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create own omnipocket payments" on public.omnipocket_payments;
create policy "Users can create own omnipocket payments" on public.omnipocket_payments
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own omnipocket payments" on public.omnipocket_payments;
create policy "Users can update own omnipocket payments" on public.omnipocket_payments
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.bank_transactions
  add column if not exists dedupe_key text,
  add column if not exists reconciliation_status text not null default 'unmatched',
  add column if not exists matched_local_transaction_id text,
  add column if not exists posted_at timestamptz,
  add column if not exists is_pending boolean not null default false,
  add column if not exists matched_payment_id uuid references public.omnipocket_payments(id) on delete set null;

create index if not exists bank_transactions_dedupe_key_idx
  on public.bank_transactions(dedupe_key) where dedupe_key is not null;
create index if not exists bank_transactions_matched_payment_idx
  on public.bank_transactions(matched_payment_id) where matched_payment_id is not null;
