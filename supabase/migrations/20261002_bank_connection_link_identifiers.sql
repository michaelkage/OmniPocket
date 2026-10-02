-- OmniPocket: local-account linkage columns on bank_connections.
--
-- mono-connect-link and mono-webhook both write client_account_id and
-- provider_customer_id when materialising a connection, but no earlier
-- migration created the columns, so every Connect Link completion failed with
-- "column client_account_id of relation bank_connections does not exist".
--
-- client_account_id   -> the OmniPocket account this connection projects into
-- provider_customer_id -> the Mono customer that owns the linked account

alter table public.bank_connections
  add column if not exists client_account_id text,
  add column if not exists provider_customer_id text;

-- Not unique: re-linking an account to a new Mono account must not require
-- clearing the previous connection first.
create index if not exists bank_connections_client_account_idx
  on public.bank_connections(client_account_id)
  where client_account_id is not null;

create index if not exists bank_connections_provider_customer_idx
  on public.bank_connections(provider_customer_id)
  where provider_customer_id is not null;