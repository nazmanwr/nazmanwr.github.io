-- ===========================================================================
-- no-self-bidding.sql — the seller does not bid on his own artwork
--
-- Run this in the Supabase SQL editor. It is safe to run while an auction is
-- live: it changes nothing about bids already placed, and takes effect from
-- the next one.
--
-- Why it exists: the owner signs in to the admin screen, and that same signed-
-- in session is a perfectly good bidding session as far as place_bid() is
-- concerned. So a stray tap on +1000 while looking at the page would enter a
-- real bid from the seller. Even entirely by accident that is shill bidding,
-- and it is the kind of thing that is impossible to explain afterwards to
-- someone who lost by one increment.
--
-- The check reads auth.users rather than the bidders table, because that is
-- the address Supabase actually verified. What someone typed into the sign-up
-- form is not proof of anything.
-- ===========================================================================

create or replace function public.reject_seller_bid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from auth.users u
    where u.id = new.bidder_id
      and lower(u.email) = 'nazm.anwr@gmail.com'
  ) then
    raise exception 'The seller cannot bid on his own artwork.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- BEFORE INSERT, so the refusal happens before a row exists rather than being
-- cleaned up afterwards. place_bid() is SECURITY DEFINER and inserts directly
-- into bids, so the trigger is the one place that catches every route in.

drop trigger if exists bids_reject_seller on public.bids;

create trigger bids_reject_seller
  before insert on public.bids
  for each row
  execute function public.reject_seller_bid();
