# TFT Community Platform — Schema Addendum (resolves T-CODE-02 blocked items)

## 1. `sessions` table (was listed, never defined)

Read-model only — actual token validity is Supabase Auth's job (Phase 6-D). Populated on sign-in, updated by heartbeat, marked `revoked_at` when Admin force-revokes or on suspend/remove.

```sql
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

alter table sessions enable row level security;
create policy "users see own sessions, admins see all"
  on sessions for select
  using (user_id = auth.uid() or is_admin());
```

## 2. Missing RPC bodies

```sql
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
```

## 3. Exclusivity index bug — confirmed, drop the index

The unique index was redundant *and* wrong (applies to every position, not just `is_exclusive` ones) — the trigger alone is correct and sufficient. Drop it:

```sql
drop index if exists one_active_holder_if_exclusive;
```

## 4. `group_resources` policies

```sql
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
```

## 5. Group-type visibility — confirmed mapping

- `public` — any authenticated, active user
- `staff_only` — Role ≥ Assistant Admin, OR holds at least one active Position
- `admin_only` — Role ≥ Admin
- `private` / `broadcast` — must be an explicit `group_members` row (invite-only); Admin always sees all for oversight

```sql
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
```

## 6. Repo hygiene

Add `docs/TFT-Phase1-Audit.md` through `docs/TFT-Phase7-Testing-Deployment.md` + `docs/TFT-Revision-UnifiedApp.md` to the repo (a `docs/` folder, committed) so future Claude Code passes can `Read` them directly instead of needing them pasted inline each time.
