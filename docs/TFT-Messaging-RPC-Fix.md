# TFT Community Platform — Schema Fix: Group Membership & Moderation RPCs (found in T-CODE-08)

## Problem
`group_members` and `messages` RLS write policies are `is_admin()`-only —
correct for group *creation* (Admin adds initial members directly), but
wrong for two everyday actions the product needs: a regular user
self-joining a public group, and a group **moderator/coordinator** (not a
global Admin) muting/removing someone or deleting a message in their own
group. Neither has a DB-layer write path today, so the app-layer functions
built in T-CODE-08 correctly fail closed (`NOT_ELIGIBLE`/`NOT_AUTHORIZED`)
instead of being silently wrong.

## Fix — three RPCs, same SECURITY DEFINER + self-checked pattern as claim_schedule / set_member_status

```sql
-- 1. Self-join, respecting group type rules
create or replace function join_group(p_group_id bigint)
returns group_members
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_type text;
  v_row group_members;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select type into v_type from groups where id = p_group_id and archived_at is null;
  if v_type is null then
    raise exception 'NOT_FOUND';
  end if;

  if v_type = 'staff_only' and not user_is_staff() then
    raise exception 'NOT_ELIGIBLE';
  elsif v_type = 'admin_only' and not is_admin() then
    raise exception 'NOT_ELIGIBLE';
  elsif v_type in ('private','broadcast') and not is_admin() then
    -- these require an explicit add, never self-join
    raise exception 'NOT_ELIGIBLE';
  end if;

  insert into group_members (group_id, user_id, role_in_group)
  values (p_group_id, v_user_id, 'member')
  on conflict (group_id, user_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from group_members where group_id = p_group_id and user_id = v_user_id;
  end if;

  return v_row;
end;
$$;

-- 2. Moderator/coordinator/admin-gated mute/unmute/remove
create or replace function moderate_group_member(
  p_group_id bigint,
  p_target_user_id uuid,
  p_action text,               -- 'mute' | 'unmute' | 'remove'
  p_mute_until timestamptz default null
)
returns void
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select role_in_group into v_actor_role
  from group_members where group_id = p_group_id and user_id = v_actor;

  if not (is_admin() or v_actor_role in ('moderator','coordinator')) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if p_action = 'mute' then
    update group_members set muted_until = p_mute_until
    where group_id = p_group_id and user_id = p_target_user_id;
  elsif p_action = 'unmute' then
    update group_members set muted_until = null
    where group_id = p_group_id and user_id = p_target_user_id;
  elsif p_action = 'remove' then
    delete from group_members
    where group_id = p_group_id and user_id = p_target_user_id;
  else
    raise exception 'INVALID_ACTION';
  end if;

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'group_member_moderated', 'group_member', p_target_user_id::text,
    jsonb_build_object('group_id', p_group_id, 'action', p_action));
end;
$$;

-- 3. Moderator/coordinator/admin-gated message soft-delete (for messages
--    that AREN'T the caller's own — own-message delete already works via
--    the existing sender_id = auth.uid() RLS policy, untouched here)
create or replace function moderate_delete_message(p_message_id bigint)
returns messages
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_group_id bigint;
  v_actor_role text;
  v_row messages;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select group_id into v_group_id from messages where id = p_message_id;
  if v_group_id is null then
    raise exception 'NOT_FOUND_OR_NOT_A_GROUP_MESSAGE';  -- DMs use the existing sender-only path
  end if;

  select role_in_group into v_actor_role
  from group_members where group_id = v_group_id and user_id = v_actor;

  if not (is_admin() or v_actor_role in ('moderator','coordinator')) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update messages set deleted_at = now()
  where id = p_message_id
  returning * into v_row;

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'message_moderated_delete', 'message', p_message_id::text,
    jsonb_build_object('group_id', v_group_id));

  return v_row;
end;
$$;
```

## App-layer changes needed to match
- `joinGroup` — call `rpc('join_group', ...)` instead of direct insert.
- `muteMember`/`removeMember` — call `rpc('moderate_group_member', ...)`.
- `deleteMessage`, when the target isn't the caller's own message — call
  `rpc('moderate_delete_message', ...)` instead of the direct UPDATE (own-
  message delete path is unaffected — that already works via existing RLS).

## Deferred (noted, not fixed here)
- Attachment upload UI / Storage bucket — still out of scope, needs its own task.
- Chats-list realtime not picking up new memberships mid-session without a
  page reload — minor, low priority, revisit during a polish pass.
- No DM-initiation entry point from a member list — small UI addition, can
  ride along with a future task rather than needing its own.
