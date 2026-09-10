"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { ADMIN_MIN_RANK, type ProfileWithRole } from "@/lib/auth/profile";
import {
  createGroupSchema,
  joinGroupSchema,
  sendMessageSchema,
  editMessageSchema,
  deleteMessageSchema,
  reactToMessageSchema,
  removeReactionSchema,
  markReadSchema,
  muteMemberSchema,
  removeMemberSchema,
  listMessagesSchema,
  searchMessagesSchema,
  forwardMessageSchema,
  pinChatSchema,
} from "@/lib/validation/messaging";
import { checkRateLimit, rateLimitMessage } from "@/lib/rate-limit/rateLimit";

// Phase 6-F starting limit, hardcoded: sendMessage 30/min per user.
const SEND_MESSAGE_LIMIT = 30;
const SEND_MESSAGE_WINDOW_SECONDS = 60;
import { actionError, type ActionState, type ActionError } from "./types";
import { EDIT_WINDOW_MINUTES } from "@/lib/messaging/constants";

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionState> = {
  NOT_AUTHENTICATED: actionError("NOT_AUTHENTICATED", "You must be signed in."),
  ACCOUNT_NOT_ACTIVE: actionError("ACCOUNT_NOT_ACTIVE", "Your account is not active."),
  INSUFFICIENT_RANK: actionError(
    "INSUFFICIENT_RANK",
    "You do not have permission to do this.",
  ),
};

function fromAuthzError(err: unknown): ActionState {
  if (err instanceof AuthorizationError) return AUTHZ_MESSAGES[err.code];
  return actionError("UNKNOWN_ERROR", "Something went wrong. Please try again.");
}

// Canonical DM pair ordering — lexicographic on the uuid string — so a DM
// thread resolves to the same dm_user_a/dm_user_b row regardless of who
// initiates it. Mirrors the "lower/higher uuid" instruction in the task spec.
function dmPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// group_members.role_in_group check constraint (supabase/migrations/0002_group_overview.sql)
// allows 'member' | 'moderator' | 'coordinator'. Both moderator and
// coordinator are treated as having moderation authority here.
export async function canModerateGroup(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  profile: ProfileWithRole,
  groupId: number,
): Promise<boolean> {
  if (profile.roleRank >= ADMIN_MIN_RANK) return true;
  const { data } = await supabaseAdmin
    .from("group_members")
    .select("role_in_group")
    .eq("group_id", groupId)
    .eq("user_id", profile.id)
    .maybeSingle();
  return data?.role_in_group === "moderator" || data?.role_in_group === "coordinator";
}

// Mirrors user_is_staff() (supabase/migrations/0002_group_overview.sql) in
// the app layer, for a pre-check ahead of the actual RLS-governed insert.
async function isEligibleForGroupType(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  profile: ProfileWithRole,
  type: string,
): Promise<boolean> {
  if (type === "public") return true;
  if (type === "staff_only") {
    if (profile.roleRank >= 30) return true;
    const { data } = await supabaseAdmin
      .from("user_positions")
      .select("id")
      .eq("user_id", profile.id)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle();
    return !!data;
  }
  if (type === "admin_only") return profile.roleRank >= ADMIN_MIN_RANK;
  return false; // private/broadcast: invite-only, never self-joinable
}

// ============================================================
// createGroup — T-CODE-32: any active member may create a 'public' or
// 'private' group (self-service, via the create_group RPC — they become
// its moderator). 'staff_only', 'admin_only', and 'broadcast' remain
// Role >= Admin only, via the pre-existing direct-insert path.
// ============================================================
const SELF_SERVICE_GROUP_TYPES = new Set(["public", "private"]);

export async function createGroup(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createGroupSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { name, type, description } = parsed.data;

  if (SELF_SERVICE_GROUP_TYPES.has(type)) {
    try {
      await requireActiveUser();
    } catch (err) {
      return fromAuthzError(err);
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("create_group", {
      p_name: name,
      p_description: description || null,
      p_type: type,
    });
    if (error) {
      return actionError("CREATE_FAILED", "Could not create this group.");
    }

    revalidatePath("/groups");
    revalidatePath("/chats");
    return { success: true };
  }

  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const supabase = await createClient();
  const { error } = await supabase.from("groups").insert({
    name,
    type,
    description: description || null,
    created_by: admin.id,
  });
  if (error) {
    return actionError("CREATE_FAILED", "Could not create this group.");
  }

  revalidatePath("/groups");
  revalidatePath("/chats");
  return { success: true };
}

// ============================================================
// joinGroup — eligibility is re-derived from the DB (public / staff_only /
// admin_only / private-broadcast) for a fast, friendly rejection, then the
// actual write goes through the join_group RPC (docs/TFT-Messaging-RPC-Fix.md),
// which re-checks the same eligibility rules itself as the real gate — the
// app-layer check above is a nicety, not the security boundary.
// ============================================================
export async function joinGroup(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = joinGroupSchema.safeParse({ groupId: formData.get("groupId") });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { groupId } = parsed.data;

  const supabaseAdmin = createAdminClient();
  const { data: group } = await supabaseAdmin
    .from("groups")
    .select("id, type, archived_at")
    .eq("id", groupId)
    .maybeSingle();
  if (!group) return actionError("NOT_FOUND", "Group not found.");
  if (group.archived_at) return actionError("GROUP_ARCHIVED", "This group is archived.");

  const { data: existing } = await supabaseAdmin
    .from("group_members")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", profile.id)
    .maybeSingle();
  if (existing) return actionError("ALREADY_MEMBER", "You are already in this group.");

  const NOT_ELIGIBLE = actionError("NOT_ELIGIBLE", "You're not eligible to join this group.");

  const eligible = await isEligibleForGroupType(supabaseAdmin, profile, group.type);
  if (!eligible) return NOT_ELIGIBLE;

  const supabase = await createClient();
  const { error } = await supabase.rpc("join_group", { p_group_id: groupId });
  if (error) {
    if (error.message?.includes("NOT_ELIGIBLE")) return NOT_ELIGIBLE;
    if (error.message?.includes("NOT_FOUND")) return actionError("NOT_FOUND", "Group not found.");
    return actionError("JOIN_FAILED", "Could not join this group.");
  }

  revalidatePath("/groups");
  revalidatePath("/chats");
  return { success: true };
}

// ============================================================
// muteMember / removeMember — moderator/coordinator/admin, via the
// moderate_group_member RPC (docs/TFT-Messaging-RPC-Fix.md). The app-layer
// canModerateGroup check below is a fast, friendly rejection; the RPC
// re-checks the same authorization itself as the real gate.
// ============================================================
export async function muteMember(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = muteMemberSchema.safeParse({
    groupId: formData.get("groupId"),
    userId: formData.get("userId"),
    until: formData.get("until") || undefined,
  });
  if (!parsed.success) {
    return actionError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const { groupId, userId, until } = parsed.data;

  const supabaseAdmin = createAdminClient();
  if (!(await canModerateGroup(supabaseAdmin, actor, groupId))) {
    return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
  }

  const { data: membership } = await supabaseAdmin
    .from("group_members")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return actionError("NOT_FOUND", "This member is not in the group.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("moderate_group_member", {
    p_group_id: groupId,
    p_target_user_id: userId,
    p_action: "mute",
    p_mute_until: until ?? null,
  });
  if (error) {
    return actionError("MUTE_FAILED", "Could not update this member.");
  }

  revalidatePath(`/groups/${groupId}`);
  return { success: true };
}

export async function removeMember(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let actor;
  try {
    actor = await requireActiveUser();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = removeMemberSchema.safeParse({
    groupId: formData.get("groupId"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) return actionError("VALIDATION_ERROR", "Invalid request.");
  const { groupId, userId } = parsed.data;

  const supabaseAdmin = createAdminClient();
  if (!(await canModerateGroup(supabaseAdmin, actor, groupId))) {
    return actionError("NOT_AUTHORIZED", "You do not have permission to do this.");
  }

  const { data: membership } = await supabaseAdmin
    .from("group_members")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return actionError("NOT_FOUND", "This member is not in the group.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("moderate_group_member", {
    p_group_id: groupId,
    p_target_user_id: userId,
    p_action: "remove",
  });
  if (error) {
    return actionError("REMOVE_FAILED", "Could not remove this member.");
  }

  revalidatePath(`/groups/${groupId}`);
  return { success: true };
}

// ============================================================
// Message DTOs + listMessages — shared by the initial Server Component
// fetch and the client's reconnect-refetch (Phase 5-E: reconnect = refetch,
// never replay).
// ============================================================
export type MessageDTO = {
  id: number;
  senderId: string;
  senderUsername: string;
  senderDisplayName: string;
  content: string | null; // null when deletedAt is set, regardless of stored row content
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyToId: number | null;
  replyPreview: string | null;
  forwardedFromMessageId: number | null;
  attachments: { id: number; storagePath: string; mimeType: string; sizeBytes: number }[];
  reactions: { emoji: string; count: number; reactedByMe: boolean }[];
};

export type MessageTarget = { groupId: number } | { recipientId: string };

export async function listMessages(
  target: MessageTarget,
  limit = 100,
): Promise<{ messages: MessageDTO[]; canModerate: boolean } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = listMessagesSchema.safeParse({ target, limit });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const supabase = await createClient();

  let filterGroupId: number | null = null;
  let dmPairIds: [string, string] | null = null;
  let canModerate = false;

  if ("groupId" in parsed.data.target) {
    filterGroupId = parsed.data.target.groupId;
    const { data: membership } = await supabaseAdmin
      .from("group_members")
      .select("role_in_group")
      .eq("group_id", filterGroupId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!membership && profile.roleRank < ADMIN_MIN_RANK) {
      return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
    }
    canModerate =
      profile.roleRank >= ADMIN_MIN_RANK ||
      membership?.role_in_group === "moderator" ||
      membership?.role_in_group === "coordinator";
  } else {
    const recipientId = parsed.data.target.recipientId;
    if (recipientId === profile.id) {
      return { error: { code: "INVALID_TARGET", message: "You cannot message yourself." } };
    }
    dmPairIds = dmPair(profile.id, recipientId);
  }

  let query = supabase
    .from("messages")
    .select(
      "id, group_id, dm_user_a, dm_user_b, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, forwarded_from_message_id",
    )
    .order("created_at", { ascending: false })
    .limit(parsed.data.limit);

  query =
    filterGroupId !== null
      ? query.eq("group_id", filterGroupId)
      : query.eq("dm_user_a", dmPairIds![0]).eq("dm_user_b", dmPairIds![1]);

  const { data: rows, error } = await query;
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load messages." } };

  const messages = (rows ?? []).slice().reverse(); // oldest -> newest for display
  if (messages.length === 0) return { messages: [], canModerate };

  const messageIds = messages.map((m) => m.id);
  const senderIds = Array.from(new Set(messages.map((m) => m.sender_id)));
  const replyIds = Array.from(
    new Set(messages.map((m) => m.reply_to_id).filter((id): id is number => id != null)),
  );

  const [{ data: senders }, { data: replySources }, { data: attachments }, { data: reactions }] =
    await Promise.all([
      supabaseAdmin.from("profiles").select("id, username, display_name").in("id", senderIds),
      replyIds.length
        ? supabaseAdmin
            .from("messages")
            .select("id, content, sender_id, deleted_at")
            .in("id", replyIds)
        : Promise.resolve({
            data: [] as { id: number; content: string | null; sender_id: string; deleted_at: string | null }[],
          }),
      supabaseAdmin
        .from("message_attachments")
        .select("id, message_id, storage_path, mime_type, size_bytes")
        .in("message_id", messageIds),
      supabaseAdmin
        .from("message_reactions")
        .select("message_id, emoji, user_id")
        .in("message_id", messageIds),
    ]);

  const senderById = new Map((senders ?? []).map((s) => [s.id, s]));
  const replyById = new Map((replySources ?? []).map((r) => [r.id, r]));

  const attachmentsByMessage = new Map<
    number,
    { id: number; storagePath: string; mimeType: string; sizeBytes: number }[]
  >();
  for (const a of attachments ?? []) {
    const list = attachmentsByMessage.get(a.message_id) ?? [];
    list.push({ id: a.id, storagePath: a.storage_path, mimeType: a.mime_type, sizeBytes: a.size_bytes });
    attachmentsByMessage.set(a.message_id, list);
  }

  const reactionsByMessage = new Map<number, Map<string, { count: number; reactedByMe: boolean }>>();
  for (const r of reactions ?? []) {
    const byEmoji = reactionsByMessage.get(r.message_id) ?? new Map();
    const entry = byEmoji.get(r.emoji) ?? { count: 0, reactedByMe: false };
    entry.count += 1;
    if (r.user_id === profile.id) entry.reactedByMe = true;
    byEmoji.set(r.emoji, entry);
    reactionsByMessage.set(r.message_id, byEmoji);
  }

  const dtos: MessageDTO[] = messages.map((m) => {
    const sender = senderById.get(m.sender_id);
    const replySource = m.reply_to_id != null ? replyById.get(m.reply_to_id) : null;
    const byEmoji = reactionsByMessage.get(m.id);
    return {
      id: m.id,
      senderId: m.sender_id,
      senderUsername: sender?.username ?? "unknown",
      senderDisplayName: sender?.display_name ?? "Unknown member",
      content: m.deleted_at ? null : m.content,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      replyToId: m.reply_to_id,
      replyPreview: replySource
        ? replySource.deleted_at
          ? "Message deleted"
          : (replySource.content ?? "").slice(0, 120)
        : null,
      forwardedFromMessageId: m.forwarded_from_message_id,
      attachments: attachmentsByMessage.get(m.id) ?? [],
      reactions: byEmoji ? Array.from(byEmoji.entries()).map(([emoji, v]) => ({ emoji, ...v })) : [],
    };
  });

  return { messages: dtos, canModerate };
}

// ============================================================
// sendMessage — handles both group and DM cases per the messages table's
// XOR check constraint. Called directly from client code (not a <form>
// action), same "async function invoked directly" pattern this codebase
// already uses for listEligibleReplacements in positions.ts.
// ============================================================
export async function sendMessage(
  target: MessageTarget,
  content: string,
  attachments?: { storagePath: string; mimeType: string; sizeBytes: number }[],
  replyToId?: number,
  topicId?: number,
): Promise<{ success: true; message: MessageDTO } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const messageLimit = await checkRateLimit(
    `sendmessage:${profile.id}`,
    SEND_MESSAGE_LIMIT,
    SEND_MESSAGE_WINDOW_SECONDS,
  );
  if (!messageLimit.allowed) {
    return {
      error: { code: "RATE_LIMITED", message: rateLimitMessage(messageLimit.retryAfterSeconds) },
    };
  }

  const parsed = sendMessageSchema.safeParse({ target, content, attachments, replyToId, topicId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const insertRow: Record<string, unknown> = {
    sender_id: profile.id,
    content: parsed.data.content,
  };

  if ("groupId" in parsed.data.target) {
    const groupId = parsed.data.target.groupId;
    const { data: membership } = await supabaseAdmin
      .from("group_members")
      .select("muted_until, role_in_group")
      .eq("group_id", groupId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!membership) {
      return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
    }
    if (membership.muted_until && new Date(membership.muted_until) > new Date()) {
      return { error: { code: "MUTED", message: "You are muted in this group." } };
    }

    // Slow mode (T-CODE-40 Part 5): moderators/coordinators/admins of THIS
    // group are exempt from their own group's slow mode; a regular member
    // must wait slow_mode_seconds between their own messages in this group.
    const isExemptFromSlowMode =
      profile.roleRank >= ADMIN_MIN_RANK ||
      membership.role_in_group === "moderator" ||
      membership.role_in_group === "coordinator";
    if (!isExemptFromSlowMode) {
      const { data: group } = await supabaseAdmin
        .from("groups")
        .select("slow_mode_seconds")
        .eq("id", groupId)
        .maybeSingle();
      if (group && group.slow_mode_seconds > 0) {
        const { data: lastMessage } = await supabaseAdmin
          .from("messages")
          .select("created_at")
          .eq("group_id", groupId)
          .eq("sender_id", profile.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastMessage) {
          const elapsedSeconds = (Date.now() - new Date(lastMessage.created_at).getTime()) / 1000;
          if (elapsedSeconds < group.slow_mode_seconds) {
            const retryAfterSeconds = Math.ceil(group.slow_mode_seconds - elapsedSeconds);
            return {
              error: {
                code: "SLOW_MODE_ACTIVE",
                message: `Slow mode is active in this group. Try again in ${retryAfterSeconds}s.`,
              },
            };
          }
        }
      }
    }

    if (parsed.data.topicId != null) {
      const { data: topic } = await supabaseAdmin
        .from("topics")
        .select("id, group_id, archived_at")
        .eq("id", parsed.data.topicId)
        .maybeSingle();
      if (!topic || topic.group_id !== groupId) {
        return { error: { code: "INVALID_TOPIC", message: "That topic does not belong to this group." } };
      }
      if (topic.archived_at) {
        return { error: { code: "TOPIC_ARCHIVED", message: "This topic is archived." } };
      }
      insertRow.topic_id = parsed.data.topicId;
    }

    insertRow.group_id = groupId;
  } else {
    const recipientId = parsed.data.target.recipientId;
    if (recipientId === profile.id) {
      return { error: { code: "INVALID_TARGET", message: "You cannot message yourself." } };
    }
    const { data: recipient } = await supabaseAdmin
      .from("profiles")
      .select("id, status")
      .eq("id", recipientId)
      .maybeSingle();
    if (!recipient || recipient.status !== "active") {
      return { error: { code: "NOT_FOUND", message: "Recipient not found." } };
    }
    const [lo, hi] = dmPair(profile.id, recipientId);
    insertRow.dm_user_a = lo;
    insertRow.dm_user_b = hi;
  }

  if (parsed.data.replyToId != null) {
    const { data: replySource } = await supabaseAdmin
      .from("messages")
      .select("id, group_id, dm_user_a, dm_user_b")
      .eq("id", parsed.data.replyToId)
      .maybeSingle();
    const sameThread =
      !!replySource &&
      (("group_id" in insertRow && replySource.group_id === insertRow.group_id) ||
        ("dm_user_a" in insertRow &&
          replySource.dm_user_a === insertRow.dm_user_a &&
          replySource.dm_user_b === insertRow.dm_user_b));
    if (!sameThread) {
      return { error: { code: "INVALID_REPLY", message: "That message is not part of this conversation." } };
    }
    insertRow.reply_to_id = parsed.data.replyToId;
  }

  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("messages")
    .insert(insertRow)
    .select("id, created_at")
    .single();
  if (error || !inserted) {
    return { error: { code: "SEND_FAILED", message: "Could not send this message." } };
  }

  if (parsed.data.attachments && parsed.data.attachments.length > 0) {
    await supabase.from("message_attachments").insert(
      parsed.data.attachments.map((a) => ({
        message_id: inserted.id,
        storage_path: a.storagePath,
        mime_type: a.mimeType,
        size_bytes: a.sizeBytes,
      })),
    );
  }

  const message: MessageDTO = {
    id: inserted.id,
    senderId: profile.id,
    senderUsername: profile.username,
    senderDisplayName: profile.displayName,
    content: parsed.data.content,
    createdAt: inserted.created_at,
    editedAt: null,
    deletedAt: null,
    replyToId: parsed.data.replyToId ?? null,
    replyPreview: null,
    forwardedFromMessageId: null,
    attachments: (parsed.data.attachments ?? []).map((a, i) => ({
      id: -1 - i,
      storagePath: a.storagePath,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
    reactions: [],
  };

  return { success: true, message };
}

// ============================================================
// searchMessages — T-CODE-34. Delegates the actual visibility filtering to
// the search_messages() SECURITY DEFINER RPC (0009_chat_enhancements.sql),
// which mirrors the "messages readable by participants" RLS policy rather
// than trusting the caller's groupId. This action only enriches the raw
// rows with sender/chat display info for the UI.
// ============================================================
export type MessageSearchResult = {
  messageId: number;
  chatKind: "group" | "dm";
  chatLabel: string;
  href: string;
  senderDisplayName: string;
  snippet: string;
  createdAt: string;
};

export async function searchMessages(
  query: string,
  groupId?: number,
): Promise<{ results: MessageSearchResult[] } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = searchMessagesSchema.safeParse({ query, groupId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  type SearchMessageRow = {
    id: number;
    group_id: number | null;
    dm_user_a: string | null;
    dm_user_b: string | null;
    sender_id: string;
    content: string | null;
    created_at: string;
    rank: number;
  };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_messages", {
    p_query: parsed.data.query,
    p_group_id: parsed.data.groupId ?? null,
  });
  if (error) return { error: { code: "SEARCH_FAILED", message: "Could not search messages." } };
  const rows = (data ?? []) as SearchMessageRow[];
  if (rows.length === 0) return { results: [] };

  const supabaseAdmin = createAdminClient();
  const senderIds = Array.from(new Set(rows.map((r) => r.sender_id)));
  const groupIds = Array.from(new Set(rows.map((r) => r.group_id).filter((id): id is number => id != null)));
  const dmPartnerIds = Array.from(
    new Set(
      rows
        .filter((r) => r.group_id == null)
        .map((r) => (r.dm_user_a === profile.id ? r.dm_user_b : r.dm_user_a))
        .filter((id): id is string => id != null),
    ),
  );

  const [{ data: senders }, { data: groups }, { data: partners }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, display_name").in("id", senderIds),
    groupIds.length
      ? supabaseAdmin.from("groups").select("id, name").in("id", groupIds)
      : Promise.resolve({ data: [] as { id: number; name: string }[] }),
    dmPartnerIds.length
      ? supabaseAdmin.from("profiles").select("id, display_name").in("id", dmPartnerIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);

  const senderById = new Map((senders ?? []).map((s) => [s.id, s.display_name]));
  const groupById = new Map((groups ?? []).map((g) => [g.id, g.name]));
  const partnerById = new Map((partners ?? []).map((p) => [p.id, p.display_name]));

  const results: MessageSearchResult[] = rows.map((r) => {
    if (r.group_id != null) {
      return {
        messageId: r.id,
        chatKind: "group" as const,
        chatLabel: groupById.get(r.group_id) ?? "Unknown group",
        href: `/groups/${r.group_id}?m=${r.id}`,
        senderDisplayName: senderById.get(r.sender_id) ?? "Unknown member",
        snippet: (r.content ?? "").slice(0, 140),
        createdAt: r.created_at,
      };
    }
    const otherId = r.dm_user_a === profile.id ? r.dm_user_b : r.dm_user_a;
    return {
      messageId: r.id,
      chatKind: "dm" as const,
      chatLabel: (otherId ? partnerById.get(otherId) : null) ?? "Unknown member",
      href: `/dm/${otherId}?m=${r.id}`,
      senderDisplayName: senderById.get(r.sender_id) ?? "Unknown member",
      snippet: (r.content ?? "").slice(0, 140),
      createdAt: r.created_at,
    };
  });

  return { results };
}

// ============================================================
// forwardMessage — T-CODE-34. Reuses sendMessage() itself for the actual
// send so the same permission/rate-limit/validation checks run (group
// membership, muted status, SEND_MESSAGE_LIMIT) rather than duplicating
// them. This function's own job is only: read the source message (via the
// RLS-governed session client, so a caller can't forward a message they
// couldn't otherwise see), copy its content/attachments into a call to
// sendMessage, then stamp forwarded_from_message_id on the resulting row.
// ============================================================
export async function forwardMessage(
  messageId: number,
  targetGroupId?: number,
  targetUserId?: string,
): Promise<{ success: true; message: MessageDTO } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = forwardMessageSchema.safeParse({ messageId, targetGroupId, targetUserId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { data: source } = await supabase
    .from("messages")
    .select("id, content, deleted_at")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (!source) return { error: { code: "NOT_FOUND", message: "Message not found." } };
  if (source.deleted_at) return { error: { code: "MESSAGE_DELETED", message: "This message was deleted." } };
  if (!source.content) {
    return { error: { code: "VALIDATION_ERROR", message: "This message has no content to forward." } };
  }

  const { data: sourceAttachments } = await supabase
    .from("message_attachments")
    .select("storage_path, mime_type, size_bytes")
    .eq("message_id", parsed.data.messageId);

  const target: MessageTarget =
    parsed.data.targetGroupId != null
      ? { groupId: parsed.data.targetGroupId }
      : { recipientId: parsed.data.targetUserId! };

  const attachments = (sourceAttachments ?? []).map((a) => ({
    storagePath: a.storage_path,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
  }));

  const result = await sendMessage(target, source.content, attachments.length ? attachments : undefined);
  if ("error" in result) return result;

  await supabase
    .from("messages")
    .update({ forwarded_from_message_id: parsed.data.messageId })
    .eq("id", result.message.id);

  return { success: true, message: { ...result.message, forwardedFromMessageId: parsed.data.messageId } };
}

export async function editMessage(
  messageId: number,
  content: string,
): Promise<{ success: true; editedAt: string; content: string } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = editMessageSchema.safeParse({ messageId, content });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: msg } = await supabaseAdmin
    .from("messages")
    .select("id, sender_id, created_at, deleted_at")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (!msg) return { error: { code: "NOT_FOUND", message: "Message not found." } };
  if (msg.deleted_at) return { error: { code: "MESSAGE_DELETED", message: "This message was deleted." } };
  if (msg.sender_id !== profile.id) {
    return { error: { code: "NOT_AUTHORIZED", message: "Only the sender can edit a message." } };
  }

  const ageMinutes = (Date.now() - new Date(msg.created_at).getTime()) / 60000;
  if (ageMinutes > EDIT_WINDOW_MINUTES) {
    return {
      error: {
        code: "EDIT_WINDOW_EXPIRED",
        message: `Messages can only be edited within ${EDIT_WINDOW_MINUTES} minutes of sending.`,
      },
    };
  }

  const editedAt = new Date().toISOString();
  const supabase = await createClient();
  const { error } = await supabase
    .from("messages")
    .update({ content: parsed.data.content, edited_at: editedAt })
    .eq("id", parsed.data.messageId);
  if (error) return { error: { code: "EDIT_FAILED", message: "Could not edit this message." } };

  return { success: true, editedAt, content: parsed.data.content };
}

export async function deleteMessage(
  messageId: number,
): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = deleteMessageSchema.safeParse({ messageId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const { data: msg } = await supabaseAdmin
    .from("messages")
    .select("id, sender_id, group_id, deleted_at")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (!msg) return { error: { code: "NOT_FOUND", message: "Message not found." } };
  if (msg.deleted_at) return { error: { code: "ALREADY_DELETED", message: "This message was already deleted." } };

  const isSender = msg.sender_id === profile.id;
  const isModerator = !isSender && msg.group_id ? await canModerateGroup(supabaseAdmin, profile, msg.group_id) : false;
  if (!isSender && !isModerator) {
    return { error: { code: "NOT_AUTHORIZED", message: "You do not have permission to delete this message." } };
  }

  const supabase = await createClient();

  // Own-message delete: unaffected, already works via the existing
  // sender_id = auth.uid() RLS policy on messages.
  if (isSender) {
    const { error } = await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", parsed.data.messageId);
    if (error) return { error: { code: "DELETE_FAILED", message: "Could not delete this message." } };
    return { success: true };
  }

  // Moderator/coordinator/admin deleting someone else's message — via the
  // moderate_delete_message RPC (docs/TFT-Messaging-RPC-Fix.md).
  const { error } = await supabase.rpc("moderate_delete_message", {
    p_message_id: parsed.data.messageId,
  });
  if (error) return { error: { code: "DELETE_FAILED", message: "Could not delete this message." } };

  return { success: true };
}

// reactToMessage / removeReaction — group members only, per T-CODE-08 spec
// (DM messages are not reactable in this task).
export async function reactToMessage(
  messageId: number,
  emoji: string,
): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = reactToMessageSchema.safeParse({ messageId, emoji });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: msg } = await supabaseAdmin
    .from("messages")
    .select("id, group_id, deleted_at")
    .eq("id", parsed.data.messageId)
    .maybeSingle();
  if (!msg) return { error: { code: "NOT_FOUND", message: "Message not found." } };
  if (msg.deleted_at) return { error: { code: "MESSAGE_DELETED", message: "Cannot react to a deleted message." } };
  if (!msg.group_id) {
    return { error: { code: "NOT_ELIGIBLE", message: "Reactions are only available in group chats." } };
  }

  const { data: membership } = await supabaseAdmin
    .from("group_members")
    .select("id")
    .eq("group_id", msg.group_id)
    .eq("user_id", profile.id)
    .maybeSingle();
  if (!membership) return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };

  const supabase = await createClient();
  const { error } = await supabase
    .from("message_reactions")
    .insert({ message_id: parsed.data.messageId, user_id: profile.id, emoji: parsed.data.emoji });
  if (error && error.code !== "23505") {
    return { error: { code: "REACT_FAILED", message: "Could not add this reaction." } };
  }

  return { success: true };
}

export async function removeReaction(
  messageId: number,
  emoji: string,
): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = removeReactionSchema.safeParse({ messageId, emoji });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: { code: "NOT_AUTHENTICATED", message: "You must be signed in." } };

  const { error } = await supabase
    .from("message_reactions")
    .delete()
    .eq("message_id", parsed.data.messageId)
    .eq("user_id", user.id)
    .eq("emoji", parsed.data.emoji);
  if (error) return { error: { code: "REMOVE_REACTION_FAILED", message: "Could not remove this reaction." } };

  return { success: true };
}

export type MarkReadTarget = { groupId: number } | { recipientId: string } | { messageId: number };

export async function markRead(
  target: MarkReadTarget,
): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = markReadSchema.safeParse({ target });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const supabaseAdmin = createAdminClient();

  let messageIds: number[] = [];

  if ("messageId" in parsed.data.target) {
    messageIds = [parsed.data.target.messageId];
  } else if ("groupId" in parsed.data.target) {
    const groupId = parsed.data.target.groupId;
    const { data: membership } = await supabaseAdmin
      .from("group_members")
      .select("id")
      .eq("group_id", groupId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!membership && profile.roleRank < ADMIN_MIN_RANK) {
      return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
    }
    const { data: msgs } = await supabase
      .from("messages")
      .select("id")
      .eq("group_id", groupId)
      .is("deleted_at", null);
    messageIds = (msgs ?? []).map((m) => m.id);
  } else {
    const [lo, hi] = dmPair(profile.id, parsed.data.target.recipientId);
    const { data: msgs } = await supabase
      .from("messages")
      .select("id")
      .eq("dm_user_a", lo)
      .eq("dm_user_b", hi)
      .is("deleted_at", null);
    messageIds = (msgs ?? []).map((m) => m.id);
  }

  if (messageIds.length === 0) return { success: true };

  const { data: alreadyRead } = await supabase
    .from("message_reads")
    .select("message_id")
    .eq("user_id", profile.id)
    .in("message_id", messageIds);
  const readSet = new Set((alreadyRead ?? []).map((r) => r.message_id));
  const toInsert = messageIds.filter((id) => !readSet.has(id)).map((id) => ({ message_id: id, user_id: profile.id }));
  if (toInsert.length > 0) {
    await supabase.from("message_reads").insert(toInsert);
  }

  return { success: true };
}

// ============================================================
// listMyGroups / listMyDirectMessages — Chats tab data. listMyGroups is
// exactly the API spec'd function; listMyDirectMessages is an addition
// needed to fulfil the Chats screen's explicit "combined DM + group list"
// requirement (messages has no separate "DM thread" entity to list from,
// so DM threads are derived the same way listMyGroups derives unread
// counts — from messages vs message_reads, no new table).
// ============================================================
export type GroupChatSummary = {
  id: number;
  name: string;
  type: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
};

async function summarizeGroupMessages(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  groupIds: number[],
) {
  const lastMessageByGroup = new Map<number, { createdAt: string; preview: string }>();
  const unreadByGroup = new Map<number, number>();
  if (groupIds.length === 0) return { lastMessageByGroup, unreadByGroup };

  // Bounded recent-activity window (last 500 messages across the user's
  // groups) rather than the full history — enough for last-message preview
  // and unread badges at this platform's scale; not a paginated inbox.
  const { data: msgs } = await supabase
    .from("messages")
    .select("id, group_id, sender_id, content, deleted_at, created_at")
    .in("group_id", groupIds)
    .order("created_at", { ascending: false })
    .limit(500);

  const messageIds = (msgs ?? []).map((m) => m.id);
  const { data: reads } = messageIds.length
    ? await supabase.from("message_reads").select("message_id").eq("user_id", userId).in("message_id", messageIds)
    : { data: [] as { message_id: number }[] };
  const readSet = new Set((reads ?? []).map((r) => r.message_id));

  for (const m of msgs ?? []) {
    if (!lastMessageByGroup.has(m.group_id)) {
      lastMessageByGroup.set(m.group_id, {
        createdAt: m.created_at,
        preview: m.deleted_at ? "Message deleted" : (m.content ?? "").slice(0, 120),
      });
    }
    if (!m.deleted_at && m.sender_id !== userId && !readSet.has(m.id)) {
      unreadByGroup.set(m.group_id, (unreadByGroup.get(m.group_id) ?? 0) + 1);
    }
  }
  return { lastMessageByGroup, unreadByGroup };
}

export async function listMyGroups(): Promise<{ groups: GroupChatSummary[] } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const supabase = await createClient();
  const { data: memberships } = await supabase.from("group_members").select("group_id").eq("user_id", profile.id);
  const groupIds = (memberships ?? []).map((m) => m.group_id);
  if (groupIds.length === 0) return { groups: [] };

  const { data: groups } = await supabase
    .from("groups")
    .select("id, name, type")
    .in("id", groupIds)
    .is("archived_at", null);
  const activeGroups = groups ?? [];

  const { lastMessageByGroup, unreadByGroup } = await summarizeGroupMessages(
    supabase,
    profile.id,
    activeGroups.map((g) => g.id),
  );

  const result: GroupChatSummary[] = activeGroups.map((g) => ({
    id: g.id,
    name: g.name,
    type: g.type,
    lastMessageAt: lastMessageByGroup.get(g.id)?.createdAt ?? null,
    lastMessagePreview: lastMessageByGroup.get(g.id)?.preview ?? null,
    unreadCount: unreadByGroup.get(g.id) ?? 0,
  }));
  return { groups: result };
}

export type DmChatSummary = {
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
};

export async function listMyDirectMessages(): Promise<{ dms: DmChatSummary[] } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const supabase = await createClient();
  const { data: msgs } = await supabase
    .from("messages")
    .select("id, dm_user_a, dm_user_b, sender_id, content, deleted_at, created_at")
    .or(`dm_user_a.eq.${profile.id},dm_user_b.eq.${profile.id}`)
    .order("created_at", { ascending: false })
    .limit(500);

  if (!msgs || msgs.length === 0) return { dms: [] };

  const messageIds = msgs.map((m) => m.id);
  const { data: reads } = await supabase
    .from("message_reads")
    .select("message_id")
    .eq("user_id", profile.id)
    .in("message_id", messageIds);
  const readSet = new Set((reads ?? []).map((r) => r.message_id));

  const lastByPartner = new Map<string, { createdAt: string; preview: string }>();
  const unreadByPartner = new Map<string, number>();
  for (const m of msgs) {
    const otherId = m.dm_user_a === profile.id ? m.dm_user_b : m.dm_user_a;
    if (!otherId) continue;
    if (!lastByPartner.has(otherId)) {
      lastByPartner.set(otherId, {
        createdAt: m.created_at,
        preview: m.deleted_at ? "Message deleted" : (m.content ?? "").slice(0, 120),
      });
    }
    if (!m.deleted_at && m.sender_id !== profile.id && !readSet.has(m.id)) {
      unreadByPartner.set(otherId, (unreadByPartner.get(otherId) ?? 0) + 1);
    }
  }

  const partnerIds = Array.from(lastByPartner.keys());
  const { data: partners } = partnerIds.length
    ? await supabase.from("profiles").select("id, username, display_name").in("id", partnerIds)
    : { data: [] as { id: string; username: string; display_name: string }[] };
  const partnerById = new Map((partners ?? []).map((p) => [p.id, p]));

  const dms: DmChatSummary[] = partnerIds.map((id) => ({
    otherUserId: id,
    otherUsername: partnerById.get(id)?.username ?? "unknown",
    otherDisplayName: partnerById.get(id)?.display_name ?? "Unknown member",
    lastMessageAt: lastByPartner.get(id)?.createdAt ?? null,
    lastMessagePreview: lastByPartner.get(id)?.preview ?? null,
    unreadCount: unreadByPartner.get(id) ?? 0,
  }));
  return { dms };
}

// ============================================================
// getOrCreateSavedMessagesThread — T-CODE-40 Part 3. "Saved messages" is a
// DM thread where dm_user_a = dm_user_b = the user's own id, reusing all
// existing DM machinery rather than a new table/concept. There is nothing
// to actually "create": DM threads aren't a row, they're implied by
// messages rows (same as every other DM thread in this schema), so this
// just resolves the routing identifier — the self-DM IS the user's own id.
//
// Verified for this: dmPair(a, a) returns [a, a] without error (a < a is
// false, so it takes the `b < a` branch, giving [b, a] = [a, a]); the
// messages check constraint (0001_init.sql) only requires dm_user_a/
// dm_user_b to both be non-null, never that they differ; and both
// "messages readable by participants" and "messages sent by authenticated
// participants" RLS policies are OR'd conditions that pass when
// dm_user_a = dm_user_b = auth.uid(). No migration was needed for this.
//
// KNOWN GAP (see T-CODE-40 report BLOCKED ITEMS): sendMessage() still has
// its own `recipientId === profile.id` guard (this task's instructions
// explicitly forbid touching sendMessage beyond topicId/slow-mode), so
// actually sending a message into this thread will currently be rejected
// with INVALID_TARGET until that guard is revisited in the UI follow-up.
// ============================================================
export async function getOrCreateSavedMessagesThread(): Promise<
  { success: true; recipientId: string } | { error: ActionError }
> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  return { success: true, recipientId: profile.id };
}

// ============================================================
// Pinned chats — T-CODE-34. Per-user chat-list pins (distinct from
// groups.pinned_message_id / pin_message / unpin_message from T-CODE-11,
// which pin one announcement message per group for everyone; these pin an
// entire group or DM thread to the top of one user's own Chats list).
// RLS on pinned_chats is self-only, so the session client alone is enough
// authorization — no admin-client pre-check needed here.
// ============================================================
export type PinnedChats = { groupIds: number[]; dmUserIds: string[] };

export async function listPinnedChats(): Promise<{ pinned: PinnedChats } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pinned_chats")
    .select("group_id, dm_other_user_id")
    .eq("user_id", profile.id);
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load pinned chats." } };

  const groupIds = (data ?? [])
    .map((r) => r.group_id)
    .filter((id): id is number => id != null);
  const dmUserIds = (data ?? [])
    .map((r) => r.dm_other_user_id)
    .filter((id): id is string => id != null);

  return { pinned: { groupIds, dmUserIds } };
}

export async function pinChat(
  groupId?: number,
  userId?: string,
): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = pinChatSchema.safeParse({ groupId, userId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("pinned_chats").insert({
    user_id: profile.id,
    group_id: parsed.data.groupId ?? null,
    dm_other_user_id: parsed.data.userId ?? null,
  });
  if (error && error.code !== "23505") {
    return { error: { code: "PIN_FAILED", message: "Could not pin this chat." } };
  }

  revalidatePath("/chats");
  return { success: true };
}

export async function unpinChat(
  groupId?: number,
  userId?: string,
): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = pinChatSchema.safeParse({ groupId, userId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  let query = supabase.from("pinned_chats").delete().eq("user_id", profile.id);
  query =
    parsed.data.groupId != null
      ? query.eq("group_id", parsed.data.groupId)
      : query.eq("dm_other_user_id", parsed.data.userId!);
  const { error } = await query;
  if (error) return { error: { code: "UNPIN_FAILED", message: "Could not unpin this chat." } };

  revalidatePath("/chats");
  return { success: true };
}
