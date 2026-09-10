import { z } from "zod";

// Same z.coerce rationale as src/lib/validation/messaging.ts — bigint
// identity columns serialize as JSON numbers.
const groupId = z.coerce.number().int().positive("Invalid group");
const topicId = z.coerce.number().int().positive("Invalid topic");

const topicName = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters");

export const createTopicSchema = z.object({ groupId, name: topicName });
export type CreateTopicInput = z.infer<typeof createTopicSchema>;

export const archiveTopicSchema = z.object({ topicId });
export type ArchiveTopicInput = z.infer<typeof archiveTopicSchema>;

export const listTopicsSchema = z.object({ groupId });
export type ListTopicsInput = z.infer<typeof listTopicsSchema>;
