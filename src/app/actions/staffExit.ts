"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthorizationError } from "@/lib/auth/session";
import {
  getStaffExitChecklistSchema,
  resolveExitItemSchema,
  finalizeStaffExitSchema,
} from "@/lib/validation/staffExit";
import { initialActionState, type ActionState, type ActionError } from "./types";
import { revokePosition, assignPosition } from "./positions";
import { releaseSchedule, reassignSchedule } from "./scheduling";
import { removeGroupCoordinator, assignGroupCoordinator, listEligibleCoordinators } from "./groupOverview";
import { suspendMember } from "./members";

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionError> = {
  NOT_AUTHENTICATED: { code: "NOT_AUTHENTICATED", message: "You must be signed in." },
  ACCOUNT_NOT_ACTIVE: { code: "ACCOUNT_NOT_ACTIVE", message: "Your account is not active." },
  INSUFFICIENT_RANK: { code: "INSUFFICIENT_RANK", message: "You do not have permission to do this." },
};

function fromAuthzError(err: unknown): ActionError {
  if (err instanceof AuthorizationError) return AUTHZ_MESSAGES[err.code];
  return { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." };
}

// ============================================================
// getStaffExitChecklist — Role >= Admin. Read-only aggregation across the
// four categories named in the task (positions, future schedules, managed
// groups, owned resources). No new table: everything is re-derived live
// from user_positions / schedules / group_members / group_resources, so
// there is no persisted "resolved" flag — an item disappears from the
// checklist the moment the underlying row no longer matches, which is also
// what finalizeStaffExit re-checks below.
//
// Owned group_resources are surfaced as `blocking: false` — resource
// ownership isn't a role/duty that needs to be handed off for an exit to be
// safe (unlike a claimed schedule slot or an exclusive coordinator seat),
// and no action in this task's allowed scope (position/schedule/group
// coordinator dispatch only, per the task's resolveExitItem spec) covers
// transferring resource ownership, so it is not authorized here.
// ============================================================
export type StaffExitPositionItem = {
  itemType: "position";
  itemId: number; // user_positions.id
  positionId: number;
  positionName: string;
  blocking: true;
};

export type StaffExitScheduleItem = {
  itemType: "schedule";
  itemId: number; // schedules.id
  date: string;
  startTime: string;
  blocking: true;
};

export type StaffExitGroupItem = {
  itemType: "group_coordinator" | "group_moderator";
  itemId: number; // groups.id
  groupName: string;
  // group_moderator entries have no corresponding resolveExitItem action in
  // this task's allowed scope (only "group coordinator" dispatch is
  // authorized) — surfaced for visibility but never blocking, and
  // resolveExitItem rejects resolution attempts against them.
  blocking: boolean;
};

export type StaffExitResourceItem = {
  itemType: "resource";
  itemId: number; // group_resources.id
  title: string;
  groupId: number;
  groupName: string;
  blocking: false;
};

export type StaffExitChecklist = {
  positions: StaffExitPositionItem[];
  schedules: StaffExitScheduleItem[];
  groups: StaffExitGroupItem[];
  resources: StaffExitResourceItem[];
  hasBlockingItems: boolean;
};

export async function getStaffExitChecklist(
  userId: string,
): Promise<StaffExitChecklist | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = getStaffExitChecklistSchema.safeParse({ userId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();

  const [{ data: holdingRows }, { data: scheduleRows }, { data: groupRows }, { data: resourceRows }] =
    await Promise.all([
      supabaseAdmin
        .from("user_positions")
        .select("id, position_id, positions ( name )")
        .eq("user_id", parsed.data.userId)
        .is("revoked_at", null),
      supabaseAdmin
        .from("schedules")
        .select("id, date, start_time, status")
        .eq("assigned_user_id", parsed.data.userId)
        .gt("start_time", new Date().toISOString())
        .not("status", "in", "(cancelled,completed)"),
      supabaseAdmin
        .from("group_members")
        .select("group_id, role_in_group, groups ( name )")
        .eq("user_id", parsed.data.userId)
        .in("role_in_group", ["coordinator", "moderator"]),
      supabaseAdmin
        .from("group_resources")
        .select("id, title, group_id, groups ( name )")
        .eq("added_by", parsed.data.userId),
    ]);

  const positions: StaffExitPositionItem[] = (holdingRows ?? []).map((row) => {
    const position = Array.isArray(row.positions) ? row.positions[0] : row.positions;
    return {
      itemType: "position",
      itemId: row.id,
      positionId: row.position_id,
      positionName: (position as { name: string } | null)?.name ?? "Unknown position",
      blocking: true,
    };
  });

  const schedules: StaffExitScheduleItem[] = (scheduleRows ?? []).map((row) => ({
    itemType: "schedule",
    itemId: row.id,
    date: row.date,
    startTime: row.start_time,
    blocking: true,
  }));

  const groups: StaffExitGroupItem[] = (groupRows ?? []).map((row) => {
    const group = Array.isArray(row.groups) ? row.groups[0] : row.groups;
    return {
      itemType: row.role_in_group === "coordinator" ? "group_coordinator" : "group_moderator",
      itemId: row.group_id,
      groupName: (group as { name: string } | null)?.name ?? "Unknown group",
      blocking: row.role_in_group === "coordinator",
    };
  });

  const resources: StaffExitResourceItem[] = (resourceRows ?? []).map((row) => {
    const group = Array.isArray(row.groups) ? row.groups[0] : row.groups;
    return {
      itemType: "resource",
      itemId: row.id,
      title: row.title,
      groupId: row.group_id,
      groupName: (group as { name: string } | null)?.name ?? "Unknown group",
      blocking: false,
    };
  });

  const hasBlockingItems =
    positions.some((p) => p.blocking) ||
    schedules.some((s) => s.blocking) ||
    groups.some((g) => g.blocking);

  return { positions, schedules, groups, resources, hasBlockingItems };
}

// ============================================================
// resolveExitItem — Role >= Admin. Dispatches to the existing Server
// Actions from prior tasks (positions.ts / scheduling.ts / groupOverview.ts)
// — no position/schedule/coordinator business logic is reimplemented here,
// only the lookups needed to translate a checklist item + resolution into
// the arguments those actions already expect.
// ============================================================
export async function resolveExitItem(
  itemType: string,
  itemId: number,
  resolution: string,
  targetUserId?: string,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = resolveExitItemSchema.safeParse({ itemType, itemId, resolution, targetUserId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }
  const data = parsed.data;

  if (data.resolution === "already_resolved") {
    return { success: true };
  }

  if (data.resolution === "reassign" && !data.targetUserId) {
    return { error: { code: "VALIDATION_ERROR", message: "Select a member to reassign to." } };
  }

  const supabaseAdmin = createAdminClient();

  if (data.itemType === "position") {
    if (data.resolution === "vacate") {
      const formData = new FormData();
      formData.set("userPositionId", String(data.itemId));
      formData.set("reason", "Staff exit");
      return revokePosition(initialActionState, formData);
    }

    // reassign: itemId is user_positions.id, but assignPosition needs the
    // position_id, not the holding row id — one extra lookup, not new logic.
    const { data: holding } = await supabaseAdmin
      .from("user_positions")
      .select("position_id")
      .eq("id", data.itemId)
      .maybeSingle();
    if (!holding) return { error: { code: "NOT_FOUND", message: "Position assignment not found." } };

    const revokeFormData = new FormData();
    revokeFormData.set("userPositionId", String(data.itemId));
    revokeFormData.set("reason", "Staff exit — reassigned");
    const revokeResult = await revokePosition(initialActionState, revokeFormData);
    if (revokeResult.error) return revokeResult;

    const assignFormData = new FormData();
    assignFormData.set("userId", data.targetUserId!);
    assignFormData.set("positionId", String(holding.position_id));
    return assignPosition(initialActionState, assignFormData);
  }

  if (data.itemType === "schedule") {
    const result =
      data.resolution === "vacate"
        ? await releaseSchedule(data.itemId)
        : await reassignSchedule(data.itemId, data.targetUserId!);
    return "error" in result ? { error: result.error } : { success: true };
  }

  if (data.itemType === "group_coordinator") {
    if (data.resolution === "vacate") {
      const formData = new FormData();
      formData.set("groupId", String(data.itemId));
      return removeGroupCoordinator(initialActionState, formData);
    }

    // reassign: assignGroupCoordinator requires the specific qualifying
    // position as justification (not "holds any position") — reuse
    // listEligibleCoordinators (groupOverview.ts) to find one the target
    // actually holds for this group, rather than guessing.
    const eligible = await listEligibleCoordinators(data.itemId);
    if ("error" in eligible) return { error: eligible.error };
    const candidate = eligible.coordinators.find((c) => c.userId === data.targetUserId);
    if (!candidate || candidate.positions.length === 0) {
      return {
        error: {
          code: "NOT_ELIGIBLE",
          message: "This member does not hold a position qualifying them to be coordinator.",
        },
      };
    }

    const formData = new FormData();
    formData.set("groupId", String(data.itemId));
    formData.set("userId", data.targetUserId!);
    formData.set("positionId", String(candidate.positions[0].positionId));
    return assignGroupCoordinator(initialActionState, formData);
  }

  return { error: { code: "UNSUPPORTED_ITEM_TYPE", message: "This item cannot be resolved from here." } };
}

// ============================================================
// finalizeStaffExit — Role >= Admin. Re-runs getStaffExitChecklist and
// blocks unless every BLOCKING item (position/schedule/coordinator — see
// StaffExitChecklist's blocking flags above) has been cleared. Optionally
// suspends the account by calling the existing suspendMember action
// (members.ts), which itself goes through set_member_status — not
// reimplemented here.
// ============================================================
export async function finalizeStaffExit(
  userId: string,
  suspend?: boolean,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = finalizeStaffExitSchema.safeParse({ userId, suspend: suspend ?? false });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const checklist = await getStaffExitChecklist(parsed.data.userId);
  if ("error" in checklist) return { error: checklist.error };

  if (checklist.hasBlockingItems) {
    return {
      error: {
        code: "UNRESOLVED_ITEMS_REMAIN",
        message: "Every position, schedule, and coordinator seat must be resolved before finalizing this exit.",
      },
    };
  }

  if (parsed.data.suspend) {
    const formData = new FormData();
    formData.set("userId", parsed.data.userId);
    formData.set("reason", "Staff exit finalized");
    const result = await suspendMember(initialActionState, formData);
    if (result.error) return result;
  }

  return { success: true };
}
