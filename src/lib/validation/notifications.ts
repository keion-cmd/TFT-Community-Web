import { z } from "zod";

// notifications.id is a bigint identity column, same PostgREST-serializes-
// as-a-number situation as broadcasts/broadcast_targets (see
// lib/validation/broadcast.ts) — z.coerce guards a stray string since these
// actions are called directly, not via <form> FormData.
const notificationId = z.coerce.number().int().positive("Invalid notification");

export const listNotificationsSchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(20),
  beforeId: notificationId.optional(),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;

export const markNotificationReadSchema = z.object({ notificationId });
export type MarkNotificationReadInput = z.infer<typeof markNotificationReadSchema>;
