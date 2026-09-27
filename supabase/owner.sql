-- ===========================================================================
-- owner.sql — who is allowed to put an auction up
--
-- Run this in the Supabase SQL editor after schema.sql.
--
-- schema.sql deliberately gave nobody permission to create an auction, so that
-- the question "who may" is answered on purpose rather than by omission. This
-- answers it: one email address.
--
-- The check is on the signed-in token, not on anything the browser sends, so
-- it cannot be talked around from the page. Anyone else who signs in — a
-- bidder, or a stranger who finds the admin URL — is refused by the database
-- no matter what their browser asks for.
-- ===========================================================================

drop policy if exists auctions_owner_write on public.auctions;

create policy auctions_owner_write on public.auctions
  for all
  to authenticated
  using      (auth.jwt() ->> 'email' = 'nazm.anwr@gmail.com')
  with check (auth.jwt() ->> 'email' = 'nazm.anwr@gmail.com');

-- --- Somewhere to put uploaded photographs ---------------------------------
-- Artworks chosen from the catalogue already live on the site. A photograph
-- uploaded from a phone needs a home, and it should be a real file with its
-- own URL rather than a few hundred kilobytes of text inside the auction row.

insert into storage.buckets (id, name, public)
values ('auction', 'auction', true)
on conflict (id) do nothing;

drop policy if exists "auction images are readable" on storage.objects;
create policy "auction images are readable" on storage.objects
  for select using (bucket_id = 'auction');

drop policy if exists "only the owner uploads auction images" on storage.objects;
create policy "only the owner uploads auction images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'auction'
    and auth.jwt() ->> 'email' = 'nazm.anwr@gmail.com'
  );

-- Bids arrive live rather than on a refresh. Without this the page still
-- works, it just polls instead.
do $$
begin
  alter publication supabase_realtime add table public.bids;
exception
  when duplicate_object then null;   -- already added, nothing to do
end
$$;

-- --- Closing on time --------------------------------------------------------
-- close_due_auctions() in schema.sql decides the winner, but something has to
-- call it. A minute's granularity is plenty: the close only ever moves later,
-- and place_bid() refuses a bid past ends_at whether or not the row has been
-- marked closed yet. This only governs when the winner is announced.
--
-- Needs pg_cron: Database -> Extensions -> pg_cron -> enable, before running
-- this. Without it the block below says so and changes nothing.

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron is not enabled, so nothing will close automatically. Turn it on under Database -> Extensions and run this file again.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'close-due-auctions') then
    perform cron.unschedule('close-due-auctions');
  end if;

  perform cron.schedule(
    'close-due-auctions',
    '* * * * *',
    'select public.close_due_auctions();'
  );
end
$$;
