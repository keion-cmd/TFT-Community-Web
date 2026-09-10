create or replace function is_member_of_group(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;

drop policy "group members readable by fellow members or admin" on group_members;

create policy "group members readable by fellow members or admin"
  on group_members for select
  using (
    is_admin()
    or user_id = auth.uid()
    or is_member_of_group(group_id)
  );
