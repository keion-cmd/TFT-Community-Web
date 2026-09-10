# Messaging System Architecture Audit

Read-only inspection performed 2026-09-10. No files were modified as part of this pass.

## 1. Frontend

- **Framework**: Next.js 15.5.25, App Router (`src/app`, route groups like `(app)`), Turbopack for dev/build.
- **React**: 19.1.0 / react-dom 19.1.0.
- **Language**: TypeScript 5, strict-ish setup via `tsconfig.json`.
- **Styling**: Tailwind CSS v4 (`@tailwindcss/postcss`), CSS custom properties for design tokens defined in [globals.css](src/app/globals.css) and mapped into Tailwind's `@theme inline` block (`--color-background`, `--color-accent`, `--color-success/warning/danger/info` + `-muted` variants). Dark, navy/indigo themed palette, explicitly *not* Telegram blue ("TFT's own identity").
- **Component system**: small hand-rolled primitives in [src/components/ui/](src/components/ui/) — `Button`, `Input`, `Textarea`, `Card`, `Badge`, `Avatar`. Variant props via string-keyed class maps (no CVA/shadcn), `forwardRef` used for form controls.
- **No component library** (no shadcn/radix/mui) — everything is bespoke Tailwind.

## 2. Backend / API layer

- **No separate API layer** (no REST route handlers for app data, no tRPC, no GraphQL). Data access happens via:
  1. **Next.js Server Actions** (`"use server"` files under [src/app/actions/](src/app/actions/) — messaging, groups, roles, scheduling, broadcast, notifications, polls, topics, quick replies, checklists, etc.), calling the Supabase JS client directly or invoking Postgres RPCs.
  2. **Supabase Postgres RPCs** (`security definer` functions) for anything requiring atomicity or auth re-validation server-side (e.g. `claim_schedule`, `send_broadcast`, `create_poll`, `vote_poll`, `join_group`, `moderate_delete_message`).
  3. One plain **Route Handler**: [src/app/api/cron/detect-missed-schedules/route.ts](src/app/api/cron/detect-missed-schedules/route.ts), gated by a bearer `CRON_SECRET`, triggered by Vercel Cron (`vercel.json` — currently empty stub, so cron config isn't actually wired there yet; worth confirming before relying on it).
- Every action re-derives identity server-side via `supabase.auth.getUser()` (not a decoded/cached JWT) — see [src/lib/auth/session.ts](src/lib/auth/session.ts)'s `getCurrentProfile`/`requireAdmin`/`requireActiveUser`.

## 3. Database & ORM

- **Database**: Supabase-hosted Postgres. No traditional ORM (no Prisma/Drizzle) — schema is hand-authored SQL migrations in [supabase/migrations/](supabase/migrations/) (0001 → 0011), applied via the Supabase CLI (`supabase/.temp/*` shows a linked project).
- Data access from app code goes through `@supabase/supabase-js` query builder (`.from(...).select(...)`) plus `.rpc(...)` calls — thin, no schema codegen detected (no `database.types.ts` present).
- **RLS is the authorization backbone**: virtually every table has row-level security enabled with per-table policies; sensitive/atomic writes are funneled through `security definer` RPC functions rather than raw client `insert`/`update`, with `is_admin()`/`current_role_rank()` SQL helper functions as the shared gate.

### Existing messaging-relevant schema (already substantial)

From [0001_init.sql](supabase/migrations/0001_init.sql), [0009](supabase/migrations/0009_chat_enhancements.sql), [0010](supabase/migrations/0010_telegram_features.sql), [0011](supabase/migrations/0011_quick_replies_checklists.sql):

- `groups`, `group_members` (role_in_group: member/moderator/coordinator, `muted_until`, `slow_mode_seconds`)
- `messages` — unified table for **both** group messages and DMs via a check constraint (`group_id` XOR `dm_user_a`+`dm_user_b`), plus `reply_to_id`, `forwarded_from_message_id`, `topic_id`, `message_type` ('text'|'poll'), soft `deleted_at`/`edited_at`, generated `content_search tsvector` column with GIN index
- `message_attachments` (storage_path, mime_type, size_bytes) — **schema only, see gap below**
- `message_reactions`, `message_reads`
- `pinned_chats` (per-user chat-list pinning, distinct from group-wide pinned announcements)
- `topics` (sub-threads within a group)
- `polls` / `poll_options` / `poll_votes` (+ `create_poll`/`vote_poll`/`get_poll_results` RPCs, single-vs-multiple choice enforced via a partial unique index, not just app logic)
- `quick_replies` (personal canned responses), checklist tables from 0011 (collaborative checklists, tied to `message_type` constraint from 0010)
- "Saved messages" = self-DM (`dm_user_a = dm_user_b = auth.uid()`), explicitly supported by existing RLS with no schema change needed
- `search_messages()` RPC — Postgres full-text search, re-implements the messages RLS visibility boundary inside a `security definer` function
- Slow mode via `groups.slow_mode_seconds` + `update_group_slow_mode()` RPC

This is **not a blank slate** — a Telegram-inspired feature set (topics, polls, saved messages, forwarding, pinning, slow mode, quick replies, moderation RPCs) is already implemented at the DB layer with matching Server Actions in [src/app/actions/messaging.ts](src/app/actions/messaging.ts) (1403 lines), [topics.ts](src/app/actions/topics.ts), [polls.ts](src/app/actions/polls.ts), [quickReplies.ts](src/app/actions/quickReplies.ts), [checklists.ts](src/app/actions/checklists.ts).

## 4. Authentication & session system

- **Supabase Auth** end-to-end (`@supabase/ssr` browser + server clients — [client.ts](src/lib/supabase/client.ts), [server.ts](src/lib/supabase/server.ts)).
- [src/middleware.ts](src/middleware.ts) re-validates the session on every request via `supabase.auth.getUser()` (explicitly not `getSession()`, to always hit the Auth server rather than trust a local JWT), then checks `profiles.status === 'active'` before allowing access; redirects unauthenticated/pending users appropriately. Public paths are an explicit allowlist.
- App-layer role/permission model: `profiles.role_id → roles(rank)` (Member=10 → Super Admin=50), `current_role_rank()`/`is_admin()` SQL helpers reused across RLS policies and RPCs.
- A parallel **`sessions` table** exists as a read-model (device_info, ip_address, last_seen_at, revoked_at) for admin-visible active-sessions tracking / forced revocation — not the source of auth truth (Supabase Auth owns that), just a read/audit layer.
- Auth pages: login, register, forgot/reset password, email confirm route, pending-approval holding page — all present under `src/app/`.

## 5. User / profile model

- `profiles` — 1:1 with `auth.users` (`id` is the FK), `username` (unique), `display_name`, `bio`, `avatar_url`, `role_id`, `status` (`pending_approval|active|suspended|disabled|removed|rejected`), `last_active_at`.
- Supporting tables: `role_history`, `positions`/`user_positions`/`position_history` (an org-position system layered on top of roles, with exclusivity enforced by trigger, not just app logic).
- Profile editing UI exists: [src/app/(app)/profile/](src/app/(app)/profile/) with admin sub-pages (role changes, member actions, position management, staff exit flow, broadcast).

## 6. Routing conventions

- Next.js App Router, file-based, using a route group `(app)` to wrap all authenticated-app pages behind a shared [layout.tsx](src/app/(app)/layout.tsx) (nav chrome) without adding a URL segment.
- Dynamic segments used conventionally: `dm/[userId]`, `groups/[groupId]`, `groups/[groupId]/overview`, `profile/admin/positions/[positionId]`, `profile/admin/staff-exit/[userId]`.
- Existing messaging-relevant routes: `(app)/chats` (list), `(app)/dm/[userId]` (1:1 thread), `(app)/groups`, `(app)/groups/[groupId]` (group thread + members panel), `(app)/groups/[groupId]/overview` (group info tabs: coordinator, location, pinned info, resources).
- Server Actions live outside the route tree in `src/app/actions/*.ts`, imported directly by page/client components — no dedicated `/api/*` REST surface for app data (only the one cron route handler).

## 7. UI component system / design tokens / CSS approach

- Tailwind v4, token-driven via CSS custom properties (see §1). No Storybook, no design-token JSON/package — tokens live directly in `globals.css`.
- Chat-specific components already exist: [ChatShell.tsx](src/components/chat/ChatShell.tsx), [ChatsList.tsx](src/components/chat/ChatsList.tsx), [ChatListRow.tsx](src/components/chat/ChatListRow.tsx), [ChatSearch.tsx](src/components/chat/ChatSearch.tsx), and messaging-specific: [MessageThread.tsx](src/components/messaging/MessageThread.tsx) (298 lines — the core thread view + realtime wiring), [MessageItem.tsx](src/components/messaging/MessageItem.tsx), [ForwardMessagePicker.tsx](src/components/messaging/ForwardMessagePicker.tsx).
- Bottom nav for mobile-style app shell: [BottomNav.tsx](src/components/nav/BottomNav.tsx).
- Message formatting logic centralized in [src/lib/messaging/formatMessage.ts](src/lib/messaging/formatMessage.ts) (no schema change needed for text formatting, per 0010's migration comment).

## 8. File / media storage

- **Gap.** `message_attachments` has `storage_path`/`mime_type`/`size_bytes` columns and RLS policies, and Server Actions (`sendMessage`, `forwardMessage` in [messaging.ts](src/app/actions/messaging.ts)) already read/write attachment *metadata* rows — but there is no Supabase Storage bucket, bucket policy, or upload code anywhere in the repo (no `supabase.storage.from(...)` call, no upload widget component, no bucket defined in migrations). `storagePath` is currently populated only by `forwardMessage` copying an existing message's attachment rows — nothing produces the first one. **This is new work**, not a wire-up.

## 9. Realtime infrastructure

- **Supabase Realtime** (`postgres_changes` on the `messages` and `message_reactions` tables), wired up client-side in [MessageThread.tsx](src/components/messaging/MessageThread.tsx#L100-L134), [ChatShell.tsx](src/components/chat/ChatShell.tsx), [ChatsList.tsx](src/components/chat/ChatsList.tsx), and [NotificationBell.tsx](src/app/(app)/notifications/NotificationBell.tsx).
- Pattern: one channel per open thread, named `group:{groupId}` or `dm:{lo}:{hi}` (canonical low/high uuid pair). Since Realtime's `postgres_changes` filter only supports a single column match, the DM case filters server-side on `dm_user_a` and double-checks `dm_user_b` client-side.
- On any matching change event, the client **refetches** the thread rather than patching state from the realtime payload — deliberate simplicity tradeoff (documented inline: a raw row lacks the joined sender/reaction/attachment data the list query produces).
- No WebSocket/SSE server of our own — entirely riding on Supabase's managed Realtime (which is Postgres logical replication → websocket under the hood).

## 10. Test framework

- **None found.** No Jest/Vitest/Playwright config, no `*.test.*`/`*.spec.*` files anywhere in the repo. `npm run lint` (ESLint, flat config extending `next/core-web-vitals` + `next/typescript`) is the only automated check currently wired into `package.json`.

## 11. Environment & deployment

- **Vercel**-targeted: `.vercel/project.json` present (linked project), `vercel.json` exists but is currently an empty `{}` — no cron schedule, headers, or redirects actually configured there despite the cron route handler existing (worth confirming Vercel Cron is configured directly in the dashboard, or this route is currently unreachable on a schedule).
- Env vars ([.env.example](.env.example)): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (client-safe, RLS-enforced), `SUPABASE_SERVICE_ROLE_KEY` (server-only, bypasses RLS — used sparingly per code comments, e.g. admin-only paths), `CRON_SECRET` (bearer-auth for the one cron route).
- Supabase project is CLI-linked (`supabase/.temp/project-ref`, `pooler-url`, etc.), migrations are the deployment artifact for schema changes (`supabase db push` presumably, not checked directly).

## 12. Reuse vs. build-new for a Telegram-inspired messaging system

### Reuse as-is
- Core schema: `messages` (unified group/DM model), `message_reactions`, `message_reads`, `pinned_chats`, `topics`, `polls`, `quick_replies`, checklists, slow mode, full-text search RPC.
- Auth/session/profile/role system — no changes needed to support messaging features.
- RLS + security-definer RPC pattern — the established convention for any new write path; follow it rather than inventing a new access-control mechanism.
- Realtime wiring pattern (`postgres_changes` + refetch) for any new realtime surface (typing indicators, read receipts, presence) — same channel-per-thread convention should extend cleanly.
- UI primitives (`Button`, `Input`, `Card`, `Avatar`, etc.) and the existing chat/messaging component set — extend rather than replace.
- Server Actions architecture — no need to introduce tRPC/REST/GraphQL for new messaging features; stay consistent with the rest of the app.

### Needs to be built new
- **Media/file storage**: a Supabase Storage bucket (with its own access policies, likely mirroring the `message_attachments` RLS shape), an upload code path (client upload → confirm → insert `message_attachments` row), and UI for attaching/previewing files in `MessageThread`/message composer. This is the single biggest gap for a Telegram-like experience (currently text + polls only, no images/files/voice notes).
- **Presence / typing indicators / online status** — no `presence` channel usage found anywhere; would be new Realtime Presence wiring plus possibly a `last_active_at`-driven "online" indicator (column exists on `profiles` but isn't wired to realtime presence).
- **Any conversation/group creation UX gaps** — `CreateGroupForm.tsx`/`JoinGroupButton.tsx` exist, so group creation itself is covered; confirm whether "new DM" / "start conversation with a user" flow exists before assuming it needs to be built (not fully audited here — check `(app)/dm/[userId]/page.tsx` for how a DM thread is first created).
- **Automated tests** — there is no test harness at all; any new messaging work (especially attachment upload and realtime state) will need test infrastructure introduced from scratch (framework choice itself is an open decision).
- **Push/browser notifications** — only in-app `notifications` table + `NotificationBell` exist; no service worker / Web Push / native push integration found. Needed if "Telegram-inspired" implies out-of-app notification delivery.
