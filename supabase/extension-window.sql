-- ===========================================================================
-- extension-window.sql — the anti-sniping window becomes a setting
--
-- Run this in the Supabase SQL editor. Safe to run at any time: existing
-- auctions keep the three hours they were created under, because that is the
-- column's default.
--
-- Until now the window was three hours, written into place_bid() and into the
-- page. Three hours is right for a lot running over several days and far too
-- long for one running an evening, where it means the auction cannot end while
-- anyone is still awake. So it moves out of the code and onto the auction.
--
-- The rule itself does not change: a bid landing inside the window pushes the
-- close to that bid's time plus the window, so a run of late bids keeps walking
-- the deadline forward and nothing can be won in the final seconds.
-- ===========================================================================

alter table public.auctions
  add column if not exists extension_minutes integer not null default 180;

alter table public.auctions
  drop constraint if exists auctions_extension_sane;

-- One minute to one day. Zero would remove sniping protection entirely, which
-- should be a decision made in the open rather than by typing 0 into a box.
alter table public.auctions
  add constraint auctions_extension_sane
  check (extension_minutes between 1 and 1440);

-- --- place_bid, with the window read from the auction ------------------------
-- Unchanged from schema.sql except for where v_window comes from.

create or replace function public.place_bid(
  p_auction_id uuid,
  p_amount     numeric
)
returns table (bid_id uuid, new_ends_at timestamptz, highest numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auction   public.auctions%rowtype;
  v_highest   numeric;
  v_minimum   numeric;
  v_bid_id    uuid;
  v_window    interval;
begin
  if auth.uid() is null then
    raise exception 'You need to be signed in to bid.' using errcode = '28000';
  end if;

  if not exists (select 1 from public.bidders where id = auth.uid()) then
    raise exception 'Finish signing up before bidding.' using errcode = '28000';
  end if;

  -- Lock the row: two people bidding in the same instant must queue, or both
  -- could pass the "is this high enough" check against the same old highest.
  select * into v_auction
  from public.auctions
  where id = p_auction_id
  for update;

  if not found then
    raise exception 'That auction does not exist.';
  end if;

  v_window := make_interval(mins => coalesce(v_auction.extension_minutes, 180));

  if v_auction.status = 'closed' or now() >= v_auction.ends_at then
    raise exception 'This auction has closed.';
  end if;

  if now() < v_auction.starts_at then
    raise exception 'This auction has not opened yet.';
  end if;

  select max(amount) into v_highest
  from public.bids where auction_id = p_auction_id;

  v_minimum := case
                 when v_highest is null then v_auction.start_price
                 else v_highest + v_auction.increment
               end;

  if p_amount < v_minimum then
    raise exception 'The lowest you can bid now is %.', v_minimum
      using errcode = '22003';
  end if;

  insert into public.bids (auction_id, bidder_id, amount)
  values (p_auction_id, auth.uid(), p_amount)
  returning id into v_bid_id;

  -- now() is the database clock, so a browser with the wrong time — or a
  -- deliberately wrong one — changes nothing.
  if v_auction.ends_at - now() <= v_window then
    update public.auctions
       set ends_at = now() + v_window,
           status  = 'live'
     where id = p_auction_id
    returning ends_at into v_auction.ends_at;
  else
    update public.auctions
       set status = 'live'
     where id = p_auction_id and status <> 'live';
  end if;

  return query select v_bid_id, v_auction.ends_at, p_amount;
end;
$fn$;
