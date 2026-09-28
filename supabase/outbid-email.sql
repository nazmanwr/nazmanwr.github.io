-- ===========================================================================
-- outbid-email.sql — telling everyone else that the price moved
--
-- Run this AFTER winner-email.sql, which supplies send_email(), mail_log and
-- the small formatting helpers this depends on.
--
-- This is the piece most likely to raise a final price. On the first auction,
-- someone was outbid and did not find out for eleven hours, because nothing
-- told them. A person who knows they have been passed comes back; a person who
-- does not, does not.
--
-- Built as a trigger rather than as a change to place_bid(), so that bidding
-- itself is untouched. Two consequences worth understanding:
--
--   1. It runs inside the bid's own transaction. If anything in here raised,
--      the bid would roll back — someone would be told their bid failed
--      because an email did. So the whole body is wrapped: any failure is
--      swallowed and the bid stands. A missed email is a small loss; a lost
--      bid is not.
--
--   2. It fires on the INSERT, before place_bid() has finished extending the
--      closing time. That is why the message states no closing time — only
--      the amount, which is always right. The page carries the live clock.
--
-- The trigger function returns `trigger`, so PostgREST does not expose it:
-- unlike send_email it cannot be reached over the API, and needs no revoke.
-- ===========================================================================

create or replace function public.notify_outbid()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auction  public.auctions%rowtype;
  v_image    text;
  v_html     text;
  v_req      bigint;
  v_person   record;
  v_subject  text;
  -- A run of quick raises must not mean a run of emails. Someone raised four
  -- times in four seconds on the first auction; that should be one message.
  v_throttle constant interval := interval '10 minutes';
begin
  begin
    select * into v_auction from public.auctions where id = new.auction_id;
    if not found or v_auction.status = 'closed' then
      return new;
    end if;

    -- Only ever announce a genuine new high. A trigger fires on any insert,
    -- and a lower one would make the message a lie.
    if exists (
      select 1 from public.bids
      where auction_id = new.auction_id
        and id <> new.id
        and amount >= new.amount
    ) then
      return new;
    end if;

    v_image   := public.absolute_image(v_auction.image_path);
    v_subject := 'Outbid — ' || v_auction.title;

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

      v_html := format(
        '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#141414;max-width:520px">'
        '<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c0261c;margin:0 0 18px">You have been outbid</p>'
        '%s'
        '<h1 style="font-size:20px;font-weight:400;margin:20px 0 4px">%s</h1>'
        '<p style="font-size:26px;margin:18px 0 4px">%s</p>'
        '<p style="color:#6b6b6b;margin:0 0 24px">The highest bid now.</p>'
        '<p><a href="https://nazmanwr.com/auction.html" '
        'style="display:inline-block;padding:12px 22px;background:#141414;color:#ffffff;'
        'text-decoration:none;font-size:13px;letter-spacing:.1em;text-transform:uppercase">'
        'Place another bid</a></p>'
        '<p style="color:#6b6b6b;font-size:13px;margin-top:28px">'
        'You are getting this because you bid on this artwork. It stops when the '
        'auction closes.</p>'
        '</div>',
        case when v_image is null then ''
             else format('<img src="%s" alt="" style="display:block;width:100%%;max-width:320px;height:auto">', v_image)
        end,
        public.html_escape(v_auction.title),
        public.taka(new.amount)
      );

      v_req := public.send_email(v_person.email, v_subject, v_html);

      insert into public.mail_log (auction_id, kind, to_email, subject, request_id)
      values (new.auction_id, 'outbid', v_person.email, v_subject, v_req);
    end loop;

  exception when others then
    -- Never take a bid down with a failed email.
    raise warning 'Outbid alert failed on auction %: %', new.auction_id, sqlerrm;
  end;

  return new;
end;
$fn$;

drop trigger if exists bids_notify_outbid on public.bids;

create trigger bids_notify_outbid
  after insert on public.bids
  for each row
  execute function public.notify_outbid();
