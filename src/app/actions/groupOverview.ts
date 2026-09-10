"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { canModerateGroup } from "./messaging";
import {
  getGroupOverviewSchema,
  assignGroupCoordinatorSchema,
  removeGroupCoordinatorSchema,
  updateGroupLocationSchema,
  updateGroupSlowModeSchema,
  pinMessageSchema,
  unpinMessageSchema,
  addGroupResourceSchema,
  removeGroupResourceSchema,
  linkScheduleToGroupSchema,
  listEligibleCoordinatorsSchema,
} from "@/lib/validation/groupOverview";
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

// A pending-migration RPC (docs/TFT-GroupOverview-RPC-Fix.md) surfaces as a
// Postgres "function ... does not exist" error, not a business-rule
// rejection — mapped to its own code so the UI can say something more useful
// than a generic failure while the migration is still pending.
function isMissingFunctionError(err: { message?: string; code?: string } | null): boolean {
  return !!err && (err.code === "PGRST202" || (err.message ?? "").toLowerCase().includes("does not exist"));
}
const PENDING_MIGRATION_ERROR = actionError(
  "PENDING_MIGRATION",
  "This action isn't available yet — it depends on a database migration that hasn't shipped.",
);

async function getGroupMembership(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  groupId: number,
  userId: string,
): Promise<{ roleInGroup: string } | null> {
  const { data } = await supabaseAdmin
    .from("group_members")
    .select("role_in_group")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ? { roleInGroup: data.role_in_group } : null;
}

// ============================================================
// getGroupOverview — any group member (or admin, per this platform's
// standing "admin always sees everything for oversight" convention).
// ============================================================
export type GroupOverviewMember = {
  id: number;
  userId: string;
  roleInGroup: string;
  mutedUntil: string | null;
  profile: { id: string; username: string; displayName: string } | null;
};

export type GroupOverviewSchedule = {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  assignedUserId: string | null;
};

export type GroupOverviewResource = {
  id: number;
  title: string;
  url: string | null;
  storagePath: string | null;
  addedBy: string;
  addedByProfile: { username: string; displayName: string } | null;
  createdAt: string;
};

export type GroupOverviewPinnedMessage = {
  id: number;
  content: string | null;
  senderId: string;
  senderDisplayName: string;
  createdAt: string;
  deletedAt: string | null;
} | null;

export type GroupOverviewResult = {
  group: {
    id: number;
    name: string;
    description: string | null;
    type: string;
    location: string | null;
    archivedAt: string | null;
  };
  members: GroupOverviewMember[];
  coordinator: { userId: string; username: string; displayName: string } | null;
  canModerate: boolean;
  upcomingSchedules: GroupOverviewSchedule[];
  pinnedMessage: GroupOverviewPinnedMessage;
  resources: GroupOverviewResource[];
};

export async function getGroupOverview(
  groupId: number,
): Promise<GroupOverviewResult | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = getGroupOverviewSchema.safeParse({ groupId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;

  const { data: group } = await supabaseAdmin
    .from("groups")
    .select("id, name, description, type, location, pinned_message_id, archived_at")
    .eq("id", parsed.data.groupId)
    .maybeSingle();
  if (!group) return { error: { code: "NOT_FOUND", message: "Group not found." } };

  const membership = await getGroupMembership(supabaseAdmin, group.id, profile.id);
  if (!membership && !isAdmin) {
    return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
  }
  const canModerate =
    isAdmin || membership?.roleInGroup === "moderator" || membership?.roleInGroup === "coordinator";

  const { data: memberRows } = await supabaseAdmin
    .from("group_members")
    .select("id, user_id, role_in_group, muted_until")
    .eq("group_id", group.id)
    .order("joined_at", { ascending: true });
  const memberUserIds = (memberRows ?? []).map((m) => m.user_id);
  const { data: memberProfiles } = memberUserIds.length
    ? await supabaseAdmin.from("profiles").select("id, username, display_name").in("id", memberUserIds)
    : { data: [] as { id: string; username: string; display_name: string }[] };
  const profileById = new Map((memberProfiles ?? []).map((p) => [p.id, p]));

  const members: GroupOverviewMember[] = (memberRows ?? []).map((m) => {
    const p = profileById.get(m.user_id);
    return {
      id: m.id,
      userId: m.user_id,
      roleInGroup: m.role_in_group,
      mutedUntil: m.muted_until,
      profile: p ? { id: p.id, username: p.username, displayName: p.display_name } : null,
    };
  });

  const coordinatorRow = (memberRows ?? []).find((m) => m.role_in_group === "coordinator");
  const coordinatorProfile = coordinatorRow ? profileById.get(coordinatorRow.user_id) : null;
  const coordinator = coordinatorRow && coordinatorProfile
    ? { userId: coordinatorRow.user_id, username: coordinatorProfile.username, displayName: coordinatorProfile.display_name }
    : null;

  const { data: scheduleRows } = await supabaseAdmin
    .from("schedules")
    .select("id, date, start_time, end_time, status, assigned_user_id")
    .eq("group_id", group.id)
    .neq("status", "cancelled")
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true });
  const upcomingSchedules: GroupOverviewSchedule[] = (scheduleRows ?? []).map((s) => ({
    id: s.id,
    date: s.date,
    startTime: s.start_time,
    endTime: s.end_time,
    status: s.status,
    assignedUserId: s.assigned_user_id,
  }));

  let pinnedMessage: GroupOverviewPinnedMessage = null;
  if (group.pinned_message_id != null) {
    const { data: msg } = await supabaseAdmin
      .from("messages")
      .select("id, content, sender_id, created_at, deleted_at")
      .eq("id", group.pinned_message_id)
      .maybeSingle();
    if (msg) {
      const sender = profileById.get(msg.sender_id);
      let senderDisplayName = sender?.display_name;
      if (!senderDisplayName) {
        const { data: senderProfile } = await supabaseAdmin
          .from("profiles")
          .select("display_name")
          .eq("id", msg.sender_id)
          .maybeSingle();
        senderDisplayName = senderProfile?.display_name;
      }
      pinnedMessage = {
        id: msg.id,
        content: msg.deleted_at ? null : msg.content,
        senderId: msg.sender_id,
        senderDisplayName: senderDisplayName ?? "Unknown member",
        createdAt: msg.created_at,
        deletedAt: msg.deleted_at,
      };
    }
  }

  const { data: resourceRows } = await supabaseAdmin
    .from("group_resources")
    .select("id, title, url, storage_path, added_by, created_at")
    .eq("group_id", group.id)
    .order("created_at", { ascending: false });
  const resourceAdderIds = Array.from(new Set((resourceRows ?? []).map((r) => r.added_by)));
  const { data: resourceAdders } = resourceAdderIds.length
    ? await supabaseAdmin.from("profiles").select("id, username, display_name").in("id", resourceAdderIds)
    : { data: [] as { id: string; username: string; display_name: string }[] };
  const adderById = new Map((resourceAdders ?? []).map((p) => [p.id, p]));
  const resources: GroupOverviewResource[] = (resourceRows ?? []).map((r) => {
    const adder = adderById.get(r.added_by);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      storagePath: r.storage_path,
      addedBy: r.added_by,
      addedByProfile: adder ? { username: adder.username, displayName: adder.display_name } : null,
      createdAt: r.created_at,
    };
  });

  return {
    group: {
      id: group.id,
      name: group.name,
      description: group.description,
      type: group.type,
      location: group.location,
      archivedAt: group.archived_at,
    },
    members,
    coordinator,
    canModerate,
    upcomingSchedules,
    pinnedMessage,
    resources,
  };
}

// ============================================================
// listEligibleCoordinators — not one of the seven spec'd actions, but a data
// helper the Coordinator assignment UI needs, same role as
// listEligibleReplacements in positions.ts: an existing group member who
// holds at least one active, active-position qualifying them to be tagged
// Coordinator, per the Revision doc's confirmed "Position-gated" decision.
// ============================================================
export type EligibleCoordinatorPosition = { positionId: number; positionName: string };
export type EligibleCoordinator = {
  userId: string;
  username: string;
  displayName: string;
  positions: EligibleCoordinatorPosition[];
};

export async function listEligibleCoordinators(
  groupId: number,
): Promise<{ coordinators: EligibleCoordinator[] } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = listEligibleCoordinatorsSchema.safeParse({ groupId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const { data: memberRows } = await supabaseAdmin
    .from("group_members")
    .select("user_id")
    .eq("group_id", parsed.data.groupId);
  const memberIds = (memberRows ?? []).map((m) => m.user_id);
  if (memberIds.length === 0) return { coordinators: [] };

  const { data: holdingRows } = await supabaseAdmin
    .from("user_positions")
    .select("user_id, position_id, positions!inner ( id, name, is_active )")
    .in("user_id", memberIds)
    .is("revoked_at", null)
    .eq("positions.is_active", true);

  const positionsByUser = new Map<string, EligibleCoordinatorPosition[]>();
  for (const row of holdingRows ?? []) {
    const position = Array.isArray(row.positions) ? row.positions[0] : row.positions;
    if (!position) continue;
    const list = positionsByUser.get(row.user_id) ?? [];
    list.push({ positionId: position.id, positionName: position.name });
    positionsByUser.set(row.user_id, list);
  }

  const eligibleUserIds = Array.from(positionsByUser.keys());
  if (eligibleUserIds.length === 0) return { coordinators: [] };

  const { data: profiles } = await supabaseAdmin
    .from("profiles")
    .select("id, username, display_name")
    .in("id", eligibleUserIds)
    .order("display_name", { ascending: true });

  const coordinators: EligibleCoordinator[] = (profiles ?? []).map((p) => ({
    userId: p.id,
    username: p.username,
    displayName: p.display_name,
    positions: positionsByUser.get(p.id) ?? [],
  }));

  return { coordinators };
}

// ============================================================
// assignGroupCoordinator — Role >= Admin, Position-gated per the Revision
// doc's confirmed decision. Demotes any previous coordinator to 'member'
// BEFORE promoting the target, so trg_group_coordinator_exclusivity (fires
// on both INSERT and UPDATE, per supabase/migrations/0002_group_overview.sql
// — unlike trg_position_exclusivity, which positions.ts notes is INSERT-only)
// never sees two 'coordinator' rows at once.
// ============================================================
export async function assignGroupCoordinator(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = assignGroupCoordinatorSchema.safeParse({
    groupId: formData.get("groupId"),
    userId: formData.get("userId"),
    positionId: formData.get("positionId"),
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { groupId, userId, positionId } = parsed.data;

  const supabaseAdmin = createAdminClient();

  const { data: group } = await supabaseAdmin.from("groups").select("id").eq("id", groupId).maybeSingle();
  if (!group) return actionError("NOT_FOUND", "Group not found.");

  const targetMembership = await getGroupMembership(supabaseAdmin, groupId, userId);
  if (!targetMembership) return actionError("NOT_A_MEMBER", "This member is not in the group.");
  if (targetMembership.roleInGroup === "coordinator") {
    return actionError("ALREADY_COORDINATOR", "This member is already the group's coordinator.");
  }

  // Verify the SPECIFIC position invoked as justification, not merely "holds
  // any position" — per the task's explicit "not the same check as group
  // moderator status" instruction.
  const { data: position } = await supabaseAdmin
    .from("positions")
    .select("id, is_active")
    .eq("id", positionId)
    .maybeSingle();
  if (!position || !position.is_active) {
    return actionError("NOT_ELIGIBLE", "That position is not active.");
  }
  const { data: holding } = await supabaseAdmin
    .from("user_positions")
    .select("id")
    .eq("user_id", userId)
    .eq("position_id", positionId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!holding) {
    return actionError("NOT_ELIGIBLE", "This member does not hold that position.");
  }

  const supabase = await createClient();

  const { data: currentCoordinator } = await supabaseAdmin
    .from("group_members")
    .select("id, user_id")
    .eq("group_id", groupId)
    .eq("role_in_group", "coordinator")
    .maybeSingle();
  if (currentCoordinator) {
    const { error: demoteError } = await supabase
      .from("group_members")
      .update({ role_in_group: "member" })
      .eq("id", currentCoordinator.id);
    if (demoteError) return actionError("ASSIGN_FAILED", "Could not assign this coordinator.");
  }

  const { error: promoteError } = await supabase
    .from("group_members")
    .update({ role_in_group: "coordinator" })
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (promoteError) {
    if (promoteError.message?.toLowerCase().includes("already has a coordinator")) {
      return actionError("ASSIGN_FAILED", "This group already has a coordinator.");
    }
    return actionError("ASSIGN_FAILED", "Could not assign this coordinator.");
  }

  // audit_logs has no client insert policy by design (service-role/RPC-only
  // audit trail) — same pattern as position_history in positions.ts.
  await supabaseAdmin.from("audit_logs").insert({
    actor_id: admin.id,
    action: "group_coordinator_assigned",
    target_type: "group_member",
    target_id: userId,
    metadata: { group_id: groupId, position_id: positionId },
  });

  revalidatePath(`/groups/${groupId}`);
  revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}

export async function removeGroupCoordinator(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = removeGroupCoordinatorSchema.safeParse({ groupId: formData.get("groupId") });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { groupId } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: currentCoordinator } = await supabaseAdmin
    .from("group_members")
    .select("id, user_id")
    .eq("group_id", groupId)
    .eq("role_in_group", "coordinator")
    .maybeSingle();
  if (!currentCoordinator) return actionError("NO_COORDINATOR", "This group has no coordinator.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("group_members")
    .update({ role_in_group: "member" })
    .eq("id", currentCoordinator.id);
  if (error) return actionError("REMOVE_FAILED", "Could not remove this coordinator.");

  await supabaseAdmin.from("audit_logs").insert({
    actor_id: admin.id,
    action: "group_coordinator_removed",
    target_type: "group_member",
    target_id: currentCoordinator.user_id,
    metadata: { group_id: groupId },
  });

  revalidatePath(`/groups/${groupId}`);
  revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}

// ============================================================
// updateGroupLocation — Role >= Admin OR that group's coordinator/moderator.
// Admin's path is a direct UPDATE (RLS's "groups updated by admin" policy
// already covers it). The non-Admin coordinator/moderator path has no RLS
// coverage today (see docs/TFT-GroupOverview-RPC-Fix.md) — it calls the
// update_group_location RPC that fix doc specifies, which fails closed until
// that migration lands, rather than silently no-op'ing via a direct UPDATE.
// ============================================================
export async function updateGroupLocation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = updateGroupLocationSchema.safeParse({
    groupId: formData.get("groupId"),
    location: formData.get("location") || undefined,
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { groupId, location } = parsed.data;
  const normalizedLocation = location && location.length > 0 ? location : null;

  const supabaseAdmin = createAdminClient();
  const { data: group } = await supabaseAdmin.from("groups").select("id").eq("id", groupId).maybeSingle();
  if (!group) return actionError("NOT_FOUND", "Group not found.");

  const isAdmin = actor.roleRank >= ADMIN_MIN_RANK;

  if (isAdmin) {
    const supabase = await createClient();
    const { error } = await supabase.from("groups").update({ location: normalizedLocation }).eq("id", groupId);
    if (error) return actionError("UPDATE_FAILED", "Could not update this group's location.");
    revalidatePath(`/groups/${groupId}/overview`);
    return { success: true };
  }

  const membership = await getGroupMembership(supabaseAdmin, groupId, actor.id);
  if (!membership || !["moderator", "coordinator"].includes(membership.roleInGroup)) {
    return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_group_location", {
    p_group_id: groupId,
    p_location: normalizedLocation,
  });
  if (error) {
    if (isMissingFunctionError(error)) return PENDING_MIGRATION_ERROR;
    if (error.message?.includes("NOT_AUTHORIZED")) {
      return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
    }
    return actionError("UPDATE_FAILED", "Could not update this group's location.");
  }

  revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}

// ============================================================
// updateGroupSlowMode — T-CODE-40 Part 5. Same moderator/coordinator/admin
// gate as updateGroupLocation, but calls the update_group_slow_mode RPC
// unconditionally (rather than that function's admin-direct/moderator-RPC
// split): this migration ships already applied, so there is no
// "pending migration" window to work around, and the RPC itself already
// accepts Admins (is_admin() OR moderator/coordinator) — one code path is
// simplest and matches the RPC's own authorization exactly.
// ============================================================
export async function updateGroupSlowMode(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = updateGroupSlowModeSchema.safeParse({
    groupId: formData.get("groupId"),
    seconds: formData.get("seconds"),
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { groupId, seconds } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const isAdmin = actor.roleRank >= ADMIN_MIN_RANK;
  if (!isAdmin && !(await canModerateGroup(supabaseAdmin, actor, groupId))) {
    return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_group_slow_mode", {
    p_group_id: groupId,
    p_seconds: seconds,
  });
  if (error) {
    if (error.message?.includes("NOT_AUTHORIZED")) {
      return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
    }
    return actionError("UPDATE_FAILED", "Could not update slow mode for this group.");
  }

  revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}

// ============================================================
// pinMessage / unpinMessage — moderator/coordinator/admin. Same Admin-direct
// / moderator-RPC split as updateGroupLocation, for the same reason (see
// docs/TFT-GroupOverview-RPC-Fix.md).
// ============================================================
export async function pinMessage(groupId: number, messageId: number): Promise<{ success: true } | { error: ActionError }> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = pinMessageSchema.safeParse({ groupId, messageId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const isAdmin = actor.roleRank >= ADMIN_MIN_RANK;
  if (!isAdmin && !(await canModerateGroup(supabaseAdmin, actor, parsed.data.groupId))) {
    return { error: { code: "NOT_AUTHORIZED", message: "You do not have permission to do this." } };
  }

  const { data: message } = await supabaseAdmin
    .from("messages")
    .select("id, group_id, deleted_at")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (!message || message.deleted_at) return { error: { code: "NOT_FOUND", message: "Message not found." } };
  if (message.group_id !== parsed.data.groupId) {
    return { error: { code: "WRONG_GROUP", message: "This message does not belong to this group." } };
  }

  const supabase = await createClient();

  if (isAdmin) {
    const { error } = await supabase
      .from("groups")
      .update({ pinned_message_id: parsed.data.messageId })
      .eq("id", parsed.data.groupId);
    if (error) return { error: { code: "PIN_FAILED", message: "Could not pin this message." } };
    revalidatePath(`/groups/${parsed.data.groupId}/overview`);
    return { success: true };
  }

  const { error } = await supabase.rpc("pin_message", {
    p_group_id: parsed.data.groupId,
    p_message_id: parsed.data.messageId,
  });
  if (error) {
    if (isMissingFunctionError(error)) return { error: PENDING_MIGRATION_ERROR.error as ActionError };
    return { error: { code: "PIN_FAILED", message: "Could not pin this message." } };
  }

  revalidatePath(`/groups/${parsed.data.groupId}/overview`);
  return { success: true };
}

export async function unpinMessage(groupId: number): Promise<{ success: true } | { error: ActionError }> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = unpinMessageSchema.safeParse({ groupId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const isAdmin = actor.roleRank >= ADMIN_MIN_RANK;
  if (!isAdmin && !(await canModerateGroup(supabaseAdmin, actor, parsed.data.groupId))) {
    return { error: { code: "NOT_AUTHORIZED", message: "You do not have permission to do this." } };
  }

  const supabase = await createClient();

  if (isAdmin) {
    const { error } = await supabase
      .from("groups")
      .update({ pinned_message_id: null })
      .eq("id", parsed.data.groupId);
    if (error) return { error: { code: "UNPIN_FAILED", message: "Could not unpin this message." } };
    revalidatePath(`/groups/${parsed.data.groupId}/overview`);
    return { success: true };
  }

  const { error } = await supabase.rpc("unpin_message", { p_group_id: parsed.data.groupId });
  if (error) {
    if (isMissingFunctionError(error)) return { error: PENDING_MIGRATION_ERROR.error as ActionError };
    return { error: { code: "UNPIN_FAILED", message: "Could not unpin this message." } };
  }

  revalidatePath(`/groups/${parsed.data.groupId}/overview`);
  return { success: true };
}

// ============================================================
// addGroupResource — moderator/coordinator/admin. Direct insert; already
// fully covered by 0002_group_overview.sql's "group resources insertable by
// moderator/coordinator/admin" policy, no RPC needed.
// ============================================================
export async function addGroupResource(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = addGroupResourceSchema.safeParse({
    groupId: formData.get("groupId"),
    title: formData.get("title"),
    url: formData.get("url"),
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { groupId, title, url } = parsed.data;

  const supabaseAdmin = createAdminClient();
  if (!(await canModerateGroup(supabaseAdmin, actor, groupId))) {
    return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("group_resources").insert({
    group_id: groupId,
    title,
    url,
    added_by: actor.id,
  });
  if (error) return actionError("ADD_FAILED", "Could not add this resource.");

  revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}

// ============================================================
// removeGroupResource — moderator/coordinator/admin (direct delete, already
// covered by existing RLS), OR the member who added it (no RLS coverage —
// calls the remove_own_group_resource RPC from docs/TFT-GroupOverview-RPC-Fix.md,
// which fails closed until that migration lands).
// ============================================================
export async function removeGroupResource(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = removeGroupResourceSchema.safeParse({ resourceId: formData.get("resourceId") });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { resourceId } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: resource } = await supabaseAdmin
    .from("group_resources")
    .select("id, group_id, added_by")
    .eq("id", resourceId)
    .maybeSingle();
  if (!resource) return actionError("NOT_FOUND", "Resource not found.");

  const canModerate = await canModerateGroup(supabaseAdmin, actor, resource.group_id);
  const supabase = await createClient();

  if (canModerate) {
    const { error } = await supabase.from("group_resources").delete().eq("id", resourceId);
    if (error) return actionError("REMOVE_FAILED", "Could not remove this resource.");
    revalidatePath(`/groups/${resource.group_id}/overview`);
    return { success: true };
  }

  if (resource.added_by !== actor.id) {
    return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
  }

  const { error } = await supabase.rpc("remove_own_group_resource", { p_resource_id: resourceId });
  if (error) {
    if (isMissingFunctionError(error)) return PENDING_MIGRATION_ERROR;
    return actionError("REMOVE_FAILED", "Could not remove this resource.");
  }

  revalidatePath(`/groups/${resource.group_id}/overview`);
  return { success: true };
}

// ============================================================
// linkScheduleToGroup — Role >= Admin. Direct update on schedules.group_id
// only; RLS's "schedule slots overridden by admin" policy already covers
// this exactly, no RPC needed. Does not touch any other scheduling field.
// ============================================================
export async function linkScheduleToGroup(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = linkScheduleToGroupSchema.safeParse({
    scheduleId: formData.get("scheduleId"),
    groupId: formData.get("groupId"),
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { scheduleId, groupId } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const [{ data: schedule }, { data: group }] = await Promise.all([
    supabaseAdmin.from("schedules").select("id").eq("id", scheduleId).maybeSingle(),
    supabaseAdmin.from("groups").select("id").eq("id", groupId).maybeSingle(),
  ]);
  if (!schedule) return actionError("NOT_FOUND", "Schedule not found.");
  if (!group) return actionError("NOT_FOUND", "Group not found.");

  const supabase = await createClient();
  const { error } = await supabase.from("schedules").update({ group_id: groupId }).eq("id", scheduleId);
  if (error) return actionError("LINK_FAILED", "Could not link this schedule to the group.");

  revalidatePath(`/groups/${groupId}/overview`);
  return { success: true };
}
