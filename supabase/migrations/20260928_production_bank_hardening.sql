-- OmniPocket production bank-sync hardening.
-- Canonical provider records live in Supabase; the PWA stores only a projection.
alter table public.bank_connections
  add column if not exists sync_status text not null default 'connected',
  add column if not exists provider_balance_minor bigint,
  add column if not exists provider_balance_at timestamptz,
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists disconnected_at timestamptz;

alter table public.bank_transactions
  add column if not exists provider_status text,
  add column if not exists provenance text not null default 'bank_sync',
  add column if not exists raw_retained_until timestamptz;

create table if not exists public.bank_sync_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  connection_id uuid references public.bank_connections(id) on delete cascade,
  provider text not null default 'mono',
  event_type text not null,
  status text not null default 'received',
  started_at timestamptz,
  completed_at timestamptz,
  imported_count integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists bank_sync_events_connection_idx on public.bank_sync_events(connection_id, created_at desc);
alter table public.bank_sync_events enable row level security;
drop policy if exists "Users can read own bank sync events" on public.bank_sync_events;
create policy "Users can read own bank sync events" on public.bank_sync_events for select to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.bank_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mono',
  event_id text,
  event_type text,
  signature_valid boolean not null default false,
  connection_id uuid references public.bank_connections(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider,event_id)
);
create index if not exists bank_webhook_events_received_idx on public.bank_webhook_events(received_at desc);
alter table public.bank_webhook_events enable row level security;

create table if not exists public.reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.bank_connections(id) on delete set null,
  local_account_id text,
  currency text,
  provider_balance numeric,
  local_balance numeric,
  difference numeric,
  reason text,
  status text not null default 'open' check (status in ('open','investigating','resolved','ignored')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists reconciliation_events_user_idx on public.reconciliation_events(user_id, created_at desc);
alter table public.reconciliation_events enable row level security;
drop policy if exists "Users can read own reconciliation events" on public.reconciliation_events;
create policy "Users can read own reconciliation events" on public.reconciliation_events for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create own reconciliation events" on public.reconciliation_events;
create policy "Users can create own reconciliation events" on public.reconciliation_events for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own reconciliation events" on public.reconciliation_events;
create policy "Users can update own reconciliation events" on public.reconciliation_events for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create index if not exists bank_transactions_retention_idx on public.bank_transactions(raw_retained_until);
