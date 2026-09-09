import { z } from "zod";

const userId = z.string().uuid("Invalid user id");

export const getStaffExitChecklistSchema = z.object({ userId });
export type GetStaffExitChecklistInput = z.infer<typeof getStaffExitChecklistSchema>;

export const exitItemTypeSchema = z.enum([
  "position",
  "schedule",
  "group_coordinator",
]);
export type ExitItemType = z.infer<typeof exitItemTypeSchema>;

export const exitResolutionSchema = z.enum(["reassign", "vacate", "already_resolved"]);
export type ExitResolution = z.infer<typeof exitResolutionSchema>;

export const resolveExitItemSchema = z.object({
  itemType: exitItemTypeSchema,
  itemId: z.coerce.number().int().positive("Invalid item"),
  resolution: exitResolutionSchema,
  targetUserId: userId.optional(),
});
export type ResolveExitItemInput = z.infer<typeof resolveExitItemSchema>;

export const finalizeStaffExitSchema = z.object({
  userId,
  suspend: z.boolean().default(false),
});
export type FinalizeStaffExitInput = z.infer<typeof finalizeStaffExitSchema>;
