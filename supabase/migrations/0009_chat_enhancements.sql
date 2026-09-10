-- ============================================================
-- 0009_chat_enhancements.sql
-- T-CODE-34: message search (Phase 3-§78 "start simple, DB full-text
-- search" principle), message forwarding, and per-user chat-level pinning
-- (distinct from groups.pinned_message_id / pin_message / unpin_message
-- from T-CODE-11, which is a group-wide pinned-announcement feature and is
-- untouched here).
--
-- NUMBERING NOTE: 0008 is claimed by feat/member-groups'
-- 0008_member_group_creation.sql (in-flight, not yet on main as of this
-- branch's base f5c05f4). This migration uses 0009 to avoid a collision;
-- flagged for whoever resolves the merge order of these two branches.
-- ============================================================

-- ---------------------------------------------------------------
-- 1a. Message search
-- ---------------------------------------------------------------
alter table messages
  add column content_search tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create index messages_content_search_gin_idx on messages using gin (content_search);

-- SECURITY DEFINER so it can read across all messages, but re-implements
-- the exact visibility boundary of the "messages readable by participants"
-- RLS policy (0001_init.sql) inside the function body — sender, DM
-- participant, or group member (or admin) — rather than bypassing RLS and
-- trusting the caller.
create or replace function search_messages(p_query text, p_group_id bigint default null)
returns table (
  id bigint,
  group_id bigint,
  dm_user_a uuid,
  dm_user_b uuid,
  sender_id uuid,
  content text,
  created_at timestamptz,
  rank real
)
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_tsquery tsquery;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  if p_query is null or btrim(p_query) = '' then
    return;
  end if;

  v_tsquery := websearch_to_tsquery('english', p_query);

  return query
  select
    m.id, m.group_id, m.dm_user_a, m.dm_user_b, m.sender_id, m.content, m.created_at,
    ts_rank(m.content_search, v_tsquery) as rank
  from messages m
  where m.deleted_at is null
    and m.content_search @@ v_tsquery
    and (p_group_id is null or m.group_id = p_group_id)
    and (
      is_admin()
      or m.sender_id = v_actor
      or m.dm_user_a = v_actor
      or m.dm_user_b = v_actor
      or (
        m.group_id is not null
        and exists (
          select 1 from group_members gm
          where gm.group_id = m.group_id and gm.user_id = v_actor
        )
      )
    )
  order by rank desc, m.created_at desc
  limit 50;
end;
$$;

-- ---------------------------------------------------------------
-- 1b. Message forwarding
-- ---------------------------------------------------------------
alter table messages
  add column forwarded_from_message_id bigint references messages(id);

-- ---------------------------------------------------------------
-- 1c. Pinned chats (per-user chat-list pins — NOT group message pinning)
-- ---------------------------------------------------------------
create table pinned_chats (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  group_id bigint references groups(id),
  dm_other_user_id uuid references profiles(id),
  pinned_at timestamptz not null default now(),
  check (
    (group_id is not null and dm_other_user_id is null)
    or (group_id is null and dm_other_user_id is not null)
  )
);

create unique index pinned_chats_user_group_uidx
  on pinned_chats (user_id, group_id)
  where group_id is not null;

create unique index pinned_chats_user_dm_uidx
  on pinned_chats (user_id, dm_other_user_id)
  where dm_other_user_id is not null;

alter table pinned_chats enable row level security;

create policy "pinned chats readable by owner"
  on pinned_chats for select
  using (user_id = auth.uid());

create policy "pinned chats inserted by owner"
  on pinned_chats for insert
  with check (user_id = auth.uid());

create policy "pinned chats deleted by owner"
  on pinned_chats for delete
  using (user_id = auth.uid());
