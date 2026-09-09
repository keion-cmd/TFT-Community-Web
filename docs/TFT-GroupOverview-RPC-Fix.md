# TFT Community Platform — Schema Fix: Group Overview Moderator RPCs (found in T-CODE-10)

## Problem

`groups` has exactly one write policy (`"groups updated by admin"`, `using (is_admin())`) —
correct for Admin-driven edits, but the Revision doc's API delta (section E) and this
task's spec both call for a **group's coordinator or moderator** (not just a global
Admin) to be able to:

- edit `groups.location` (`updateGroupLocation`)
- set/clear `groups.pinned_message_id` (`pinMessage` / `unpinMessage`)

There is no RLS path for a non-Admin coordinator/moderator to do any of this today — a
direct client `UPDATE` from a moderator would be filtered to zero rows by RLS (not an
error, just a silent no-op), which is worse than failing closed. Admin's own path is
unaffected — `is_admin()` already covers it via direct `UPDATE`, unchanged here.

Separately, `group_resources`' delete policy (`0002_group_overview.sql`) covers
`is_admin()` and `moderator`/`coordinator` — correct for that case — but this task's
spec also allows **the member who added a resource** to remove their own, even if
they hold no elevated role in the group. That clause has no RLS coverage (no
`added_by = auth.uid()` branch), so a plain member removing their own link resource
would also silently no-op under RLS today. `addGroupResource` / the admin-or-moderator
delete path are both already correctly covered by existing RLS and need no RPC.

## Fix — three RPCs, same SECURITY DEFINER + self-checked + audit_logs pattern as
## join_group / moderate_group_member / moderate_delete_message (docs/TFT-Messaging-RPC-Fix.md)

```sql
-- 1. Moderator/coordinator/admin-gated group location edit (Admin's own path
--    already works via direct UPDATE + the existing "groups updated by admin"
--    policy; this RPC only needs to additionally cover the non-Admin case, but
--    is written to also accept Admin so callers have one code path)
create or replace function update_group_location(p_group_id bigint, p_location text)
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

  update groups set location = p_location where id = p_group_id;

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'group_location_updated', 'group', p_group_id::text,
    jsonb_build_object('location', p_location));
end;
$$;

-- 2. Moderator/coordinator/admin-gated pin/unpin. Verifies the message
--    actually belongs to the group before pinning (defense-in-depth backstop
--    behind the app-layer check in pinMessage).
create or replace function pin_message(p_group_id bigint, p_message_id bigint)
returns void
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_message_group bigint;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select role_in_group into v_actor_role
  from group_members where group_id = p_group_id and user_id = v_actor;

  if not (is_admin() or v_actor_role in ('moderator','coordinator')) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select group_id into v_message_group from messages where id = p_message_id and deleted_at is null;
  if v_message_group is null or v_message_group <> p_group_id then
    raise exception 'NOT_FOUND_OR_WRONG_GROUP';
  end if;

  update groups set pinned_message_id = p_message_id where id = p_group_id;

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'group_message_pinned', 'group', p_group_id::text,
    jsonb_build_object('message_id', p_message_id));
end;
$$;

create or replace function unpin_message(p_group_id bigint)
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

  update groups set pinned_message_id = null where id = p_group_id;

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'group_message_unpinned', 'group', p_group_id::text, '{}'::jsonb);
end;
$$;

-- 3. Resource removal by its own adder, when that adder holds no elevated
--    role in the group (the admin/moderator/coordinator path is already
--    covered by 0002_group_overview.sql's existing delete policy and does
--    NOT need this RPC — removeGroupResource only calls this for the
--    "adder, not otherwise privileged" case)
create or replace function remove_own_group_resource(p_resource_id bigint)
returns void
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_added_by uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select added_by into v_added_by from group_resources where id = p_resource_id;
  if v_added_by is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_added_by <> v_actor then
    raise exception 'NOT_AUTHORIZED';
  end if;

  delete from group_resources where id = p_resource_id;
end;
$$;
```

## App-layer changes needed to match

- `updateGroupLocation` — Admin path: direct `UPDATE` on `groups` (already works via
  existing RLS, unchanged). Coordinator/moderator (non-Admin) path: calls
  `rpc('update_group_location', ...)` — **currently fails** (function does not exist
  yet), so that path correctly fails closed rather than silently no-op'ing.
- `pinMessage` / `unpinMessage` — same Admin-direct / moderator-RPC split as above.
- `removeGroupResource` — Admin/moderator/coordinator path: direct `DELETE` (already
  works via existing `0002_group_overview.sql` policy, unchanged). Adder-only
  (non-privileged) path: calls `rpc('remove_own_group_resource', ...)` — **currently
  fails** for the same reason.

## Deferred (noted, not fixed here)

- File-upload resources (`storage_path`) — still out of scope, no Storage bucket yet
  (same deferral as T-CODE-08/T-CODE-10 task text).
- Full Group Settings editing (name/description/type/archive) beyond `location` — out
  of this task's scope per its own instructions.
