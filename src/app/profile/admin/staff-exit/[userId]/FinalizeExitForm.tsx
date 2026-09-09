"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { finalizeStaffExit } from "@/app/actions/staffExit";

type Props = { userId: string; username: string; disabled: boolean };

export function FinalizeExitForm({ userId, username, disabled }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [suspend, setSuspend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFinalize() {
    setError(null);
    const ok = window.confirm(
      suspend
        ? `Finalize ${username}'s staff exit and suspend their account? This revokes their sessions immediately.`
        : `Finalize ${username}'s staff exit? Their positions/schedules/coordinator seats must already be resolved.`,
    );
    if (!ok) return;

    startTransition(async () => {
      const result = await finalizeStaffExit(userId, suspend);
      if (result.error) {
        setError(result.error.message);
        return;
      }
      router.push("/profile/admin");
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-black/[.08] dark:border-white/[.145] p-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={suspend} onChange={(event) => setSuspend(event.target.checked)} />
        Also suspend this member&apos;s account
      </label>
      <button
        type="button"
        onClick={handleFinalize}
        disabled={disabled || isPending}
        className="w-fit rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
      >
        {isPending ? "Finalizing…" : "Finalize Staff Exit"}
      </button>
      {disabled && (
        <p className="text-sm text-black/60 dark:text-white/60">
          Resolve every position, schedule, and coordinator seat below before finalizing.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
