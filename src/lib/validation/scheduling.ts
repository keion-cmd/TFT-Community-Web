import { z } from "zod";

// schedules.id is a bigint identity column; PostgREST serializes it as a
// JSON number, form fields arrive as strings — same z.coerce rationale as
// src/lib/validation/positions.ts / groupOverview.ts.
const scheduleId = z.coerce.number().int().positive("Invalid schedule");
const userId = z.string().uuid("Invalid user id");

// positions.id / groups.id — optional on create (schedules.position_id and
// .group_id are both nullable columns). Empty-string form values (an
// unselected <select>) coerce to undefined via the literal("") branch, same
// pattern as groupOverview.ts's `location`.
const optionalPositionId = z.coerce
  .number()
  .int()
  .positive("Invalid position")
  .optional()
  .or(z.literal("").transform(() => undefined));
const optionalGroupId = z.coerce
  .number()
  .int()
  .positive("Invalid group")
  .optional()
  .or(z.literal("").transform(() => undefined));

// date: schedules.date is a plain `date` column (no time/zone component).
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

// start_time/end_time are timestamptz — accept anything Date.parse can read
// (the create form submits `datetime-local` values, which Date.parse
// handles as local time) and let the DB store the resolved instant.
const dateTime = z
  .string()
  .min(1, "Required")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date/time");

const notes = z
  .string()
  .trim()
  .max(1000, "Notes must be at most 1000 characters")
  .optional()
  .or(z.literal("").transform(() => undefined));

const cancelReason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(500, "Reason must be at most 500 characters");

export const createScheduleSlotSchema = z
  .object({
    date: dateOnly,
    startTime: dateTime,
    endTime: dateTime,
    positionId: optionalPositionId,
    notes,
    groupId: optionalGroupId,
  })
  .refine((v) => Date.parse(v.endTime) > Date.parse(v.startTime), {
    message: "End time must be after start time",
    path: ["endTime"],
  });
export type CreateScheduleSlotInput = z.infer<typeof createScheduleSlotSchema>;

export const listSchedulesSchema = z
  .object({
    dateRangeStart: dateTime,
    dateRangeEnd: dateTime,
  })
  .refine((v) => Date.parse(v.dateRangeEnd) >= Date.parse(v.dateRangeStart), {
    message: "Range end must be on or after range start",
    path: ["dateRangeEnd"],
  });
export type ListSchedulesInput = z.infer<typeof listSchedulesSchema>;

export const claimScheduleSchema = z.object({ scheduleId });
export type ClaimScheduleInput = z.infer<typeof claimScheduleSchema>;

export const checkInScheduleSchema = z.object({ scheduleId });
export type CheckInScheduleInput = z.infer<typeof checkInScheduleSchema>;

export const releaseScheduleSchema = z.object({ scheduleId });
export type ReleaseScheduleInput = z.infer<typeof releaseScheduleSchema>;

export const cancelScheduleSchema = z.object({ scheduleId, reason: cancelReason });
export type CancelScheduleInput = z.infer<typeof cancelScheduleSchema>;

export const reassignScheduleSchema = z.object({ scheduleId, newUserId: userId });
export type ReassignScheduleInput = z.infer<typeof reassignScheduleSchema>;

export const listEligibleScheduleAssigneesSchema = z.object({ scheduleId });
export type ListEligibleScheduleAssigneesInput = z.infer<typeof listEligibleScheduleAssigneesSchema>;
