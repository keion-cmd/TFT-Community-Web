-- ============================================================
-- 0013_presence_typing.sql
-- Fills the gap flagged in docs/messaging-audit.md §9/§12: no Realtime
-- Presence usage anywhere in the repo. Adds:
--   1. touch_last_seen() RPC — persists profiles.last_active_at for the
--      calling user only. Originally drafted as callable for *any* target
--      user (so a peer observing someone else's Presence "leave" event
--      could persist it on their behalf), but tightened to self-only after
--      review: an unrestricted cross-user write was an unnecessary risk,
--      and redundant besides, since last_active_at already updates on any
--      authenticated request (Phase 5-D).
--   2. Realtime Authorization policies on realtime.messages — Presence and
--      Broadcast are NOT covered by table RLS (unlike postgres_changes,
--      which already rides on the messages/message_reactions RLS policies
--      per §9). Without this, a per-conversation Presence channel used for
--      typing indicators would be readable by any authenticated client that
--      guesses the `group:{id}` / `dm:{lo}:{hi}` topic name, even if not a
--      participant — the same membership boundary messages already enforce
--      must be re-applied here explicitly. Channels must be created with
--      `{ config: { private: true } }` client-side for these policies to be
--      consulted at all (see MessageThread.tsx / PresenceProvider.tsx).
-- ============================================================

-- ---- 1. last_active_at write path ----

-- SECURITY DEFINER, but self-only: the caller may only stamp their own
-- last_active_at (enforced by the `id = auth.uid()` clause below, not just
-- by convention). A call for someone else's id simply updates zero rows
-- rather than raising, since the RPC target and current caller not matching
-- isn't an error condition here — the caller can't request another user's
-- row be touched, it just has no effect. Always stamps now() server-side;
-- never trusts a client-supplied timestamp, so it can't be used to backdate.
create or replace function touch_last_seen(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update profiles set last_active_at = now()
  where id = p_user_id and id = auth.uid();
$$;

grant execute on function touch_last_seen(uuid) to authenticated;

-- ---- 2. Realtime Authorization for per-conversation Presence/Broadcast ----

-- Mirrors can_access_attachment_path's shape (0012_message_attachments_storage.sql):
-- re-derive the same "is this user a participant" check the messages RLS
-- policies use, from the topic string alone, with exception-safe parsing so
-- a malformed/unexpected topic just denies rather than errors the whole
-- subscribe call.
create or replace function can_access_realtime_topic(topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  parts text[];
  v_group_id bigint;
begin
  if topic = 'presence:online-users' then
    -- Global presence — no stricter boundary than the profiles table
    -- already has (readable by any authenticated approved user).
    return auth.role() = 'authenticated';
  end if;

  parts := string_to_array(topic, ':');

  if parts[1] = 'group' and array_length(parts, 1) = 2 then
    begin
      v_group_id := parts[2]::bigint;
    exception when others then
      return false;
    end;
    return is_admin() or exists (
      select 1 from group_members
      where group_id = v_group_id and user_id = auth.uid()
    );
  elsif parts[1] = 'dm' and array_length(parts, 1) = 3 then
    return auth.uid() is not null and auth.uid()::text in (parts[2], parts[3]);
  else
    return false;
  end if;
end;
$$;

-- Private channels are authorized by a single SELECT policy on
-- realtime.messages, checked at subscribe time against realtime.topic() —
-- this governs both sending and receiving Presence/Broadcast on that topic.
create policy "conversation participants can use their presence/typing channel"
  on realtime.messages for select
  to authenticated
  using (can_access_realtime_topic(realtime.topic()));
