// Scheduling display constants. Lives outside app/actions/scheduling.ts
// because a "use server" file may only export async functions — see
// src/lib/messaging/constants.ts for the same rationale.

// Matches schedules.status's check constraint (supabase/migrations/0001_init.sql).
export type ScheduleStatus =
  | "available"
  | "claimed"
  | "checked_in"
  | "active"
  | "completed"
  | "cancelled"
  | "missed"
  | "released";

export const STATUS_LABELS: Record<ScheduleStatus, string> = {
  available: "Available",
  claimed: "Claimed",
  checked_in: "Checked in",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
  missed: "Missed",
  released: "Released",
};

// Tailwind badge classes per status, same "rounded-full ... px-2 py-0.5
// text-xs font-medium" shape used elsewhere (e.g. CoordinatorPanel.tsx).
export const STATUS_BADGE_CLASSES: Record<ScheduleStatus, string> = {
  available: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  claimed: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  checked_in: "bg-blue-600/10 text-blue-700 dark:text-blue-400",
  active: "bg-blue-600/10 text-blue-700 dark:text-blue-400",
  completed: "bg-black/[.06] text-black/60 dark:bg-white/[.1] dark:text-white/60",
  cancelled: "bg-red-600/10 text-red-700 dark:text-red-400",
  missed: "bg-red-600/10 text-red-700 dark:text-red-400",
  released: "bg-black/[.06] text-black/60 dark:bg-white/[.1] dark:text-white/60",
};

// Check-in window: not spec'd with an exact value beyond "within window" (see
// Phase 2 flow #1 fallback content in this task), so this picks a concrete
// lower bound rather than leaving the control unconditionally visible. No
// explicit upper bound is computed here — schedule_settings (the source of
// truth for that, via missed_threshold_minutes) is admin-only under RLS, so
// a plain member's session client can't read it; instead the upper bound is
// enforced structurally by detect_missed_schedules flipping the row's status
// away from 'claimed' once that threshold passes, which alone is enough to
// hide the Check In control (only shown for status === 'claimed').
export const CHECK_IN_WINDOW_BEFORE_MINUTES = 15;
