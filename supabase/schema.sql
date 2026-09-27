-- ===========================================================================
-- Auction schema for nazmanwr.com
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New
-- query -> paste -> Run).
--
-- The rule that matters most is in place_bid(): every check uses now(), the
-- database's own clock. Nothing about a bid is decided in the browser, because
-- anything decided in a browser can be edited by whoever is sitting at it —
-- and these bids are money.
-- ===========================================================================

create extension if not exists pgcrypto;

-- --- Auctions --------------------------------------------------------------
-- One row per artwork put up for auction. Only one should be live at a time;
-- nothing enforces that, it is just how it is meant to be used.

create table if not exists public.auctions (
  id               uuid primary key default gen_random_uuid(),
  title            text        not null,
  medium           text,
  size             text,
  note             text,                       -- optional line under the title
  image_path       text        not null,       -- e.g. /assets/img/auction/01.jpg
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,       -- moves when a late bid lands
  scheduled_end_at timestamptz not null,       -- what you originally set
  -- The two numbers set when an artwork goes up.
  --   start_price = "starting bid": the least the first bid may be.
  --   increment   = "lowest bid": the smallest raise allowed after that, so
  --                 the next bid must be at least highest + increment.
  start_price      numeric(12,2) not null,
  increment        numeric(12,2) not null default 1000,
  status           text        not null default 'scheduled'
                   check (status in ('scheduled','live','closed')),
  winning_bid_id   uuid,
  created_at       timestamptz not null default now()
);

-- --- Bidders ---------------------------------------------------------------
-- Personal data. Phone and home address are in here, so this table is never
-- readable by the public — see the policies further down. A bidder can read
-- and write only their own row.

create table if not exists public.bidders (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  phone      text not null,
  address    text not null,
  email      text not null,
  created_at timestamptz not null default now()
);

-- --- Bids ------------------------------------------------------------------

create table if not exists public.bids (
  id         uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions(id) on delete cascade,
  bidder_id  uuid not null references public.bidders(id) on delete cascade,
  amount     numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists bids_auction_amount_idx
  on public.bids (auction_id, amount desc, created_at asc);

-- --- What the public may see ------------------------------------------------
-- The bid history is public so the page can show the auction heating up, but
-- only a first name and a last initial go out. Never the phone, never the
-- address, never the email.

create or replace view public.public_bids
with (security_invoker = off) as
  select
    b.id,
    b.auction_id,
    b.amount,
    b.created_at,
    split_part(d.full_name, ' ', 1) || ' ' ||
      case when position(' ' in d.full_name) > 0
           then left(split_part(d.full_name, ' ', 2), 1) || '.'
           else '' end as display_name,
    b.bidder_id
  from public.bids b
  join public.bidders d on d.id = b.bidder_id;

-- ===========================================================================
-- place_bid — the only way a bid may be created
-- ===========================================================================
--
-- Anti-sniping, exactly as specified: a bid landing inside the final 3 hours
-- pushes the close to (bid time + 3 hours). A bid before that window leaves the
-- close where it is. Because the new close is always measured from the bid, a
-- run of late bids keeps walking the deadline forward, which is the point —
-- nobody can win by bidding in the last ten seconds.
--
-- Returns the new end time so the page can update its countdown immediately.

create or replace function public.place_bid(
  p_auction_id uuid,
  p_amount     numeric
)
returns table (bid_id uuid, new_ends_at timestamptz, highest numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auction   public.auctions%rowtype;
  v_highest   numeric;
  v_minimum   numeric;
  v_bid_id    uuid;
  v_window    constant interval := interval '3 hours';
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

  if v_auction.status = 'closed' or now() >= v_auction.ends_at then
    raise exception 'This auction has closed.';
  end if;

  if now() < v_auction.starts_at then
    raise exception 'This auction has not opened yet.';
  end if;

  select max(amount) into v_highest
  from public.bids where auction_id = p_auction_id;

  -- First bid must meet the start price; after that, beat the highest by at
  -- least one increment.
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

  -- The extension. now() is the database clock, so a browser with the wrong
  -- time — or a deliberately wrong one — changes nothing.
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
$$;

-- ===========================================================================
-- close_due_auctions — run on a schedule
-- ===========================================================================
-- Marks anything past its end time as closed and records the winner: highest
-- amount, and on a tie the one that arrived first.

create or replace function public.close_due_auctions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auction public.auctions%rowtype;
  v_bid_id  uuid;
  v_count   integer := 0;
begin
  for v_auction in
    select * from public.auctions
    where status <> 'closed' and now() >= ends_at
    for update
  loop
    select id into v_bid_id
    from public.bids
    where auction_id = v_auction.id
    order by amount desc, created_at asc
    limit 1;

    update public.auctions
       set status = 'closed', winning_bid_id = v_bid_id
     where id = v_auction.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ===========================================================================
-- Row level security
-- ===========================================================================

alter table public.auctions enable row level security;
alter table public.bidders  enable row level security;
alter table public.bids     enable row level security;

-- Auctions: anyone may look.
drop policy if exists auctions_public_read on public.auctions;
create policy auctions_public_read on public.auctions
  for select using (true);

-- Bidders: your own row and nobody else's. This is what keeps home addresses
-- private — without it, anyone holding the public key could read the table.
drop policy if exists bidders_self_read on public.bidders;
create policy bidders_self_read on public.bidders
  for select using (auth.uid() = id);

drop policy if exists bidders_self_write on public.bidders;
create policy bidders_self_write on public.bidders
  for insert with check (auth.uid() = id);

drop policy if exists bidders_self_update on public.bidders;
create policy bidders_self_update on public.bidders
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Bids: readable (the page shows the history), but never writable directly —
-- every insert has to go through place_bid so the rules cannot be skipped.
drop policy if exists bids_public_read on public.bids;
create policy bids_public_read on public.bids
  for select using (true);

grant select on public.public_bids to anon, authenticated;
grant execute on function public.place_bid(uuid, numeric) to authenticated;

-- Deliberately NOT granted: insert/update/delete on bids and auctions.
-- Bids go through place_bid; auctions are managed from the dashboard or the
-- admin page using the service key, which never goes near a browser.
