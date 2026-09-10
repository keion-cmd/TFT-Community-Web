"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  sendMessage,
  editMessage,
  deleteMessage,
  reactToMessage,
  removeReaction,
  markRead,
  listMessages,
  type MessageDTO,
  type MessageTarget,
} from "@/app/actions/messaging";
import { EDIT_WINDOW_MINUTES } from "@/lib/messaging/constants";
import { TYPING_STOP_DEBOUNCE_MS, TYPING_STALE_MS } from "@/lib/messaging/presence";
import { pinMessage, unpinMessage } from "@/app/actions/groupOverview";
import { requestAttachmentUpload } from "@/app/actions/attachments";
import { validateAttachmentMeta, MAX_ATTACHMENTS_PER_MESSAGE, isImageMimeType } from "@/lib/messaging/attachments";
import { MessageItem } from "./MessageItem";
import { ForwardMessagePicker } from "./ForwardMessagePicker";

type PendingAttachment = {
  localId: string;
  file: File;
  status: "validating" | "uploading" | "uploaded" | "error";
  progress: number;
  error?: string;
  uploaded?: {
    storagePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    width?: number;
    height?: number;
  };
};

async function readImageDimensions(file: File): Promise<{ width: number; height: number } | undefined> {
  if (!isImageMimeType(file.type) || typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return undefined;
  }
}

// PUT directly to the Supabase Storage signed upload URL (never through our
// Next.js server) via XHR rather than fetch, since fetch has no portable
// upload-progress event — the composer needs progress to show the bar.
function uploadWithProgress(signedUrl: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection."));
    xhr.send(file);
  });
}

function dmPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function formatTypingLabel(typingPeers: Map<string, { displayName: string }>): string {
  const names = Array.from(typingPeers.values()).map((p) => p.displayName);
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are typing…`;
}

function upsertById(existing: MessageDTO[], incoming: MessageDTO): MessageDTO[] {
  const idx = existing.findIndex((m) => m.id === incoming.id);
  if (idx === -1) return [...existing, incoming].sort((a, b) => a.id - b.id);
  const next = existing.slice();
  next[idx] = incoming;
  return next;
}

type Props = {
  target: MessageTarget;
  currentUserId: string;
  currentUserDisplayName: string;
  initialMessages: MessageDTO[];
  canModerate: boolean;
  isGroup: boolean;
  // Group threads only — undefined/null for DMs, where pinning doesn't apply.
  pinnedMessageId?: number | null;
  // Set from the Chats search result's ?m=<id> deep link (T-CODE-34) — the
  // page-level Server Component fetches a wider initial window when this is
  // present so the target message is actually in `initialMessages`.
  highlightMessageId?: number | null;
};

export function MessageThread({
  target,
  currentUserId,
  currentUserDisplayName,
  initialMessages,
  canModerate,
  isGroup,
  pinnedMessageId = null,
  highlightMessageId = null,
}: Props) {
  const [messages, setMessages] = useState<MessageDTO[]>(initialMessages);
  const [pinnedId, setPinnedId] = useState<number | null>(pinnedMessageId);
  const [pinError, setPinError] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [forwardTarget, setForwardTarget] = useState<MessageDTO | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasSubscribedOnce = useRef(false);
  const hasScrolledToHighlight = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Typing indicator state — driven by Presence on the same per-thread
  // channel the postgres_changes subscription below already opens (one
  // channel per open thread, per the existing convention), not a second
  // channel. See "typing" state below and the presence handlers in the
  // realtime effect.
  const [typingPeers, setTypingPeers] = useState<Map<string, { displayName: string; seenAt: number }>>(new Map());
  const typingChannelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);
  const isTypingRef = useRef(false);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function sendTypingStart() {
    if (isTypingRef.current) return;
    isTypingRef.current = true;
    typingChannelRef.current?.track({ typing: true, displayName: currentUserDisplayName });
  }

  function sendTypingStop() {
    if (typingStopTimerRef.current) {
      clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }
    if (!isTypingRef.current) return;
    isTypingRef.current = false;
    typingChannelRef.current?.track({ typing: false, displayName: currentUserDisplayName });
  }

  function handleComposerTyping(value: string) {
    setComposerValue(value);
    if (value.trim().length === 0) {
      sendTypingStop();
      return;
    }
    sendTypingStart();
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(sendTypingStop, TYPING_STOP_DEBOUNCE_MS);
  }

  // Local safety net independent of the network round trip: even if a
  // peer's typing:stop (or their connection's leave event) never arrives,
  // drop them from the rendered list once their last known "typing:true"
  // is older than TYPING_STALE_MS.
  useEffect(() => {
    const interval = setInterval(() => {
      setTypingPeers((prev) => {
        const now = Date.now();
        let changed = false;
        const next = new Map(prev);
        for (const [userId, entry] of prev) {
          if (now - entry.seenAt > TYPING_STALE_MS) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  async function refetch() {
    const result = await listMessages(target);
    if ("messages" in result) setMessages(result.messages);
  }

  useEffect(() => {
    // Mark the thread read once its initial messages are in view.
    markRead("groupId" in target ? { groupId: target.groupId } : { recipientId: target.recipientId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (highlightMessageId == null) {
      bottomRef.current?.scrollIntoView({ block: "end" });
      return;
    }
    if (hasScrolledToHighlight.current) return;
    const el = document.getElementById(`message-${highlightMessageId}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      hasScrolledToHighlight.current = true;
    }
  }, [messages.length, highlightMessageId]);

  // Realtime: one channel per open thread, per Phase 5-E's group:{groupId} /
  // dm:{userA}:{userB} design. postgres_changes filters support a single
  // column, so the DM case narrows by dm_user_a (the canonical "lower" uuid
  // of the pair — see dmPair) and double-checks dm_user_b client-side, since
  // dm_user_a alone doesn't uniquely identify one thread when the same user
  // participates in several DMs.
  useEffect(() => {
    const supabase = createClient();
    const isDm = "recipientId" in target;
    const [lo, hi] = isDm ? dmPair(currentUserId, target.recipientId) : [null, null];
    const channelName = isDm ? `dm:${lo}:${hi}` : `group:${target.groupId}`;
    // `private: true` routes Presence/Broadcast on this channel through the
    // realtime.messages RLS policy added in 0013_presence_typing.sql, which
    // re-checks the same group/DM participant boundary the postgres_changes
    // filters below already rely on (RLS on the messages table itself) —
    // without it, typing state would leak to anyone who guesses the topic
    // name, unlike postgres_changes rows.
    const channel = supabase.channel(channelName, {
      config: { presence: { key: currentUserId }, private: true },
    });
    typingChannelRef.current = channel;

    // A raw postgres_changes row lacks the joined sender/reaction data
    // listMessages produces; simplest idempotent path is to refetch rather
    // than hand-assemble a partial DTO.
    if (isDm) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `dm_user_a=eq.${lo}` },
        (payload: { new: Record<string, unknown> }) => {
          if (payload.new.dm_user_b !== hi) return; // a different DM pair sharing the same "lo" participant
          refetch();
        },
      );
    } else {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `group_id=eq.${target.groupId}` },
        () => refetch(),
      );
    }

    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "message_reactions" },
      (payload: { new: Record<string, unknown>; old: Record<string, unknown> }) => {
        const messageId = (payload.new?.message_id ?? payload.old?.message_id) as number | undefined;
        if (messageId != null && messagesRef.current.some((m) => m.id === messageId)) refetch();
      },
    );

    // Typing indicators — Presence, never persisted to Postgres. `sync`
    // fires with the full current state on every join/leave/track, so it's
    // simplest to just rebuild the local typing map from it each time
    // rather than hand-patch join/leave deltas.
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<{ typing?: boolean; displayName?: string }>();
      const now = Date.now();
      const next = new Map<string, { displayName: string; seenAt: number }>();
      for (const [userId, presences] of Object.entries(state)) {
        if (userId === currentUserId) continue;
        const latest = presences[presences.length - 1];
        if (!latest?.typing) continue;
        // seenAt refreshes to "now" every sync that still shows typing:true
        // for this peer — this is what TYPING_STALE_MS measures against.
        next.set(userId, { displayName: latest.displayName ?? "Someone", seenAt: now });
      }
      setTypingPeers(next);
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        if (hasSubscribedOnce.current) {
          // Reconnect case (Phase 5-E): refetch current view rather than
          // trying to replay missed events.
          refetch();
        }
        hasSubscribedOnce.current = true;
      }
    });

    return () => {
      supabase.removeChannel(channel);
      hasSubscribedOnce.current = false;
      typingChannelRef.current = null;
      isTypingRef.current = false;
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      setTypingPeers(new Map());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGroup, "groupId" in target ? target.groupId : target.recipientId, currentUserId]);

  // Runs one file through validate -> requestAttachmentUpload -> direct PUT
  // to Storage, updating that file's own pendingAttachments entry as it
  // goes so the picker can show per-file progress / failed+retry state.
  async function uploadAttachment(localId: string, file: File) {
    setPendingAttachments((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, status: "validating", error: undefined } : a)),
    );

    const validation = validateAttachmentMeta({ fileName: file.name, mimeType: file.type, sizeBytes: file.size });
    if (!validation.ok) {
      setPendingAttachments((prev) =>
        prev.map((a) => (a.localId === localId ? { ...a, status: "error", error: validation.message } : a)),
      );
      return;
    }

    const isSavedMessages = "recipientId" in target && target.recipientId === currentUserId;
    const ticket = await requestAttachmentUpload(target, file.name, file.type, file.size, isSavedMessages);
    if ("error" in ticket) {
      setPendingAttachments((prev) =>
        prev.map((a) => (a.localId === localId ? { ...a, status: "error", error: ticket.error.message } : a)),
      );
      return;
    }

    setPendingAttachments((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, status: "uploading", progress: 0 } : a)),
    );

    try {
      await uploadWithProgress(ticket.upload.signedUrl, file, (progress) => {
        setPendingAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, progress } : a)));
      });
      const dims = await readImageDimensions(file);
      setPendingAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? {
                ...a,
                status: "uploaded",
                progress: 100,
                uploaded: {
                  storagePath: ticket.upload.path,
                  fileName: file.name,
                  mimeType: file.type,
                  sizeBytes: file.size,
                  width: dims?.width,
                  height: dims?.height,
                },
              }
            : a,
        ),
      );
    } catch (err) {
      setPendingAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? { ...a, status: "error", error: err instanceof Error ? err.message : "Upload failed." }
            : a,
        ),
      );
    }
  }

  function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length;
    const selected = Array.from(files).slice(0, Math.max(room, 0));
    for (const file of selected) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPendingAttachments((prev) => [...prev, { localId, file, status: "validating", progress: 0 }]);
      uploadAttachment(localId, file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(localId: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.localId !== localId));
  }

  function retryAttachment(localId: string) {
    const pending = pendingAttachments.find((a) => a.localId === localId);
    if (pending) uploadAttachment(localId, pending.file);
  }

  function handleSend() {
    const content = composerValue.trim();
    const uploadedAttachments = pendingAttachments
      .filter((a) => a.status === "uploaded" && a.uploaded)
      .map((a) => a.uploaded!);
    const stillBusy = pendingAttachments.some((a) => a.status === "uploading" || a.status === "validating");
    if (!content && uploadedAttachments.length === 0) return;
    if (stillBusy) {
      setSendError("Wait for attachments to finish uploading before sending.");
      return;
    }
    setSendError(null);
    sendTypingStop();
    startTransition(async () => {
      const result = await sendMessage(
        target,
        content,
        uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        replyTo?.id,
      );
      if ("error" in result) {
        setSendError(result.error.message);
        return;
      }
      setMessages((prev) => upsertById(prev, result.message));
      setComposerValue("");
      setPendingAttachments([]);
      setReplyTo(null);
    });
  }

  async function handleEdit(messageId: number, content: string) {
    const result = await editMessage(messageId, content);
    if ("error" in result) return { error: result.error };
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, content: result.content, editedAt: result.editedAt } : m)),
    );
    return { success: true as const };
  }

  function handleDelete(messageId: number) {
    startTransition(async () => {
      const result = await deleteMessage(messageId);
      if ("success" in result) {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: null, deletedAt: new Date().toISOString() } : m)),
        );
      } else {
        setSendError(result.error.message);
      }
    });
  }

  function handleToggleReaction(messageId: number, emoji: string, reactedByMe: boolean) {
    startTransition(async () => {
      const result = reactedByMe
        ? await removeReaction(messageId, emoji)
        : await reactToMessage(messageId, emoji);
      if ("error" in result) {
        setSendError(result.error.message);
        return;
      }
      refetch();
    });
  }

  function handleTogglePin(messageId: number) {
    if (!("groupId" in target)) return;
    setPinError(null);
    startTransition(async () => {
      const result =
        pinnedId === messageId
          ? await unpinMessage(target.groupId)
          : await pinMessage(target.groupId, messageId);
      if ("error" in result) {
        setPinError(result.error.message);
        return;
      }
      setPinnedId((prev) => (prev === messageId ? null : messageId));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto rounded-lg border border-black/[.08] p-2 dark:border-white/[.145]">
        {messages.length === 0 ? (
          <p className="p-4 text-sm text-black/50 dark:text-white/50">
            No messages yet — say hello.
          </p>
        ) : (
          messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              currentUserId={currentUserId}
              canModerate={canModerate}
              reactionsEnabled={isGroup}
              editWindowMinutes={EDIT_WINDOW_MINUTES}
              onReply={setReplyTo}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleReaction={handleToggleReaction}
              onForward={setForwardTarget}
              canPin={isGroup && canModerate}
              isPinned={pinnedId === m.id}
              onTogglePin={handleTogglePin}
              highlighted={highlightMessageId === m.id}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {forwardTarget && (
        <ForwardMessagePicker messageId={forwardTarget.id} onClose={() => setForwardTarget(null)} />
      )}

      {pinError && <p className="text-sm text-red-600">{pinError}</p>}

      {replyTo && (
        <div className="flex items-center justify-between rounded border border-black/[.1] px-3 py-2 text-xs dark:border-white/[.15]">
          <span className="text-black/60 dark:text-white/60">
            Replying to {replyTo.senderDisplayName}: {replyTo.content?.slice(0, 80)}
          </span>
          <button type="button" onClick={() => setReplyTo(null)} className="underline underline-offset-4">
            Cancel
          </button>
        </div>
      )}

      {typingPeers.size > 0 && (
        <p className="px-1 text-xs italic text-black/50 dark:text-white/50">{formatTypingLabel(typingPeers)}</p>
      )}

      <div className="flex flex-col gap-2">
        {pendingAttachments.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {pendingAttachments.map((a) => (
              <li
                key={a.localId}
                className="flex items-center gap-2 rounded border border-black/[.1] px-2 py-1 text-xs dark:border-white/[.15]"
              >
                <span className="max-w-[10rem] truncate">{a.file.name}</span>
                {a.status === "uploading" && <span className="text-black/40 dark:text-white/40">{a.progress}%</span>}
                {a.status === "validating" && <span className="text-black/40 dark:text-white/40">Checking…</span>}
                {a.status === "uploaded" && <span className="text-green-600">Ready</span>}
                {a.status === "error" && (
                  <>
                    <span className="text-red-600">{a.error ?? "Failed"}</span>
                    <button
                      type="button"
                      onClick={() => retryAttachment(a.localId)}
                      className="underline underline-offset-4"
                    >
                      Retry
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.localId)}
                  className="text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
                  aria-label={`Remove ${a.file.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          value={composerValue}
          onChange={(e) => handleComposerTyping(e.target.value)}
          onBlur={sendTypingStop}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Write a message…"
          className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
        />
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            title="Attach files"
            aria-label="Attach files"
            className="self-start rounded border border-black/[.1] px-3 py-2 text-sm disabled:opacity-50 dark:border-white/[.15]"
          >
            📎
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={
              isPending ||
              (composerValue.trim().length === 0 && !pendingAttachments.some((a) => a.status === "uploaded"))
            }
            className="self-start rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {isPending ? "Sending…" : "Send"}
          </button>
          {sendError && <p className="text-sm text-red-600">{sendError}</p>}
        </div>
      </div>
    </div>
  );
}
