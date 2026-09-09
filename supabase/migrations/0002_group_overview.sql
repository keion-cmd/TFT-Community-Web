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

-- NOTE: TFT-Revision-UnifiedApp.md section F states group_resources should
-- "follow the same RLS-by-membership + Server Action re-check pattern as
-- everything else," but section D (the section this migration is scoped
-- to) gives no concrete policy text for it. No RLS policy is added here to
-- stay within "matching the ALTER/CREATE statements in the source doc
-- exactly" — flagged in BLOCKED ITEMS for a follow-up migration once the
-- exact membership/moderator-write policy is specified. RLS is switched on
-- now (safe default: deny-all until that follow-up policy lands) so the
-- table is never accidentally left open over PostgREST in the interim.
alter table group_resources enable row level security;
