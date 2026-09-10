"use server";

// T-CODE-41 Part 2 — collaborative checklists. Group-only (per spec:
// createChecklist(groupId, ...)), not available in DMs. All real writes go
// through the create_checklist / toggle_checklist_item SECURITY DEFINER
// RPCs (0011_quick_replies_checklists.sql) so the message + checklist +
// checklist_items insert is atomic, and the completion toggle is a single
// atomic UPDATE rather than a read-then-write from this app layer — same
// division of labor as polls.ts's RPC call sites.
//
// Item completion is collaborative by design (confirmed in T-CODE-41
// report): any member of the checklist's group may toggle any item, and
// toggling is unconditional last-toggle-wins, not "claim this item as
// mine" — there is no per-user lock on a checklist_items row.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { createChecklistSchema, toggleChecklistItemSchema, getChecklistSchema } from "@/lib/validation/checklists";
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

export type ChecklistItemDTO = {
  id: number;
  text: string;
  position: number;
  completedBy: string | null;
  completedAt: string | null;
};

export type ChecklistDTO = {
  id: number;
  messageId: number;
  title: string;
  createdBy: string;
  createdAt: string;
  items: ChecklistItemDTO[];
};

export async function createChecklist(
  groupId: number,
  title: string,
  items: string[],
): Promise<{ success: true; checklistId: number } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = createChecklistSchema.safeParse({ groupId, title, items });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_checklist", {
    p_group_id: parsed.data.groupId,
    p_title: parsed.data.title,
    p_items: parsed.data.items,
  });
  if (error || data == null) {
    if (error?.message?.includes("NOT_A_MEMBER")) {
      return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
    }
    return { error: { code: "CREATE_FAILED", message: "Could not create this checklist." } };
  }

  revalidatePath(`/groups/${parsed.data.groupId}`);
  return { success: true, checklistId: data as number };
}

export async function toggleChecklistItem(
  itemId: number,
): Promise<{ success: true; completedBy: string | null; completedAt: string | null } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = toggleChecklistItemSchema.safeParse({ itemId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  type ToggleRow = { id: number; completed_by: string | null; completed_at: string | null };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("toggle_checklist_item", { p_item_id: parsed.data.itemId });
  if (error) {
    if (error.message?.includes("NOT_AUTHORIZED")) {
      return { error: { code: "NOT_AUTHORIZED", message: "You are not a member of this group." } };
    }
    if (error.message?.includes("NOT_FOUND")) {
      return { error: { code: "NOT_FOUND", message: "Checklist item not found." } };
    }
    return { error: { code: "TOGGLE_FAILED", message: "Could not update this checklist item." } };
  }

  const row = (data as ToggleRow[] | null)?.[0];
  if (!row) return { error: { code: "NOT_FOUND", message: "Checklist item not found." } };

  return { success: true, completedBy: row.completed_by, completedAt: row.completed_at };
}

export async function getChecklist(
  checklistId: number,
): Promise<{ checklist: ChecklistDTO } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = getChecklistSchema.safeParse({ checklistId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const { data: checklist, error: checklistError } = await supabase
    .from("checklists")
    .select("id, message_id, title, created_by, created_at")
    .eq("id", parsed.data.checklistId)
    .maybeSingle();
  if (checklistError) return { error: { code: "FETCH_FAILED", message: "Could not load this checklist." } };
  if (!checklist) return { error: { code: "NOT_FOUND", message: "Checklist not found." } };

  const { data: itemRows, error: itemsError } = await supabase
    .from("checklist_items")
    .select("id, text, position, completed_by, completed_at")
    .eq("checklist_id", checklist.id)
    .order("position", { ascending: true });
  if (itemsError) return { error: { code: "FETCH_FAILED", message: "Could not load this checklist." } };

  const items: ChecklistItemDTO[] = (itemRows ?? []).map((i) => ({
    id: i.id,
    text: i.text,
    position: i.position,
    completedBy: i.completed_by,
    completedAt: i.completed_at,
  }));

  return {
    checklist: {
      id: checklist.id,
      messageId: checklist.message_id,
      title: checklist.title,
      createdBy: checklist.created_by,
      createdAt: checklist.created_at,
      items,
    },
  };
}
