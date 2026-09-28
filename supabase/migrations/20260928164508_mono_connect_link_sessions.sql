create table if not exists public.mono_link_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  customer_name text not null,
  customer_email text not null,
  client_account_id text,
  status text not null default 'initiated' check (status in ('initiated','linked','synced','failed','expired')),
  mono_customer_id text,
  mono_account_id text,
  mono_url text,
  error_message text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  completed_at timestamptz
);

create index if not exists mono_link_sessions_user_idx on public.mono_link_sessions(user_id);
create index if not exists mono_link_sessions_reference_idx on public.mono_link_sessions(reference);

alter table public.mono_link_sessions enable row level security;

drop policy if exists "Users can read own mono link sessions" on public.mono_link_sessions;
create policy "Users can read own mono link sessions"
  on public.mono_link_sessions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create own mono link sessions" on public.mono_link_sessions;
create policy "Users can create own mono link sessions"
  on public.mono_link_sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own mono link sessions" on public.mono_link_sessions;
create policy "Users can update own mono link sessions"
  on public.mono_link_sessions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
