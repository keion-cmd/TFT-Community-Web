-- ============================================================
-- 0003_scheduling_missed_detection.sql
-- T-CODE-12: the one migration change this task is scoped to make.
-- claim_schedule / check_in_schedule / release_schedule (0001_init.sql) are
-- untouched — this only adds a new function for the missed-shift cron.
-- ============================================================

-- detect_missed_schedules: flips 'claimed' schedules whose start_time is
-- older than schedule_settings.missed_threshold_minutes (default 720, i.e.
-- 12 hours, matching the seed row) to 'missed', notifies the assigned user,
-- and writes an audit_logs entry per schedule. Returns the flagged rows so
-- the calling Route Handler can report what it did.
--
-- Deliberately has NO auth.uid()/is_admin() check inside the body — unlike
-- claim_schedule/set_member_status/etc., which read auth.uid() and require
-- being invoked through the caller's own session client (see the
-- set_member_status comment above), this function represents a *system*
-- action with no calling user at all: it is only ever invoked by the cron
-- Route Handler via the service-role client, which has no auth.uid() to
-- check. The security boundary is therefore EXECUTE privilege, locked down
-- to service_role below, plus the Route Handler's own shared-secret check —
-- not a role check in the function body.
create or replace function detect_missed_schedules()
returns setof schedules
language plpgsql
security definer
as $$
declare
  v_threshold_minutes int;
  v_row schedules;
begin
  select (value::text)::int into v_threshold_minutes
  from schedule_settings where key = 'missed_threshold_minutes';

  if v_threshold_minutes is null then
    v_threshold_minutes := 720;
  end if;

  for v_row in
    update schedules
    set status = 'missed'
    where status = 'claimed'
      and start_time < now() - (v_threshold_minutes || ' minutes')::interval
    returning *
  loop
    if v_row.assigned_user_id is not null then
      insert into notifications (user_id, type, payload)
      values (
        v_row.assigned_user_id,
        'schedule_missed',
        jsonb_build_object(
          'schedule_id', v_row.id,
          'date', v_row.date,
          'start_time', v_row.start_time
        )
      );
    end if;

    insert into audit_logs (actor_id, action, target_type, target_id, metadata)
    values (
      null,  -- system-triggered, no actor
      'schedule_missed_detected',
      'schedule',
      v_row.id::text,
      jsonb_build_object(
        'assigned_user_id', v_row.assigned_user_id,
        'threshold_minutes', v_threshold_minutes
      )
    );

    return next v_row;
  end loop;

  return;
end;
$$;

-- Lock EXECUTE down to service_role only. Postgres grants EXECUTE on new
-- functions to PUBLIC by default, which would otherwise let any
-- authenticated (or even anon) caller invoke this SECURITY DEFINER function
-- directly via PostgREST's rpc() and mark other users' schedules missed —
-- there is no in-function role check to stop that (see comment above), so
-- the grant/revoke here IS the access control.
revoke execute on function detect_missed_schedules() from public;
revoke execute on function detect_missed_schedules() from anon;
revoke execute on function detect_missed_schedules() from authenticated;
grant execute on function detect_missed_schedules() to service_role;
