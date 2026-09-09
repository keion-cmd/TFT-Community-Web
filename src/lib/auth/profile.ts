import type { SupabaseClient } from "@supabase/supabase-js";

// Mirrors the `profiles.status` check constraint in
// supabase/migrations/0001_init.sql.
export type AccountStatus =
  | "pending_approval"
  | "active"
  | "suspended"
  | "disabled"
  | "removed"
  | "rejected";

export type ProfileWithRole = {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  roleId: number;
  roleName: string;
  roleRank: number;
};

// Role ranks, per the seed data in supabase/migrations/0001_init.sql
// (Member 10 / Editor 20 / Assistant Admin 30 / Admin 40 / Super Admin 50).
export const ADMIN_MIN_RANK = 40;
export const SUPER_ADMIN_MIN_RANK = 50;
// Phase 1 "CONFIRMED — Recovery approach": two standing Super Admins at all
// times; demotion/removal is blocked if it would drop the count below this.
export const MIN_SUPER_ADMIN_COUNT = 2;

// Two round trips instead of a single embedded select — `profiles.role_id`
// embeds reliably via PostgREST, but this repo has no generated DB types
// yet, so keeping the shape simple and explicit is worth more than saving
// a query on a low-traffic (per-request, not per-render) lookup.
export async function fetchProfileWithRole(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProfileWithRole | null> {
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, username, display_name, bio, avatar_url, status, role_id")
    .eq("id", userId)
    .maybeSingle();

  if (profileError || !profile) return null;

  const { data: role, error: roleError } = await supabase
    .from("roles")
    .select("name, rank")
    .eq("id", profile.role_id)
    .maybeSingle();

  if (roleError || !role) return null;

  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name,
    bio: profile.bio,
    avatarUrl: profile.avatar_url,
    status: profile.status as AccountStatus,
    roleId: profile.role_id,
    roleName: role.name,
    roleRank: role.rank,
  };
}
