"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryBroadcastTarget, type BroadcastHistoryItem } from "@/app/actions/broadcast";

const STATUS_CLASSES: Record<string, string> = {
  sent: "text-emerald-600",
  failed: "text-red-600",
  pending: "text-amber-600",
};

export function BroadcastHistoryRow({ broadcast }: { broadcast: BroadcastHistoryItem }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRetry(targetId: number) {
    setError(null);
    setRetryingId(targetId);
    startTransition(async () => {
      const result = await retryBroadcastTarget(targetId);
      setRetryingId(null);
      if ("error" in result) {
        setError(result.error.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-black/[.08] dark:border-white/[.145] p-4">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex flex-col items-start gap-1 text-left sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <p className="text-sm font-medium">{broadcast.message.slice(0, 120)}</p>
          <p className="text-xs text-black/60 dark:text-white/60">
            {new Date(broadcast.createdAt).toLocaleString()} — {broadcast.senderDisplayName} (@{broadcast.senderUsername})
          </p>
        </div>
        <p className="text-xs">
          <span className="text-emerald-600">{broadcast.counts.sent} sent</span>
          {" · "}
          <span className="text-amber-600">{broadcast.counts.pending} pending</span>
          {" · "}
          <span className="text-red-600">{broadcast.counts.failed} failed</span>
        </p>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-black/[.08] pt-3 dark:border-white/[.145]">
          {broadcast.attachmentUrl && (
            <p className="text-xs text-black/60 dark:text-white/60">
              Attachment: <span className="underline">{broadcast.attachmentUrl}</span>
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {broadcast.targets.map((target) => (
              <li
                key={target.id}
                className="flex flex-col gap-1 rounded border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">{target.groupName}</p>
                  <p className={`text-xs ${STATUS_CLASSES[target.status] ?? ""}`}>
                    {target.status}
                    {target.sentAt ? ` — ${new Date(target.sentAt).toLocaleString()}` : ""}
                    {target.retryCount > 0 ? ` (retried ${target.retryCount}×)` : ""}
                  </p>
                  {target.error && <p className="text-xs text-red-600">{target.error}</p>}
                </div>
                {target.status === "failed" && (
                  <button
                    type="button"
                    onClick={() => handleRetry(target.id)}
                    disabled={isPending && retryingId === target.id}
                    className="self-start rounded bg-black/[.06] px-3 py-1.5 text-xs font-medium hover:bg-black/[.1] disabled:opacity-50 dark:bg-white/[.1] dark:hover:bg-white/[.15]"
                  >
                    {isPending && retryingId === target.id ? "Retrying…" : "Retry"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </li>
  );
}
