import { z } from "zod";

const groupId = z.coerce.number().int().positive("Invalid group");
const pollId = z.coerce.number().int().positive("Invalid poll");
const optionId = z.coerce.number().int().positive("Invalid option");

const pollQuestion = z
  .string()
  .trim()
  .min(1, "Question is required")
  .max(500, "Question must be at most 500 characters");

const pollOptionText = z
  .string()
  .trim()
  .min(1, "Option text is required")
  .max(200, "Option must be at most 200 characters");

export const createPollSchema = z.object({
  groupId,
  question: pollQuestion,
  options: z.array(pollOptionText).min(2, "A poll needs at least 2 options").max(20, "A poll can have at most 20 options"),
  allowMultiple: z.boolean().default(false),
  closesAt: z.string().datetime().optional(),
});
export type CreatePollInput = z.infer<typeof createPollSchema>;

export const votePollSchema = z.object({
  pollId,
  optionIds: z.array(optionId).min(1, "Choose at least one option").max(20),
});
export type VotePollInput = z.infer<typeof votePollSchema>;

export const getPollResultsSchema = z.object({ pollId });
export type GetPollResultsInput = z.infer<typeof getPollResultsSchema>;
