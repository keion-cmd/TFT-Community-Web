"use client";

import { useActionState } from "react";
import { addGroupResource, removeGroupResource } from "@/app/actions/groupOverview";
import { initialActionState } from "@/app/actions/types";
import type { GroupOverviewResource } from "@/app/actions/groupOverview";

function AddResourceForm({ groupId }: { groupId: number }) {
  const [state, formAction, isPending] = useActionState(addGroupResource, initialActionState);

  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="groupId" value={groupId} />
      <input
        type="text"
        name="title"
        required
        maxLength={200}
        placeholder="Title"
        className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
      />
      <input
        type="url"
        name="url"
        required
        maxLength={2000}
        placeholder="https://…"
        className="min-w-0 flex-1 rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
      />
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {isPending ? "Adding…" : "Add"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
    </form>
  );
}

function RemoveResourceForm({ resourceId }: { resourceId: number }) {
  const [state, formAction, isPending] = useActionState(removeGroupResource, initialActionState);

  return (
    <form action={formAction}>
      <input type="hidden" name="resourceId" value={resourceId} />
      <button
        type="submit"
        disabled={isPending}
        className="text-xs text-red-600 hover:underline disabled:opacity-50"
      >
        {isPending ? "Removing…" : "Remove"}
      </button>
      {state.error && <p className="text-xs text-red-600">{state.error.message}</p>}
    </form>
  );
}

export function ResourcesPanel({
  groupId,
  resources,
  currentUserId,
  canModerate,
}: {
  groupId: number;
  resources: GroupOverviewResource[];
  currentUserId: string;
  canModerate: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {resources.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No resources added yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {resources.map((r) => {
            const canRemove = canModerate || r.addedBy === currentUserId;
            return (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]"
              >
                <div>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
                      {r.title}
                    </a>
                  ) : (
                    <span className="font-medium">{r.title}</span>
                  )}
                  <p className="text-xs text-black/50 dark:text-white/50">
                    Added by {r.addedByProfile?.displayName ?? "Unknown member"}
                  </p>
                </div>
                {canRemove && <RemoveResourceForm resourceId={r.id} />}
              </li>
            );
          })}
        </ul>
      )}

      {canModerate && <AddResourceForm groupId={groupId} />}
    </div>
  );
}
