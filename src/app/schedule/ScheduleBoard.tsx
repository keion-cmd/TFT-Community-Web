"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  listSchedules,
  claimSchedule,
  checkIn,
  releaseSchedule,
  cancelSchedule,
  reassignSchedule,
  listEligibleScheduleAssignees,
  type ScheduleDTO,
  type EligibleScheduleAssignee,
} from "@/app/actions/scheduling";
import type { ActionError } from "@/app/actions/types";
import { STATUS_LABELS, STATUS_BADGE_CLASSES } from "@/lib/scheduling/constants";
import { CreateSlotForm } from "./CreateSlotForm";

type Position = { id: number; name: string };
type ActionResult = { success: true } | { error: ActionError };

function formatDateHeading(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ============================================================
// Confirm sheet for claiming — Phase 2 flow #1: shows slot date/time/
// position, confirms identity is the authenticated user (no name entry —
// there is no input for who is claiming, it's always the signed-in caller).
// ============================================================
function ClaimSheet({
  schedule,
  isPending,
  onConfirm,
  onDismiss,
}: {
  schedule: ScheduleDTO;
  isPending: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/[.1] bg-black/[.03] p-3 dark:border-white/[.15] dark:bg-white/[.05]">
      <p className="text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
        Confirm claim
      </p>
      <p>
        {formatDateHeading(schedule.date)}, {formatTime(schedule.startTime)} – {formatTime(schedule.endTime)}
      </p>
      {schedule.positionName && <p className="text-black/60 dark:text-white/60">{schedule.positionName}</p>}
      <p className="text-xs text-black/50 dark:text-white/50">
        You&apos;ll claim this slot under your own signed-in account.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={onConfirm}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {isPending ? "Claiming…" : "Claim"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-4 py-2 text-sm font-medium underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ReassignPanel({
  scheduleId,
  isPending,
  onSubmit,
  onDismiss,
}: {
  scheduleId: number;
  isPending: boolean;
  onSubmit: (userId: string) => void;
  onDismiss: () => void;
}) {
  const [users, setUsers] = useState<EligibleScheduleAssignee[] | null>(null);
  const [selection, setSelection] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listEligibleScheduleAssignees(scheduleId).then((result) => {
      if (cancelled) return;
      if ("users" in result) setUsers(result.users);
      else setLoadError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/[.1] bg-black/[.03] p-3 dark:border-white/[.15] dark:bg-white/[.05]">
      <p className="text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
        Reassign to
      </p>
      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {users === null ? (
        <p className="text-xs text-black/50 dark:text-white/50">Loading eligible members…</p>
      ) : users.length === 0 ? (
        <p className="text-xs text-black/50 dark:text-white/50">No eligible members for this slot.</p>
      ) : (
        <select
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
          className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
        >
          <option value="" disabled>
            Select a member…
          </option>
          {users.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.displayName} (@{u.username})
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={isPending || !selection}
          onClick={() => onSubmit(selection)}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {isPending ? "Reassigning…" : "Reassign"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-4 py-2 text-sm font-medium underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CancelPanel({
  isPending,
  onSubmit,
  onDismiss,
}: {
  isPending: boolean;
  onSubmit: (reason: string) => void;
  onDismiss: () => void;
}) {
  const [reason, setReason] = useState("");

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/[.1] bg-black/[.03] p-3 dark:border-white/[.15] dark:bg-white/[.05]">
      <p className="text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
        Cancel this slot
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        placeholder="Reason (required)"
        rows={2}
        className="rounded border border-black/[.1] bg-transparent px-2 py-1 text-sm dark:border-white/[.15]"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={isPending || !reason.trim()}
          onClick={() => {
            if (window.confirm("Cancel this slot? The assigned member (if any) will be notified.")) {
              onSubmit(reason.trim());
            }
          }}
          className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
        >
          {isPending ? "Cancelling…" : "Cancel slot"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-4 py-2 text-sm font-medium underline underline-offset-4"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function SlotCard({
  schedule,
  isAdmin,
  onChange,
}: {
  schedule: ScheduleDTO;
  isAdmin: boolean;
  onChange: () => void;
}) {
  const [openPanel, setOpenPanel] = useState<null | "claim" | "reassign" | "cancel">(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function runAction(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if ("error" in result) {
        setError(result.error.message);
      } else {
        setOpenPanel(null);
        onChange();
      }
    });
  }

  const canReassign = isAdmin && ["available", "claimed", "checked_in"].includes(schedule.status);
  const canCancel = isAdmin && schedule.status !== "cancelled";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {formatTime(schedule.startTime)} – {formatTime(schedule.endTime)}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[schedule.status]}`}>
          {STATUS_LABELS[schedule.status]}
        </span>
      </div>
      {schedule.positionName && <p className="text-black/60 dark:text-white/60">{schedule.positionName}</p>}
      {schedule.assignedUserDisplayName && (
        <p className="text-black/60 dark:text-white/60">
          Assigned: {schedule.assignedUserDisplayName}
          {schedule.isMine ? " (you)" : ""}
        </p>
      )}
      {schedule.notes && <p className="text-black/50 dark:text-white/50">{schedule.notes}</p>}
      {schedule.status === "cancelled" && schedule.cancelReason && (
        <p className="text-red-600">Cancelled: {schedule.cancelReason}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {schedule.canClaim && (
          <button
            type="button"
            onClick={() => setOpenPanel(openPanel === "claim" ? null : "claim")}
            className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background"
          >
            Claim
          </button>
        )}
        {schedule.canCheckIn && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => runAction(() => checkIn(schedule.id))}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {isPending ? "Checking in…" : "Check In"}
          </button>
        )}
        {schedule.canRelease && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              if (window.confirm("Release this slot back to available?")) {
                runAction(() => releaseSchedule(schedule.id));
              }
            }}
            className="rounded bg-black/[.06] px-3 py-1.5 text-xs font-medium hover:bg-black/[.1] disabled:opacity-50 dark:bg-white/[.1] dark:hover:bg-white/[.15]"
          >
            {isPending ? "Releasing…" : "Release"}
          </button>
        )}
        {canReassign && (
          <button
            type="button"
            onClick={() => setOpenPanel(openPanel === "reassign" ? null : "reassign")}
            className="rounded bg-black/[.06] px-3 py-1.5 text-xs font-medium hover:bg-black/[.1] dark:bg-white/[.1] dark:hover:bg-white/[.15]"
          >
            Reassign
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            onClick={() => setOpenPanel(openPanel === "cancel" ? null : "cancel")}
            className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
          >
            Cancel
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {openPanel === "claim" && (
        <ClaimSheet
          schedule={schedule}
          isPending={isPending}
          onConfirm={() => runAction(() => claimSchedule(schedule.id))}
          onDismiss={() => setOpenPanel(null)}
        />
      )}
      {openPanel === "reassign" && canReassign && (
        <ReassignPanel
          scheduleId={schedule.id}
          isPending={isPending}
          onSubmit={(userId) => runAction(() => reassignSchedule(schedule.id, userId))}
          onDismiss={() => setOpenPanel(null)}
        />
      )}
      {openPanel === "cancel" && canCancel && (
        <CancelPanel
          isPending={isPending}
          onSubmit={(reason) => runAction(() => cancelSchedule(schedule.id, reason))}
          onDismiss={() => setOpenPanel(null)}
        />
      )}
    </div>
  );
}

type Props = {
  currentUserId: string;
  isAdmin: boolean;
  positions: Position[];
  initialSchedules: ScheduleDTO[];
  initialRangeStart: string;
  initialRangeEnd: string;
};

export function ScheduleBoard({ isAdmin, positions, initialSchedules, initialRangeStart, initialRangeEnd }: Props) {
  const [schedules, setSchedules] = useState<ScheduleDTO[]>(initialSchedules);
  const [rangeStart, setRangeStart] = useState(initialRangeStart);
  const [rangeEnd, setRangeEnd] = useState(initialRangeEnd);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [showCreate, setShowCreate] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [globalError, setGlobalError] = useState<string | null>(null);

  function refetch(start = rangeStart, end = rangeEnd) {
    startTransition(async () => {
      const result = await listSchedules(start, end);
      if ("schedules" in result) {
        setSchedules(result.schedules);
        setGlobalError(null);
      } else {
        setGlobalError(result.error.message);
      }
    });
  }

  function shiftRange(days: number) {
    const newStart = new Date(rangeStart);
    newStart.setDate(newStart.getDate() + days);
    const newEnd = new Date(rangeEnd);
    newEnd.setDate(newEnd.getDate() + days);
    const startIso = newStart.toISOString();
    const endIso = newEnd.toISOString();
    setRangeStart(startIso);
    setRangeEnd(endIso);
    refetch(startIso, endIso);
  }

  const byDate = useMemo(() => {
    const map = new Map<string, ScheduleDTO[]>();
    for (const s of schedules) {
      const list = map.get(s.date) ?? [];
      list.push(s);
      map.set(s.date, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }, [schedules]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setView("list")}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              view === "list" ? "bg-foreground text-background" : "bg-black/[.06] dark:bg-white/[.1]"
            }`}
          >
            List
          </button>
          <button
            type="button"
            onClick={() => setView("calendar")}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              view === "calendar" ? "bg-foreground text-background" : "bg-black/[.06] dark:bg-white/[.1]"
            }`}
          >
            Calendar
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => shiftRange(-7)}
            className="rounded border border-black/[.1] px-2 py-1 text-sm dark:border-white/[.15]"
          >
            ← Prev week
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => refetch()}
            className="rounded border border-black/[.1] px-2 py-1 text-sm disabled:opacity-50 dark:border-white/[.15]"
          >
            {isPending ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => shiftRange(7)}
            className="rounded border border-black/[.1] px-2 py-1 text-sm dark:border-white/[.15]"
          >
            Next week →
          </button>
        </div>
      </div>

      {isAdmin && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="self-start rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            {showCreate ? "Close" : "+ Create Slot"}
          </button>
          {showCreate && (
            <CreateSlotForm
              positions={positions}
              onCreated={() => {
                setShowCreate(false);
                refetch();
              }}
            />
          )}
        </div>
      )}

      {globalError && <p className="text-sm text-red-600">{globalError}</p>}

      {byDate.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No schedule slots in this range.</p>
      ) : view === "list" ? (
        <div className="flex flex-col gap-6">
          {byDate.map(([date, slots]) => (
            <section key={date} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
                {formatDateHeading(date)}
              </h3>
              <div className="flex flex-col gap-2">
                {slots.map((s) => (
                  <SlotCard key={s.id} schedule={s} isAdmin={isAdmin} onChange={() => refetch()} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {byDate.map(([date, slots]) => (
            <section key={date} className="flex w-64 shrink-0 flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
                {formatDateHeading(date)}
              </h3>
              <div className="flex flex-col gap-2">
                {slots.map((s) => (
                  <SlotCard key={s.id} schedule={s} isAdmin={isAdmin} onChange={() => refetch()} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
