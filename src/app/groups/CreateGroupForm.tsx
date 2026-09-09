"use client";

import { useActionState } from "react";
import { createGroup } from "@/app/actions/messaging";
import { initialActionState } from "@/app/actions/types";

const GROUP_TYPES = [
  { value: "public", label: "Public — any active member can join" },
  { value: "staff_only", label: "Staff only — Assistant Admin+ or Position holders" },
  { value: "admin_only", label: "Admin only" },
  { value: "private", label: "Private — invite only" },
  { value: "broadcast", label: "Broadcast — invite only" },
];

export function CreateGroupForm() {
  const [state, formAction, isPending] = useActionState(createGroup, initialActionState);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-black/[.08] p-5 dark:border-white/[.145]"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="group-name" className="text-sm font-medium">
          Name
        </label>
        <input
          id="group-name"
          name="name"
          required
          maxLength={100}
          className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="group-type" className="text-sm font-medium">
          Type
        </label>
        <select
          id="group-type"
          name="type"
          defaultValue="public"
          required
          className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
        >
          {GROUP_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="group-description" className="text-sm font-medium">
          Description
        </label>
        <textarea
          id="group-description"
          name="description"
          rows={2}
          maxLength={500}
          className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {isPending ? "Creating…" : "Create group"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
      {state.success && <p className="text-sm text-emerald-600">Created.</p>}
    </form>
  );
}
