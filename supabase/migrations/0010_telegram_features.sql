-- ============================================================
-- 0010_telegram_features.sql
-- T-CODE-40: topics, polls, saved messages (self-DM), message
-- formatting (no schema change — see src/lib/messaging/formatMessage.ts),
-- and slow mode.
--
-- Base: main @ faa8175 (T-CODE-37). Highest existing migration on main is
-- 0009_chat_enhancements.sql (T-CODE-34) — this file is 0010.
-- ============================================================

-- ============================================================
-- PART 1 — TOPICS
-- Sub-discussions within a group. null messages.topic_id means
-- "General" / no topic — every existing message row is unaffected.
-- ============================================================
create table topics (
  id bigint generated always as identity primary key,
  group_id bigint not null references groups(id),
  name text not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz  -- soft-archive, not delete
);

alter table messages add column topic_id bigint references topics(id);

alter table topics enable row level security;

-- Same membership-check shape as group_resources (0002_group_overview.sql).
create policy "topics readable by group members or admin"
  on topics for select
  using (
    is_admin()
    or exists (
      select 1 from group_members gm
      where gm.group_id = topics.group_id and gm.user_id = auth.uid()
    )
  );

create policy "topics created by moderator/coordinator/admin"
  on topics for insert
  with check (
    is_admin()
    or exists (
      select 1 from group_members gm
      where gm.group_id = topics.group_id
        and gm.user_id = auth.uid()
        and gm.role_in_group in ('moderator','coordinator')
    )
  );

create policy "topics archived by moderator/coordinator/admin"
  on topics for update
  using (
    is_admin()
    or exists (
      select 1 from group_members gm
      where gm.group_id = topics.group_id
        and gm.user_id = auth.uid()
        and gm.role_in_group in ('moderator','coordinator')
    )
  );

-- ============================================================
-- PART 2 — POLLS
-- ============================================================
alter table messages add column message_type text not null default 'text';
alter table messages add constraint messages_message_type_check
  check (message_type in ('text','poll'));

create table polls (
  id bigint generated always as identity primary key,
  message_id bigint not null references messages(id),
  question text not null,
  allow_multiple boolean not null default false,
  closes_at timestamptz,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

create table poll_options (
  id bigint generated always as identity primary key,
  poll_id bigint not null references polls(id),
  text text not null,
  position int not null default 0
);

-- poll_votes.allow_multiple is a denormalized copy of polls.allow_multiple,
-- stamped by the trigger below at insert time (immutable per poll — polls
-- has no "change allow_multiple after creation" path). This is what makes
-- the vote-uniqueness constraint below possible as a real partial UNIQUE
-- INDEX: a partial index predicate can only reference columns of the
-- indexed table itself, not a joined table, so "allow_multiple" has to
-- live on poll_votes for `where allow_multiple = false` to be legal.
--
-- unique(poll_id, user_id, option_id) below stops an identical duplicate
-- vote row (same user, same option, e.g. a double-click retry).
-- poll_votes_single_choice_uidx below is the actual one-vote-per-user rule
-- for non-multiple polls: a real UNIQUE INDEX (not a trigger's read-then-
-- write check), so it is enforced atomically by Postgres itself — two
-- concurrent inserts for the same (poll_id, user_id) on a single-choice
-- poll cannot both succeed, one gets a unique_violation, full stop. This
-- is stronger than the exclusivity triggers elsewhere in this schema
-- (trg_position_exclusivity, trg_group_coordinator_exclusivity), which are
-- read-then-write checks in a trigger body — fine for their low-concurrency
-- admin-action use cases, but voting is exactly the kind of concurrent,
-- user-facing write where a real constraint is worth the extra column.
create table poll_votes (
  id bigint generated always as identity primary key,
  poll_id bigint not null references polls(id),
  option_id bigint not null references poll_options(id),
  user_id uuid not null references profiles(id),
  allow_multiple boolean not null,
  created_at timestamptz not null default now(),
  unique (poll_id, user_id, option_id)
);

create unique index poll_votes_single_choice_uidx
  on poll_votes (poll_id, user_id)
  where allow_multiple = false;

create or replace function stamp_poll_vote_allow_multiple() returns trigger as $$
begin
  select allow_multiple into new.allow_multiple from polls where id = new.poll_id;
  if new.allow_multiple is null then
    raise exception 'POLL_NOT_FOUND';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_poll_votes_stamp_allow_multiple
  before insert on poll_votes
  for each row execute function stamp_poll_vote_allow_multiple();

-- RLS: reads gated by the same "member of the poll's message's group"
-- check as messages itself; all writes funnel through the RPCs below
-- (no client insert/update/delete policy — default deny), same shape as
-- schedules/broadcast_targets in 0001_init.sql.
alter table polls enable row level security;
create policy "polls readable by group members or admin"
  on polls for select
  using (
    is_admin()
    or exists (
      select 1 from messages m
      join group_members gm on gm.group_id = m.group_id
      where m.id = polls.message_id and gm.user_id = auth.uid()
    )
  );

alter table poll_options enable row level security;
create policy "poll options readable by group members or admin"
  on poll_options for select
  using (
    is_admin()
    or exists (
      select 1 from polls p
      join messages m on m.id = p.message_id
      join group_members gm on gm.group_id = m.group_id
      where p.id = poll_options.poll_id and gm.user_id = auth.uid()
    )
  );

-- poll_votes: a user may read their own vote rows directly (or admin) —
-- NOT gated to "any group member", since that would leak who voted for
-- what to every group member via a raw client select. Aggregate counts +
-- "did I vote" are only available via get_poll_results() below.
alter table poll_votes enable row level security;
create policy "poll votes readable by their own voter or admin"
  on poll_votes for select
  using (user_id = auth.uid() or is_admin());

-- create_poll: creates the message (message_type='poll') + poll +
-- poll_options atomically — single plpgsql function body is one transaction.
create or replace function create_poll(
  p_group_id bigint,
  p_question text,
  p_options text[],
  p_allow_multiple boolean default false,
  p_closes_at timestamptz default null
)
returns bigint
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_message_id bigint;
  v_poll_id bigint;
  v_option text;
  v_position int := 0;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  if p_question is null or btrim(p_question) = '' then
    raise exception 'INVALID_QUESTION';
  end if;

  if p_options is null or array_length(p_options, 1) is null or array_length(p_options, 1) < 2 then
    raise exception 'INVALID_OPTIONS';
  end if;

  if not exists (
    select 1 from group_members where group_id = p_group_id and user_id = v_actor
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  insert into messages (group_id, sender_id, content, message_type)
  values (p_group_id, v_actor, p_question, 'poll')
  returning id into v_message_id;

  insert into polls (message_id, question, allow_multiple, closes_at, created_by)
  values (v_message_id, p_question, coalesce(p_allow_multiple, false), p_closes_at, v_actor)
  returning id into v_poll_id;

  foreach v_option in array p_options loop
    insert into poll_options (poll_id, text, position) values (v_poll_id, v_option, v_position);
    v_position := v_position + 1;
  end loop;

  return v_poll_id;
end;
$$;

-- vote_poll: rejects a closed poll or an over-full selection, then always
-- REPLACES the caller's vote set for this poll (delete then insert, inside
-- this function's single transaction) — "changing your vote replaces it,
-- not adds to it" applies uniformly whether the poll is single- or
-- multi-choice. poll_votes_single_choice_uidx above is the actual
-- data-integrity backstop against this function's logic having a bug.
create or replace function vote_poll(p_poll_id bigint, p_option_ids bigint[])
returns void
language plpgsql
security definer
as $$
declare
  v_actor uuid := auth.uid();
  v_allow_multiple boolean;
  v_closes_at timestamptz;
  v_group_id bigint;
  v_option_id bigint;
  v_valid_count int;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select p.allow_multiple, p.closes_at, m.group_id
    into v_allow_multiple, v_closes_at, v_group_id
  from polls p
  join messages m on m.id = p.message_id
  where p.id = p_poll_id;

  if v_group_id is null then
    raise exception 'NOT_FOUND';
  end if;

  if v_closes_at is not null and v_closes_at <= now() then
    raise exception 'POLL_CLOSED';
  end if;

  if not exists (
    select 1 from group_members where group_id = v_group_id and user_id = v_actor
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if p_option_ids is null or array_length(p_option_ids, 1) is null then
    raise exception 'INVALID_OPTIONS';
  end if;

  if not v_allow_multiple and array_length(p_option_ids, 1) > 1 then
    raise exception 'MULTIPLE_NOT_ALLOWED';
  end if;

  select count(*) into v_valid_count
  from poll_options
  where poll_id = p_poll_id and id = any(p_option_ids);
  if v_valid_count <> array_length(p_option_ids, 1) then
    raise exception 'INVALID_OPTIONS';
  end if;

  delete from poll_votes where poll_id = p_poll_id and user_id = v_actor;

  foreach v_option_id in array p_option_ids loop
    insert into poll_votes (poll_id, option_id, user_id)
    values (p_poll_id, v_option_id, v_actor);
  end loop;
end;
$$;

-- get_poll_results: aggregate counts + the caller's own vote only —
-- individual voter identities are never returned, by construction (the
-- query never selects poll_votes.user_id except to test it against the
-- caller via bool_or).
create or replace function get_poll_results(p_poll_id bigint)
returns table (
  option_id bigint,
  option_text text,
  vote_count bigint,
  voted_by_me boolean
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
  from polls p
  join messages m on m.id = p.message_id
  where p.id = p_poll_id;

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
  select
    po.id,
    po.text,
    count(pv.id),
    bool_or(pv.user_id = v_actor)
  from poll_options po
  left join poll_votes pv on pv.option_id = po.id
  where po.poll_id = p_poll_id
  group by po.id, po.text, po.position
  order by po.position;
end;
$$;

-- ============================================================
-- PART 3 — SAVED MESSAGES
-- No schema change. Verified (see report): dmPair(a,a) sorts to [a,a]
-- without error (a < a is false, returns [b,a] = [a,a]); the messages
-- check constraint (0001_init.sql) requires dm_user_a/dm_user_b both
-- non-null but never requires them to differ; the "messages readable by
-- participants" / "messages sent by authenticated participants" RLS
-- policies both pass when dm_user_a = dm_user_b = auth.uid(), since they
-- are OR'd conditions, not an implicit inequality. No migration needed
-- for this part.
-- ============================================================

-- ============================================================
-- PART 5 — SLOW MODE
-- ============================================================
alter table groups add column slow_mode_seconds int not null default 0;

-- update_group_slow_mode: same moderator/coordinator/admin gate as
-- update_group_location (0002_group_overview.sql).
create or replace function update_group_slow_mode(p_group_id bigint, p_seconds int)
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

  if p_seconds is null or p_seconds < 0 then
    raise exception 'INVALID_SECONDS';
  end if;

  select role_in_group into v_actor_role
  from group_members where group_id = p_group_id and user_id = v_actor;

  if not (is_admin() or v_actor_role in ('moderator','coordinator')) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update groups set slow_mode_seconds = p_seconds where id = p_group_id;

  insert into audit_logs (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'group_slow_mode_updated', 'group', p_group_id::text,
    jsonb_build_object('seconds', p_seconds));
end;
$$;
