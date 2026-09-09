-- ============================================================
-- 0001_init.sql
-- TFT Community Platform — initial schema
-- Source: TFT-Phase3-Database.md, section B (DDL), section C
-- (claim_schedule RPC), section D (RLS pattern + helper functions +
-- representative policies, extended here to full per-table coverage).
--
-- Gaps originally flagged in T-CODE-02's report (sessions table, the
-- check_in_schedule/release_schedule/send_broadcast RPC bodies, and the
-- one_active_holder_if_exclusive index bug) are resolved per
-- docs/TFT-Schema-Addendum.md — see the sessions table below, the RPCs
-- after claim_schedule, and the exclusivity trigger note.
-- ============================================================

-- ============================================================
-- ROLES  (fixed hierarchy, rank drives comparisons everywhere)
-- ============================================================
create table roles (
  id smallint primary key,
  name text unique not null,
  rank smallint unique not null   -- higher = more powerful
);
insert into roles (id, name, rank) values
  (1, 'Member', 10),
  (2, 'Editor', 20),
  (3, 'Assistant Admin', 30),
  (4, 'Admin', 40),
  (5, 'Super Admin', 50);

-- ============================================================
-- PROFILES  (1:1 with auth.users)
-- ============================================================
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  bio text,
  avatar_url text,
  role_id smallint not null references roles(id) default 1,
  status text not null default 'pending_approval'
    check (status in ('pending_approval','active','suspended','disabled','removed','rejected')),
  last_active_at timestamptz,
  created_at timestamptz not null default now()
);

create table role_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  previous_role_id smallint references roles(id),
  new_role_id smallint not null references roles(id),
  actor_id uuid not null references profiles(id),
  reason text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- POSITIONS  (fully admin-authored, per Phase 1 decision)
-- ============================================================
create table positions (
  id bigint generated always as identity primary key,
  name text unique not null,             -- "Schedule Coordinator", "Crown", "King", "Muse"...
  description text,
  min_role_id smallint not null references roles(id) default 1,
  is_exclusive boolean not null default false,  -- true = only one active holder at a time
  is_active boolean not null default true,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

create table user_positions (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  position_id bigint not null references positions(id),
  assigned_by uuid not null references profiles(id),
  assigned_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references profiles(id),
  unique (user_id, position_id) -- prevents duplicate active holding rows; re-assign after revoke inserts new row
);

create table position_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  position_id bigint not null references positions(id),
  action text not null check (action in ('assigned','revoked','transferred')),
  actor_id uuid not null references profiles(id),
  notes text,
  created_at timestamptz not null default now()
);

-- Exclusivity for is_exclusive positions is enforced solely by the trigger
-- below. (Addendum section 3: a partial unique index previously stood here
-- but applied to every position_id regardless of is_exclusive — redundant
-- with, and broader than, the trigger. Removed rather than fixed in place
-- since the trigger alone is correct and sufficient.)

create or replace function enforce_position_exclusivity() returns trigger as $$
begin
  if (select is_exclusive from positions where id = new.position_id) then
    if exists (
      select 1 from user_positions
      where position_id = new.position_id and revoked_at is null
    ) then
      raise exception 'This position is exclusive and already has an active holder';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_position_exclusivity
  before insert on user_positions
  for each row execute function enforce_position_exclusivity();

-- ============================================================
-- GROUPS
-- ============================================================
create table groups (
  id bigint generated always as identity primary key,
  name text not null,
  type text not null check (type in ('public','staff_only','admin_only','private','broadcast')),
  description text,
  created_by uuid not null references profiles(id),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table group_members (
  id bigint generated always as identity primary key,
  group_id bigint not null references groups(id),
  user_id uuid not null references profiles(id),
  role_in_group text not null default 'member' check (role_in_group in ('member','moderator')),
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

-- ============================================================
-- MESSAGING
-- ============================================================
create table messages (
  id bigint generated always as identity primary key,
  group_id bigint references groups(id),      -- null for DMs
  dm_user_a uuid references profiles(id),      -- null for group messages
  dm_user_b uuid references profiles(id),
  sender_id uuid not null references profiles(id),
  content text,
  reply_to_id bigint references messages(id),
  edited_at timestamptz,
  deleted_at timestamptz,                      -- soft delete
  created_at timestamptz not null default now(),
  check (
    (group_id is not null and dm_user_a is null and dm_user_b is null)
    or (group_id is null and dm_user_a is not null and dm_user_b is not null)
  )
);

create table message_attachments (
  id bigint generated always as identity primary key,
  message_id bigint not null references messages(id),
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);

create table message_reactions (
  id bigint generated always as identity primary key,
  message_id bigint not null references messages(id),
  user_id uuid not null references profiles(id),
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

create table message_reads (
  message_id bigint not null references messages(id),
  user_id uuid not null references profiles(id),
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- ============================================================
-- SCHEDULING  (the concurrency-critical module)
-- ============================================================
create table schedule_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);
insert into schedule_settings (key, value) values
  ('missed_threshold_minutes', '720'),   -- 12 hours, confirmed Phase 1
  ('max_slots_per_user', 'null'),        -- unset = no cap, tune later
  ('claim_cutoff_minutes', 'null'),
  ('release_cutoff_minutes', 'null');

create table schedules (
  id bigint generated always as identity primary key,
  date date not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  position_id bigint references positions(id),   -- optional: restrict slot to a position
  status text not null default 'available'
    check (status in ('available','claimed','checked_in','active','completed','cancelled','missed','released')),
  assigned_user_id uuid references profiles(id),
  created_by uuid not null references profiles(id),
  notes text,
  claimed_at timestamptz,
  checkin_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now()
);

create index idx_schedules_status on schedules(status);
create index idx_schedules_assigned_user on schedules(assigned_user_id);

-- ============================================================
-- BROADCAST
-- ============================================================
create table broadcasts (
  id bigint generated always as identity primary key,
  sender_id uuid not null references profiles(id),
  message text not null,
  attachment_url text,
  idempotency_key text unique not null,   -- client-generated UUID, prevents double-send
  created_at timestamptz not null default now()
);

create table broadcast_targets (
  id bigint generated always as identity primary key,
  broadcast_id bigint not null references broadcasts(id),
  group_id bigint not null references groups(id),
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  sent_at timestamptz,
  error text,
  retry_count int not null default 0,
  unique (broadcast_id, group_id)
);

-- ============================================================
-- GOVERNANCE
-- ============================================================
create table audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references profiles(id),
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table approvals (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  reason text,
  created_at timestamptz not null default now()
);

create table notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  type text not null,                 -- 'message','mention','schedule_reminder','role_changed',...
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- sessions: read-model only, actual token validity is Supabase Auth's job
-- (Phase 6-D). Populated on sign-in, updated by heartbeat, marked
-- revoked_at when Admin force-revokes or on suspend/remove.
-- Source: docs/TFT-Schema-Addendum.md section 1.
create table sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id),
  device_info text,
  ip_address inet,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index idx_sessions_user on sessions(user_id);

-- ============================================================
-- RPC: claim_schedule
-- Source: TFT-Phase3-Database.md section C, verbatim.
-- The single atomic UPDATE ... WHERE status = 'available' is the
-- concurrency guarantee — client never does a read-then-write.
-- ============================================================
create or replace function claim_schedule(p_schedule_id bigint)
returns schedules
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_row schedules;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Eligibility check: does the user hold a Position qualifying for this slot
  -- (or slot has no position restriction)?
  if not exists (
    select 1 from schedules s
    left join positions p on p.id = s.position_id
    where s.id = p_schedule_id
      and (
        s.position_id is null
        or exists (
          select 1 from user_positions up
          where up.user_id = v_user_id
            and up.position_id = s.position_id
            and up.revoked_at is null
        )
      )
  ) then
    raise exception 'Not eligible to claim this slot';
  end if;

  -- THE ATOMIC PART: this single UPDATE is the concurrency guarantee.
  -- Postgres row-level locking means only one concurrent transaction
  -- can win this UPDATE; the loser's WHERE clause simply matches 0 rows.
  update schedules
  set status = 'claimed',
      assigned_user_id = v_user_id,
      claimed_at = now()
  where id = p_schedule_id
    and status = 'available'          -- <-- this is what makes it safe
  returning * into v_row;

  if v_row.id is null then
    raise exception 'SLOT_ALREADY_CLAIMED';
  end if;

  insert into audit_logs (actor_id, action, target_type, target_id)
  values (v_user_id, 'schedule_claimed', 'schedule', p_schedule_id::text);

  return v_row;
end;
$$;

-- ============================================================
-- RPC: check_in_schedule / release_schedule / send_broadcast
-- Source: docs/TFT-Schema-Addendum.md section 2 (RPCs referenced by name
-- in TFT-Phase3-Database.md section C but without bodies until now).
-- ============================================================
create or replace function check_in_schedule(p_schedule_id bigint)
returns schedules
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_row schedules;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  update schedules
  set status = 'checked_in', checkin_at = now()
  where id = p_schedule_id
    and assigned_user_id = v_user_id
    and status = 'claimed'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'NOT_YOUR_SLOT_OR_INVALID_STATE';
  end if;

  insert into audit_logs (actor_id, action, target_type, target_id)
  values (v_user_id, 'schedule_checked_in', 'schedule', p_schedule_id::text);

  return v_row;
end;
$$;

create or replace function release_schedule(p_schedule_id bigint)
returns schedules
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_row schedules;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  update schedules
  set status = 'available', assigned_user_id = null, claimed_at = null
  where id = p_schedule_id
    and status in ('claimed','checked_in')
    and (assigned_user_id = v_user_id or is_admin())
  returning * into v_row;

  if v_row.id is null then
    raise exception 'NOT_YOUR_SLOT_OR_INVALID_STATE';
  end if;

  insert into audit_logs (actor_id, action, target_type, target_id)
  values (v_user_id, 'schedule_released', 'schedule', p_schedule_id::text);

  return v_row;
end;
$$;

-- send_broadcast: creates the broadcast + per-target rows atomically.
-- Actual delivery (inserting the message into each target group) happens in a
-- background job processing 'pending' broadcast_targets rows, NOT synchronously
-- here — matches the background-jobs pattern from Phase 3/6, keeps this RPC fast.
-- Note: references current_role_rank(), defined below in the RLS helper
-- functions section — safe forward reference, plpgsql function bodies are
-- only resolved at call time, not at CREATE FUNCTION time.
create or replace function send_broadcast(
  p_message text,
  p_attachment_url text,
  p_target_group_ids bigint[],
  p_idempotency_key text
)
returns broadcasts
language plpgsql
security definer
as $$
declare
  v_user_id uuid := auth.uid();
  v_broadcast broadcasts;
  v_group_id bigint;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if current_role_rank() < 40 then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if p_target_group_ids is null or array_length(p_target_group_ids, 1) is null then
    raise exception 'NO_TARGETS_SELECTED';
  end if;

  select * into v_broadcast from broadcasts where idempotency_key = p_idempotency_key;
  if found then
    return v_broadcast;  -- duplicate request: return original result, no error, no re-send
  end if;

  insert into broadcasts (sender_id, message, attachment_url, idempotency_key)
  values (v_user_id, p_message, p_attachment_url, p_idempotency_key)
  returning * into v_broadcast;

  foreach v_group_id in array p_target_group_ids loop
    insert into broadcast_targets (broadcast_id, group_id, status)
    values (v_broadcast.id, v_group_id, 'pending');
  end loop;

  insert into audit_logs (actor_id, action, target_type, target_id)
  values (v_user_id, 'broadcast_sent', 'broadcast', v_broadcast.id::text);

  return v_broadcast;
end;
$$;

-- ============================================================
-- RLS — helper functions
-- Source: TFT-Phase3-Database.md section D, verbatim.
-- ============================================================
create or replace function current_role_rank() returns smallint
language sql stable as $$
  select r.rank from profiles p join roles r on r.id = p.role_id
  where p.id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable as $$
  select coalesce(current_role_rank() >= 40, false); -- Admin or Super Admin
$$;

-- ============================================================
-- RLS — policies, per table
--
-- SCOPE NOTE: section D of the source doc gives four "representative"
-- policies (profiles select/update, schedules select, audit_logs select,
-- broadcasts insert) and states the general shape explicitly: "reads are
-- permissive within role/membership boundaries, writes to sensitive
-- tables are funneled through RPC functions (not raw client UPDATE/
-- INSERT)". The task calls for extending that shape to every table.
-- Where the source docs do not specify the exact membership boundary
-- for a table (e.g. which group types are visible to whom), the policy
-- below follows the closest literal precedent and is flagged in
-- BLOCKED ITEMS rather than silently assumed as spec.
--
-- CORRECTNESS FIX: the source doc's broadcasts policy is written with
-- `using (is_admin())` on an INSERT policy. Postgres INSERT policies are
-- evaluated with WITH CHECK, not USING — `using` on a bare `for insert`
-- policy is rejected by the database. Every INSERT policy below uses
-- `with check` accordingly; this is a syntax correction, not a change
-- in who is allowed to do what.
-- ============================================================

-- ---- roles ----
-- Static seed data, no RLS needed for client reads (referenced via FK
-- everywhere); still enabled defensively, read-only to authenticated users.
alter table roles enable row level security;
create policy "roles readable by any authenticated user"
  on roles for select
  using (auth.role() = 'authenticated');

-- ---- profiles ----
alter table profiles enable row level security;
create policy "profiles readable by any authenticated approved user"
  on profiles for select
  using (auth.role() = 'authenticated');

create policy "users update only their own profile"
  on profiles for update
  using (id = auth.uid());

create policy "users insert only their own profile"
  on profiles for insert
  with check (id = auth.uid());

-- ---- role_history ----
alter table role_history enable row level security;
create policy "role history admin-only read"
  on role_history for select
  using (is_admin());
-- writes happen only through admin Server Actions using service role / RPC,
-- never direct client INSERT — no insert policy defined (default deny).

-- ---- positions ----
alter table positions enable row level security;
create policy "positions readable by any authenticated user"
  on positions for select
  using (auth.role() = 'authenticated');

create policy "positions managed by admin"
  on positions for insert
  with check (is_admin());

create policy "positions updated by admin"
  on positions for update
  using (is_admin());

-- ---- user_positions ----
alter table user_positions enable row level security;
create policy "user positions readable by any authenticated user"
  on user_positions for select
  using (auth.role() = 'authenticated');

create policy "user positions assigned by admin"
  on user_positions for insert
  with check (is_admin());

create policy "user positions revoked by admin"
  on user_positions for update
  using (is_admin());

-- ---- position_history ----
alter table position_history enable row level security;
create policy "position history admin-only read"
  on position_history for select
  using (is_admin());
-- writes happen only through admin Server Actions / RPC — no insert policy.

-- ---- groups ----
alter table groups enable row level security;
create policy "groups readable by members or admin"
  on groups for select
  using (
    is_admin()
    or type = 'public'
    or exists (
      select 1 from group_members gm
      where gm.group_id = groups.id and gm.user_id = auth.uid()
    )
  );

create policy "groups created by admin"
  on groups for insert
  with check (is_admin());

create policy "groups updated by admin"
  on groups for update
  using (is_admin());

-- ---- group_members ----
alter table group_members enable row level security;
create policy "group members readable by fellow members or admin"
  on group_members for select
  using (
    is_admin()
    or user_id = auth.uid()
    or exists (
      select 1 from group_members gm
      where gm.group_id = group_members.group_id and gm.user_id = auth.uid()
    )
  );

create policy "group membership managed by admin"
  on group_members for insert
  with check (is_admin());

create policy "group membership updated by admin"
  on group_members for update
  using (is_admin());

create policy "group membership removed by admin"
  on group_members for delete
  using (is_admin());

-- ---- messages ----
alter table messages enable row level security;
create policy "messages readable by participants"
  on messages for select
  using (
    is_admin()
    or sender_id = auth.uid()
    or dm_user_a = auth.uid()
    or dm_user_b = auth.uid()
    or (
      group_id is not null
      and exists (
        select 1 from group_members gm
        where gm.group_id = messages.group_id and gm.user_id = auth.uid()
      )
    )
  );

create policy "messages sent by authenticated participants"
  on messages for insert
  with check (
    sender_id = auth.uid()
    and (
      (dm_user_a = auth.uid() or dm_user_b = auth.uid())
      or (
        group_id is not null
        and exists (
          select 1 from group_members gm
          where gm.group_id = messages.group_id and gm.user_id = auth.uid()
        )
      )
    )
  );

create policy "messages edited or soft-deleted by sender or admin"
  on messages for update
  using (sender_id = auth.uid() or is_admin());

-- ---- message_attachments ----
alter table message_attachments enable row level security;
create policy "attachments readable if parent message is readable"
  on message_attachments for select
  using (
    exists (
      select 1 from messages m
      where m.id = message_attachments.message_id
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

create policy "attachments added by message sender"
  on message_attachments for insert
  with check (
    exists (
      select 1 from messages m
      where m.id = message_attachments.message_id and m.sender_id = auth.uid()
    )
  );

-- ---- message_reactions ----
alter table message_reactions enable row level security;
create policy "reactions readable if parent message is readable"
  on message_reactions for select
  using (
    exists (
      select 1 from messages m
      where m.id = message_reactions.message_id
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

create policy "reactions added by their own user"
  on message_reactions for insert
  with check (user_id = auth.uid());

create policy "reactions removed by their own user"
  on message_reactions for delete
  using (user_id = auth.uid());

-- ---- message_reads ----
alter table message_reads enable row level security;
create policy "read receipts readable by own user or admin"
  on message_reads for select
  using (user_id = auth.uid() or is_admin());

create policy "read receipts inserted by own user"
  on message_reads for insert
  with check (user_id = auth.uid());

-- ---- schedule_settings ----
alter table schedule_settings enable row level security;
create policy "schedule settings admin-only read"
  on schedule_settings for select
  using (is_admin());

create policy "schedule settings admin-only write"
  on schedule_settings for update
  using (is_admin());

-- ---- schedules ----
alter table schedules enable row level security;
create policy "schedules visible to all active members"
  on schedules for select
  using (auth.role() = 'authenticated');
  -- writes happen ONLY through the RPC functions above, never direct UPDATE/INSERT from client

create policy "schedule slots created by admin"
  on schedules for insert
  with check (is_admin());
  -- claim/check-in/release/cancel of an EXISTING slot happen only through
  -- security-definer RPCs (claim_schedule, check_in_schedule,
  -- release_schedule above). No general client UPDATE policy is defined
  -- here so that those state transitions cannot be performed by a raw
  -- client UPDATE bypassing RPC business rules;
  -- admin override (reassign/cancel, per the Revision doc's Schedule tab)
  -- is the one direct-UPDATE exception:
create policy "schedule slots overridden by admin"
  on schedules for update
  using (is_admin());

-- ---- broadcasts ----
alter table broadcasts enable row level security;
create policy "broadcast create admin/position-gated"
  on broadcasts for insert
  with check (is_admin());  -- position-gated Editor exception handled in app layer for V1

create policy "broadcasts readable by admin"
  on broadcasts for select
  using (is_admin() or sender_id = auth.uid());

-- ---- broadcast_targets ----
alter table broadcast_targets enable row level security;
create policy "broadcast targets readable by admin"
  on broadcast_targets for select
  using (is_admin());
-- writes happen only through the send_broadcast RPC above — no client
-- insert/update policy defined (default deny).

-- ---- audit_logs ----
alter table audit_logs enable row level security;
create policy "audit logs admin-only"
  on audit_logs for select
  using (is_admin());
-- inserts come only from security-definer RPCs (e.g. claim_schedule above),
-- which run as the function owner and are not subject to this policy.

-- ---- approvals ----
alter table approvals enable row level security;
create policy "approvals readable by admin or the applicant"
  on approvals for select
  using (is_admin() or user_id = auth.uid());

create policy "approvals reviewed by admin"
  on approvals for update
  using (is_admin());

-- ---- notifications ----
alter table notifications enable row level security;
create policy "notifications readable by their own user"
  on notifications for select
  using (user_id = auth.uid());

create policy "notifications marked read by their own user"
  on notifications for update
  using (user_id = auth.uid());
-- inserts are system-generated (triggers / server actions using service
-- role), not raw client writes — no insert policy defined.

-- ---- sessions ----
-- Source: docs/TFT-Schema-Addendum.md section 1.
alter table sessions enable row level security;
create policy "users see own sessions, admins see all"
  on sessions for select
  using (user_id = auth.uid() or is_admin());
-- writes (create on sign-in, heartbeat update, revoke) are system-generated
-- via server actions using service role / RPC, not raw client writes —
-- no insert/update policy defined (default deny).
