"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthorizationError } from "@/lib/auth/session";
import { fetchProfileWithRole } from "@/lib/auth/profile";
import {
  createPositionSchema,
  updatePositionSchema,
  deactivatePositionSchema,
  assignPositionSchema,
  revokePositionSchema,
  listEligibleReplacementsSchema,
} from "@/lib/validation/positions";
import { actionError, type ActionState, type ActionError } from "./types";

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

const NAME_TAKEN_ERROR = actionError(
  "NAME_TAKEN",
  "A position with this name already exists.",
);

const POSITION_NOT_FOUND_ERROR = actionError("NOT_FOUND", "Position not found.");

export async function createPosition(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = createPositionSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    minRoleId: formData.get("minRoleId"),
    isExclusive: formData.get("isExclusive") === "on",
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request.",
    );
  }
  const { name, description, minRoleId, isExclusive } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: existing } = await supabaseAdmin
    .from("positions")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (existing) return NAME_TAKEN_ERROR;

  const supabase = await createClient();
  const { error } = await supabase.from("positions").insert({
    name,
    description: description || null,
    min_role_id: minRoleId,
    is_exclusive: isExclusive,
    created_by: admin.id,
  });
  if (error) {
    if (error.code === "23505") return NAME_TAKEN_ERROR;
    return actionError("CREATE_FAILED", "Could not create this position.");
  }

  revalidatePath("/profile/admin/positions");
  return { success: true };
}

export async function updatePosition(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = updatePositionSchema.safeParse({
    positionId: formData.get("positionId"),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    minRoleId: formData.get("minRoleId"),
    isExclusive: formData.get("isExclusive") === "on",
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request.",
    );
  }
  const { positionId, name, description, minRoleId, isExclusive } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: existingPosition } = await supabaseAdmin
    .from("positions")
    .select("id, name")
    .eq("id", positionId)
    .maybeSingle();
  if (!existingPosition) return POSITION_NOT_FOUND_ERROR;

  if (name !== existingPosition.name) {
    const { data: nameClash } = await supabaseAdmin
      .from("positions")
      .select("id")
      .eq("name", name)
      .neq("id", positionId)
      .maybeSingle();
    if (nameClash) return NAME_TAKEN_ERROR;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("positions")
    .update({
      name,
      description: description || null,
      min_role_id: minRoleId,
      is_exclusive: isExclusive,
    })
    .eq("id", positionId);
  if (error) {
    if (error.code === "23505") return NAME_TAKEN_ERROR;
    return actionError("UPDATE_FAILED", "Could not update this position.");
  }

  revalidatePath("/profile/admin/positions");
  revalidatePath(`/profile/admin/positions/${positionId}`);
  return { success: true };
}

export async function deactivatePosition(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = deactivatePositionSchema.safeParse({
    positionId: formData.get("positionId"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request.",
    );
  }
  const { positionId } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: position } = await supabaseAdmin
    .from("positions")
    .select("id")
    .eq("id", positionId)
    .maybeSingle();
  if (!position) return POSITION_NOT_FOUND_ERROR;

  // Soft-delete only: is_active=false, row (and every holder/history row
  // that points at it) stays intact — never delete a position.
  const supabase = await createClient();
  const { error } = await supabase
    .from("positions")
    .update({ is_active: false })
    .eq("id", positionId);
  if (error) {
    return actionError("DEACTIVATE_FAILED", "Could not deactivate this position.");
  }

  revalidatePath("/profile/admin/positions");
  revalidatePath(`/profile/admin/positions/${positionId}`);
  return { success: true };
}

export async function assignPosition(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = assignPositionSchema.safeParse({
    userId: formData.get("userId"),
    positionId: formData.get("positionId"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request.",
    );
  }
  const { userId, positionId } = parsed.data;

  const supabaseAdmin = createAdminClient();

  const { data: position } = await supabaseAdmin
    .from("positions")
    .select("id, name, min_role_id, is_active, is_exclusive")
    .eq("id", positionId)
    .maybeSingle();
  if (!position) return POSITION_NOT_FOUND_ERROR;
  if (!position.is_active) {
    return actionError("POSITION_INACTIVE", "This position is not active.");
  }

  // Re-derive the target's role_rank from the DB — never trust any
  // client-supplied role state (Phase 6-B invariant, same as requireAdmin).
  const targetProfile = await fetchProfileWithRole(supabaseAdmin, userId);
  if (!targetProfile) return actionError("NOT_FOUND", "Member not found.");

  if (targetProfile.roleRank < position.min_role_id) {
    return actionError(
      "INSUFFICIENT_ROLE_FOR_POSITION",
      `${targetProfile.displayName}'s role does not meet this position's minimum role requirement.`,
    );
  }

  const { data: existingHolding } = await supabaseAdmin
    .from("user_positions")
    .select("id, revoked_at")
    .eq("user_id", userId)
    .eq("position_id", positionId)
    .maybeSingle();
  if (existingHolding && existingHolding.revoked_at === null) {
    return actionError("ALREADY_HOLDS_POSITION", "This member already holds this position.");
  }

  // trg_position_exclusivity only fires BEFORE INSERT (see
  // supabase/migrations/0001_init.sql), so the re-activate-a-revoked-row
  // path below (an UPDATE) would bypass it entirely. Check exclusivity
  // ourselves first so both paths are covered, then still catch the
  // trigger's raised exception below as a defense-in-depth backstop on
  // the INSERT path.
  if (position.is_exclusive) {
    const { data: activeHolder } = await supabaseAdmin
      .from("user_positions")
      .select("id")
      .eq("position_id", positionId)
      .is("revoked_at", null)
      .maybeSingle();
    if (activeHolder) {
      return actionError(
        "EXCLUSIVE_POSITION_TAKEN",
        "This position is exclusive and already has an active holder.",
      );
    }
  }

  const supabase = await createClient();

  if (existingHolding) {
    // unique(user_id, position_id) means a previously-revoked holder can't
    // be re-inserted — reactivate their existing row instead.
    const { error: updateError } = await supabase
      .from("user_positions")
      .update({
        assigned_by: admin.id,
        assigned_at: new Date().toISOString(),
        revoked_at: null,
        revoked_by: null,
      })
      .eq("id", existingHolding.id);
    if (updateError) {
      return actionError("ASSIGN_FAILED", "Could not assign this position.");
    }
  } else {
    const { error: insertError } = await supabase.from("user_positions").insert({
      user_id: userId,
      position_id: positionId,
      assigned_by: admin.id,
    });
    if (insertError) {
      if (insertError.message.toLowerCase().includes("exclusive")) {
        return actionError(
          "EXCLUSIVE_POSITION_TAKEN",
          "This position is exclusive and already has an active holder.",
        );
      }
      return actionError("ASSIGN_FAILED", "Could not assign this position.");
    }
  }

  // position_history has no client INSERT policy by design (admin-only
  // audit trail) — write it with the service-role client, same pattern as
  // role_history's documented write path.
  await supabaseAdmin.from("position_history").insert({
    user_id: userId,
    position_id: positionId,
    action: "assigned",
    actor_id: admin.id,
  });

  await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    type: "admin",
    payload: { message: `You have been assigned the position: ${position.name}.` },
  });

  revalidatePath("/profile/admin/positions");
  revalidatePath(`/profile/admin/positions/${positionId}`);
  return { success: true };
}

export async function revokePosition(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = revokePositionSchema.safeParse({
    userPositionId: formData.get("userPositionId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid request.",
    );
  }
  const { userPositionId, reason } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: holding } = await supabaseAdmin
    .from("user_positions")
    .select("id, user_id, position_id, revoked_at, positions ( name )")
    .eq("id", userPositionId)
    .maybeSingle();
  if (!holding) return actionError("NOT_FOUND", "This position assignment was not found.");
  if (holding.revoked_at) {
    return actionError("ALREADY_REVOKED", "This position has already been revoked.");
  }

  const supabase = await createClient();
  const { error: updateError } = await supabase
    .from("user_positions")
    .update({ revoked_at: new Date().toISOString(), revoked_by: admin.id })
    .eq("id", userPositionId);
  if (updateError) {
    return actionError("REVOKE_FAILED", "Could not revoke this position.");
  }

  await supabaseAdmin.from("position_history").insert({
    user_id: holding.user_id,
    position_id: holding.position_id,
    action: "revoked",
    actor_id: admin.id,
    notes: reason,
  });

  const holdingPosition = Array.isArray(holding.positions) ? holding.positions[0] : holding.positions;
  const positionName = (holdingPosition as { name: string } | null)?.name ?? "a position";
  await supabaseAdmin.from("notifications").insert({
    user_id: holding.user_id,
    type: "admin",
    payload: {
      message: reason
        ? `Your position "${positionName}" has been revoked. Reason: ${reason}`
        : `Your position "${positionName}" has been revoked.`,
    },
  });

  revalidatePath("/profile/admin/positions");
  revalidatePath(`/profile/admin/positions/${holding.position_id}`);
  return { success: true };
}

export type EligibleUser = {
  id: string;
  username: string;
  displayName: string;
  roleName: string;
};

// Not a form-bound action — called directly from the position detail
// Server Component to build the assign-holder <select> options.
export async function listEligibleReplacements(
  positionId: number,
): Promise<{ users: EligibleUser[] } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = listEligibleReplacementsSchema.safeParse({ positionId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: position } = await supabaseAdmin
    .from("positions")
    .select("id, min_role_id")
    .eq("id", parsed.data.positionId)
    .maybeSingle();
  if (!position) {
    return { error: { code: "NOT_FOUND", message: "Position not found." } };
  }

  const { data: activeHolders } = await supabaseAdmin
    .from("user_positions")
    .select("user_id")
    .eq("position_id", position.id)
    .is("revoked_at", null);
  const excludedIds = new Set((activeHolders ?? []).map((h) => h.user_id));

  const { data: candidates } = await supabaseAdmin
    .from("profiles")
    .select("id, username, display_name, roles!inner ( name, rank )")
    .eq("status", "active")
    .gte("roles.rank", position.min_role_id)
    .order("display_name", { ascending: true });

  const users: EligibleUser[] = (candidates ?? [])
    .filter((candidate) => !excludedIds.has(candidate.id))
    .map((candidate) => {
      const role = Array.isArray(candidate.roles) ? candidate.roles[0] : candidate.roles;
      return {
        id: candidate.id,
        username: candidate.username,
        displayName: candidate.display_name,
        roleName: (role as { name: string } | null)?.name ?? "Member",
      };
    });

  return { users };
}
