"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveExitItem } from "@/app/actions/staffExit";

type EligibleUser = { userId: string; username: string; displayName: string };

type Props = {
  itemType: "position" | "schedule" | "group_coordinator";
  itemId: number;
  label: string;
  eligibleUsers: EligibleUser[];
};

export function StaffExitItemRow({ itemType, itemId, label, eligibleUsers }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resolution, setResolution] = useState<"reassign" | "vacate" | "already_resolved">(
    "already_resolved",
  );
  const [targetUserId, setTargetUserId] = useState(eligibleUsers[0]?.userId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function handleResolve() {
    setError(null);
    if (resolution === "reassign" && !targetUserId) {
      setError("Select a member to reassign to.");
      return;
    }
    if (
      !window.confirm(
        resolution === "vacate"
          ? `Vacate this item? "${label}" will be released with no one assigned.`
          : resolution === "reassign"
            ? `Reassign "${label}" to the selected member?`
            : `Mark "${label}" as already resolved?`,
      )
    ) {
      return;
    }

    startTransition(async () => {
      const result = await resolveExitItem(
        itemType,
        itemId,
        resolution,
        resolution === "reassign" ? targetUserId : undefined,
      );
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setDone(true);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-black/[.08] dark:border-white/[.145] p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium">{label}</p>
      {done ? (
        <p className="text-sm text-emerald-600">Resolved.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={resolution}
            onChange={(event) => setResolution(event.target.value as typeof resolution)}
            className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-2 py-1 text-sm"
          >
            <option value="reassign">Reassign to…</option>
            <option value="vacate">Vacate</option>
            <option value="already_resolved">Already resolved</option>
          </select>
          {resolution === "reassign" && (
            <select
              value={targetUserId}
              onChange={(event) => setTargetUserId(event.target.value)}
              className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-2 py-1 text-sm"
            >
              {eligibleUsers.length === 0 && <option value="">No eligible members</option>}
              {eligibleUsers.map((user) => (
                <option key={user.userId} value={user.userId}>
                  {user.displayName} (@{user.username})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={handleResolve}
            disabled={isPending}
            className="rounded bg-black/[.08] px-3 py-1.5 text-sm font-medium hover:bg-black/[.12] disabled:opacity-50 dark:bg-white/[.1] dark:hover:bg-white/[.15]"
          >
            {isPending ? "Working…" : "Apply"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </li>
  );
}
