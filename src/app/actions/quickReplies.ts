"use server";

// T-CODE-41 Part 1 — quick replies. Personal canned-response shortcuts,
// fully self-only (0011_quick_replies_checklists.sql RLS covers every
// operation), so this file is a thin validate-then-table-operation layer,
// same shape as pinnedChats-style self-owned rows — no RPC needed since
// there's no cross-table atomicity or authorization beyond "is this row
// mine", both of which RLS already enforces.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import {
  createQuickReplySchema,
  updateQuickReplySchema,
  deleteQuickReplySchema,
} from "@/lib/validation/quickReplies";
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

export type QuickReplyDTO = {
  id: number;
  shortcut: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export async function listQuickReplies(): Promise<
  { quickReplies: QuickReplyDTO[] } | { error: ActionError }
> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("quick_replies")
    .select("id, shortcut, content, created_at, updated_at")
    .order("shortcut", { ascending: true });
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load quick replies." } };

  const quickReplies: QuickReplyDTO[] = (rows ?? []).map((r) => ({
    id: r.id,
    shortcut: r.shortcut,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return { quickReplies };
}

export async function createQuickReply(
  shortcut: string,
  content: string,
): Promise<{ success: true; quickReply: QuickReplyDTO } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = createQuickReplySchema.safeParse({ shortcut, content });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("quick_replies")
    .insert({ user_id: profile.id, shortcut: parsed.data.shortcut, content: parsed.data.content })
    .select("id, shortcut, content, created_at, updated_at")
    .single();
  if (error || !inserted) {
    if (error?.code === "23505") {
      return { error: { code: "DUPLICATE_SHORTCUT", message: "You already have a quick reply with this shortcut." } };
    }
    return { error: { code: "CREATE_FAILED", message: "Could not create this quick reply." } };
  }

  revalidatePath("/settings/quick-replies");

  return {
    success: true,
    quickReply: {
      id: inserted.id,
      shortcut: inserted.shortcut,
      content: inserted.content,
      createdAt: inserted.created_at,
      updatedAt: inserted.updated_at,
    },
  };
}

export async function updateQuickReply(
  id: number,
  fields: { shortcut?: string; content?: string },
): Promise<{ success: true; quickReply: QuickReplyDTO } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = updateQuickReplySchema.safeParse({
    quickReplyId: id,
    shortcut: fields.shortcut,
    content: fields.content,
  });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.shortcut !== undefined) updateRow.shortcut = parsed.data.shortcut;
  if (parsed.data.content !== undefined) updateRow.content = parsed.data.content;

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("quick_replies")
    .update(updateRow)
    .eq("id", parsed.data.quickReplyId)
    .select("id, shortcut, content, created_at, updated_at")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return { error: { code: "DUPLICATE_SHORTCUT", message: "You already have a quick reply with this shortcut." } };
    }
    return { error: { code: "UPDATE_FAILED", message: "Could not update this quick reply." } };
  }
  if (!updated) return { error: { code: "NOT_FOUND", message: "Quick reply not found." } };

  revalidatePath("/settings/quick-replies");

  return {
    success: true,
    quickReply: {
      id: updated.id,
      shortcut: updated.shortcut,
      content: updated.content,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    },
  };
}

export async function deleteQuickReply(id: number): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = deleteQuickReplySchema.safeParse({ quickReplyId: id });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabase = await createClient();
  const { data: deleted, error } = await supabase
    .from("quick_replies")
    .delete()
    .eq("id", parsed.data.quickReplyId)
    .select("id")
    .maybeSingle();
  if (error) return { error: { code: "DELETE_FAILED", message: "Could not delete this quick reply." } };
  if (!deleted) return { error: { code: "NOT_FOUND", message: "Quick reply not found." } };

  revalidatePath("/settings/quick-replies");
  return { success: true };
}
