"use client";

import { useActionState } from "react";
import { updateOwnProfile } from "@/app/actions/profile";
import { initialActionState } from "@/app/actions/types";

export function ProfileEditForm({
  displayName,
  bio,
}: {
  displayName: string;
  bio: string;
}) {
  const [state, formAction, isPending] = useActionState(
    updateOwnProfile,
    initialActionState,
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-black/[.08] dark:border-white/[.145] p-5"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="displayName" className="text-sm font-medium">
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          defaultValue={displayName}
          required
          maxLength={50}
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="bio" className="text-sm font-medium">
          Bio
        </label>
        <textarea
          id="bio"
          name="bio"
          defaultValue={bio}
          maxLength={280}
          rows={3}
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Save changes"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
      {state.success && <p className="text-sm text-emerald-600">Saved.</p>}
    </form>
  );
}
