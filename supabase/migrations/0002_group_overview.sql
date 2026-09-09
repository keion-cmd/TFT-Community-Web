-- ============================================================
-- 0002_group_overview.sql
-- Groups as first-class objects — schema delta only.
-- Source: TFT-Revision-UnifiedApp.md, section D, verbatim ALTER/CREATE
-- statements, plus the coordinator-exclusivity trigger that section D
-- describes in prose ("in practice: at most one 'coordinator' per group
-- enforced by a trigger, same pattern as the exclusive-position trigger
-- in Phase 3-B") but does not spell out as literal SQL — implemented
-- here following that same pattern (see enforce_position_exclusivity /
-- trg_position_exclusivity in 0001_init.sql).
-- ============================================================

-- groups gains operational context fields
alter table groups add column location text;
alter table groups add column pinned_message_id bigint references messages(id);

-- group_members gains a coordinator designation
alter table group_members
  drop constraint if exists group_members_role_in_group_check;
alter table group_members
  add constraint group_members_role_in_group_check
  check (role_in_group in ('member','moderator','coordinator'));

-- at most one 'coordinator' per group, mirroring trg_position_exclusivity's
-- shape (checked in a trigger rather than a partial unique index, since the
-- exclusivity condition here is "role_in_group = 'coordinator'" rather than
-- a static per-row flag on a referenced table):
create or replace function enforce_group_coordinator_exclusivity() returns trigger as $$
begin
  if new.role_in_group = 'coordinator' then
    if exists (
      select 1 from group_members
      where group_id = new.group_id
        and role_in_group = 'coordinator'
        and id <> coalesce(new.id, -1)
    ) then
      raise exception 'This group already has a coordinator';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_group_coordinator_exclusivity
  before insert or update on group_members
  for each row execute function enforce_group_coordinator_exclusivity();

-- schedules can now optionally belong to a group
alter table schedules add column group_id bigint references groups(id);
create index idx_schedules_group on schedules(group_id);

-- curated resources, distinct from raw chat attachments
create table group_resources (
  id bigint generated always as identity primary key,
  group_id bigint not null references groups(id),
  title text not null,
  url text,
  storage_path text,
  added_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  check (url is not null or storage_path is not null)
);

-- group_resources RLS: membership-gated read, moderator/coordinator/admin
-- write, per TFT-Revision-UnifiedApp.md section F's "RLS-by-membership +
-- Server Action re-check" pattern, made concrete in
-- docs/TFT-Schema-Addendum.md section 4.
alter table group_resources enable row level security;

create policy "group resources visible to group members"
  on group_resources for select
  using (
    exists (select 1 from group_members gm where gm.group_id = group_resources.group_id and gm.user_id = auth.uid())
    or is_admin()
  );

create policy "group resources insertable by moderator/coordinator/admin"
  on group_resources for insert
  with check (
    is_admin()
    or exists (
      select 1 from group_members gm
      where gm.group_id = group_resources.group_id
        and gm.user_id = auth.uid()
        and gm.role_in_group in ('moderator','coordinator')
    )
  );

create policy "group resources deletable by moderator/coordinator/admin"
  on group_resources for delete
  using (
    is_admin()
    or exists (
      select 1 from group_members gm
      where gm.group_id = group_resources.group_id
        and gm.user_id = auth.uid()
        and gm.role_in_group in ('moderator','coordinator')
    )
  );

-- ============================================================
-- Group-type visibility (docs/TFT-Schema-Addendum.md section 5)
--
-- public       — any authenticated, active user
-- staff_only   — Role >= Assistant Admin, OR holds an active Position
-- admin_only   — Role >= Admin
-- private/broadcast — explicit group_members row only (invite-only)
-- Admin always sees all, for oversight.
--
-- NOTE: 0001_init.sql already defines a broader "groups readable by
-- members or admin" SELECT policy (is_admin() OR type='public' OR any
-- group_members row exists, regardless of type). Postgres combines
-- multiple permissive SELECT policies with OR, so that existing policy's
-- unconditional "member exists" clause will still grant read access to a
-- staff_only/admin_only group for any user who has a group_members row
-- there, independent of the type-based checks below. Amending 0001's
-- policy is outside this migration's authorized scope (0002 amendments
-- only add group_resources policies + this function/policy per the task
-- instructions) — flagged here rather than silently touching 0001.
-- ============================================================
create or replace function user_is_staff() returns boolean
language sql stable as $$
  select coalesce(
    current_role_rank() >= 30
    or exists (select 1 from user_positions where user_id = auth.uid() and revoked_at is null),
    false
  );
$$;

create policy "groups visible per type"
  on groups for select
  using (
    type = 'public'
    or (type = 'staff_only' and user_is_staff())
    or (type = 'admin_only' and is_admin())
    or (type in ('private','broadcast') and exists (
      select 1 from group_members gm where gm.group_id = groups.id and gm.user_id = auth.uid()
    ))
    or is_admin()
  );

-- ============================================================
-- Moderator/coordinator RPCs (docs/TFT-GroupOverview-RPC-Fix.md, found in
-- T-CODE-10) — same SECURITY DEFINER + self-checked + audit_logs pattern as
-- join_group / moderate_group_member / moderate_delete_message
-- (docs/TFT-Messaging-RPC-Fix.md, 0001_init.sql).
-- ============================================================

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
