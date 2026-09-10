"use server";

// T-CODE-44 — fills the storage gap flagged in docs/messaging-audit.md §8.
// This action only prepares the upload: it validates the file, checks the
// caller is a member of the target conversation (group_members / DM pair,
// same check sendMessage itself makes), then hands back a Supabase Storage
// signed upload URL scoped to a conversation-prefixed object path. The
// client uploads directly to Storage with that URL — the file bytes never
// pass through this server. The resulting message_attachments row is only
// created once by sendMessage() in messaging.ts, after the message it
// belongs to exists (see the re-validation + existence check there);
// nothing here writes to message_attachments.

import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveUser, AuthorizationError } from "@/lib/auth/session";
import type { MessageTarget } from "./messaging";
import { dmPair } from "@/lib/messaging/constants";
import { actionError, type ActionState, type ActionError } from "./types";
import { ATTACHMENT_BUCKET, sanitizeFileNameForPath, validateAttachmentMeta } from "@/lib/messaging/attachments";

const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionState> = {
  NOT_AUTHENTICATED: actionError("NOT_AUTHENTICATED", "You must be signed in."),
  ACCOUNT_NOT_ACTIVE: actionError("ACCOUNT_NOT_ACTIVE", "Your account is not active."),
  INSUFFICIENT_RANK: actionError("INSUFFICIENT_RANK", "You do not have permission to do this."),
};

function fromAuthzError(err: unknown): ActionState {
  if (err instanceof AuthorizationError) return AUTHZ_MESSAGES[err.code];
  return actionError("UNKNOWN_ERROR", "Something went wrong. Please try again.");
}

export type AttachmentUploadTicket = {
  bucket: string;
  path: string;
  token: string;
  signedUrl: string;
};

export async function requestAttachmentUpload(
  target: MessageTarget,
  fileName: string,
  mimeType: string,
  sizeBytes: number,
  isSavedMessages = false,
): Promise<{ success: true; upload: AttachmentUploadTicket } | { error: ActionError }> {
  let profile;
  try {
    profile = await requireActiveUser();
  } catch (err) {
    const state = fromAuthzError(err);
    return { error: state.error as ActionError };
  }

  const validation = validateAttachmentMeta({ fileName, mimeType, sizeBytes });
  if (!validation.ok) {
    return { error: { code: "VALIDATION_ERROR", message: validation.message } };
  }

  const supabaseAdmin = createAdminClient();
  let prefix: string;

  if ("groupId" in target) {
    const groupId = target.groupId;
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return { error: { code: "VALIDATION_ERROR", message: "Invalid group." } };
    }
    const { data: membership } = await supabaseAdmin
      .from("group_members")
      .select("id")
      .eq("group_id", groupId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!membership) {
      return { error: { code: "NOT_A_MEMBER", message: "You are not a member of this group." } };
    }
    prefix = `group/${groupId}/`;
  } else {
    const recipientId = target.recipientId;
    if (recipientId === profile.id && !isSavedMessages) {
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
    prefix = `dm/${lo}/${hi}/`;
  }

  const path = `${prefix}${randomUUID()}-${sanitizeFileNameForPath(fileName)}`;

  // Uses the caller's own session (not the admin client) so the storage
  // RLS policy from 0012_message_attachments_storage.sql — the actual
  // authority here, the membership check above is just a fast, friendly
  // rejection — independently re-verifies conversation membership from
  // `path` before minting the signed URL.
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return { error: { code: "UPLOAD_URL_FAILED", message: "Could not prepare the upload. Please try again." } };
  }

  return {
    success: true,
    upload: { bucket: ATTACHMENT_BUCKET, path: data.path, token: data.token, signedUrl: data.signedUrl },
  };
}
