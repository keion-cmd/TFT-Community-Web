import { createAdminClient } from "@/lib/supabase/admin";

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

export type BroadcastRow = {
  id: number;
  sender_id: string;
  message: string;
  attachment_url: string | null;
};

export type BroadcastTargetRow = {
  id: number;
  broadcast_id: number;
  group_id: number;
};

// Delivers one broadcast_targets row: inserts the message into the target
// group using the service-role client. The triggering admin may not be an
// active member of every target group, and this is authorized system
// delivery on behalf of an already-verified admin action — same
// justification as detect_missed_schedules. Everything else about the
// broadcast flow (auth checks, fetching the broadcast) stays on the session
// client; only this cross-group write needs the service role.
// (broadcast_targets itself also has no client insert/update RLS policy —
// 0001_init.sql's own comment says those rows are written only through
// send_broadcast or trusted server code — so the status-transition writes
// below use the same admin client.)
//
// message_attachments has no url-only column (unlike group_resources) —
// storage_path/mime_type/size_bytes are all not-null, built for real
// uploads. Broadcast link attachments have no file, so the URL is appended
// to the message content as plain text instead of faking an attachment row.
async function deliverToTarget(
  supabaseAdmin: SupabaseAdmin,
  broadcast: BroadcastRow,
  target: BroadcastTargetRow,
): Promise<void> {
  const content = broadcast.attachment_url
    ? `${broadcast.message}\n\n${broadcast.attachment_url}`
    : broadcast.message;

  const { error: insertError } = await supabaseAdmin.from("messages").insert({
    group_id: target.group_id,
    sender_id: broadcast.sender_id,
    content,
  });
  if (insertError) {
    throw new Error(insertError.message);
  }
}

// Processes a batch of pending broadcast_targets rows for one broadcast.
// Each target is wrapped in its own try/catch so one failure never aborts
// the rest of the loop. Shared by sendBroadcast (all pending targets for a
// new broadcast) and retryBroadcastTarget (a single target reset to pending).
export async function processBroadcastTargets(
  supabaseAdmin: SupabaseAdmin,
  broadcast: BroadcastRow,
  targets: BroadcastTargetRow[],
): Promise<void> {
  for (const target of targets) {
    try {
      await deliverToTarget(supabaseAdmin, broadcast, target);
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "sent", sent_at: new Date().toISOString(), error: null })
        .eq("id", target.id);
    } catch (err) {
      await supabaseAdmin
        .from("broadcast_targets")
        .update({
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown delivery error",
        })
        .eq("id", target.id);
    }
  }
}
