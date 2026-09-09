"use client";

import { useActionState } from "react";
import { assignPosition } from "@/app/actions/positions";
import { initialActionState } from "@/app/actions/types";
import type { EligibleUser } from "@/app/actions/positions";

// Select-from-eligible-users only — no free-text name field, per the
// platform's "select, don't type" principle. Options come from
// listEligibleReplacements, which re-derives role_rank/active-holder state
// from the DB, so nothing here needs to (or should) re-validate eligibility.
export function AssignHolderForm({
  positionId,
  eligibleUsers,
}: {
  positionId: number;
  eligibleUsers: EligibleUser[];
}) {
  const [state, formAction, isPending] = useActionState(assignPosition, initialActionState);

  if (eligibleUsers.length === 0) {
    return (
      <p className="text-sm text-black/60 dark:text-white/60">
        No eligible members to assign right now.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="positionId" value={positionId} />
      <select
        name="userId"
        required
        defaultValue=""
        className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
      >
        <option value="" disabled>
          Select a member…
        </option>
        {eligibleUsers.map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName} (@{user.username} — {user.roleName})
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? "Assigning…" : "Assign"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
      {state.success && <p className="text-sm text-emerald-600">Assigned.</p>}
    </form>
  );
}
