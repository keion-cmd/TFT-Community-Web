"use client";

import { useActionState, useEffect, useRef } from "react";
import { createScheduleSlot } from "@/app/actions/scheduling";
import { initialActionState } from "@/app/actions/types";

type Position = { id: number; name: string };

// groupId is accepted by createScheduleSlot per the API spec (a slot can
// optionally belong to a group), but this form — the standalone Schedule
// tab's admin entry point — doesn't expose that field. Group-scoped
// linking already has its own surface (linkScheduleToGroup, T-CODE-10's
// Group Overview page), so this form intentionally stays group-agnostic
// rather than duplicating that control here.
export function CreateSlotForm({
  positions,
  onCreated,
}: {
  positions: Position[];
  onCreated: () => void;
}) {
  const [state, formAction, isPending] = useActionState(createScheduleSlot, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const hasNotifiedRef = useRef(false);

  useEffect(() => {
    if (state.success && !hasNotifiedRef.current) {
      hasNotifiedRef.current = true;
      formRef.current?.reset();
      onCreated();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.success]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-black/[.08] p-5 dark:border-white/[.145]"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="slot-date" className="text-sm font-medium">
            Date
          </label>
          <input
            id="slot-date"
            name="date"
            type="date"
            required
            className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="slot-position" className="text-sm font-medium">
            Position (optional)
          </label>
          <select
            id="slot-position"
            name="positionId"
            defaultValue=""
            className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
          >
            <option value="">Any / no restriction</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="slot-start" className="text-sm font-medium">
            Start time
          </label>
          <input
            id="slot-start"
            name="startTime"
            type="datetime-local"
            required
            className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="slot-end" className="text-sm font-medium">
            End time
          </label>
          <input
            id="slot-end"
            name="endTime"
            type="datetime-local"
            required
            className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="slot-notes" className="text-sm font-medium">
          Notes
        </label>
        <textarea
          id="slot-notes"
          name="notes"
          rows={2}
          maxLength={1000}
          className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {isPending ? "Creating…" : "Create slot"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
    </form>
  );
}
