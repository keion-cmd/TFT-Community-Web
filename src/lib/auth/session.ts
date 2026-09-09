import { createClient } from "@/lib/supabase/server";
import { fetchProfileWithRole, ADMIN_MIN_RANK, type ProfileWithRole } from "@/lib/auth/profile";

// Re-derives the caller's identity + role from the database on every call,
// per Phase 6-B: never trust client-cached role state for gating a read or
// a write. Used by Server Actions, Server Components, and route handlers
// (never by Client Components — `@/lib/supabase/server` depends on
// `next/headers`, which only works in those contexts).
export async function getCurrentProfile(): Promise<ProfileWithRole | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return fetchProfileWithRole(supabase, user.id);
}

export class AuthorizationError extends Error {
  code: "NOT_AUTHENTICATED" | "ACCOUNT_NOT_ACTIVE" | "INSUFFICIENT_RANK";

  constructor(code: AuthorizationError["code"]) {
    super(code);
    this.code = code;
  }
}

// Throws rather than returning null/false so every call site is forced to
// handle the failure explicitly (Server Actions catch this and translate it
// into the `{ code, message }` error shape from Phase 4-J).
export async function requireAdmin(): Promise<ProfileWithRole> {
  const profile = await getCurrentProfile();

  if (!profile) throw new AuthorizationError("NOT_AUTHENTICATED");
  if (profile.status !== "active") throw new AuthorizationError("ACCOUNT_NOT_ACTIVE");
  if (profile.roleRank < ADMIN_MIN_RANK) throw new AuthorizationError("INSUFFICIENT_RANK");

  return profile;
}
