-- ============================================================
-- 0007_pg_cron_missed_detection.sql
-- T-CODE-30: move missed-schedule detection off Vercel's Hobby-plan cron
-- (which rejects sub-daily schedules) and onto Supabase pg_cron instead.
-- detect_missed_schedules() itself (0003_scheduling_missed_detection.sql)
-- is untouched — only the trigger mechanism changes.
-- ============================================================

-- All existing extensions on this project (pgcrypto, uuid-ossp,
-- pg_stat_statements) live in the `extensions` schema, so pg_cron follows
-- the same convention here.
create extension if not exists pg_cron with schema extensions;

-- No explicit GRANT needed for detect_missed_schedules(): cron.schedule()
-- below runs as whichever role executes this migration (postgres on
-- Supabase's managed instances), and postgres is already a member of
-- service_role, which already has EXECUTE on detect_missed_schedules()
-- per 0003_scheduling_missed_detection.sql. Verified live via
-- has_function_privilege('postgres', 'detect_missed_schedules()', 'execute')
-- before writing this migration.
select cron.schedule(
  'detect-missed-schedules',
  '*/15 * * * *',
  $$ select detect_missed_schedules(); $$
);
