-- ===========================================================================
-- storage-fix.sql — uploads for a new photograph
--
-- Run this if putting up an auction from an uploaded photo is refused with
-- "new row violates row-level security policy".
--
-- That message means Postgres allowed nothing to be written to
-- storage.objects: either the bucket is not there, or no INSERT policy matched
-- the upload. This sets both up from scratch and then prints what exists, so
-- the answer is on screen rather than inferred.
--
-- Safe to run more than once.
-- ===========================================================================

-- --- The bucket -------------------------------------------------------------
-- public = true so the auction page and the emails can show the artwork
-- without signed URLs. Only the owner can put anything in it; that is the
-- policy's job, below, not the bucket's.

insert into storage.buckets (id, name, public)
values ('auction', 'auction', true)
on conflict (id) do update set public = true;

-- --- The policies -----------------------------------------------------------
-- Reading is open, because the images are on a public page anyway. Writing is
-- the owner's alone, checked on the signed-in token.
--
-- Four separate ones: Supabase Storage does more than a bare INSERT when it
-- saves a file, and a missing UPDATE or DELETE policy shows up as the same
-- unhelpful RLS message as a missing INSERT one.

drop policy if exists "auction images are readable" on storage.objects;
create policy "auction images are readable" on storage.objects
  for select
  using (bucket_id = 'auction');

drop policy if exists "only the owner uploads auction images" on storage.objects;
create policy "only the owner uploads auction images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'auction'
    and lower(coalesce(auth.jwt() ->> 'email', '')) = 'nazm.anwr@gmail.com'
  );

drop policy if exists "only the owner replaces auction images" on storage.objects;
create policy "only the owner replaces auction images" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'auction'
    and lower(coalesce(auth.jwt() ->> 'email', '')) = 'nazm.anwr@gmail.com'
  )
  with check (
    bucket_id = 'auction'
    and lower(coalesce(auth.jwt() ->> 'email', '')) = 'nazm.anwr@gmail.com'
  );

drop policy if exists "only the owner removes auction images" on storage.objects;
create policy "only the owner removes auction images" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'auction'
    and lower(coalesce(auth.jwt() ->> 'email', '')) = 'nazm.anwr@gmail.com'
  );

-- --- What actually exists now ------------------------------------------------
-- Run the file, then read these two results. Between them they say whether the
-- bucket is there and which policies are guarding it.

select id, name, public, created_at
from storage.buckets
where id = 'auction';

select policyname, cmd, roles::text, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by cmd, policyname;
