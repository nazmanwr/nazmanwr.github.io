-- ===========================================================================
-- bidder-area.sql — the courier's fields on a bidder
--
-- Run this in the Supabase SQL editor, then re-run winner-email.sql so the
-- email to you carries the new fields.
--
-- A courier does not route on a free-text address. It routes on a thana inside
-- a district, and that pair is also what decides the delivery charge. Asking
-- for it at sign-up, from a fixed list, is the difference between a parcel
-- that arrives and one that comes back.
--
-- Nullable on purpose: bidders who signed up before this exist already, and
-- must not be broken by it. They simply have no area recorded, and you ask
-- them for it when the time comes.
-- ===========================================================================

alter table public.bidders add column if not exists alt_phone text;
alter table public.bidders add column if not exists district  text;
alter table public.bidders add column if not exists thana     text;

-- public_bids is rebuilt because a view does not pick up new columns on its
-- own. It exposes no more than before: a first name and a last initial. The
-- area, like the phone and the address, stays unreadable to the public.

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
