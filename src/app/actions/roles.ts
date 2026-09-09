"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthorizationError } from "@/lib/auth/session";
import { changeRoleSchema, listRoleHistorySchema } from "@/lib/validation/roles";
import type { ActionError } from "./types";

function fromAuthzError(err: unknown): ActionError {
  if (err instanceof AuthorizationError) {
    const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionError> = {
      NOT_AUTHENTICATED: { code: "NOT_AUTHENTICATED", message: "You must be signed in." },
      ACCOUNT_NOT_ACTIVE: { code: "ACCOUNT_NOT_ACTIVE", message: "Your account is not active." },
      INSUFFICIENT_RANK: { code: "INSUFFICIENT_RANK", message: "You do not have permission to do this." },
    };
    return AUTHZ_MESSAGES[err.code];
  }
  return { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." };
}

// ============================================================
// changeRole — calls the change_role RPC (supabase/migrations/
// 0004_role_management.sql). requireAdmin() is checked here too, as
// defense in depth (same convention as every other RPC-backed action in
// this codebase, e.g. set_member_status's callers in members.ts) — the RPC
// re-derives the caller's rank itself and does not trust this app-layer
// check alone.
// ============================================================
export async function changeRole(
  userId: string,
  newRoleId: number,
  reason: string,
): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = changeRoleSchema.safeParse({ userId, newRoleId, reason });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("change_role", {
    p_user_id: parsed.data.userId,
    p_new_role_id: parsed.data.newRoleId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("last_super_admin_protected")) {
      return {
        error: {
          code: "LAST_SUPER_ADMIN_PROTECTED",
          message: "TFT requires at least 2 Super Admins.",
        },
      };
    }
    if (msg.includes("not_authorized")) {
      return {
        error: {
          code: "NOT_AUTHORIZED",
          message: "You do not have permission to make this role change.",
        },
      };
    }
    if (msg.includes("not_found")) {
      return { error: { code: "NOT_FOUND", message: "Member not found." } };
    }
    if (msg.includes("invalid_role")) {
      return { error: { code: "INVALID_ROLE", message: "That role does not exist." } };
    }
    return { error: { code: "CHANGE_ROLE_FAILED", message: "Could not change this member's role." } };
  }

  revalidatePath("/profile/admin");
  return { success: true };
}

// ============================================================
// listRoleHistory — Role >= Admin. role_history has no client insert
// policy (0001_init.sql: "writes happen only through admin Server Actions
// using service role / RPC") and an admin-only select policy, so the
// admin client is used here purely for the actor/role display-name joins,
// same pattern as listEligibleReplacements in positions.ts.
// ============================================================
export type RoleHistoryEntry = {
  id: number;
  previousRoleName: string | null;
  newRoleName: string;
  actorDisplayName: string;
  reason: string | null;
  createdAt: string;
};

export async function listRoleHistory(
  userId: string,
): Promise<{ entries: RoleHistoryEntry[] } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = listRoleHistorySchema.safeParse({ userId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const { data: rows, error } = await supabaseAdmin
    .from("role_history")
    .select(
      "id, previous_role_id, new_role_id, actor_id, reason, created_at, previous_role:roles!role_history_previous_role_id_fkey ( name ), new_role:roles!role_history_new_role_id_fkey ( name )",
    )
    .eq("user_id", parsed.data.userId)
    .order("created_at", { ascending: false });
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load role history." } };

  const actorIds = Array.from(new Set((rows ?? []).map((r) => r.actor_id)));
  const { data: actors } = actorIds.length
    ? await supabaseAdmin.from("profiles").select("id, display_name").in("id", actorIds)
    : { data: [] as { id: string; display_name: string }[] };
  const actorById = new Map((actors ?? []).map((a) => [a.id, a.display_name]));

  const entries: RoleHistoryEntry[] = (rows ?? []).map((row) => {
    const previousRole = Array.isArray(row.previous_role) ? row.previous_role[0] : row.previous_role;
    const newRole = Array.isArray(row.new_role) ? row.new_role[0] : row.new_role;
    return {
      id: row.id,
      previousRoleName: (previousRole as { name: string } | null)?.name ?? null,
      newRoleName: (newRole as { name: string } | null)?.name ?? "Unknown role",
      actorDisplayName: actorById.get(row.actor_id) ?? "Unknown",
      reason: row.reason,
      createdAt: row.created_at,
    };
  });

  return { entries };
}
