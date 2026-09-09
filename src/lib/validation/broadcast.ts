import { z } from "zod";

// broadcasts.id / broadcast_targets.id / groups.id are bigint identity
// columns; PostgREST serializes them as JSON numbers. Server Actions here
// are called directly (not via <form> FormData), so z.coerce is a guard
// against a stray string, same rationale as messaging.ts.
const groupId = z.coerce.number().int().positive("Invalid group");
const broadcastTargetId = z.coerce.number().int().positive("Invalid target");
const broadcastId = z.coerce.number().int().positive("Invalid broadcast");

const broadcastMessage = z
  .string()
  .trim()
  .min(1, "Message cannot be empty")
  .max(4000, "Message must be at most 4000 characters");

// No file upload for broadcasts (V1) — text/link only, same deferral as
// messaging/resources. Empty string from an untouched form field is
// normalized to undefined by the caller before hitting the RPC.
const attachmentUrl = z
  .string()
  .trim()
  .url("Must be a valid URL")
  .max(2000, "URL is too long")
  .optional()
  .or(z.literal(""));

const targetGroupIds = z.array(groupId).min(1, "Select at least one group");

// Client-generated (crypto.randomUUID()), per send_broadcast's
// idempotency_key column.
const idempotencyKey = z.string().uuid("Invalid request");

export const previewBroadcastSchema = z.object({
  message: broadcastMessage,
  attachmentUrl,
  targetGroupIds,
});
export type PreviewBroadcastInput = z.infer<typeof previewBroadcastSchema>;

export const sendBroadcastSchema = z.object({
  message: broadcastMessage,
  attachmentUrl,
  targetGroupIds,
  idempotencyKey,
});
export type SendBroadcastInput = z.infer<typeof sendBroadcastSchema>;

export const retryBroadcastTargetSchema = z.object({ broadcastTargetId });
export type RetryBroadcastTargetInput = z.infer<typeof retryBroadcastTargetSchema>;

export const listBroadcastHistorySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(20),
  beforeId: broadcastId.optional(),
});
export type ListBroadcastHistoryInput = z.infer<typeof listBroadcastHistorySchema>;
