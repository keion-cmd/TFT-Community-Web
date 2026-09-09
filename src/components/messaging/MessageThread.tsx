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
import { MessageItem } from "./MessageItem";

function dmPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
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
  initialMessages: MessageDTO[];
  canModerate: boolean;
  isGroup: boolean;
};

export function MessageThread({ target, currentUserId, initialMessages, canModerate, isGroup }: Props) {
  const [messages, setMessages] = useState<MessageDTO[]>(initialMessages);
  const [composerValue, setComposerValue] = useState("");
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasSubscribedOnce = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

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
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

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
    const channel = supabase.channel(channelName);

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGroup, "groupId" in target ? target.groupId : target.recipientId, currentUserId]);

  function handleSend() {
    const content = composerValue.trim();
    if (!content) return;
    setSendError(null);
    startTransition(async () => {
      const result = await sendMessage(target, content, undefined, replyTo?.id);
      if ("error" in result) {
        setSendError(result.error.message);
        return;
      }
      setMessages((prev) => upsertById(prev, result.message));
      setComposerValue("");
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
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

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

      <div className="flex flex-col gap-2">
        <textarea
          value={composerValue}
          onChange={(e) => setComposerValue(e.target.value)}
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
          <button
            type="button"
            onClick={handleSend}
            disabled={isPending || composerValue.trim().length === 0}
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
