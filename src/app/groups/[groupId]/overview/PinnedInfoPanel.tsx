"use client";

import { useState, useTransition } from "react";
import { unpinMessage } from "@/app/actions/groupOverview";
import type { GroupOverviewPinnedMessage } from "@/app/actions/groupOverview";

export function PinnedInfoPanel({
  groupId,
  pinnedMessage,
  canModerate,
}: {
  groupId: number;
  pinnedMessage: GroupOverviewPinnedMessage;
  canModerate: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!pinnedMessage) {
    return <p className="text-sm text-black/60 dark:text-white/60">Nothing pinned yet.</p>;
  }

  function handleUnpin() {
    setError(null);
    startTransition(async () => {
      const result = await unpinMessage(groupId);
      if ("error" in result) setError(result.error.message);
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{pinnedMessage.senderDisplayName}</p>
          <p className={pinnedMessage.deletedAt ? "italic text-black/40 dark:text-white/40" : ""}>
            {pinnedMessage.deletedAt ? "Message deleted" : pinnedMessage.content}
          </p>
        </div>
        {canModerate && (
          <button
            type="button"
            onClick={handleUnpin}
            disabled={isPending}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            {isPending ? "Unpinning…" : "Unpin"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
