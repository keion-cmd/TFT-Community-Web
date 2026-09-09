# TFT Community Platform — Phase 6: Security Architecture

**Builds on:** Phases 1–5. This is the last "how it works" phase before test planning and deployment.

---

## A. Authentication

- Supabase Auth, email/username + password. Password hashing/storage handled by Supabase (bcrypt-based) — never touched or logged by app code.
- Session tokens are Supabase JWTs, short-lived access token + refresh token, stored in httpOnly secure cookies (not localStorage) via `@supabase/ssr` so tokens aren't reachable by client-side JS/XSS.
- Login blocked entirely for `status != 'active'` accounts — `pending_approval`/`suspended`/`disabled`/`removed`/`rejected` all get a specific human-readable message, not a generic "invalid credentials" (except actually-wrong passwords, which stay generic to avoid leaking which accounts exist).
- Password reset via Supabase's built-in flow (emailed time-limited token).

## B. Authorization (RBAC enforcement, restated as security controls)

- Every mutating Server Action re-derives the caller's role/positions from the database on every call — **never trusts a role passed in the request**, never trusts client-cached role state for gating a write.
- `current_role_rank()` and eligibility checks (Phase 3) run inside Postgres functions where possible, so even a compromised or bypassed Server Action can't write data the RLS policy wouldn't allow.
- Two independent layers: **RLS at the DB** + **explicit checks in Server Actions**. Neither layer alone is trusted — this is deliberate redundancy, not laziness, per spec §7/§128 ("never rely only on frontend hiding").

## C. Sensitive-Action Confirmation (spec §69, §107)

Actions requiring an explicit typed/confirmed dialog, not just a click:

| Action | Confirmation requirement |
|---|---|
| Promote to / remove Super Admin | Re-type target username + password re-entry |
| Remove Admin access | Standard confirm dialog listing consequences (sessions revoked, responsibilities need reassignment) |
| Delete group | Type group name to confirm |
| Bulk member removal | Type "REMOVE" + count confirmation |
| Suspend/remove staff mid-shift | Warns if user has an active/checked-in schedule right now |
| Mass broadcast (>N groups, configurable) | Extra preview step highlighting recipient count |
| Security settings changes | Password re-entry |

This mirrors the STRICT-confirmation pattern we standardized for verification commands — same philosophy, applied to the product itself: **destructive/sensitive = visible consequences + explicit confirm, never a single accidental click.**

## D. Session Management

- Admin can view a user's active sessions (device/browser, last seen, created) and force-revoke individually or all-at-once.
- `suspendMember`/`removeMember`/role-downgrade actions call Supabase's ban/revocation API to block new logins and refreshes, and mark the local `sessions` read-model rows revoked. **Correction from the original draft of this doc:** Supabase Auth has no API to kill an already-issued, unexpired access token instantly — a token minted before suspension technically remains cryptographically valid until it expires. Real lockout is enforced by every Server Action and the middleware re-checking `profiles.status` from the database on each request, which *does* take effect immediately in practice (the next request the suspended user makes gets rejected), satisfying spec §40's intent even though the mechanism is re-verification rather than token invalidation. Worth knowing if a future requirement ever needs a literal instant kill — that would require shortening access-token TTL considerably or a token-blocklist layer, neither of which is built.
- Sessions table (Phase 3, deferred detail) stores device metadata for the "view active sessions" UI; actual token validity is still Supabase's source of truth — this table is a read model, not the auth mechanism.

## E. File / Upload Security

- Every upload (avatars, message attachments) is validated **server-side** by inspecting actual file bytes/magic number, never trusting the client-declared MIME type (spec §67/§128).
- Size limits enforced server-side before accepting the upload (avatars ≤5MB, message attachments ≤25MB — placeholder numbers, tune later).
- Files go to Supabase Storage buckets with **signed URLs**, not public buckets — even attachment access is authorization-checked (can't guess a URL into a staff-only group's files).
- No executable file types accepted in any upload path.
- Thumbnail generation deferred to V2; V1 serves the original with reasonable size caps.

## F. Rate Limiting

Enforced via middleware (Vercel Edge Middleware, keyed on IP + user ID where authenticated):

| Endpoint | Limit (starting point, tune later) |
|---|---|
| `signIn` | 5 attempts / 15 min per IP+username, then cooldown |
| `signUp` | 3 / hour per IP |
| `requestPasswordReset` | 3 / hour per email |
| `sendMessage` | 30 / min per user |
| `sendBroadcast` | 10 / hour per user |
| general API | 100 req / min per user, generous ceiling mainly to catch runaway clients, not normal use |

## G. Input Validation & Output Handling

- Every Server Action validates input against a schema (zod) before touching the DB — reject malformed/oversized input early.
- All user-generated content rendered through React's default escaping (no `dangerouslySetInnerHTML` for message content) — XSS prevention by default, not by discipline.
- SQL injection is structurally avoided — all DB access through Supabase client/RPCs with parameterized queries, no raw string-built SQL anywhere in app code.

## H. Secrets Management

- Supabase service-role key: **server-only**, never shipped to the client bundle, stored as a Vercel environment variable (encrypted at rest by Vercel), used only inside Server Actions/route handlers that genuinely need to bypass RLS (e.g. the missed-schedule cron).
- Anonymous/public Supabase key is the only key ever exposed to the browser — RLS is what makes that safe.
- `.env.local` git-ignored from commit one; `.env.example` checked in with placeholder keys so the repo is self-documenting without leaking anything.
- No secrets in audit logs, error messages, or client-visible responses.

## I. Data Privacy

- Members never see: Admin/Staff-only groups, other users' emails, private audit notes, other users' session lists — enforced at the RLS layer, not just hidden in the UI (so a modified frontend request still gets nothing).
- Least-privilege applies to Admins too: Admin sees audit logs in their operational scope; only Super Admin sees the full unrestricted log and Emergency Recovery controls.

## J. What's Deliberately Deferred (not weaker security, just V2+ scope)

- Two-factor authentication — Supabase supports it; add when the community's size/risk profile justifies the friction.
- Admin impersonation — not built in V1 at all per spec §113's own caution.
- IP allowlisting / device fingerprinting — unnecessary complexity for current scale.

---

## Next: Phase 7 — Testing Strategy + Deployment Plan

Critical test cases, edge case matrix, phased implementation roadmap, and the actual Vercel + Supabase deployment steps (including where Claude Code takes over from this chat).
