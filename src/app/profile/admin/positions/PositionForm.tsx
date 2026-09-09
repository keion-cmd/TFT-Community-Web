"use client";

import { useActionState } from "react";
import { createPosition, updatePosition } from "@/app/actions/positions";
import { initialActionState } from "@/app/actions/types";

type Role = { id: number; name: string };

type Props = {
  roles: Role[];
  mode: "create" | "edit";
  position?: {
    id: number;
    name: string;
    description: string | null;
    minRoleId: number;
    isExclusive: boolean;
  };
};

// Edit mode always submits the full current state to updatePosition rather
// than a partial patch — same "whole form, no partial diffing" pattern as
// ProfileEditForm (T-CODE-04).
export function PositionForm({ roles, mode, position }: Props) {
  const action = mode === "edit" ? updatePosition : createPosition;
  const [state, formAction, isPending] = useActionState(action, initialActionState);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-black/[.08] dark:border-white/[.145] p-5"
    >
      {mode === "edit" && position && (
        <input type="hidden" name="positionId" value={position.id} />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`name-${mode}`} className="text-sm font-medium">
          Name
        </label>
        <input
          id={`name-${mode}`}
          name="name"
          defaultValue={position?.name}
          required
          maxLength={100}
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`description-${mode}`} className="text-sm font-medium">
          Description
        </label>
        <textarea
          id={`description-${mode}`}
          name="description"
          defaultValue={position?.description ?? ""}
          maxLength={500}
          rows={3}
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`minRoleId-${mode}`} className="text-sm font-medium">
          Minimum role
        </label>
        <select
          id={`minRoleId-${mode}`}
          name="minRoleId"
          defaultValue={position?.minRoleId ?? roles[0]?.id}
          required
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="isExclusive" defaultChecked={position?.isExclusive ?? false} />
        Exclusive (only one active holder at a time)
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? "Saving…" : mode === "edit" ? "Save changes" : "Create position"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
      {state.success && <p className="text-sm text-emerald-600">{mode === "edit" ? "Saved." : "Created."}</p>}
    </form>
  );
}
