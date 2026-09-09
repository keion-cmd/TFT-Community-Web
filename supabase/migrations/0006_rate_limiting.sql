-- ============================================================
-- 0006_rate_limiting.sql
-- T-CODE-20: Phase 6-F rate limiting. Postgres-backed fixed-window counter
-- (see report for why this beats in-memory on a multi-instance serverless
-- deployment). One row per (action, key) bucket; check_rate_limit() does
-- the read-check-increment atomically in a single upsert so concurrent
-- requests from the same caller can't race past the limit.
-- ============================================================

create table if not exists rate_limit_buckets (
  bucket_key text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);

-- No RLS policy is added: this table is never queried directly by client
-- code, only through check_rate_limit() below, and access to it goes
-- exclusively through the service-role client (src/lib/supabase/admin.ts)
-- from Server Actions. Anon/authenticated roles have no grants on it.
revoke all on rate_limit_buckets from anon, authenticated;

create or replace function check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  insert into rate_limit_buckets (bucket_key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (bucket_key) do update
    set count = case
        when rate_limit_buckets.window_start <= v_now - make_interval(secs => p_window_seconds)
          then 1
        else rate_limit_buckets.count + 1
      end,
      window_start = case
        when rate_limit_buckets.window_start <= v_now - make_interval(secs => p_window_seconds)
          then v_now
        else rate_limit_buckets.window_start
      end
  returning rate_limit_buckets.window_start, rate_limit_buckets.count
  into v_window_start, v_count;

  if v_count > p_limit then
    return query select
      false,
      greatest(0, p_window_seconds - extract(epoch from (v_now - v_window_start))::integer);
  else
    return query select true, 0;
  end if;
end;
$$;
