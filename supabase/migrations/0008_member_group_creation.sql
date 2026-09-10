-- ============================================================
-- T-CODE-32: member-created groups (Telegram-style ownership)
-- Any active member may create a 'public' or 'private' group and
-- automatically becomes that group's moderator. 'staff_only',
-- 'admin_only', and 'broadcast' remain Admin-only via the existing
-- direct-insert path (groups insert RLS policy, unchanged).
--
-- SECURITY DEFINER + self-checked pattern, same as join_group /
-- claim_schedule (0001_init.sql): the function runs as its owner, which
-- bypasses the admin-only "groups created by admin" / "group membership
-- managed by admin" RLS policies, so the function body is the only gate.
-- ============================================================
create or replace function create_group(
  p_name text,
  p_description text,
  p_type text
)
returns groups
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_group groups;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select status into v_status from profiles where id = v_user_id;
  if v_status is distinct from 'active' then
    raise exception 'ACCOUNT_NOT_ACTIVE';
  end if;

  if p_type not in ('public', 'private') then
    raise exception 'TYPE_NOT_SELF_SERVICE';
  end if;

  insert into groups (name, type, description, created_by)
  values (p_name, p_type, p_description, v_user_id)
  returning * into v_group;

  insert into group_members (group_id, user_id, role_in_group)
  values (v_group.id, v_user_id, 'moderator');

  insert into audit_logs (actor_id, action, target_type, target_id)
  values (v_user_id, 'group_created_self_service', 'group', v_group.id::text);

  return v_group;
end;
$$;
