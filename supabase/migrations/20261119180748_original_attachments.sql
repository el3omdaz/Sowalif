-- Applied and verified through the Supabase connector, 2026-11-19.
-- Source copy of original_attachments; do not apply twice.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sowalif-files', 'sowalif-files', false, null, null)
on conflict (id) do nothing;

create policy "Read own Sowalif originals" on storage.objects for select to authenticated
using (bucket_id = 'sowalif-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Upload own Sowalif originals" on storage.objects for insert to authenticated
with check (bucket_id = 'sowalif-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Remove own Sowalif originals" on storage.objects for delete to authenticated
using (bucket_id = 'sowalif-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
