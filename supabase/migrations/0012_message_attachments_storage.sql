-- ============================================================
-- 0012_message_attachments_storage.sql
-- Fills the gap flagged in docs/messaging-audit.md §8: message_attachments
-- had columns and RLS but no Storage bucket, bucket policies, or upload
-- path. This migration adds the bucket + storage.objects policies and the
-- extra columns (file_name, width, height) the upload flow needs.
--
-- Object path convention (enforced by can_access_attachment_path below,
-- chosen so group/dm membership can be checked from the path alone without
-- a lookup table mapping object -> conversation):
--   group/{groupId}/{uuid}-{safe file name}
--   dm/{lowUuid}/{highUuid}/{uuid}-{safe file name}
-- {lowUuid}/{highUuid} is the same canonical lexicographic ordering
-- sendMessage's dmPair() uses for dm_user_a/dm_user_b, so the prefix a
-- client is allowed to write under matches exactly what sendMessage will
-- accept for that DM.
-- ============================================================

alter table message_attachments
  add column file_name text not null default 'attachment',
  add column width int,
  add column height int;
alter table message_attachments alter column file_name drop default;

-- Private bucket — objects are only ever reached via short-lived signed
-- URLs (created server-side after the RLS/RPC membership checks below, or
-- via listMessages/sendMessage using the service-role client since those
-- Server Actions already re-verify membership themselves), never a public
-- URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  false,
  20971520, -- 20 MiB, mirrors MAX_ATTACHMENT_SIZE_BYTES in src/lib/messaging/attachments.ts
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip'
  ]
)
on conflict (id) do nothing;

-- SECURITY DEFINER helper, same shape as is_admin()/search_messages(): reads
-- across group_members regardless of the caller's own RLS visibility, but
-- re-implements exactly the "is this user a participant in this
-- conversation" boundary the messages/message_attachments policies already
-- use, rather than bypassing RLS.
create or replace function can_access_attachment_path(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  parts text[];
  kind text;
  v_group_id bigint;
begin
  parts := storage.foldername(object_name); -- path segments, excluding the file name itself
  if parts is null or array_length(parts, 1) < 2 then
    return false;
  end if;

  kind := parts[1];

  if kind = 'group' then
    begin
      v_group_id := parts[2]::bigint;
    exception when others then
      return false;
    end;
    return is_admin() or exists (
      select 1 from group_members
      where group_id = v_group_id and user_id = auth.uid()
    );
  elsif kind = 'dm' then
    if array_length(parts, 1) < 3 then
      return false;
    end if;
    return auth.uid() is not null and auth.uid()::text in (parts[2], parts[3]);
  else
    return false;
  end if;
end;
$$;

create policy "attachment objects readable by conversation members"
  on storage.objects for select
  using (bucket_id = 'message-attachments' and can_access_attachment_path(name));

create policy "attachment objects insertable by conversation members"
  on storage.objects for insert
  with check (bucket_id = 'message-attachments' and can_access_attachment_path(name));
