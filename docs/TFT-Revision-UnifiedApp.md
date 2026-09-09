# TFT Community Platform — Revision: Unified App Architecture + Groups as First-Class Objects

**Supersedes:** Phase 2 navigation section (A), and adds schema deltas to Phase 3. Everything else in Phases 1, 4, 5, 6, 7 stands — this is additive/structural, not a redesign of the data model's core.

---

## A. The Core Change

**Old model:** Member Platform + separate Admin Dashboard (two shells, switch between them).
**New model:** One shell. Same navigation for everyone. Admin capabilities are additional controls that appear *within* the same screens, gated by role/position — never a separate application experience.

**New rule for the master spec (add this explicitly, per your own suggestion):**
> The TFT-APP is a single unified application. There is no separate admin dashboard experience. Administrative capabilities are integrated into the same screens and are conditionally available based on the authenticated user's role and permissions. Groups are first-class objects combining conversation, membership, schedule context, resources, and settings.

---

## B. Revised Navigation (replaces Phase 2 §A)

**One bottom nav, same 5 tabs for every user — Member, Staff, Admin, Super Admin alike:**

1. **Chats** — DMs + groups, unified list
2. **Groups** — browse/joined groups; `+ Create Group` button appears here for anyone with group-creation permission (position-gated or Role ≥ Admin) — not hidden behind a different app section
3. **Schedule** — same screen for everyone; claim/check-in controls appear if eligible, admin override controls (reassign/cancel) appear inline for Admins on the same screen, not a separate "admin schedule view"
4. **Notifications**
5. **Profile** — own profile + a **"Admin Tools"** section that only renders for Admin/Super Admin, containing: Member Approval, Staff Management, Positions Manager, Broadcast Center, Audit Logs, Community Settings, Emergency Recovery (Super Admin only)

**"Attention Required" becomes a dismissible banner**, not a separate landing page — it surfaces at the top of the **Groups** tab (or Chats, whichever the user opens to) for Admin/Super Admin only, and links directly into the relevant screen (e.g. tap "3 unclaimed schedules" → jumps into Schedule tab, filtered).

This keeps the "Member sees simplicity, Admin sees control" principle from Phase 1 — the *screens* are the same, the *controls visible on them* differ by role. No context-switch, no separate mental model, matches Telegram/Messenger's own pattern of admin tools living inside group/channel settings rather than a separate app.

---

## C. Groups as First-Class Objects (new — was previously just a chat container)

### Group Creation Flow (revised)
```
Groups tab → "+ Create Group"
→ Name, Description, Type (Private/Staff/Community/Announcement)
→ Add Members: search by @username → tap to select (chips, not free text)
→ Optional: assign a Coordinator from the selected members
→ Create → members added immediately, group appears in their Chats/Groups
```

### Group Overview (new screen — accessible from the group's header)
Every group now has a second view alongside its Chat, reachable by tapping the group name/avatar:

- **Members** (count + list, admin gets remove/mute/promote-to-moderator inline)
- **Coordinator** — one designated member with `role_in_group = 'coordinator'` (see schema delta below); shown as a named badge, assignable by Admin directly from this screen
- **Schedule** — upcoming schedule slots linked to this group (not every group needs this — a "General Chat" group simply shows nothing here; a "Night Shift Team" group shows its actual shifts)
- **Location** — free-text field, optional, relevant for operational groups
- **Pinned Info** — pinned message(s), same pin mechanism from Phase 4-E, surfaced prominently here rather than only inline in chat
- **Files / Resources** — curated links/docs the group cares about (distinct from raw chat attachments — an admin/moderator explicitly adds something here vs. it just being buried in chat history)
- **Group Settings** — name/description/type/archive, Admin-only

This is the single biggest schema addition: **groups stop being just a `messages` container and become an operational object** — which is exactly the "chat + people + schedule + information" model you described.

---

## D. Schema Delta (additions to Phase 3 — nothing removed, nothing breaking)

```sql
-- groups gains operational context fields
alter table groups add column location text;
alter table groups add column pinned_message_id bigint references messages(id);

-- group_members gains a coordinator designation
alter table group_members
  drop constraint if exists group_members_role_in_group_check;
alter table group_members
  add constraint group_members_role_in_group_check
  check (role_in_group in ('member','moderator','coordinator'));
-- (in practice: at most one 'coordinator' per group enforced by a trigger,
--  same pattern as the exclusive-position trigger in Phase 3-B)

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
```

`schedules.group_id` is nullable — a standalone schedule (not tied to any group) still works exactly as designed in Phase 3; this is purely additive for groups that want operational context attached.

## E. API Delta (additions to Phase 4)

| Action | Type | Auth | Notes |
|---|---|---|---|
| `getGroupOverview(groupId)` | Route | group member | returns members, coordinator, upcoming schedules (via `schedules.group_id`), location, pinned message, resources |
| `assignGroupCoordinator` | Server Action | Role ≥ Admin | **CONFIRMED — Position-gated.** Target must hold an active, qualifying Position (e.g. "Schedule Coordinator") before they can be tagged Coordinator for a group — same `min_role_id`/eligibility check pattern as `assignPosition` in Phase 4-D, re-used here rather than invented fresh. Sets `role_in_group = 'coordinator'`, demotes previous coordinator to 'member' (trigger-enforced single coordinator). Rejects with `NOT_ELIGIBLE` if target doesn't hold a qualifying Position. |
| `addGroupResource` | Server Action | moderator/admin | title + url or file upload → `group_resources` row |
| `removeGroupResource` | Server Action | moderator/admin | soft or hard delete, low-stakes content |
| `linkScheduleToGroup` | Server Action | Role ≥ Admin | sets `schedules.group_id` when creating/editing a slot |

Everything else in Phase 4 (claim, check-in, broadcast, staff exit, etc.) is unaffected — those actions don't care whether a schedule happens to have a `group_id` set.

## F. What Doesn't Change

- Phase 1 permission matrix — still valid. Coordinator is a **group-scoped tag**, not a new system Role — but assigning it now requires the target already hold a qualifying global Position (per confirmed decision below). This means a group's Coordinator is always someone the Positions Manager already vouches for; there's no way to tag an unqualified member Coordinator just because they're in the group.
- Phase 3's core tables, RLS pattern, and the concurrency-safe `claim_schedule` RPC — untouched.
- Phase 5 realtime — `group:{groupId}` channel now also carries `group_resources`/coordinator changes; same channel, more event types, no new infrastructure.
- Phase 6 security model — unaffected; `group_resources` and coordinator assignment follow the same RLS-by-membership + Server Action re-check pattern as everything else.
