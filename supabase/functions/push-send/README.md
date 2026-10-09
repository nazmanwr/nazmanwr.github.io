# push-send — turning it on

Four things, once. Nothing here goes into the repository: the secrets below
live on Supabase, and the only key written into the site is the public half,
which is meant to be public.

Everything assumes the Supabase CLI is installed and `supabase link` has been
run against the project. If it has not, the last section does the same thing
through the dashboard.

## 1. The keys

They have already been generated. The public half is in three places in the
repo — `assets/js/auction-config.js`, `sw.js`, and here — and must be the same
string in all of them, because a phone subscribes with one and the alert is
signed with the other. Changing it silently breaks every existing subscriber:
their browser will refuse alerts signed with a key it did not subscribe to.

Public:  `BG-siLK1pcarwMWURfHBEsY_oz7y3Ky-seI1oyzdD7yeufE-vbdQd966mB0EX1TriXFkeRfS1PrRJFEdNqagahY`

The private half is in the message that came with this file. It is not written
down here on purpose.

## 2. Deploy the function

```
supabase functions deploy push-send --no-verify-jwt
```

`--no-verify-jwt` is deliberate. The usual JWT check would be satisfied by the
publishable key, which is printed in the page and therefore in everybody's
hands — it would not keep anyone out. The function is guarded by its own shared
secret instead, checked before it reads a single row.

## 3. Set its secrets

```
supabase secrets set VAPID_PUBLIC_KEY=BG-siLK1pcarwMWURfHBEsY_oz7y3Ky-seI1oyzdD7yeufE-vbdQd966mB0EX1TriXFkeRfS1PrRJFEdNqagahY
supabase secrets set VAPID_PRIVATE_KEY=<the private half>
supabase secrets set VAPID_SUBJECT=mailto:nazm.anwr@gmail.com
supabase secrets set PUSH_SHARED_SECRET=<a long random string>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set by Supabase itself. The
function needs the service key because `push_subscriptions` and `push_queue`
have row level security on and no policies at all — an endpoint is the address
that makes a stranger's phone buzz, so nothing reaches those tables with the
publishable key.

## 4. Tell the database the same secret

In the SQL editor, with the same string used for `PUSH_SHARED_SECRET`:

```sql
select vault.create_secret('<the same long random string>', 'push_shared_secret');
```

Then run `supabase/push.sql`.

To change it later:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'push_shared_secret'),
  '<the new string>'
);
```

## Checking it works

Subscribe on a phone, then from the SQL editor:

```sql
select public.queue_push(
  (select id from public.auctions order by created_at desc limit 1),
  'test',
  jsonb_build_object('title', 'Test', 'body', 'If this arrives, it works.',
                     'url', 'https://nazmanwr.com/auction.html'),
  'everyone', null, interval '0 seconds'
);
select public.push_drain();
```

A few seconds later:

```sql
select kind, status, detail, created_at
from public.push_queue order by id desc limit 20;
```

`sent` means the push service accepted it. `failed` carries the reason it gave
in `detail`. Nothing at all means `push_drain()` never got out — check that
`push_shared_secret` is in the vault and that pg_net is enabled.

## Without the CLI

Dashboard → Edge Functions → Deploy a new function → name it `push-send`,
paste `index.ts`, and turn **Verify JWT** off. Then Edge Functions → Secrets
for the four values in step 3.
