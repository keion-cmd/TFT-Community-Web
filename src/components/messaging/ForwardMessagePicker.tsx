"use client";

import { useEffect, useState } from "react";
import {
  forwardMessage,
  listMyGroups,
  listMyDirectMessages,
  type GroupChatSummary,
  type DmChatSummary,
} from "@/app/actions/messaging";

type Props = {
  messageId: number;
  onClose: () => void;
};

// No reusable group+DM picker exists elsewhere in the codebase — the only
// similar component (BroadcastComposeForm's checkbox list) is a groups-only,
// multi-select, admin-only picker (see T-CODE-34 report), not equivalent to
// a single-target forward-to-one-chat picker that also needs DMs.
export function ForwardMessagePicker({ messageId, onClose }: Props) {
  const [groups, setGroups] = useState<GroupChatSummary[]>([]);
  const [dms, setDms] = useState<DmChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [forwardingKey, setForwardingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listMyGroups(), listMyDirectMessages()]).then(([groupsResult, dmsResult]) => {
      if (cancelled) return;
      setGroups("groups" in groupsResult ? groupsResult.groups : []);
      setDms("dms" in dmsResult ? dmsResult.dms : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleForwardToGroup(groupId: number, label: string) {
    setError(null);
    setForwardingKey(`group:${groupId}`);
    const result = await forwardMessage(messageId, groupId, undefined);
    setForwardingKey(null);
    if ("error" in result) {
      setError(result.error.message);
      return;
    }
    setSentTo(label);
  }

  async function handleForwardToUser(userId: string, label: string) {
    setError(null);
    setForwardingKey(`dm:${userId}`);
    const result = await forwardMessage(messageId, undefined, userId);
    setForwardingKey(null);
    if ("error" in result) {
      setError(result.error.message);
      return;
    }
    setSentTo(label);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-lg border border-black/[.1] bg-background p-4 dark:border-white/[.15]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Forward message</h2>
          <button type="button" onClick={onClose} className="text-xs underline underline-offset-4">
            Close
          </button>
        </div>

        {sentTo ? (
          <p className="text-sm text-black/70 dark:text-white/70">Forwarded to {sentTo}.</p>
        ) : (
          <>
            {error && <p className="text-xs text-red-600">{error}</p>}
            {loading ? (
              <p className="text-sm text-black/50 dark:text-white/50">Loading chats…</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {groups.map((g) => (
                  <li key={`group:${g.id}`}>
                    <button
                      type="button"
                      disabled={forwardingKey !== null}
                      onClick={() => handleForwardToGroup(g.id, g.name)}
                      className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-black/[.03] disabled:opacity-50 dark:hover:bg-white/[.05]"
                    >
                      <span>{g.name}</span>
                      <span className="text-xs text-black/40 dark:text-white/40">
                        {forwardingKey === `group:${g.id}` ? "Sending…" : g.type}
                      </span>
                    </button>
                  </li>
                ))}
                {dms.map((d) => (
                  <li key={`dm:${d.otherUserId}`}>
                    <button
                      type="button"
                      disabled={forwardingKey !== null}
                      onClick={() => handleForwardToUser(d.otherUserId, d.otherDisplayName)}
                      className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-black/[.03] disabled:opacity-50 dark:hover:bg-white/[.05]"
                    >
                      <span>{d.otherDisplayName}</span>
                      <span className="text-xs text-black/40 dark:text-white/40">
                        {forwardingKey === `dm:${d.otherUserId}` ? "Sending…" : `@${d.otherUsername}`}
                      </span>
                    </button>
                  </li>
                ))}
                {groups.length === 0 && dms.length === 0 && (
                  <li className="p-2 text-sm text-black/50 dark:text-white/50">No chats to forward to.</li>
                )}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
