-- ============================================================
-- 0005_role_change_notification.sql
-- T-CODE-19: change_role (0004_role_management.sql) writes role_history +
-- audit_logs internally but never notified the affected user — one of the
-- 6 gaps found by T-CODE-17's audit against spec §15. Adds the missing
-- notifications insert in the same place/pattern as those other two
-- side-effect writes, rather than pushing it out to roles.ts app code.
-- ============================================================

create or replace function change_role(
  p_user_id uuid,
  p_new_role_id smallint,
  p_reason text default null
)
returns profiles
language plpgsql
security definer
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_rank smallint;
  v_previous_role_id smallint;
  v_previous_rank smallint;
  v_new_rank smallint;
  v_new_role_name text;
  v_active_super_admin_count int;
  v_row profiles;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  select r.rank into v_actor_rank
  from profiles p join roles r on r.id = p.role_id
  where p.id = v_actor_id;

  if v_actor_rank is null or v_actor_rank < 40 then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select role_id into v_previous_role_id from profiles where id = p_user_id;
  if v_previous_role_id is null then
    raise exception 'NOT_FOUND';
  end if;

  select rank into v_previous_rank from roles where id = v_previous_role_id;
  select rank, name into v_new_rank, v_new_role_name from roles where id = p_new_role_id;
  if v_new_rank is null then
    raise exception 'INVALID_ROLE';
  end if;

  -- Only a Super Admin may touch the Super Admin tier, either direction:
  -- promoting into it or demoting out of it. Admins may act freely up to
  -- and including the Admin tier.
  if (v_new_rank >= 50 or v_previous_rank >= 50) and v_actor_rank < 50 then
    raise exception 'NOT_AUTHORIZED';
  end if;

  -- Last-Super-Admin protection (Phase 1 "CONFIRMED — Recovery approach":
  -- 2 standing Super Admins minimum, not 1). Only relevant when this change
  -- actually moves the target OUT of the Super Admin tier.
  if v_previous_rank >= 50 and v_new_rank < 50 then
    select count(*) into v_active_super_admin_count
    from profiles p
    join roles r on r.id = p.role_id
    where r.rank >= 50
      and p.status = 'active';

    if v_active_super_admin_count <= 2 then
      raise exception 'LAST_SUPER_ADMIN_PROTECTED';
    end if;
  end if;

  update profiles
  set role_id = p_new_role_id
  where id = p_user_id
  returning * into v_row;

  insert into role_history (user_id, previous_role_id, new_role_id, actor_id, reason)
  values (p_user_id, v_previous_role_id, p_new_role_id, v_actor_id, p_reason);

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id,
    'role_changed',
    'profile',
    p_user_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_role_id', v_previous_role_id,
      'new_role_id', p_new_role_id,
      'reason', p_reason
    ))
  );

  insert into notifications (user_id, type, payload)
  values (
    p_user_id,
    'admin',
    jsonb_build_object('message', 'Your role has been changed to ' || v_new_role_name || '.')
  );

  return v_row;
end;
$$;
