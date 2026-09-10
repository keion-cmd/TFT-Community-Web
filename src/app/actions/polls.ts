"use server";

// T-CODE-40 Part 2 — polls. Group-only (per spec: createPoll(groupId, ...)),
// not available in DMs. All real writes go through the create_poll /
// vote_poll SECURITY DEFINER RPCs (0010_telegram_features.sql) so the
// message + poll + poll_options insert is atomic and the vote replace is
// atomic — this file's job is auth pre-checks, validation, and shaping
// results for the caller, same division of labor as messaging.ts's RPC
// call sites (join_group, moderate_group_member, etc.).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { createPollSchema, votePollSchema, getPollResultsSchema } from "@/lib/validation/polls";
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

export async function createPoll(
  groupId: number,
  question: string,
  options: string[],
  allowMultiple?: boolean,
  closesAt?: string,
): Promise<{ success: true; pollId: number } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = createPollSchema.safeParse({ groupId, question, options, allowMultiple, closesAt });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_poll", {
    p_group_id: parsed.data.groupId,
    p_question: parsed.data.question,
    p_options: parsed.data.options,
    p_allow_multiple: parsed.data.allowMultiple,
    p_closes_at: parsed.data.closesAt ?? null,
  });
  if (error || data == null) {
    if (error?.message?.includes("NOT_A_MEMBER")) {
      return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
    }
    return { error: { code: "CREATE_FAILED", message: "Could not create this poll." } };
  }

  revalidatePath(`/groups/${parsed.data.groupId}`);
  return { success: true, pollId: data as number };
}

export async function votePoll(
  pollId: number,
  optionIds: number[],
): Promise<{ success: true } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = votePollSchema.safeParse({ pollId, optionIds });
  if (!parsed.success) {
    return { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request." } };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("vote_poll", {
    p_poll_id: parsed.data.pollId,
    p_option_ids: parsed.data.optionIds,
  });
  if (error) {
    if (error.message?.includes("POLL_CLOSED")) {
      return { error: { code: "POLL_CLOSED", message: "This poll is closed." } };
    }
    if (error.message?.includes("MULTIPLE_NOT_ALLOWED")) {
      return { error: { code: "MULTIPLE_NOT_ALLOWED", message: "This poll only allows one choice." } };
    }
    if (error.message?.includes("INVALID_OPTIONS")) {
      return { error: { code: "INVALID_OPTIONS", message: "Invalid option selection." } };
    }
    if (error.message?.includes("NOT_AUTHORIZED")) {
      return { error: { code: "NOT_AUTHORIZED", message: "You are not a member of this group." } };
    }
    if (error.message?.includes("NOT_FOUND")) {
      return { error: { code: "NOT_FOUND", message: "Poll not found." } };
    }
    return { error: { code: "VOTE_FAILED", message: "Could not record your vote." } };
  }

  return { success: true };
}

export type PollResultOption = {
  optionId: number;
  optionText: string;
  voteCount: number;
  votedByMe: boolean;
};

export async function getPollResults(
  pollId: number,
): Promise<{ options: PollResultOption[] } | { error: ActionError }> {
  try {
    await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const parsed = getPollResultsSchema.safeParse({ pollId });
  if (!parsed.success) return { error: { code: "VALIDATION_ERROR", message: "Invalid request." } };

  type ResultRow = { option_id: number; option_text: string; vote_count: number; voted_by_me: boolean };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_poll_results", { p_poll_id: parsed.data.pollId });
  if (error) {
    if (error.message?.includes("NOT_AUTHORIZED")) {
      return { error: { code: "NOT_AUTHORIZED", message: "You are not a member of this group." } };
    }
    if (error.message?.includes("NOT_FOUND")) {
      return { error: { code: "NOT_FOUND", message: "Poll not found." } };
    }
    return { error: { code: "FETCH_FAILED", message: "Could not load poll results." } };
  }

  const rows = (data ?? []) as ResultRow[];
  const options: PollResultOption[] = rows.map((r) => ({
    optionId: r.option_id,
    optionText: r.option_text,
    voteCount: r.vote_count,
    votedByMe: r.voted_by_me,
  }));
  return { options };
}
