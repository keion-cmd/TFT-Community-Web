import { z } from "zod";

// Same z.coerce rationale as src/lib/validation/messaging.ts — bigint
// identity columns serialize as JSON numbers.
const quickReplyId = z.coerce.number().int().positive("Invalid quick reply");

const shortcut = z
  .string()
  .trim()
  .min(1, "Shortcut is required")
  .max(50, "Shortcut must be at most 50 characters");

const content = z
  .string()
  .trim()
  .min(1, "Content is required")
  .max(2000, "Content must be at most 2000 characters");

export const createQuickReplySchema = z.object({ shortcut, content });
export type CreateQuickReplyInput = z.infer<typeof createQuickReplySchema>;

export const updateQuickReplySchema = z
  .object({
    quickReplyId,
    shortcut: shortcut.optional(),
    content: content.optional(),
  })
  .refine((data) => data.shortcut !== undefined || data.content !== undefined, {
    message: "Nothing to update",
  });
export type UpdateQuickReplyInput = z.infer<typeof updateQuickReplySchema>;

export const deleteQuickReplySchema = z.object({ quickReplyId });
export type DeleteQuickReplyInput = z.infer<typeof deleteQuickReplySchema>;
