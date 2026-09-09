import { z } from "zod";

const userId = z.string().uuid("Invalid user id");

export const approveMemberSchema = z.object({
  userId,
});
export type ApproveMemberInput = z.infer<typeof approveMemberSchema>;

export const rejectMemberSchema = z.object({
  userId,
  reason: z.string().trim().max(500).optional(),
});
export type RejectMemberInput = z.infer<typeof rejectMemberSchema>;

export const suspendMemberSchema = z.object({
  userId,
  reason: z.string().trim().min(1, "A reason is required").max(500),
});
export type SuspendMemberInput = z.infer<typeof suspendMemberSchema>;

export const reinstateMemberSchema = z.object({
  userId,
});
export type ReinstateMemberInput = z.infer<typeof reinstateMemberSchema>;

export const updateOwnProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required")
    .max(50, "Display name must be at most 50 characters"),
  bio: z
    .string()
    .trim()
    .max(280, "Bio must be at most 280 characters")
    .optional()
    .or(z.literal("")),
});
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>;
