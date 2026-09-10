import { z } from "zod";

// Same z.coerce rationale as src/lib/validation/messaging.ts — bigint
// identity columns serialize as JSON numbers.
const groupId = z.coerce.number().int().positive("Invalid group");
const checklistId = z.coerce.number().int().positive("Invalid checklist");
const itemId = z.coerce.number().int().positive("Invalid checklist item");

const checklistTitle = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(200, "Title must be at most 200 characters");

const checklistItemText = z
  .string()
  .trim()
  .min(1, "Item text is required")
  .max(500, "Item must be at most 500 characters");

export const createChecklistSchema = z.object({
  groupId,
  title: checklistTitle,
  items: z.array(checklistItemText).min(1, "A checklist needs at least 1 item").max(100, "A checklist can have at most 100 items"),
});
export type CreateChecklistInput = z.infer<typeof createChecklistSchema>;

export const toggleChecklistItemSchema = z.object({ itemId });
export type ToggleChecklistItemInput = z.infer<typeof toggleChecklistItemSchema>;

export const getChecklistSchema = z.object({ checklistId });
export type GetChecklistInput = z.infer<typeof getChecklistSchema>;
