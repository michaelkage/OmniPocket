create table if not exists public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'mono',
  mono_account_id text not null unique,
  status text not null default 'active' check (status in ('active','syncing','error','revoked')),
  institution_name text,
  account_name text,
  account_number_last4 text,
  currency text not null default 'NGN',
  account_type text,
  balance_minor bigint,
  data_status text,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.bank_connections(id) on delete cascade,
  mono_transaction_id text not null,
  type text not null check (type in ('credit','debit')),
  amount_minor bigint not null,
  currency text not null,
  narration text,
  category text,
  balance_minor bigint,
  transaction_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id, mono_transaction_id)
);

create index if not exists bank_connections_user_idx on public.bank_connections(user_id);
create index if not exists bank_transactions_user_idx on public.bank_transactions(user_id);
create index if not exists bank_transactions_connection_date_idx on public.bank_transactions(connection_id, transaction_at desc);

alter table public.bank_connections enable row level security;
alter table public.bank_transactions enable row level security;

drop policy if exists "Users can read own bank connections" on public.bank_connections;
create policy "Users can read own bank connections" on public.bank_connections for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create own bank connections" on public.bank_connections;
create policy "Users can create own bank connections" on public.bank_connections for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own bank connections" on public.bank_connections;
create policy "Users can update own bank connections" on public.bank_connections for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read own bank transactions" on public.bank_transactions;
create policy "Users can read own bank transactions" on public.bank_transactions for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create own bank transactions" on public.bank_transactions;
create policy "Users can create own bank transactions" on public.bank_transactions for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own bank transactions" on public.bank_transactions;
create policy "Users can update own bank transactions" on public.bank_transactions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.touch_bank_connection()
returns trigger
language plpgsql
set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists bank_connections_touch on public.bank_connections;
create trigger bank_connections_touch before update on public.bank_connections for each row execute function public.touch_bank_connection();
