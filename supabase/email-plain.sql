-- ===========================================================================
-- email-plain.sql — getting the outbid alert out of Gmail's Promotions tab
--
-- Run this in the Supabase SQL editor. It is safe while a lot is live: it
-- replaces two functions in one transaction and changes nothing about how a
-- bid is judged. The next outbid alert simply looks different.
--
-- The alert was arriving, but filed under Promotions. Gmail sorts on shape,
-- not intent, and the old one had the exact shape of marketing: a hero image,
-- a large filled call-to-action button, almost no prose, and no plain-text
-- part at all. An HTML-only message with one big image and one big button is
-- what a newsletter looks like.
--
-- So the alert becomes what it actually is: a short note from a person, mostly
-- words, one ordinary underlined link, and a genuine text/plain alternative
-- alongside the HTML. Mail that carries both parts reads as correspondence
-- rather than as a campaign.
--
-- Worth doing in the Resend dashboard as well, and it may matter more than
-- any of this: under the domain's settings, turn OFF open tracking and click
-- tracking. Both work by rewriting every link through a tracking host and
-- adding an invisible pixel, which is about the loudest "this is bulk mail"
-- signal there is.
-- ===========================================================================

-- --- send_email, now able to carry a plain-text part ------------------------
-- The old three-argument version has to go first: adding a fourth parameter
-- with a default beside it would leave three-argument calls ambiguous, and
-- Postgres would refuse them as "function is not unique". Dropping and
-- recreating in one transaction leaves no window where sending is broken.

drop function if exists public.send_email(text, text, text);

create or replace function public.send_email(
  p_to      text,
  p_subject text,
  p_html    text,
  p_text    text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key     text;
  v_body    jsonb;
  v_request bigint;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'resend_api_key';

  if v_key is null then
    raise warning 'No resend_api_key in the vault — no email sent to %.', p_to;
    return null;
  end if;

  v_body := jsonb_build_object(
    'from',     'Nazm Anwr <auction@nazmanwr.com>',
    'reply_to', 'nazm.anwr@gmail.com',
    'to',       jsonb_build_array(p_to),
    'subject',  p_subject,
    'html',     p_html
  );

  -- Only when there is one: an empty text part is worse than none.
  if p_text is not null and length(btrim(p_text)) > 0 then
    v_body := v_body || jsonb_build_object('text', p_text);
  end if;

  select net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := v_body,
    timeout_milliseconds := 8000
  ) into v_request;

  return v_request;
end;
$fn$;

revoke all on function public.send_email(text, text, text, text)
  from public, anon, authenticated;

-- --- The outbid alert, written like a note ----------------------------------
-- Identical rules to before: everyone who bid except whoever just bid, one
-- message per person per lot per ten minutes, only on a genuine new high, and
-- the whole body wrapped so a failed email can never undo a bid.

create or replace function public.notify_outbid()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auction  public.auctions%rowtype;
  v_html     text;
  v_plain    text;
  v_req      bigint;
  v_person   record;
  v_subject  text;
  v_amount   text;
  v_throttle constant interval := interval '10 minutes';
begin
  begin
    select * into v_auction from public.auctions where id = new.auction_id;
    if not found or v_auction.status = 'closed' then
      return new;
    end if;

    if exists (
      select 1 from public.bids
      where auction_id = new.auction_id
        and id <> new.id
        and amount >= new.amount
    ) then
      return new;
    end if;

    v_amount  := public.taka(new.amount);
    -- Names the artwork and says what happened, with no exclamation and no
    -- offer in it. Subject lines that read like an announcement get filed
    -- like one.
    v_subject := 'You have been outbid on ' || v_auction.title;

    v_plain :=
      'Someone has bid higher than you.' || E'\n\n' ||
      v_auction.title || ' is now ' || v_amount || '.' || E'\n\n' ||
      'You can bid again here: https://nazmanwr.com/auction.html' || E'\n\n' ||
      'You are getting this because you bid on this artwork. It stops when ' ||
      'the auction closes.' || E'\n\n' ||
      'Nazm Anwr' || E'\n' ||
      'nazmanwr.com';

    v_html := format(
      '<div style="font-family:Georgia,''Times New Roman'',serif;font-size:16px;'
      'line-height:1.6;color:#222222;max-width:460px">'
      '<p>Someone has bid higher than you.</p>'
      '<p><strong>%s</strong> is now <strong>%s</strong>.</p>'
      '<p>You can <a href="https://nazmanwr.com/auction.html" '
      'style="color:#222222">bid again here</a>.</p>'
      '<p style="color:#666666;font-size:14px">You are getting this because you '
      'bid on this artwork. It stops when the auction closes.</p>'
      '<p style="color:#666666;font-size:14px">Nazm Anwr<br>nazmanwr.com</p>'
      '</div>',
      public.html_escape(v_auction.title),
      v_amount
    );

    for v_person in
      select distinct on (b.bidder_id)
             b.bidder_id,
             coalesce(u.email, d.email) as email
      from public.bids b
      join public.bidders d on d.id = b.bidder_id
      left join auth.users u on u.id = b.bidder_id
      where b.auction_id = new.auction_id
        and b.bidder_id <> new.bidder_id
      order by b.bidder_id
    loop
      continue when v_person.email is null;

      continue when exists (
        select 1 from public.mail_log
        where auction_id = new.auction_id
          and kind      = 'outbid'
          and to_email  = v_person.email
          and created_at > now() - v_throttle
      );

      v_req := public.send_email(v_person.email, v_subject, v_html, v_plain);

      insert into public.mail_log (auction_id, kind, to_email, subject, request_id)
      values (new.auction_id, 'outbid', v_person.email, v_subject, v_req);
    end loop;

  exception when others then
    raise warning 'Outbid alert failed on auction %: %', new.auction_id, sqlerrm;
  end;

  return new;
end;
$fn$;
