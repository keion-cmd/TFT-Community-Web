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
