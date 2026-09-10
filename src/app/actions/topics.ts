"use server";

// T-CODE-40 Part 1 — topics (sub-discussions within a group). New file
// rather than adding to messaging.ts: topics are their own table with
// their own RLS-gated writes, not an extension of message send/read.
//
// Writes go through direct table operations, same shape as
// addGroupResource/removeGroupResource in groupOverview.ts — the
// moderator/coordinator/admin gate is fully covered by RLS
// (0010_telegram_features.sql), so no RPC is needed here, only an
// app-layer pre-check via canModerateGroup for a fast, friendly rejection.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { canModerateGroup } from "./messaging";
import { createTopicSchema, archiveTopicSchema, listTopicsSchema } from "@/lib/validation/topics";
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

export type TopicDTO = {
  id: number;
  groupId: number;
  name: string;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
};

export async function createTopic(
  groupId: number,
  name: string,
): Promise<{ success: true; topic: TopicDTO } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = createTopicSchema.safeParse({ groupId, name });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabaseAdmin = createAdminClient();
  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;
  if (!isAdmin && !(await canModerateGroup(supabaseAdmin, profile, parsed.data.groupId))) {
    return { error: { code: "NOT_AUTHORIZED", message: "You do not have permission to do this." } };
  }

  const { data: group } = await supabaseAdmin
    .from("groups")
    .select("id, archived_at")
    .eq("id", parsed.data.groupId)
    .maybeSingle();
  if (!group) return { error: { code: "NOT_FOUND", message: "Group not found." } };
  if (group.archived_at) return { error: { code: "GROUP_ARCHIVED", message: "This group is archived." } };

  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("topics")
    .insert({ group_id: parsed.data.groupId, name: parsed.data.name, created_by: profile.id })
    .select("id, group_id, name, created_by, created_at, archived_at")
    .single();
  if (error || !inserted) return { error: { code: "CREATE_FAILED", message: "Could not create this topic." } };

  revalidatePath(`/groups/${parsed.data.groupId}`);

  return {
    success: true,
    topic: {
      id: inserted.id,
      groupId: inserted.group_id,
      name: inserted.name,
      createdBy: inserted.created_by,
      createdAt: inserted.created_at,
      archivedAt: inserted.archived_at,
    },
  };
}

export async function archiveTopic(topicId: number): Promise<{ success: true } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = archiveTopicSchema.safeParse({ topicId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const { data: topic } = await supabaseAdmin
    .from("topics")
    .select("id, group_id, archived_at")
    .eq("id", parsed.data.topicId)
    .maybeSingle();
  if (!topic) return { error: { code: "NOT_FOUND", message: "Topic not found." } };
  if (topic.archived_at) return { error: { code: "ALREADY_ARCHIVED", message: "This topic is already archived." } };

  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;
  if (!isAdmin && !(await canModerateGroup(supabaseAdmin, profile, topic.group_id))) {
    return { error: { code: "NOT_AUTHORIZED", message: "You do not have permission to do this." } };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("topics")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", parsed.data.topicId);
  if (error) return { error: { code: "ARCHIVE_FAILED", message: "Could not archive this topic." } };

  revalidatePath(`/groups/${topic.group_id}`);
  return { success: true };
}

export async function listTopics(
  groupId: number,
): Promise<{ topics: TopicDTO[] } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = listTopicsSchema.safeParse({ groupId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  const supabaseAdmin = createAdminClient();
  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;
  if (!isAdmin) {
    const { data: membership } = await supabaseAdmin
      .from("group_members")
      .select("id")
      .eq("group_id", parsed.data.groupId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!membership) return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
  }

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("topics")
    .select("id, group_id, name, created_by, created_at, archived_at")
    .eq("group_id", parsed.data.groupId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) return { error: { code: "FETCH_FAILED", message: "Could not load topics." } };

  const topics: TopicDTO[] = (rows ?? []).map((t) => ({
    id: t.id,
    groupId: t.group_id,
    name: t.name,
    createdBy: t.created_by,
    createdAt: t.created_at,
    archivedAt: t.archived_at,
  }));
  return { topics };
}
