import { z } from "zod";

const userId = z.string().uuid("Invalid user id");
// roles.id is a smallint referencing the fixed role ladder (Member..Super Admin).
const newRoleId = z.coerce.number().int().positive("Select a role");

export const changeRoleSchema = z.object({
  userId,
  newRoleId,
  reason: z.string().trim().min(1, "A reason is required").max(500, "Reason must be at most 500 characters"),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const listRoleHistorySchema = z.object({ userId });
export type ListRoleHistoryInput = z.infer<typeof listRoleHistorySchema>;
