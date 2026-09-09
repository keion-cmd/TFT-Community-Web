"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthorizationError } from "@/lib/auth/session";
import { SUPER_ADMIN_MIN_RANK, MIN_SUPER_ADMIN_COUNT } from "@/lib/auth/profile";
import {
  approveMemberSchema,
  rejectMemberSchema,
  suspendMemberSchema,
  reinstateMemberSchema,
} from "@/lib/validation/members";
import { actionError, type ActionState } from "./types";

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionState> = {
  NOT_AUTHENTICATED: actionError("NOT_AUTHENTICATED", "You must be signed in."),
  ACCOUNT_NOT_ACTIVE: actionError(
    "ACCOUNT_NOT_ACTIVE",
    "Your account is not active.",
  ),
  INSUFFICIENT_RANK: actionError(
    "INSUFFICIENT_RANK",
    "You do not have permission to do this.",
  ),
};

function fromAuthzError(err: unknown): ActionState {
  if (err instanceof AuthorizationError) return AUTHZ_MESSAGES[err.code];
  return actionError("UNKNOWN_ERROR", "Something went wrong. Please try again.");
}

// Ban durations are strings ("<n><unit>", e.g. "876000h"); GoTrue bans
// prevent new sign-ins/token refreshes for the duration but — per Supabase's
// own documented limitation — cannot invalidate an access token already in
// a client's hands before it naturally expires. Combined with every
// Server Action / middleware pass re-checking `profiles.status` from the
// DB on each request (Phase 6-B), a suspended user is locked out of the
// app well within one request cycle even though the raw JWT is not
// cryptographically revoked. See T-CODE-04 report BLOCKED ITEMS.
const PERMANENT_BAN_DURATION = "876000h"; // ~100 years
const UNBAN_DURATION = "none";

export async function approveMember(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = approveMemberSchema.safeParse({ userId: formData.get("userId") });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { userId } = parsed.data;

  const supabaseAdmin = createAdminClient();

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, status")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return actionError("NOT_FOUND", "Member not found.");
  if (target.status !== "pending_approval") {
    return actionError("ALREADY_REVIEWED", "This application was already reviewed.");
  }

  const supabase = await createClient();
  const { error: rpcError } = await supabase.rpc("set_member_status", {
    p_user_id: userId,
    p_new_status: "active",
  });
  if (rpcError) {
    return actionError("UPDATE_FAILED", "Could not approve this member.");
  }

  const { data: pendingApproval } = await supabaseAdmin
    .from("approvals")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingApproval) {
    await supabaseAdmin
      .from("approvals")
      .update({
        status: "approved",
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", pendingApproval.id);
  }

  await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    type: "admin",
    payload: { message: "Your account has been approved. Welcome!" },
  });

  revalidatePath("/profile/admin");
  return { success: true };
}

export async function rejectMember(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = rejectMemberSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { userId, reason } = parsed.data;

  const supabaseAdmin = createAdminClient();

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, status")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return actionError("NOT_FOUND", "Member not found.");
  if (target.status !== "pending_approval") {
    return actionError("ALREADY_REVIEWED", "This application was already reviewed.");
  }

  const supabase = await createClient();
  const { error: rpcError } = await supabase.rpc("set_member_status", {
    p_user_id: userId,
    p_new_status: "rejected",
    p_reason: reason ?? null,
  });
  if (rpcError) {
    return actionError("UPDATE_FAILED", "Could not reject this member.");
  }

  const { data: pendingApproval } = await supabaseAdmin
    .from("approvals")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingApproval) {
    await supabaseAdmin
      .from("approvals")
      .update({
        status: "rejected",
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString(),
        reason: reason ?? null,
      })
      .eq("id", pendingApproval.id);
  }

  await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    type: "admin",
    payload: { message: "Your application was not approved." },
  });

  revalidatePath("/profile/admin");
  return { success: true };
}

export async function suspendMember(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = suspendMemberSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request.",
    );
  }
  const { userId, reason } = parsed.data;

  if (userId === admin.id) {
    return actionError("CANNOT_SUSPEND_SELF", "You cannot suspend your own account.");
  }

  const supabaseAdmin = createAdminClient();

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, status, role_id, roles ( rank )")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return actionError("NOT_FOUND", "Member not found.");

  const targetRole = Array.isArray(target.roles) ? target.roles[0] : target.roles;
  const targetRank = (targetRole as { rank: number } | null)?.rank ?? 0;

  // Can't suspend an equal-or-higher role unless acting as Super Admin.
  if (targetRank >= admin.roleRank && admin.roleRank < SUPER_ADMIN_MIN_RANK) {
    return actionError(
      "INSUFFICIENT_RANK",
      "You cannot suspend a member with an equal or higher role.",
    );
  }

  // Reuses Phase 1's last-Super-Admin invariant: suspending revokes access
  // exactly like a demotion would, so the same lockout risk applies.
  if (targetRank >= SUPER_ADMIN_MIN_RANK) {
    const { count } = await supabaseAdmin
      .from("profiles")
      .select("id, roles!inner(rank)", { count: "exact", head: true })
      .eq("status", "active")
      .gte("roles.rank", SUPER_ADMIN_MIN_RANK);
    if ((count ?? 0) <= MIN_SUPER_ADMIN_COUNT) {
      return actionError(
        "LAST_SUPER_ADMIN_PROTECTED",
        `TFT requires at least ${MIN_SUPER_ADMIN_COUNT} Super Admins — suspend another Super Admin first.`,
      );
    }
  }

  // set_member_status handles the profiles.status write, the audit_logs
  // row, and revoking this user's `sessions` read-model rows (new status
  // is one of suspended/disabled/removed) — see supabase/migrations/0001_init.sql.
  const supabase = await createClient();
  const { error: rpcError } = await supabase.rpc("set_member_status", {
    p_user_id: userId,
    p_new_status: "suspended",
    p_reason: reason,
  });
  if (rpcError) {
    return actionError("UPDATE_FAILED", "Could not suspend this member.");
  }

  // GoTrue ban (Phase 6-D): prevents new sign-ins / token refreshes. This
  // can only be done via the admin auth API, not SQL, so it stays on the
  // service-role client. See PERMANENT_BAN_DURATION's comment above for
  // the access-token caveat.
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    ban_duration: PERMANENT_BAN_DURATION,
  });

  revalidatePath("/profile/admin");
  return { success: true };
}

export async function reinstateMember(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = reinstateMemberSchema.safeParse({ userId: formData.get("userId") });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { userId } = parsed.data;

  const supabaseAdmin = createAdminClient();

  const { data: target } = await supabaseAdmin
    .from("profiles")
    .select("id, status")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return actionError("NOT_FOUND", "Member not found.");
  if (target.status !== "suspended" && target.status !== "disabled") {
    return actionError(
      "NOT_REINSTATABLE",
      "Only suspended or disabled members can be reinstated.",
    );
  }

  const supabase = await createClient();
  const { error: rpcError } = await supabase.rpc("set_member_status", {
    p_user_id: userId,
    p_new_status: "active",
  });
  if (rpcError) {
    return actionError("UPDATE_FAILED", "Could not reinstate this member.");
  }

  await supabaseAdmin.auth.admin.updateUserById(userId, {
    ban_duration: UNBAN_DURATION,
  });

  revalidatePath("/profile/admin");
  return { success: true };
}
