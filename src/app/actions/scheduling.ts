"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import {
  createScheduleSlotSchema,
  listSchedulesSchema,
  claimScheduleSchema,
  checkInScheduleSchema,
  releaseScheduleSchema,
  cancelScheduleSchema,
  reassignScheduleSchema,
  listEligibleScheduleAssigneesSchema,
} from "@/lib/validation/scheduling";
import { CHECK_IN_WINDOW_BEFORE_MINUTES, type ScheduleStatus } from "@/lib/scheduling/constants";
import { actionError, type ActionState, type ActionError } from "./types";

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionState> = {
  NOT_AUTHENTICATED: actionError("NOT_AUTHENTICATED", "You must be signed in."),
  ACCOUNT_NOT_ACTIVE: actionError("ACCOUNT_NOT_ACTIVE", "Your account is not active."),
  INSUFFICIENT_RANK: actionError("INSUFFICIENT_RANK", "You do not have permission to do this."),
};

function fromAuthzError(err: unknown): ActionState {
  if (err instanceof AuthorizationError) return AUTHZ_MESSAGES[err.code];
  return actionError("UNKNOWN_ERROR", "Something went wrong. Please try again.");
}

// Mirrors claim_schedule's own eligibility subquery (supabase/migrations/
// 0001_init.sql) exactly — a slot with no position_id is open to anyone, a
// slot with a position_id requires an active (non-revoked) holding of that
// exact position. reassignSchedule uses this instead of calling
// claim_schedule itself, because that RPC always assigns to auth.uid() (the
// caller) and requires status = 'available' — neither fits "an Admin
// assigns an arbitrary target user to an already-claimed slot". Per the
// task's "reused not reinvented" instruction, this is the same check, not a
// new eligibility rule.
async function isEligibleForScheduleSlot(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  userId: string,
  positionId: number | null,
): Promise<boolean> {
  if (positionId == null) return true;
  const { data } = await supabaseAdmin
    .from("user_positions")
    .select("id")
    .eq("user_id", userId)
    .eq("position_id", positionId)
    .is("revoked_at", null)
    .maybeSingle();
  return !!data;
}

// ============================================================
// createScheduleSlot — Role >= Admin. Direct insert: the "schedule slots
// created by admin" INSERT policy (supabase/migrations/0001_init.sql)
// already covers this exactly, confirmed present before writing this file
// (T-CODE-12 step 1) — no RPC needed.
// ============================================================
export async function createScheduleSlot(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = createScheduleSlotSchema.safeParse({
    date: formData.get("date"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    positionId: formData.get("positionId") ?? "",
    notes: formData.get("notes") ?? "",
    groupId: formData.get("groupId") ?? "",
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { date, startTime, endTime, positionId, notes, groupId } = parsed.data;

  const supabaseAdmin = createAdminClient();

  if (positionId != null) {
    const { data: position } = await supabaseAdmin
      .from("positions")
      .select("id, is_active")
      .eq("id", positionId)
      .maybeSingle();
    if (!position || !position.is_active) {
      return actionError("NOT_FOUND", "Position not found or inactive.");
    }
  }
  if (groupId != null) {
    const { data: group } = await supabaseAdmin.from("groups").select("id").eq("id", groupId).maybeSingle();
    if (!group) return actionError("NOT_FOUND", "Group not found.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("schedules").insert({
    date,
    start_time: new Date(startTime).toISOString(),
    end_time: new Date(endTime).toISOString(),
    position_id: positionId ?? null,
    notes: notes ?? null,
    group_id: groupId ?? null,
    created_by: admin.id,
  });
  if (error) return actionError("CREATE_FAILED", "Could not create this schedule slot.");

  revalidatePath("/schedule");
  if (groupId != null) revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}

// ============================================================
// listSchedules — any authenticated active user. Uses the session client
// throughout (not the service-role client): schedules/positions/profiles
// are all readable by any authenticated user per existing RLS ("schedules
// visible to all active members" / "positions readable by any
// authenticated user" / "profiles readable by any authenticated approved
// user" — supabase/migrations/0001_init.sql), so nothing here needs a
// privilege escalation.
// ============================================================
export type ScheduleDTO = {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  status: ScheduleStatus;
  positionId: number | null;
  positionName: string | null;
  assignedUserId: string | null;
  assignedUserDisplayName: string | null;
  notes: string | null;
  groupId: number | null;
  cancelReason: string | null;
  // Derived, per-viewer flags — computed here so the UI never has to
  // re-derive authorization/eligibility rules itself.
  isMine: boolean;
  canClaim: boolean;
  canCheckIn: boolean;
  canRelease: boolean;
};

export async function listSchedules(
  dateRangeStart: string,
  dateRangeEnd: string,
): Promise<{ schedules: ScheduleDTO[] } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = listSchedulesSchema.safeParse({ dateRangeStart, dateRangeEnd });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("schedules")
    .select(
      "id, date, start_time, end_time, status, position_id, assigned_user_id, notes, group_id, cancel_reason",
    )
    .gte("start_time", parsed.data.dateRangeStart)
    .lte("start_time", parsed.data.dateRangeEnd)
    .order("start_time", { ascending: true });
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load the schedule." } };

  const schedules = rows ?? [];
  const positionIds = Array.from(
    new Set(schedules.map((s) => s.position_id).filter((id): id is number => id != null)),
  );
  const userIds = Array.from(
    new Set(schedules.map((s) => s.assigned_user_id).filter((id): id is string => id != null)),
  );

  const [{ data: positions }, { data: profiles }] = await Promise.all([
    positionIds.length
      ? supabase.from("positions").select("id, name").in("id", positionIds)
      : Promise.resolve({ data: [] as { id: number; name: string }[] }),
    userIds.length
      ? supabase.from("profiles").select("id, display_name").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);
  const positionById = new Map((positions ?? []).map((p) => [p.id, p.name]));
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  const now = Date.now();
  const checkInWindowStartMs = CHECK_IN_WINDOW_BEFORE_MINUTES * 60_000;

  const dtos: ScheduleDTO[] = schedules.map((s) => {
    const isMine = s.assigned_user_id === profile.id;
    const startMs = new Date(s.start_time).getTime();
    return {
      id: s.id,
      date: s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      status: s.status as ScheduleStatus,
      positionId: s.position_id,
      positionName: s.position_id != null ? positionById.get(s.position_id) ?? null : null,
      assignedUserId: s.assigned_user_id,
      assignedUserDisplayName: s.assigned_user_id != null ? profileById.get(s.assigned_user_id) ?? null : null,
      notes: s.notes,
      groupId: s.group_id,
      cancelReason: s.cancel_reason,
      isMine,
      canClaim: s.status === "available",
      canCheckIn: isMine && s.status === "claimed" && now >= startMs - checkInWindowStartMs,
      canRelease: isMine && (s.status === "claimed" || s.status === "checked_in"),
    };
  });

  return { schedules: dtos };
}

// ============================================================
// claimSchedule — calls the existing claim_schedule RPC, untouched.
// SLOT_ALREADY_CLAIMED / eligibility failures are mapped to the
// human-readable Phase 2 flow #1 copy; anything else falls back to a
// generic message rather than surfacing the raw Postgres error.
// ============================================================
export async function claimSchedule(scheduleId: number): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = claimScheduleSchema.safeParse({ scheduleId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_schedule", { p_schedule_id: parsed.data.scheduleId });
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("slot_already_claimed")) {
      return {
        error: { code: "SLOT_ALREADY_CLAIMED", message: "This slot was already claimed by someone else." },
      };
    }
    if (msg.includes("not eligible")) {
      return { error: { code: "NOT_ELIGIBLE", message: "You're not eligible to claim this slot." } };
    }
    return { error: { code: "CLAIM_FAILED", message: "Could not claim this slot." } };
  }

  revalidatePath("/schedule");
  return { success: true };
}

// ============================================================
// checkIn — calls the existing check_in_schedule RPC, untouched.
// ============================================================
export async function checkIn(scheduleId: number): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = checkInScheduleSchema.safeParse({ scheduleId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const { error } = await supabase.rpc("check_in_schedule", { p_schedule_id: parsed.data.scheduleId });
  if (error) {
    return {
      error: {
        code: "CHECK_IN_FAILED",
        message: "Could not check in — this slot may not be yours, or it's no longer in a claimed state.",
      },
    };
  }

  revalidatePath("/schedule");
  return { success: true };
}

// ============================================================
// releaseSchedule — calls the existing release_schedule RPC, untouched.
// ============================================================
export async function releaseSchedule(scheduleId: number): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = releaseScheduleSchema.safeParse({ scheduleId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const { error } = await supabase.rpc("release_schedule", { p_schedule_id: parsed.data.scheduleId });
  if (error) {
    return {
      error: {
        code: "RELEASE_FAILED",
        message: "Could not release this slot — it may not be yours, or it's no longer in a releasable state.",
      },
    };
  }

  revalidatePath("/schedule");
  return { success: true };
}

// ============================================================
// cancelSchedule — Role >= Admin, direct update via the "schedule slots
// overridden by admin" policy (confirmed present, T-CODE-12 step 1).
// Notifies the previously-assigned user, if any.
// ============================================================
export async function cancelSchedule(
  scheduleId: number,
  reason: string,
): Promise<{ success: true } | { error: ActionError }> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = cancelScheduleSchema.safeParse({ scheduleId, reason });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: schedule } = await supabaseAdmin
    .from("schedules")
    .select("id, status, assigned_user_id, group_id")
    .eq("id", parsed.data.scheduleId)
    .maybeSingle();
  if (!schedule) return { error: { code: "NOT_FOUND", message: "Schedule not found." } };
  if (schedule.status === "cancelled") {
    return { error: { code: "ALREADY_CANCELLED", message: "This slot is already cancelled." } };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("schedules")
    .update({
      status: "cancelled",
      cancel_reason: parsed.data.reason,
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.scheduleId);
  if (error) return { error: { code: "CANCEL_FAILED", message: "Could not cancel this slot." } };

  await supabaseAdmin.from("audit_logs").insert({
    actor_id: admin.id,
    action: "schedule_cancelled",
    target_type: "schedule",
    target_id: String(parsed.data.scheduleId),
    metadata: { reason: parsed.data.reason, previous_status: schedule.status },
  });

  if (schedule.assigned_user_id) {
    await supabaseAdmin.from("notifications").insert({
      user_id: schedule.assigned_user_id,
      type: "schedule_cancelled",
      payload: { schedule_id: parsed.data.scheduleId, reason: parsed.data.reason },
    });
  }

  revalidatePath("/schedule");
  if (schedule.group_id) revalidatePath(`/groups/${schedule.group_id}/overview`);
  return { success: true };
}

// ============================================================
// reassignSchedule — Role >= Admin, verifies the new assignee is eligible
// (isEligibleForScheduleSlot above — same rule as claim_schedule, reused
// not reinvented) before a direct update via the admin-override policy.
// Resets checkin_at and moves status back to 'claimed': the new assignee
// hasn't checked in, regardless of what the previous assignee had done.
// ============================================================
export async function reassignSchedule(
  scheduleId: number,
  newUserId: string,
): Promise<{ success: true } | { error: ActionError }> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = reassignScheduleSchema.safeParse({ scheduleId, newUserId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: schedule } = await supabaseAdmin
    .from("schedules")
    .select("id, position_id, status, group_id, assigned_user_id")
    .eq("id", parsed.data.scheduleId)
    .maybeSingle();
  if (!schedule) return { error: { code: "NOT_FOUND", message: "Schedule not found." } };
  if (!["available", "claimed", "checked_in"].includes(schedule.status)) {
    return { error: { code: "INVALID_STATE", message: "This slot cannot be reassigned in its current state." } };
  }

  const { data: targetProfile } = await supabaseAdmin
    .from("profiles")
    .select("id, status")
    .eq("id", parsed.data.newUserId)
    .maybeSingle();
  if (!targetProfile || targetProfile.status !== "active") {
    return { error: { code: "NOT_FOUND", message: "Member not found." } };
  }

  const eligible = await isEligibleForScheduleSlot(supabaseAdmin, parsed.data.newUserId, schedule.position_id);
  if (!eligible) {
    return {
      error: { code: "NOT_ELIGIBLE", message: "This member does not hold the position required for this slot." },
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("schedules")
    .update({
      assigned_user_id: parsed.data.newUserId,
      status: "claimed",
      claimed_at: new Date().toISOString(),
      checkin_at: null,
    })
    .eq("id", parsed.data.scheduleId);
  if (error) return { error: { code: "REASSIGN_FAILED", message: "Could not reassign this slot." } };

  await supabaseAdmin.from("audit_logs").insert({
    actor_id: admin.id,
    action: "schedule_reassigned",
    target_type: "schedule",
    target_id: String(parsed.data.scheduleId),
    metadata: { new_user_id: parsed.data.newUserId, previous_status: schedule.status },
  });

  await supabaseAdmin.from("notifications").insert({
    user_id: parsed.data.newUserId,
    type: "schedule_assigned",
    payload: { schedule_id: parsed.data.scheduleId },
  });

  if (schedule.assigned_user_id && schedule.assigned_user_id !== parsed.data.newUserId) {
    await supabaseAdmin.from("notifications").insert({
      user_id: schedule.assigned_user_id,
      type: "admin",
      payload: {
        message: "You have been reassigned away from a schedule slot.",
        schedule_id: parsed.data.scheduleId,
      },
    });
  }

  revalidatePath("/schedule");
  if (schedule.group_id) revalidatePath(`/groups/${schedule.group_id}/overview`);
  return { success: true };
}

// ============================================================
// listEligibleScheduleAssignees — not one of the six spec'd actions, but a
// data helper the Reassign control needs, same role as
// listEligibleReplacements (positions.ts) / listEligibleCoordinators
// (groupOverview.ts): active members who satisfy isEligibleForScheduleSlot
// for this specific slot's position_id.
// ============================================================
export type EligibleScheduleAssignee = { userId: string; username: string; displayName: string };

export async function listEligibleScheduleAssignees(
  scheduleId: number,
): Promise<{ users: EligibleScheduleAssignee[] } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = listEligibleScheduleAssigneesSchema.safeParse({ scheduleId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const { data: schedule } = await supabaseAdmin
    .from("schedules")
    .select("id, position_id")
    .eq("id", parsed.data.scheduleId)
    .maybeSingle();
  if (!schedule) return { error: { code: "NOT_FOUND", message: "Schedule not found." } };

  if (schedule.position_id == null) {
    const { data: activeProfiles } = await supabaseAdmin
      .from("profiles")
      .select("id, username, display_name")
      .eq("status", "active")
      .order("display_name", { ascending: true });
    return {
      users: (activeProfiles ?? []).map((p) => ({ userId: p.id, username: p.username, displayName: p.display_name })),
    };
  }

  const { data: holders } = await supabaseAdmin
    .from("user_positions")
    .select("user_id, profiles!inner ( id, username, display_name, status )")
    .eq("position_id", schedule.position_id)
    .is("revoked_at", null);

  const users: EligibleScheduleAssignee[] = (holders ?? [])
    .map((h) => (Array.isArray(h.profiles) ? h.profiles[0] : h.profiles))
    .filter((p): p is { id: string; username: string; display_name: string; status: string } => !!p && p.status === "active")
    .map((p) => ({ userId: p.id, username: p.username, displayName: p.display_name }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { users };
}
