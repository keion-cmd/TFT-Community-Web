"use client";

import { useActionState } from "react";
import { muteMember, removeMember } from "@/app/actions/messaging";
import { initialActionState } from "@/app/actions/types";

type Member = {
  id: number;
  userId: string;
  roleInGroup: string;
  mutedUntil: string | null;
  profile: { id: string; username: string; display_name: string } | null;
};

const MUTE_DURATIONS = [
  { label: "1 hour", hours: 1 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
];

function MuteForm({ groupId, userId, isMuted }: { groupId: number; userId: string; isMuted: boolean }) {
  const [state, formAction, isPending] = useActionState(muteMember, initialActionState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="userId" value={userId} />
      {isMuted ? (
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-black/[.06] px-2 py-1 text-xs font-medium disabled:opacity-50 dark:bg-white/[.1]"
        >
          {isPending ? "Working…" : "Unmute"}
        </button>
      ) : (
        <select
          name="until"
          disabled={isPending}
          defaultValue=""
          onChange={(e) => e.target.form?.requestSubmit()}
          className="rounded border border-black/[.1] bg-transparent px-2 py-1 text-xs dark:border-white/[.15]"
        >
          <option value="" disabled>
            Mute for…
          </option>
          {MUTE_DURATIONS.map((d) => (
            <option key={d.hours} value={new Date(Date.now() + d.hours * 3600_000).toISOString()}>
              {d.label}
            </option>
          ))}
        </select>
      )}
      {state.error && <span className="text-xs text-red-600">{state.error.message}</span>}
    </form>
  );
}

function RemoveForm({ groupId, userId }: { groupId: number; userId: string }) {
  const [state, formAction, isPending] = useActionState(removeMember, initialActionState);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Remove this member from the group?")) e.preventDefault();
      }}
    >
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
      >
        {isPending ? "Working…" : "Remove"}
      </button>
      {state.error && <p className="text-xs text-red-600">{state.error.message}</p>}
    </form>
  );
}

export function GroupMembersPanel({
  groupId,
  members,
  currentUserId,
}: {
  groupId: number;
  members: Member[];
  currentUserId: string;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {members.map((m) => {
        const isMuted = !!m.mutedUntil && new Date(m.mutedUntil) > new Date();
        return (
          <li
            key={m.id}
            className="flex flex-col justify-between gap-2 rounded-lg border border-black/[.08] p-3 text-sm sm:flex-row sm:items-center dark:border-white/[.145]"
          >
            <div>
              <p className="font-medium">
                {m.profile?.display_name ?? "Unknown member"}{" "}
                <span className="text-xs font-normal text-black/50 dark:text-white/50">
                  ({m.roleInGroup}
                  {isMuted ? " · muted" : ""})
                </span>
              </p>
              <p className="text-xs text-black/50 dark:text-white/50">@{m.profile?.username ?? "unknown"}</p>
            </div>
            {m.userId !== currentUserId && (
              <div className="flex flex-wrap items-center gap-2">
                <MuteForm groupId={groupId} userId={m.userId} isMuted={isMuted} />
                <RemoveForm groupId={groupId} userId={m.userId} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
