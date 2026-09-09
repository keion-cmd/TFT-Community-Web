import { z } from "zod";

// groups.id / messages.id / message_attachments.id are bigint identity
// columns; PostgREST serializes them as JSON numbers. Client-invoked Server
// Actions here are called with plain JS values (not FormData), so no
// z.coerce is needed the way positions.ts needs it for <form> fields — but
// coercion is harmless and guards against a stray string slipping through.
const groupId = z.coerce.number().int().positive("Invalid group");
const messageId = z.coerce.number().int().positive("Invalid message");
const userId = z.string().uuid("Invalid user id");

const groupName = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters");
const groupDescription = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters")
  .optional()
  .or(z.literal(""));
// Mirrors the `groups.type` check constraint in supabase/migrations/0001_init.sql.
const groupType = z.enum(["public", "staff_only", "admin_only", "private", "broadcast"]);

const messageContent = z
  .string()
  .trim()
  .min(1, "Message cannot be empty")
  .max(4000, "Message must be at most 4000 characters");

const emoji = z
  .string()
  .trim()
  .min(1, "Reaction is required")
  .max(16, "Not a valid reaction");

const attachment = z.object({
  storagePath: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  sizeBytes: z.coerce.number().int().nonnegative(),
});

// sendMessage's target is XOR by construction (a discriminated union), same
// invariant the messages table's check constraint enforces at the DB layer.
const messageTarget = z.union([
  z.object({ groupId }),
  z.object({ recipientId: userId }),
]);

export const createGroupSchema = z.object({
  name: groupName,
  type: groupType,
  description: groupDescription,
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const joinGroupSchema = z.object({ groupId });
export type JoinGroupInput = z.infer<typeof joinGroupSchema>;

export const sendMessageSchema = z.object({
  target: messageTarget,
  content: messageContent,
  attachments: z.array(attachment).max(10).optional(),
  replyToId: messageId.optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({
  messageId,
  content: messageContent,
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

export const deleteMessageSchema = z.object({ messageId });
export type DeleteMessageInput = z.infer<typeof deleteMessageSchema>;

export const reactToMessageSchema = z.object({ messageId, emoji });
export type ReactToMessageInput = z.infer<typeof reactToMessageSchema>;

export const removeReactionSchema = z.object({ messageId, emoji });
export type RemoveReactionInput = z.infer<typeof removeReactionSchema>;

const readTarget = z.union([
  z.object({ groupId }),
  z.object({ recipientId: userId }),
  z.object({ messageId }),
]);
export const markReadSchema = z.object({ target: readTarget });
export type MarkReadInput = z.infer<typeof markReadSchema>;

export const muteMemberSchema = z.object({
  groupId,
  userId,
  until: z.string().datetime().optional(), // omitted/undefined = unmute (muted_until = null)
});
export type MuteMemberInput = z.infer<typeof muteMemberSchema>;

export const removeMemberSchema = z.object({ groupId, userId });
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

export const listMessagesSchema = z.object({
  target: messageTarget,
  limit: z.coerce.number().int().positive().max(200).default(100),
});
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
