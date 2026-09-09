"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthorizationError } from "@/lib/auth/session";
import {
  previewBroadcastSchema,
  sendBroadcastSchema,
  retryBroadcastTargetSchema,
  listBroadcastHistorySchema,
} from "@/lib/validation/broadcast";
import { processBroadcastTargets, type BroadcastRow } from "@/lib/broadcast/delivery";
import { checkRateLimit, rateLimitMessage } from "@/lib/rate-limit/rateLimit";
import type { ActionError, ActionState } from "./types";

// Phase 6-F starting limit, hardcoded: sendBroadcast 10/hour per user.
const SEND_BROADCAST_LIMIT = 10;
const SEND_BROADCAST_WINDOW_SECONDS = 60 * 60;

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionState> = {
  NOT_AUTHENTICATED: { error: { code: "NOT_AUTHENTICATED", message: "You must be signed in." } },
  ACCOUNT_NOT_ACTIVE: { error: { code: "ACCOUNT_NOT_ACTIVE", message: "Your account is not active." } },
  INSUFFICIENT_RANK: {
    error: { code: "INSUFFICIENT_RANK", message: "You do not have permission to do this." },
  },
};

function fromAuthzError(err: unknown): { error: ActionError } {
  if (err instanceof AuthorizationError) {
    return AUTHZ_MESSAGES[err.code] as { error: ActionError };
  }
  return { error: { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." } };
}

// ============================================================
// previewBroadcast — read-only confirm-style gate ahead of sendBroadcast.
// Resolves target group names/count and echoes back the message/attachment
// so the UI has a definite "what will actually be sent" summary, without
// touching the database.
// ============================================================
export type BroadcastPreview = {
  message: string;
  attachmentUrl: string | null;
  groups: { id: number; name: string; type: string }[];
  count: number;
  sender: { id: string; username: string; displayName: string };
};

export async function previewBroadcast(
  message: string,
  attachmentUrl: string | undefined,
  targetGroupIds: number[],
): Promise<{ success: true; preview: BroadcastPreview } | { error: ActionError }> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = previewBroadcastSchema.safeParse({ message, attachmentUrl, targetGroupIds });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }
  if (parsed.data.targetGroupIds.length === 0) {
    return { error: { code: "NO_TARGETS_SELECTED", message: "Select at least one group." } };
  }

  const supabaseAdmin = createAdminClient();
  const uniqueGroupIds = Array.from(new Set(parsed.data.targetGroupIds));
  const { data: groups } = await supabaseAdmin
    .from("groups")
    .select("id, name, type")
    .in("id", uniqueGroupIds)
    .is("archived_at", null);
  if (!groups || groups.length !== uniqueGroupIds.length) {
    return { error: { code: "NOT_FOUND", message: "One or more selected groups could not be found." } };
  }

  return {
    success: true,
    preview: {
      message: parsed.data.message,
      attachmentUrl: parsed.data.attachmentUrl || null,
      groups: groups.map((g) => ({ id: g.id, name: g.name, type: g.type })),
      count: groups.length,
      sender: { id: admin.id, username: admin.username, displayName: admin.displayName },
    },
  };
}

// ============================================================
// sendBroadcast — calls the (already idempotent) send_broadcast RPC to
// create the broadcast + pending targets, then delivers to every 'pending'
// target for that broadcast. On a duplicate idempotencyKey the RPC returns
// the original broadcast with no new row created; any targets already
// 'sent' are excluded by the status='pending' filter below, so a repeat
// call never re-sends — it only picks up targets that never got delivered.
// ============================================================
export async function sendBroadcast(
  message: string,
  attachmentUrl: string | undefined,
  targetGroupIds: number[],
  idempotencyKey: string,
): Promise<{ success: true; broadcastId: number } | { error: ActionError }> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const broadcastLimit = await checkRateLimit(
    `sendbroadcast:${admin.id}`,
    SEND_BROADCAST_LIMIT,
    SEND_BROADCAST_WINDOW_SECONDS,
  );
  if (!broadcastLimit.allowed) {
    return {
      error: { code: "RATE_LIMITED", message: rateLimitMessage(broadcastLimit.retryAfterSeconds) },
    };
  }

  const parsed = sendBroadcastSchema.safeParse({ message, attachmentUrl, targetGroupIds, idempotencyKey });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  // send_broadcast returns broadcasts (a single composite row, not
  // setof) — PostgREST/supabase-js hands that back as a plain object in
  // `data`, not an array, so no .single() call is needed (or valid) here.
  const { data: broadcast, error } = await supabase.rpc("send_broadcast", {
    p_message: parsed.data.message,
    p_attachment_url: parsed.data.attachmentUrl || null,
    p_target_group_ids: Array.from(new Set(parsed.data.targetGroupIds)),
    p_idempotency_key: parsed.data.idempotencyKey,
  }) as { data: BroadcastRow | null; error: { message?: string } | null };

  if (error || !broadcast) {
    if (error?.message?.includes("NO_TARGETS_SELECTED")) {
      return { error: { code: "NO_TARGETS_SELECTED", message: "Select at least one group." } };
    }
    if (error?.message?.includes("NOT_AUTHORIZED")) {
      return { error: { code: "NOT_AUTHORIZED", message: "You do not have permission to do this." } };
    }
    return { error: { code: "SEND_FAILED", message: "Could not send this broadcast." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: pendingTargets } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id, broadcast_id, group_id")
    .eq("broadcast_id", broadcast.id)
    .eq("status", "pending");

  await processBroadcastTargets(supabaseAdmin, broadcast, pendingTargets ?? []);

  revalidatePath("/profile/admin/broadcast/history");
  return { success: true, broadcastId: broadcast.id };
}

// ============================================================
// retryBroadcastTarget — resets one 'failed' target back to 'pending' and
// re-runs delivery for just that target, via the same shared helper.
// ============================================================
export async function retryBroadcastTarget(
  broadcastTargetId: number,
): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = retryBroadcastTargetSchema.safeParse({ broadcastTargetId });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const { data: target } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id, broadcast_id, group_id, status")
    .eq("id", parsed.data.broadcastTargetId)
    .maybeSingle();
  if (!target) return { error: { code: "NOT_FOUND", message: "Target not found." } };
  if (target.status !== "failed") {
    return { error: { code: "NOT_FAILED_STATE", message: "This target is not in a failed state." } };
  }

  const { data: broadcast } = await supabaseAdmin
    .from("broadcasts")
    .select("id, sender_id, message, attachment_url")
    .eq("id", target.broadcast_id)
    .maybeSingle();
  if (!broadcast) return { error: { code: "NOT_FOUND", message: "Broadcast not found." } };

  await supabaseAdmin
    .from("broadcast_targets")
    .update({ status: "pending", error: null })
    .eq("id", target.id);

  await processBroadcastTargets(supabaseAdmin, broadcast, [
    { id: target.id, broadcast_id: target.broadcast_id, group_id: target.group_id },
  ]);

  revalidatePath("/profile/admin/broadcast/history");
  return { success: true };
}

// ============================================================
// listBroadcastHistory — bounded recent list (id-cursor pagination), each
// broadcast with its per-target status breakdown + full target list for
// the History screen's expandable detail view.
// ============================================================
export type BroadcastHistoryTarget = {
  id: number;
  groupId: number;
  groupName: string;
  status: string;
  sentAt: string | null;
  error: string | null;
  retryCount: number;
};

export type BroadcastHistoryItem = {
  id: number;
  message: string;
  attachmentUrl: string | null;
  createdAt: string;
  senderUsername: string;
  senderDisplayName: string;
  counts: { pending: number; sent: number; failed: number };
  targets: BroadcastHistoryTarget[];
};

export async function listBroadcastHistory(
  pagination?: { limit?: number; beforeId?: number },
): Promise<{ broadcasts: BroadcastHistoryItem[] } | { error: ActionError }> {
  try {
    await requireAdmin();
  } catch (err) {
    return fromAuthzError(err);
  }

  const parsed = listBroadcastHistorySchema.safeParse({
    limit: pagination?.limit ?? 20,
    beforeId: pagination?.beforeId,
  });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  let query = supabaseAdmin
    .from("broadcasts")
    .select("id, sender_id, message, attachment_url, created_at")
    .order("id", { ascending: false })
    .limit(parsed.data.limit);
  if (parsed.data.beforeId) query = query.lt("id", parsed.data.beforeId);

  const { data: broadcasts, error } = await query;
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load broadcast history." } };
  if (!broadcasts || broadcasts.length === 0) return { broadcasts: [] };

  const broadcastIds = broadcasts.map((b) => b.id);
  const senderIds = Array.from(new Set(broadcasts.map((b) => b.sender_id)));

  const [{ data: targets }, { data: senders }] = await Promise.all([
    supabaseAdmin
      .from("broadcast_targets")
      .select("id, broadcast_id, group_id, status, sent_at, error, retry_count")
      .in("broadcast_id", broadcastIds),
    supabaseAdmin.from("profiles").select("id, username, display_name").in("id", senderIds),
  ]);

  const groupIds = Array.from(new Set((targets ?? []).map((t) => t.group_id)));
  const { data: groups } = groupIds.length
    ? await supabaseAdmin.from("groups").select("id, name").in("id", groupIds)
    : { data: [] as { id: number; name: string }[] };

  const groupById = new Map((groups ?? []).map((g) => [g.id, g]));
  const senderById = new Map((senders ?? []).map((s) => [s.id, s]));

  const targetsByBroadcast = new Map<number, BroadcastHistoryTarget[]>();
  for (const t of targets ?? []) {
    const list = targetsByBroadcast.get(t.broadcast_id) ?? [];
    list.push({
      id: t.id,
      groupId: t.group_id,
      groupName: groupById.get(t.group_id)?.name ?? "Unknown group",
      status: t.status,
      sentAt: t.sent_at,
      error: t.error,
      retryCount: t.retry_count,
    });
    targetsByBroadcast.set(t.broadcast_id, list);
  }

  const result: BroadcastHistoryItem[] = broadcasts.map((b) => {
    const bTargets = targetsByBroadcast.get(b.id) ?? [];
    const counts = { pending: 0, sent: 0, failed: 0 };
    for (const t of bTargets) {
      if (t.status === "pending") counts.pending += 1;
      else if (t.status === "sent") counts.sent += 1;
      else if (t.status === "failed") counts.failed += 1;
    }
    return {
      id: b.id,
      message: b.message,
      attachmentUrl: b.attachment_url,
      createdAt: b.created_at,
      senderUsername: senderById.get(b.sender_id)?.username ?? "unknown",
      senderDisplayName: senderById.get(b.sender_id)?.display_name ?? "Unknown member",
      counts,
      targets: bTargets,
    };
  });

  return { broadcasts: result };
}
