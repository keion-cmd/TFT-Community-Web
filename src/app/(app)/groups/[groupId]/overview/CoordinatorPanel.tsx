"use client";

import { useActionState, useState } from "react";
import { assignGroupCoordinator, removeGroupCoordinator } from "@/app/actions/groupOverview";
import { initialActionState } from "@/app/actions/types";
import type { EligibleCoordinator } from "@/app/actions/groupOverview";

type Coordinator = { userId: string; username: string; displayName: string } | null;

function AssignForm({ groupId, eligibleCoordinators }: { groupId: number; eligibleCoordinators: EligibleCoordinator[] }) {
  const [state, formAction, isPending] = useActionState(assignGroupCoordinator, initialActionState);
  const [selection, setSelection] = useState("");

  const options = eligibleCoordinators.flatMap((c) =>
    c.positions.map((p) => ({
      value: `${c.userId}::${p.positionId}`,
      label: `${c.displayName} (@${c.username}) — ${p.positionName}`,
    })),
  );

  if (options.length === 0) {
    return (
      <p className="text-sm text-black/60 dark:text-white/60">
        No group members currently hold a qualifying position.
      </p>
    );
  }

  const [selectedUserId, selectedPositionId] = selection.split("::");

  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="userId" value={selectedUserId ?? ""} />
      <input type="hidden" name="positionId" value={selectedPositionId ?? ""} />
      <select
        value={selection}
        onChange={(e) => setSelection(e.target.value)}
        required
        className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
      >
        <option value="" disabled>
          Select a member — position…
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={isPending || !selection}
        className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {isPending ? "Assigning…" : "Assign Coordinator"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
      {state.success && <p className="text-sm text-emerald-600">Assigned.</p>}
    </form>
  );
}

function RemoveForm({ groupId }: { groupId: number }) {
  const [state, formAction, isPending] = useActionState(removeGroupCoordinator, initialActionState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="groupId" value={groupId} />
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
      >
        {isPending ? "Removing…" : "Remove Coordinator"}
      </button>
      {state.error && <span className="text-xs text-red-600">{state.error.message}</span>}
    </form>
  );
}

export function CoordinatorPanel({
  groupId,
  coordinator,
  isAdmin,
  eligibleCoordinators,
}: {
  groupId: number;
  coordinator: Coordinator;
  isAdmin: boolean;
  eligibleCoordinators: EligibleCoordinator[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {coordinator ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]">
          <span>
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium">Coordinator</span>{" "}
            {coordinator.displayName} <span className="text-black/50 dark:text-white/50">@{coordinator.username}</span>
          </span>
          {isAdmin && <RemoveForm groupId={groupId} />}
        </div>
      ) : (
        <p className="text-sm text-black/60 dark:text-white/60">This group has no coordinator yet.</p>
      )}

      {isAdmin && <AssignForm groupId={groupId} eligibleCoordinators={eligibleCoordinators} />}
    </div>
  );
}
