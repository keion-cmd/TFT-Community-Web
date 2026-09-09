"use client";

import { useActionState, useEffect, useState } from "react";
import { updateGroupLocation } from "@/app/actions/groupOverview";
import { initialActionState } from "@/app/actions/types";

export function LocationPanel({
  groupId,
  location,
  canEdit,
}: {
  groupId: number;
  location: string | null;
  canEdit: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateGroupLocation, initialActionState);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (state.success) setIsEditing(false);
  }, [state.success]);

  if (!canEdit) {
    return (
      <p className="text-sm text-black/60 dark:text-white/60">{location ?? "No location set."}</p>
    );
  }

  if (!isEditing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-black/60 dark:text-white/60">{location ?? "No location set."}</p>
        <button type="button" onClick={() => setIsEditing(true)} className="text-xs underline underline-offset-4">
          Edit
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="groupId" value={groupId} />
      <input
        type="text"
        name="location"
        defaultValue={location ?? ""}
        maxLength={200}
        placeholder="e.g. Building 4, Room 210"
        className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
      />
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      <button type="button" onClick={() => setIsEditing(false)} className="text-xs underline underline-offset-4">
        Cancel
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
    </form>
  );
}
