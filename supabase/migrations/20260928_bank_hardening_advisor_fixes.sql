create policy "Webhook events are service-role only" on public.bank_webhook_events
for all to authenticated
using (false)
with check (false);

create index if not exists bank_sync_events_user_idx on public.bank_sync_events(user_id);
create index if not exists bank_webhook_events_connection_idx on public.bank_webhook_events(connection_id);
create index if not exists reconciliation_events_connection_idx on public.reconciliation_events(connection_id);
