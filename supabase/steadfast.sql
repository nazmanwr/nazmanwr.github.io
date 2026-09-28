-- ===========================================================================
-- steadfast.sql — handing the winner's parcel to the courier
--
-- Run this after winner-email.sql. It adds a button's worth of machinery: the
-- admin page asks the database for the winner's dispatch details, you check
-- them, and one call creates the consignment at Steadfast.
--
-- BEFORE RUNNING, put your two Steadfast keys in the vault. SQL Editor, once:
--
--     select vault.create_secret('YOUR_API_KEY',    'steadfast_api_key');
--     select vault.create_secret('YOUR_SECRET_KEY', 'steadfast_secret_key');
--
-- Both come from the Steadfast merchant portal under API settings. They never
-- touch the website: the admin page is public, like every file on a static
-- host, so the keys stay here and the page only ever asks this database to act.
--
-- If Steadfast tell you to use a different host, change it without editing
-- this file:
--
--     select vault.create_secret('https://portal.steadfast.com.bd/api/v1',
--                                'steadfast_base_url');
--
-- ===========================================================================

-- --- What has been sent, so nothing is sent twice ---------------------------

create table if not exists public.dispatches (
  auction_id     uuid primary key references public.auctions(id) on delete cascade,
  invoice        text not null,
  cod_amount     numeric(12,2) not null,
  request_id     bigint,                   -- pg_net's handle
  consignment_id text,                     -- filled once Steadfast answers
  tracking_code  text,
  status         text not null default 'sent',
  note           text,
  created_at     timestamptz not null default now()
);

alter table public.dispatches enable row level security;
-- No policy: unreachable with the publishable key. Reached only through the
-- functions below, which check who is asking.

-- --- Who is allowed ---------------------------------------------------------
-- The same single address as owner.sql. Checked on the signed-in token, so it
-- cannot be talked around from a browser.

create or replace function public.is_owner()
returns boolean
language sql
stable
as $fn$
  select coalesce(auth.jwt() ->> 'email', '') = 'nazm.anwr@gmail.com';
$fn$;

-- --- What the admin page shows before you press the button ------------------
-- bidders stays closed to everyone including you; this hands over exactly the
-- one winner's dispatch fields, and only to you.

create or replace function public.dispatch_details(p_auction_id uuid)
returns table (
  title          text,
  spec           text,
  image_path     text,
  amount         numeric,
  full_name      text,
  phone          text,
  alt_phone      text,
  area           text,
  inside_dhaka   boolean,
  address        text,
  email          text,
  already_sent   boolean,
  consignment_id text,
  tracking_code  text
)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_owner() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  return query
  select
    a.title,
    nullif(concat_ws(' · ', a.medium, a.size), ''),
    a.image_path,
    b.amount,
    d.full_name,
    d.phone,
    d.alt_phone,
    nullif(concat_ws(', ', d.thana, d.district), ''),
    -- A suggestion, not a verdict: the page lets you change it, because the
    -- earliest bidders signed up before the district was ever asked for.
    coalesce(d.district = 'Dhaka', false),
    d.address,
    coalesce(u.email, d.email),
    (s.auction_id is not null),
    s.consignment_id,
    s.tracking_code
  from public.auctions a
  join public.bids    b on b.id = a.winning_bid_id
  join public.bidders d on d.id = b.bidder_id
  left join auth.users u on u.id = b.bidder_id
  left join public.dispatches s on s.auction_id = a.id
  where a.id = p_auction_id;
end;
$fn$;

-- --- The most recent closed auction, so the page has something to open on ---

create or replace function public.latest_dispatchable()
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  if not public.is_owner() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  select a.id into v_id
  from public.auctions a
  where a.status = 'closed' and a.winning_bid_id is not null
  order by a.ends_at desc
  limit 1;

  return v_id;
end;
$fn$;

-- --- Phone numbers ----------------------------------------------------------
-- Typed as 01712345678; couriers and WhatsApp both want it without decoration.
-- Strips spaces and dashes, and reduces +8801… / 8801… to the 01… form the
-- portal expects.

create or replace function public.bd_phone(p_raw text)
returns text
language sql
immutable
as $fn$
  select case
           when digits like '880%' and length(digits) = 13 then '0' || right(digits, 10)
           when digits like '0%'   and length(digits) = 11 then digits
           else digits
         end
  from (select regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') as digits) t;
$fn$;

-- --- Creating the consignment ------------------------------------------------

create or replace function public.send_to_steadfast(
  p_auction_id uuid,
  p_cod        numeric,
  p_note       text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_api     text;
  v_secret  text;
  v_base    text;
  v_invoice text;
  v_row     record;
  v_request bigint;
begin
  if not public.is_owner() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  if exists (select 1 from public.dispatches where auction_id = p_auction_id) then
    raise exception 'This one has already gone to Steadfast.';
  end if;

  if p_cod is null or p_cod <= 0 then
    raise exception 'Set the amount to collect.';
  end if;

  select decrypted_secret into v_api
    from vault.decrypted_secrets where name = 'steadfast_api_key';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'steadfast_secret_key';
  select decrypted_secret into v_base
    from vault.decrypted_secrets where name = 'steadfast_base_url';

  if v_api is null or v_secret is null then
    raise exception 'The Steadfast keys are not in the vault yet.';
  end if;

  v_base := coalesce(v_base, 'https://portal.packzy.com/api/v1');

  select d.full_name, d.phone,
         concat_ws(', ', d.address, d.thana, d.district) as address
    into v_row
  from public.auctions a
  join public.bids    b on b.id = a.winning_bid_id
  join public.bidders d on d.id = b.bidder_id
  where a.id = p_auction_id;

  if not found then
    raise exception 'No winner on that auction.';
  end if;

  -- Steadfast want an invoice unique to the merchant. The auction's own id is
  -- already unique and already means something when you go looking.
  v_invoice := 'NA-' || left(replace(p_auction_id::text, '-', ''), 10);

  select net.http_post(
    url     := v_base || '/create_order',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Api-Key',      v_api,
                 'Secret-Key',   v_secret
               ),
    body    := jsonb_build_object(
                 'invoice',           v_invoice,
                 'recipient_name',    v_row.full_name,
                 'recipient_phone',   public.bd_phone(v_row.phone),
                 'recipient_address', v_row.address,
                 'cod_amount',        p_cod,
                 'note',              coalesce(p_note, '')
               ),
    timeout_milliseconds := 10000
  ) into v_request;

  insert into public.dispatches (auction_id, invoice, cod_amount, request_id, note)
  values (p_auction_id, v_invoice, p_cod, v_request, p_note);

  return v_request;
end;
$fn$;

-- --- What Steadfast said -----------------------------------------------------
-- pg_net answers asynchronously, so the page asks again a moment after
-- pressing the button.

create or replace function public.steadfast_result(p_auction_id uuid)
returns table (state text, detail text, consignment_id text, tracking_code text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row   record;
  v_resp  record;
  v_body  jsonb;
  v_cons  text;
  v_track text;
begin
  if not public.is_owner() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  select * into v_row from public.dispatches where auction_id = p_auction_id;
  if not found then
    return query select 'none'::text, 'Nothing has been sent.'::text, null::text, null::text;
    return;
  end if;

  if v_row.consignment_id is not null then
    return query select 'done'::text, 'Already created.'::text,
                        v_row.consignment_id, v_row.tracking_code;
    return;
  end if;

  select status_code, content into v_resp
  from net._http_response where id = v_row.request_id;

  if not found then
    return query select 'waiting'::text, 'Steadfast has not answered yet.'::text,
                        null::text, null::text;
    return;
  end if;

  begin
    v_body := v_resp.content::jsonb;
  exception when others then
    v_body := null;
  end;

  if v_resp.status_code between 200 and 299 and v_body is not null then
    update public.dispatches
       set consignment_id = v_body #>> '{consignment,consignment_id}',
           tracking_code  = v_body #>> '{consignment,tracking_code}',
           status         = 'created'
     where auction_id = p_auction_id
    returning consignment_id, tracking_code into v_cons, v_track;

    return query select 'done'::text, 'Consignment created.'::text, v_cons, v_track;
    return;
  end if;

  -- Refused. Keep the row so the reason is visible, but let it be tried again.
  update public.dispatches set status = 'failed' where auction_id = p_auction_id;

  return query select 'failed'::text,
                      coalesce(left(v_resp.content, 400), 'No reply body.'),
                      null::text, null::text;
end;
$fn$;

-- --- Letting a refused one be tried again -----------------------------------

create or replace function public.clear_dispatch(p_auction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_owner() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  delete from public.dispatches
   where auction_id = p_auction_id and consignment_id is null;
end;
$fn$;

-- --- Who may call these ------------------------------------------------------
-- Each one checks is_owner() for itself, so they are safe to expose to signed-
-- in users — but not to anonymous ones, and never to PUBLIC by default.

revoke all on function public.dispatch_details(uuid)          from public, anon;
revoke all on function public.latest_dispatchable()           from public, anon;
revoke all on function public.send_to_steadfast(uuid, numeric, text) from public, anon;
revoke all on function public.steadfast_result(uuid)          from public, anon;
revoke all on function public.clear_dispatch(uuid)            from public, anon;

grant execute on function public.dispatch_details(uuid)          to authenticated;
grant execute on function public.latest_dispatchable()           to authenticated;
grant execute on function public.send_to_steadfast(uuid, numeric, text) to authenticated;
grant execute on function public.steadfast_result(uuid)          to authenticated;
grant execute on function public.clear_dispatch(uuid)            to authenticated;
