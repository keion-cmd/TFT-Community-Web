import { z } from "zod";

// Same z.coerce rationale as src/lib/validation/messaging.ts and
// src/lib/validation/positions.ts — bigint identity columns serialize as JSON
// numbers, form fields arrive as strings; coercion is harmless either way.
const groupId = z.coerce.number().int().positive("Invalid group");
const messageId = z.coerce.number().int().positive("Invalid message");
const resourceId = z.coerce.number().int().positive("Invalid resource");
const scheduleId = z.coerce.number().int().positive("Invalid schedule");
const positionId = z.coerce.number().int().positive("Invalid position");
const userId = z.string().uuid("Invalid user id");

// Empty string clears the location (matches groups.location's nullable text
// column) — not a "required field" the way most other free-text inputs are.
const location = z
  .string()
  .trim()
  .max(200, "Location must be at most 200 characters")
  .optional()
  .or(z.literal(""));

const resourceTitle = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(200, "Title must be at most 200 characters");

// Link/text only for this task (no file upload — group_resources.storage_path
// is deferred, same as T-CODE-08's attachment-upload deferral), so url is
// required here rather than the table's own `url is not null or storage_path
// is not null` either/or.
const resourceUrl = z
  .string()
  .trim()
  .url("Enter a valid URL")
  .max(2000, "URL must be at most 2000 characters");

export const getGroupOverviewSchema = z.object({ groupId });
export type GetGroupOverviewInput = z.infer<typeof getGroupOverviewSchema>;

export const assignGroupCoordinatorSchema = z.object({ groupId, userId, positionId });
export type AssignGroupCoordinatorInput = z.infer<typeof assignGroupCoordinatorSchema>;

export const removeGroupCoordinatorSchema = z.object({ groupId });
export type RemoveGroupCoordinatorInput = z.infer<typeof removeGroupCoordinatorSchema>;

export const updateGroupLocationSchema = z.object({ groupId, location });
export type UpdateGroupLocationInput = z.infer<typeof updateGroupLocationSchema>;

export const pinMessageSchema = z.object({ groupId, messageId });
export type PinMessageInput = z.infer<typeof pinMessageSchema>;

export const unpinMessageSchema = z.object({ groupId });
export type UnpinMessageInput = z.infer<typeof unpinMessageSchema>;

export const addGroupResourceSchema = z.object({
  groupId,
  title: resourceTitle,
  url: resourceUrl,
});
export type AddGroupResourceInput = z.infer<typeof addGroupResourceSchema>;

export const removeGroupResourceSchema = z.object({ resourceId });
export type RemoveGroupResourceInput = z.infer<typeof removeGroupResourceSchema>;

export const linkScheduleToGroupSchema = z.object({ scheduleId, groupId });
export type LinkScheduleToGroupInput = z.infer<typeof linkScheduleToGroupSchema>;

export const listEligibleCoordinatorsSchema = z.object({ groupId });
export type ListEligibleCoordinatorsInput = z.infer<typeof listEligibleCoordinatorsSchema>;
