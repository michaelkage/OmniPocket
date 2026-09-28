drop policy if exists "Users can create own bank sync events" on public.bank_sync_events;
create policy "Users can create own bank sync events" on public.bank_sync_events
for insert to authenticated
with check ((select auth.uid()) = user_id);
