create table public.sowalif_documents (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id) between 1 and 160),
  kind text not null check (kind in ('chat', 'memory')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4194304),
  deleted boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.sowalif_documents enable row level security;
revoke all on public.sowalif_documents from anon, authenticated;
grant select, insert, update on public.sowalif_documents to authenticated;
create policy "Read own Sowalif data" on public.sowalif_documents for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own Sowalif data" on public.sowalif_documents for insert to authenticated with check ((select auth.uid()) = user_id and revision = 1);
create policy "Update own Sowalif data" on public.sowalif_documents for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create function public.sowalif_document_revision() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.sowalif_document_revision() from public;
create trigger sowalif_document_revision before update on public.sowalif_documents for each row execute function public.sowalif_document_revision();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sowalif-media', 'sowalif-media', false, 10485760, array['image/jpeg','image/png','image/webp']);
create policy "Read own Sowalif media" on storage.objects for select to authenticated using (bucket_id = 'sowalif-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Upload own Sowalif media" on storage.objects for insert to authenticated with check (bucket_id = 'sowalif-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Remove own Sowalif media" on storage.objects for delete to authenticated using (bucket_id = 'sowalif-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
