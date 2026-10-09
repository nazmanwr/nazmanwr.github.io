-- ===========================================================================
-- push.sql — the alert that arrives without the page being open
--
-- Run this after winner-email.sql and outbid-email.sql. It adds two alerts:
--
--   * a lot opens        -> everyone who asked to be told
--   * someone is outbid  -> everyone else who bid on that lot
--
-- Email already does the second, and email keeps doing it. This is the faster
-- half of the same message: an email is read when someone next opens their
-- inbox, and a lot can be lost in the hour before that. A phone alert is read
-- now. On the first auction someone was outbid and did not find out for eleven
-- hours.
--
-- WHY THERE IS AN EDGE FUNCTION
--
-- A web push is not an ordinary POST. The body has to be encrypted to a key
-- the phone generated, and the request signed with a key of ours, and Postgres
-- can do neither — pgcrypto has no P-256. So the database decides WHO is told
-- and WHAT they are told, writes it into push_queue, and pokes a small
-- function that does the sending. All the judgement stays here; only the
-- cryptography is over there.
--
-- BEFORE RUNNING, three things.
--
--   1. Database -> Extensions -> pg_net and pg_cron, both enabled. pg_net is
--      already on if the emails are working.
--
--   2. Deploy the function in supabase/functions/push-send and set its
--      secrets. The README beside it has the commands.
--
--   3. Put the shared secret in the vault — the same string the function has:
--
--        select vault.create_secret('SOME_LONG_RANDOM_STRING', 'push_shared_secret');
--
--      This is what stops a stranger calling the function and making every
--      phone that ever visited the site buzz. The function has no other door:
--      it checks this header before it reads anything.
--
--      If the project ever moves, the URL can be overridden without editing
--      this file:
--
--        select vault.create_secret('https://…/functions/v1/push-send',
--                                   'push_function_url');
-- ===========================================================================

-- --- Who has asked to be told -----------------------------------------------
-- One row per browser, not per person: the same person on a phone and on a
-- laptop is two rows, and is told on both. The endpoint is the address the
-- push service handed that browser, so it is the natural key.
--
-- bidder_id is filled in when the subscription is made by someone signed in.
-- It stays null for a visitor who has only asked to hear when a lot opens,
-- which is the point of letting them ask without an account.

create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  endpoint     text not null unique,
  p256dh       text not null,          -- the browser's public key
  auth         text not null,          -- and its shared secret
  bidder_id    uuid references auth.users(id) on delete set null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_subscriptions_bidder_idx
  on public.push_subscriptions (bidder_id);

-- --- What is waiting to go out ----------------------------------------------
-- A queue rather than a straight send, for the same reason mail_log exists:
-- when someone says they were not told, there is a row that says whether they
-- were. It also means a push service down for a minute costs nothing — the
-- rows stay pending and the next sweep sends them.

create table if not exists public.push_queue (
  id              bigint generated always as identity primary key,
  subscription_id bigint not null references public.push_subscriptions(id) on delete cascade,
  auction_id      uuid references public.auctions(id) on delete cascade,
  kind            text not null,                    -- 'live' | 'outbid'
  payload         jsonb not null,
  status          text not null default 'pending',  -- pending|sending|sent|failed
  detail          text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create index if not exists push_queue_pending_idx
  on public.push_queue (status, id);

create index if not exists push_queue_throttle_idx
  on public.push_queue (subscription_id, auction_id, kind, created_at desc);

alter table public.push_subscriptions enable row level security;
alter table public.push_queue         enable row level security;
-- No policies on either. An endpoint is the address that makes a stranger's
-- phone buzz, so neither table is readable with the publishable key at all.
-- Everything goes through the functions below.

-- ===========================================================================
-- Asking to be told
-- ===========================================================================
-- Called from the page by anyone, signed in or not. The browser has already
-- asked the person for permission by the time this runs — a subscription
-- cannot exist without it — so there is nobody to protect here except the
-- table itself, which is why this is a function and not an insert policy.

create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_endpoint is null or p_endpoint !~ '^https://' then
    raise exception 'That is not a push endpoint.';
  end if;

  if p_p256dh is null or p_auth is null then
    raise exception 'That subscription is missing its keys.';
  end if;

  insert into public.push_subscriptions (endpoint, p256dh, auth, bidder_id, user_agent)
  values (p_endpoint, p_p256dh, p_auth, auth.uid(), left(coalesce(p_user_agent, ''), 300))
  on conflict (endpoint) do update
     set p256dh       = excluded.p256dh,
         auth         = excluded.auth,
         -- Signing in later should attach the subscription to the account, but
         -- signing out must not detach it: a browser that has been promised
         -- alerts keeps getting them.
         bidder_id    = coalesce(excluded.bidder_id, public.push_subscriptions.bidder_id),
         user_agent   = excluded.user_agent,
         last_seen_at = now();
end;
$fn$;

create or replace function public.forget_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint;
end;
$fn$;

-- ===========================================================================
-- Deciding who is told
-- ===========================================================================
-- p_audience is 'everyone' (a lot has opened) or 'bidders' (something has
-- happened to the lot they are bidding on).
--
-- The throttle is per browser, per lot, per kind. Someone raising four times
-- in four seconds — which happened on the first auction — should make a phone
-- buzz once, not four times. The message carries the price at the moment it is
-- built, so the one that gets through is the true one.

create or replace function public.queue_push(
  p_auction_id uuid,
  p_kind       text,
  p_payload    jsonb,
  p_audience   text default 'everyone',
  p_exclude    uuid default null,
  p_throttle   interval default interval '90 seconds'
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  insert into public.push_queue (subscription_id, auction_id, kind, payload)
  select s.id, p_auction_id, p_kind, p_payload
  from public.push_subscriptions s
  where (
          p_audience = 'everyone'
          or s.bidder_id in (
               select b.bidder_id from public.bids b where b.auction_id = p_auction_id
             )
        )
    and (p_exclude is null or s.bidder_id is distinct from p_exclude)
    and not exists (
      select 1 from public.push_queue q
      where q.subscription_id = s.id
        and q.auction_id      = p_auction_id
        and q.kind            = p_kind
        and q.created_at      > now() - p_throttle
    );

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ===========================================================================
-- Poking the sender
-- ===========================================================================
-- Fire-and-forget, exactly like the Resend call: pg_net queues the request and
-- returns, so a slow push service never holds up a bid. If the poke is lost
-- the rows stay pending and the minute sweep sends them.

create or replace function public.push_drain()
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_secret  text;
  v_url     text;
  v_request bigint;
begin
  if not exists (select 1 from public.push_queue where status = 'pending') then
    return null;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_shared_secret';

  if v_secret is null then
    raise warning 'No push_shared_secret in the vault — nothing was sent.';
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_function_url';

  v_url := coalesce(
    v_url,
    'https://ipwpeeoesesmerzsenoe.supabase.co/functions/v1/push-send'
  );

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-push-secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) into v_request;

  return v_request;
end;
$fn$;

-- ===========================================================================
-- What the sender calls back
-- ===========================================================================
-- Claiming and settling are two calls rather than one, so that a sender which
-- dies halfway leaves its rows marked 'sending' rather than sent — visible,
-- and picked up again by the sweep below.
--
-- `for update skip locked` is what makes it safe for the minute sweep and a
-- just-placed bid to drain at the same instant: neither can take the other's
-- rows, so nobody's phone buzzes twice.

create or replace function public.push_claim(p_limit integer default 200)
returns table (id bigint, endpoint text, p256dh text, auth text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
  with picked as (
    select q.id
    from public.push_queue q
    where q.status = 'pending'
    order by q.id
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    for update skip locked
  )
  update public.push_queue q
     set status = 'sending'
    from picked p, public.push_subscriptions s
   where q.id = p.id
     and s.id = q.subscription_id
  returning q.id, s.endpoint, s.p256dh, s.auth, q.payload;
end;
$fn$;

-- p_results is [{ "id": 12, "status": "sent", "detail": null, "gone": false }, …]
--
-- `gone` means the push service said that browser no longer exists — data
-- cleared, app removed, permission withdrawn. The row is deleted rather than
-- retried, because it will never work again and every later send would carry
-- it along.

create or replace function public.push_settle(p_results jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.push_queue q
     set status  = case when r.status = 'sent' then 'sent' else 'failed' end,
         detail  = left(r.detail, 400),
         sent_at = now()
    from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
           as r(id bigint, status text, detail text, gone boolean)
   where q.id = r.id;

  delete from public.push_subscriptions s
   where s.id in (
     select q.subscription_id
     from public.push_queue q
     join jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
            as r(id bigint, status text, detail text, gone boolean)
       on r.id = q.id
     where coalesce(r.gone, false)
   );
end;
$fn$;

-- --- Housekeeping ------------------------------------------------------------
-- Anything left 'sending' for five minutes had its sender die mid-flight. Put
-- it back. Anything older than a week has served its purpose as a record.

create or replace function public.push_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.push_queue
     set status = 'pending'
   where status = 'sending'
     and created_at < now() - interval '5 minutes';

  delete from public.push_queue
   where created_at < now() - interval '7 days'
     and status in ('sent', 'failed');

  perform public.push_drain();
end;
$fn$;

-- ===========================================================================
-- A lot opens
-- ===========================================================================
-- There are three ways an auction becomes live, and the alert has to go out on
-- all of them or it will be the busiest one that is missed:
--
--   * the admin page publishes it to open now, and inserts it live outright —
--     by far the commonest;
--   * the admin page publishes it for later, and the cron below opens it;
--   * neither happened and the first bid opened it, inside place_bid().
--
-- So the announcement hangs off the row becoming live, not off whichever piece
-- of code did it. A trigger sees all three.
--
-- Wrapped, like the outbid one: this now runs inside the admin page's insert,
-- and a failed alert must never be the reason a lot cannot be published.

create or replace function public.announce_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  begin
    if new.status <> 'live' then
      return new;
    end if;

    -- Already live before this statement: an ordinary update — a bid moving
    -- the closing time, a title corrected — not an opening.
    if tg_op = 'UPDATE' and old.status = 'live' then
      return new;
    end if;

    -- A lot backdated into a window that has already passed is not news.
    if now() >= new.ends_at then
      return new;
    end if;

    perform public.queue_push(
      new.id,
      'live',
      jsonb_build_object(
        'title', 'Live now — ' || new.title,
        'body',  'Bidding is open. Starts at ' || public.taka(new.start_price) || '.',
        'url',   'https://nazmanwr.com/auction.html',
        'icon',  public.absolute_image(new.image_path),
        'tag',   'auction-' || new.id
      ),
      'everyone',
      null,
      -- A lot opens once. The long window is what makes a second run of this
      -- file, or a status flipped by hand, harmless.
      interval '12 hours'
    );

    perform public.push_drain();

  exception when others then
    raise warning 'Opening alert failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$fn$;

drop trigger if exists auctions_announce_live on public.auctions;

create trigger auctions_announce_live
  after insert or update on public.auctions
  for each row
  execute function public.announce_live();

-- --- Opening the ones set for later ------------------------------------------
-- Nothing used to move an auction from 'scheduled' to 'live' at its starting
-- time; place_bid() set it live on the first bid, so the status only became
-- true once somebody had already found the page on their own. That is the
-- wrong way round when the alert is what brings them. The trigger above does
-- the announcing — this only turns the status over.

create or replace function public.open_due_auctions()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  update public.auctions
     set status = 'live'
   where status = 'scheduled'
     and now() >= starts_at
     and now() <  ends_at;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ===========================================================================
-- Someone is outbid
-- ===========================================================================
-- A second trigger rather than a change to notify_outbid(), so that the email
-- path is untouched and re-running outbid-email.sql cannot quietly undo this.
-- It repeats that function's "is this really a new high" test, which is six
-- lines and worth repeating to keep the two independent.
--
-- Same discipline as the email: the whole body is wrapped, because this runs
-- inside the bid's own transaction and a failed alert must never cost someone
-- their bid.

create or replace function public.notify_outbid_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auction public.auctions%rowtype;
begin
  begin
    select * into v_auction from public.auctions where id = new.auction_id;
    if not found or v_auction.status = 'closed' then
      return new;
    end if;

    -- A trigger fires on any insert. Announcing a bid that is not the highest
    -- would make the message a lie.
    if exists (
      select 1 from public.bids
      where auction_id = new.auction_id
        and id <> new.id
        and amount >= new.amount
    ) then
      return new;
    end if;

    perform public.queue_push(
      new.auction_id,
      'outbid',
      jsonb_build_object(
        'title', 'You have been outbid',
        'body',  v_auction.title || ' is now ' || public.taka(new.amount) || '.',
        'url',   'https://nazmanwr.com/auction.html',
        'icon',  public.absolute_image(v_auction.image_path),
        -- The same tag as the lot's other alerts, so a run of quick raises
        -- replaces the last notification instead of stacking five of them up.
        'tag',   'auction-' || new.auction_id
      ),
      'bidders',
      new.bidder_id
    );

    perform public.push_drain();

  exception when others then
    raise warning 'Outbid alert failed on auction %: %', new.auction_id, sqlerrm;
  end;

  return new;
end;
$fn$;

drop trigger if exists bids_notify_outbid_push on public.bids;

create trigger bids_notify_outbid_push
  after insert on public.bids
  for each row
  execute function public.notify_outbid_push();

-- ===========================================================================
-- The schedule
-- ===========================================================================

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron is not enabled, so nothing will open or send automatically. Turn it on under Database -> Extensions and run this file again.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'open-due-auctions') then
    perform cron.unschedule('open-due-auctions');
  end if;

  perform cron.schedule(
    'open-due-auctions', '* * * * *',
    'select public.open_due_auctions();'
  );

  if exists (select 1 from cron.job where jobname = 'push-sweep') then
    perform cron.unschedule('push-sweep');
  end if;

  perform cron.schedule(
    'push-sweep', '* * * * *',
    'select public.push_sweep();'
  );
end
$$;

-- ===========================================================================
-- Who may call these
-- ===========================================================================
-- Postgres grants EXECUTE to PUBLIC on a new function, and every function in
-- the public schema is reachable over the REST API with the publishable key —
-- which is in the page, so it is in everybody's hands. Without these revokes a
-- stranger could call queue_push() and make every phone that has ever visited
-- the site say whatever they liked.
--
-- Two of them are meant for the page and are granted back. The rest are called
-- by the scheduler, by a trigger, or by the sender holding the service key.

revoke all on function public.save_push_subscription(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.forget_push_subscription(text)
  from public, anon, authenticated;
revoke all on function public.queue_push(uuid, text, jsonb, text, uuid, interval)
  from public, anon, authenticated;
revoke all on function public.push_drain()        from public, anon, authenticated;
revoke all on function public.push_claim(integer) from public, anon, authenticated;
revoke all on function public.push_settle(jsonb)  from public, anon, authenticated;
revoke all on function public.push_sweep()        from public, anon, authenticated;
revoke all on function public.open_due_auctions() from public, anon, authenticated;

-- The page asks for these two, and a visitor without an account must be able
-- to ask as well — being told a lot has opened is how they become a bidder.
grant execute on function public.save_push_subscription(text, text, text, text)
  to anon, authenticated;
grant execute on function public.forget_push_subscription(text)
  to anon, authenticated;

-- The sender holds the service key. Revoking from PUBLIC above took these from
-- it too, so they are granted back by name.
grant execute on function public.push_claim(integer) to service_role;
grant execute on function public.push_settle(jsonb)  to service_role;
