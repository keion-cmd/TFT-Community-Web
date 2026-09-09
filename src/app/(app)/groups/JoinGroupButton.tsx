"use client";

import { useActionState } from "react";
import { joinGroup } from "@/app/actions/messaging";
import { initialActionState } from "@/app/actions/types";

export function JoinGroupButton({ groupId }: { groupId: number }) {
  const [state, formAction, isPending] = useActionState(joinGroup, initialActionState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="groupId" value={groupId} />
      <button
        type="submit"
        disabled={isPending || state.success}
        className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
      >
        {isPending ? "Joining…" : state.success ? "Joined" : "Join"}
      </button>
      {state.error && <p className="text-xs text-red-600">{state.error.message}</p>}
    </form>
  );
}
