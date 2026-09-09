"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { listNotificationsSchema, markNotificationReadSchema } from "@/lib/validation/notifications";
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

// Flat `type` values in use today ('admin', 'schedule_cancelled',
// 'schedule_assigned', 'schedule_missed' — see notifications.type's comment
// in supabase/migrations/0001_init.sql) group cleanly by a name-prefix
// convention, so grouping is done client-side off this derived field rather
// than adding a new column.
export type NotificationCategory = "messaging" | "scheduling" | "admin";

function categorize(type: string): NotificationCategory {
  if (type === "message" || type === "mention") return "messaging";
  if (type.startsWith("schedule")) return "scheduling";
  return "admin";
}

export type NotificationDTO = {
  id: number;
  type: string;
  category: NotificationCategory;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

// ============================================================
// listNotifications — self only. RLS ("notifications readable by their own
// user", 0001_init.sql) already scopes this to auth.uid(), so the session
// client alone is the access control here — no explicit .eq("user_id", ...)
// needed, same reasoning as listMySchedules-style reads elsewhere.
// ============================================================
export async function listNotifications(
  pagination?: { limit?: number; beforeId?: number },
): Promise<{ notifications: NotificationDTO[] } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = listNotificationsSchema.safeParse({
    limit: pagination?.limit ?? 20,
    beforeId: pagination?.beforeId,
  });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  let query = supabase
    .from("notifications")
    .select("id, type, payload, read_at, created_at")
    .order("id", { ascending: false })
    .limit(parsed.data.limit);
  if (parsed.data.beforeId) query = query.lt("id", parsed.data.beforeId);

  const { data, error } = await query;
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load notifications." } };

  const notifications: NotificationDTO[] = (data ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    category: categorize(row.type),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));

  return { notifications };
}

// ============================================================
// markNotificationRead — self only. The "notifications marked read by their
// own user" UPDATE policy scopes this by RLS; the explicit .eq("user_id", …)
// below is defense-in-depth, matching the rest of this codebase's
// convention (e.g. assignPosition's exclusivity check ahead of the
// trigger).
// ============================================================
export async function markNotificationRead(
  notificationId: number,
): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const parsed = markNotificationReadSchema.safeParse({ notificationId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", parsed.data.notificationId)
    .eq("user_id", profile.id);
  if (error) return { error: { code: "UPDATE_FAILED", message: "Could not mark this notification as read." } };

  revalidatePath("/notifications");
  return { success: true };
}

// ============================================================
// markAllNotificationsRead — self only, same RLS/defense-in-depth pattern
// as markNotificationRead above.
// ============================================================
export async function markAllNotificationsRead(): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", profile.id)
    .is("read_at", null);
  if (error) return { error: { code: "UPDATE_FAILED", message: "Could not mark notifications as read." } };

  revalidatePath("/notifications");
  return { success: true };
}

// ============================================================
// getUnreadCount — self only, for the bell badge. head:true means no rows
// are actually transferred, just the count.
// ============================================================
export async function getUnreadCount(): Promise<{ count: number } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id)
    .is("read_at", null);
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load unread count." } };

  return { count: count ?? 0 };
}
