-- ============================================================
-- 0011_quick_replies_checklists.sql
-- T-CODE-41: quick replies + collaborative checklists.
--
-- Base: feat/telegram-features-backend @ 33338b8 (T-CODE-43). Highest
-- existing migration on that branch is 0010_telegram_features.sql
-- (T-CODE-40) — this file is 0011. Depends on 0010's
-- messages.message_type column + messages_message_type_check constraint.
-- ============================================================

-- ============================================================
-- PART 1 — QUICK REPLIES
-- Personal canned-response shortcuts. Fully self-only, same shape as
-- pinned_chats (0009_chat_enhancements.sql): no admin override, no
-- group scoping, owner-only on every operation.
-- ============================================================
create table quick_replies (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  shortcut text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, shortcut)
);

alter table quick_replies enable row level security;

create policy "quick replies readable by owner"
  on quick_replies for select
  using (user_id = auth.uid());

create policy "quick replies inserted by owner"
  on quick_replies for insert
  with check (user_id = auth.uid());

create policy "quick replies updated by owner"
  on quick_replies for update
  using (user_id = auth.uid());

create policy "quick replies deleted by owner"
  on quick_replies for delete
  using (user_id = auth.uid());

-- ============================================================
-- PART 2 — COLLABORATIVE CHECKLISTS
-- ============================================================
alter table messages drop constraint messages_message_type_check;
alter table messages add constraint messages_message_type_check
  check (message_type in ('text', 'poll', 'checklist'));

create table checklists (
  id bigint generated always as identity primary key,
  message_id bigint not null references messages(id),
  title text not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

create table checklist_items (
  id bigint generated always as identity primary key,
  checklist_id bigint not null references checklists(id),
  text text not null,
  position int not null default 0,
  completed_by uuid references profiles(id),
  completed_at timestamptz
);

-- RLS: reads gated by the same "can read the parent message" check as
-- message_attachments (0001_init.sql). All writes funnel through the
-- SECURITY DEFINER RPCs below (no client insert/update/delete policy —
-- default deny), same shape as polls/poll_options in 0010_telegram_features.sql.
alter table checklists enable row level security;
create policy "checklists readable if parent message is readable"
  on checklists for select
  using (
    exists (
      select 1 from messages m
      where m.id = checklists.message_id
        and (
          is_admin()
          or m.sender_id = auth.uid()
          or m.dm_user_a = auth.uid()
          or m.dm_user_b = auth.uid()
          or (
            m.group_id is not null
            and exists (
              select 1 from group_members gm
              where gm.group_id = m.group_id and gm.user_id = auth.uid()
            )
          )
        )
    )
  );

alter table checklist_items enable row level security;
create policy "checklist items readable if parent checklist is readable"
  on checklist_items for select
  using (
    exists (
      select 1 from checklists c
      join messages m on m.id = c.message_id
      where c.id = checklist_items.checklist_id
        and (
          is_admin()
          or m.sender_id = auth.uid()
          or m.dm_user_a = auth.uid()
          or m.dm_user_b = auth.uid()
          or (
            m.group_id is not null
            and exists (
              select 1 from group_members gm
              where gm.group_id = m.group_id and gm.user_id = auth.uid()
            )
          )
        )
    )
  );

-- create_checklist: creates the message (message_type='checklist') +
-- checklist + checklist_items atomically, same shape as create_poll.
-- Group-only (per spec: createChecklist(groupId, ...)), not available in DMs.
create or replace function create_checklist(
  p_group_id bigint,
  p_title text,
  p_items text[]
)
returns bigint
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_message_id bigint;
  v_checklist_id bigint;
  v_item text;
  v_position int := 0;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'INVALID_TITLE';
  end if;

  if p_items is null or array_length(p_items, 1) is null then
    raise exception 'INVALID_ITEMS';
  end if;

  if not exists (
    select 1 from group_members where group_id = p_group_id and user_id = v_actor
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  insert into messages (group_id, sender_id, content, message_type)
  values (p_group_id, v_actor, p_title, 'checklist')
  returning id into v_message_id;

  insert into checklists (message_id, title, created_by)
  values (v_message_id, p_title, v_actor)
  returning id into v_checklist_id;

  foreach v_item in array p_items loop
    insert into checklist_items (checklist_id, text, position) values (v_checklist_id, v_item, v_position);
    v_position := v_position + 1;
  end loop;

  return v_checklist_id;
end;
$$;

-- toggle_checklist_item: last-toggle-wins collaborative state — any member
-- of the checklist's group may flip an item, and there is no per-user
-- ownership of the completed/uncompleted state (unlike poll_votes, which is
-- scoped per-voter). The single UPDATE ... SET col = CASE ... statement
-- below reads and writes the row atomically under Postgres's normal
-- per-statement row lock, so two concurrent toggles on the same item can't
-- interleave into a torn (completed_by set, completed_at null) state —
-- whichever transaction commits last simply determines the final value.
create or replace function toggle_checklist_item(p_item_id bigint)
returns table (
  id bigint,
  completed_by uuid,
  completed_at timestamptz
)
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_group_id bigint;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select m.group_id into v_group_id
  from checklist_items ci
  join checklists c on c.id = ci.checklist_id
  join messages m on m.id = c.message_id
  where ci.id = p_item_id;

  if v_group_id is null then
    raise exception 'NOT_FOUND';
  end if;

  if not (
    is_admin()
    or exists (select 1 from group_members where group_id = v_group_id and user_id = v_actor)
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  update checklist_items
  set completed_by = case when completed_by is null then v_actor else null end,
      completed_at = case when completed_by is null then now() else null end
  where checklist_items.id = p_item_id
  returning checklist_items.id, checklist_items.completed_by, checklist_items.completed_at;
end;
$$;
