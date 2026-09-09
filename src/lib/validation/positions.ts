import { z } from "zod";

// positions.id / user_positions.id are bigint identity columns; PostgREST
// serializes them as JSON numbers, and form fields arrive as strings, so
// every id field coerces through z.coerce.number().
const positionId = z.coerce.number().int().positive("Invalid position");
const userPositionId = z.coerce.number().int().positive("Invalid position assignment");
const userId = z.string().uuid("Invalid user id");

const name = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters");
const description = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters")
  .optional()
  .or(z.literal(""));
// roles.id is a smallint referencing the fixed role ladder (Member..Super Admin).
const minRoleId = z.coerce.number().int().positive("Select a minimum role");
const isExclusive = z.boolean();

export const createPositionSchema = z.object({
  name,
  description,
  minRoleId,
  isExclusive,
});
export type CreatePositionInput = z.infer<typeof createPositionSchema>;

// Edit form always submits the full current state (no partial-patch
// semantics) — matches this codebase's existing profile-edit pattern.
export const updatePositionSchema = z.object({
  positionId,
  name,
  description,
  minRoleId,
  isExclusive,
});
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;

export const deactivatePositionSchema = z.object({
  positionId,
});
export type DeactivatePositionInput = z.infer<typeof deactivatePositionSchema>;

export const assignPositionSchema = z.object({
  userId,
  positionId,
});
export type AssignPositionInput = z.infer<typeof assignPositionSchema>;

export const revokePositionSchema = z.object({
  userPositionId,
  reason: z.string().trim().min(1, "A reason is required").max(500, "Reason must be at most 500 characters"),
});
export type RevokePositionInput = z.infer<typeof revokePositionSchema>;

export const listEligibleReplacementsSchema = z.object({
  positionId,
});
export type ListEligibleReplacementsInput = z.infer<typeof listEligibleReplacementsSchema>;
