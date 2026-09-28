-- ===========================================================================
-- winner-email.sql — telling the winner, and telling you
--
-- When an auction closes, two emails go out: one to whoever won, and one to
-- you with their phone number and address so you can arrange the handover.
--
-- BEFORE RUNNING THIS, two things in the dashboard:
--
--   1. Database -> Extensions -> enable  pg_net
--      This is what lets the database make an HTTP request to Resend.
--
--   2. Store your Resend API key, so it is never written into this file or
--      any other. SQL Editor, once:
--
--        select vault.create_secret('re_YOUR_KEY_HERE', 'resend_api_key');
--
--      If you ever need to change it:
--
--        select vault.update_secret(
--          (select id from vault.secrets where name = 'resend_api_key'),
--          're_NEW_KEY_HERE'
--        );
--
-- The key lives in Supabase's encrypted vault. It is read only inside the
-- function below, which runs as the database owner, so it is never exposed to
-- the page, to a bidder, or to anyone reading this repository.
--
-- Sending is fire-and-forget: pg_net queues the request and returns
-- immediately, so a slow or failing Resend never holds up the auction closing.
-- What was attempted is recorded in mail_log, which is how you check.
-- ===========================================================================

-- --- What was sent ----------------------------------------------------------
-- Not for the public. No policy is created for it, and RLS is on, so the
-- anon and authenticated roles cannot read it at all — only you, through the
-- dashboard.

create table if not exists public.mail_log (
  id          bigint generated always as identity primary key,
  auction_id  uuid references public.auctions(id) on delete set null,
  kind        text not null,              -- 'winner' | 'seller' | 'no-bids'
  to_email    text not null,
  subject     text,
  request_id  bigint,                     -- pg_net's handle, for tracing
  created_at  timestamptz not null default now()
);

alter table public.mail_log enable row level security;

create index if not exists mail_log_auction_idx on public.mail_log (auction_id);

-- --- One place that knows how to send ----------------------------------------

create or replace function public.send_email(
  p_to      text,
  p_subject text,
  p_html    text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key     text;
  v_request bigint;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'resend_api_key';

  if v_key is null then
    raise warning 'No resend_api_key in the vault — no email sent to %.', p_to;
    return null;
  end if;

  select net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object(
                 'from',     'Nazm Anwr <auction@nazmanwr.com>',
                 'reply_to', 'nazm.anwr@gmail.com',
                 'to',       jsonb_build_array(p_to),
                 'subject',  p_subject,
                 'html',     p_html
               ),
    timeout_milliseconds := 8000
  ) into v_request;

  return v_request;
end;
$fn$;

-- --- Small helpers -----------------------------------------------------------

-- A title is whatever was typed into the admin form, and it lands inside HTML.
create or replace function public.html_escape(p_text text)
returns text
language sql
immutable
as $fn$
  select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'),
                         '<', '&lt;'), '>', '&gt;');
$fn$;

create or replace function public.taka(p_amount numeric)
returns text
language sql
immutable
as $fn$
  select 'BDT ' || trim(to_char(p_amount, 'FM999,999,999,990'));
$fn$;

-- image_path is either a path on the site or a full URL from the upload
-- bucket. An email needs an absolute one either way.
create or replace function public.absolute_image(p_path text)
returns text
language sql
immutable
as $fn$
  select case
           when p_path is null then null
           when p_path like 'http%' then p_path
           else 'https://nazmanwr.com' || p_path
         end;
$fn$;

-- --- The announcement --------------------------------------------------------

create or replace function public.announce_winner(p_auction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auction public.auctions%rowtype;
  v_amount  numeric;
  v_name      text;
  v_phone     text;
  v_alt_phone text;
  v_area      text;
  v_address   text;
  v_email     text;
  v_image   text;
  v_spec    text;
  v_html    text;
  v_req     bigint;
begin
  select * into v_auction from public.auctions where id = p_auction_id;
  if not found then return; end if;

  v_image := public.absolute_image(v_auction.image_path);
  v_spec  := nullif(concat_ws(' · ', v_auction.medium, v_auction.size), '');

  -- No winning bid: nobody bid at all. Tell the seller, nobody else.
  if v_auction.winning_bid_id is null then
    v_html := format(
      '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#141414">'
      '<p><strong>%s</strong> closed with no bids.</p>'
      '<p>The opening price was %s. It may be worth putting it up again at a '
      'lower start, or at a different time of day.</p>'
      '</div>',
      public.html_escape(v_auction.title),
      public.taka(v_auction.start_price)
    );

    v_req := public.send_email(
      'nazm.anwr@gmail.com',
      'No bids — ' || v_auction.title,
      v_html
    );

    insert into public.mail_log (auction_id, kind, to_email, subject, request_id)
    values (p_auction_id, 'no-bids', 'nazm.anwr@gmail.com',
            'No bids — ' || v_auction.title, v_req);
    return;
  end if;

  select b.amount, d.full_name, d.phone, d.address,
         coalesce(u.email, d.email),
         d.alt_phone,
         nullif(concat_ws(', ', d.thana, d.district), '')
    into v_amount, v_name, v_phone, v_address, v_email,
         v_alt_phone, v_area
  from public.bids b
  join public.bidders d on d.id = b.bidder_id
  left join auth.users u on u.id = b.bidder_id
  where b.id = v_auction.winning_bid_id;

  if v_email is null then return; end if;

  -- --- To the winner ---------------------------------------------------------
  v_html := format(
    '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#141414;max-width:520px">'
    '<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8a8a;margin:0 0 18px">You won the auction</p>'
    '%s'
    '<h1 style="font-size:22px;font-weight:400;margin:22px 0 4px">%s</h1>'
    '%s'
    '<p style="font-size:26px;margin:22px 0 4px">%s</p>'
    '<p style="color:#6b6b6b;margin:0 0 24px">Your winning bid.</p>'
    '<p>Congratulations! You have won this Original Calligraphy Artwork in the '
    'Calligraphy Auction.</p>'
    '<p>A delivery representative will contact you shortly to arrange the '
    'delivery. Payment for the artwork will be collected via Cash on Delivery '
    '(COD) upon delivery.</p>'
    '<p><strong>Please note:</strong> The delivery charge is separate from the '
    'artwork price and will be payable to the delivery representative upon '
    'receiving the artwork. The delivery charge is BDT 100 within Dhaka and '
    'BDT 200 outside Dhaka.</p>'
    '<p>Thank you for participating in the Calligraphy Auction. Through your '
    'participation, you have contributed to the Art and Culture of Bangladesh.</p>'
    '<p style="color:#6b6b6b;font-size:13px;margin-top:28px">Nazm Anwr · '
    '<a href="https://nazmanwr.com" style="color:#6b6b6b">nazmanwr.com</a></p>'
    '</div>',
    case when v_image is null then ''
         else format('<img src="%s" alt="" style="display:block;width:100%%;max-width:520px;height:auto">', v_image)
    end,
    public.html_escape(v_auction.title),
    case when v_spec is null then ''
         else format('<p style="color:#6b6b6b;margin:0">%s</p>', public.html_escape(v_spec))
    end,
    public.taka(v_amount)
  );

  v_req := public.send_email(v_email, 'You won — ' || v_auction.title, v_html);

  insert into public.mail_log (auction_id, kind, to_email, subject, request_id)
  values (p_auction_id, 'winner', v_email,
          'You won — ' || v_auction.title, v_req);

  -- --- To the seller ---------------------------------------------------------
  -- This one carries the phone number and the address, which is the whole
  -- point: they are unreadable through the website, by design, even by you.
  v_html := format(
    '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#141414;max-width:520px">'
    '<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8a8a;margin:0 0 18px">Auction closed</p>'
    '<h1 style="font-size:22px;font-weight:400;margin:0 0 4px">%s</h1>'
    '<p style="font-size:26px;margin:18px 0 24px">%s</p>'
    '<table style="border-collapse:collapse;font-size:15px">'
    '<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a">Winner</td><td>%s</td></tr>'
    '<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a">Phone</td><td><a href="tel:%s" style="color:#141414">%s</a></td></tr>'
    '%s'
    '<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a">Email</td><td><a href="mailto:%s" style="color:#141414">%s</a></td></tr>'
    '<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a">Area</td><td>%s</td></tr>'
    '<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a;vertical-align:top">Address</td><td>%s</td></tr>'
    '<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a">Bids</td><td>%s</td></tr>'
    '</table>'
    '<p style="color:#6b6b6b;font-size:13px;margin-top:28px">They have been emailed too.</p>'
    '</div>',
    public.html_escape(v_auction.title),
    public.taka(v_amount),
    public.html_escape(v_name),
    public.html_escape(v_phone), public.html_escape(v_phone),
    case when v_alt_phone is null or v_alt_phone = '' then ''
         else format('<tr><td style="padding:4px 18px 4px 0;color:#8a8a8a">Alt phone</td>'
                     '<td><a href="tel:%s" style="color:#141414">%s</a></td></tr>',
                     public.html_escape(v_alt_phone), public.html_escape(v_alt_phone))
    end,
    public.html_escape(v_email), public.html_escape(v_email),
    case when v_area is null or v_area = ''
         then '<span style="color:#c0261c">not recorded — ask them</span>'
         else public.html_escape(v_area)
    end,
    replace(public.html_escape(v_address), E'\n', '<br>'),
    (select count(*) from public.bids where auction_id = p_auction_id)
  );

  v_req := public.send_email(
    'nazm.anwr@gmail.com',
    'Sold ' || public.taka(v_amount) || ' — ' || v_auction.title,
    v_html
  );

  insert into public.mail_log (auction_id, kind, to_email, subject, request_id)
  values (p_auction_id, 'seller', 'nazm.anwr@gmail.com',
          'Sold — ' || v_auction.title, v_req);
end;
$fn$;

-- --- Hook it into the close --------------------------------------------------
-- Same function as in schema.sql, with the announcement added. It still only
-- touches auctions that are not already closed, so an auction is announced
-- exactly once however often the schedule runs.

create or replace function public.close_due_auctions()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
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

    -- One bad address must not stop the next auction closing.
    begin
      perform public.announce_winner(v_auction.id);
    exception when others then
      raise warning 'Announcement failed for %: %', v_auction.id, sqlerrm;
    end;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

-- --- Who may call these ------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on a new function, and every function in
-- the public schema is reachable over the REST API with the publishable key —
-- which is in the page, so it is in everybody's hands. Without these revokes,
-- a stranger could call send_email() and send whatever they liked from
-- auction@nazmanwr.com, or fire announce_winner() at an auction still running.
--
-- Nothing in the browser ever needs these. They are called by the scheduler,
-- inside the database, as the owner.

revoke all on function public.send_email(text, text, text)
  from public, anon, authenticated;

revoke all on function public.announce_winner(uuid)
  from public, anon, authenticated;

revoke all on function public.close_due_auctions()
  from public, anon, authenticated;

-- place_bid stays reachable: that one is meant to be called from the page,
-- and it does its own checking.
