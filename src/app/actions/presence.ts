"use server";

import { createClient } from "@/lib/supabase/server";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import { actionError, type ActionState } from "./types";

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionState> = {
  NOT_AUTHENTICATED: actionError("NOT_AUTHENTICATED", "You must be signed in."),
  ACCOUNT_NOT_ACTIVE: actionError("ACCOUNT_NOT_ACTIVE", "Your account is not active."),
  INSUFFICIENT_RANK: actionError("INSUFFICIENT_RANK", "You do not have permission to do this."),
};

// touch_last_seen() is self-only (0013_presence_typing.sql): a call for any
// id other than the caller's own just updates zero rows. Callers should
// therefore only ever pass the current user's own id (see
// PresenceProvider.tsx's mount/visibility-change self-touch).
export async function touchLastSeen(userId: string): Promise<{ success: true } | { error: ActionState["error"] }> {
  try {
    await requireActiveUser();
  } catch (err) {
    if (err instanceof AuthorizationError) return { error: AUTHZ_MESSAGES[err.code].error };
    return { error: { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." } };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("touch_last_seen", { p_user_id: userId });
  if (error) return { error: { code: "UNKNOWN_ERROR", message: "Could not update last seen." } };
  return { success: true };
}
