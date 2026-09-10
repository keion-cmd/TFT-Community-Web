"use client";

import { useState } from "react";
import type { MessageDTO } from "@/app/actions/messaging";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Props = {
  message: MessageDTO;
  currentUserId: string;
  canModerate: boolean;
  reactionsEnabled: boolean;
  editWindowMinutes: number;
  onReply: (message: MessageDTO) => void;
  onEdit: (messageId: number, content: string) => Promise<{ success: true } | { error: { message: string } }>;
  onDelete: (messageId: number) => void;
  onToggleReaction: (messageId: number, emoji: string, reactedByMe: boolean) => void;
  onForward?: (message: MessageDTO) => void;
  canPin?: boolean;
  isPinned?: boolean;
  onTogglePin?: (messageId: number) => void;
  highlighted?: boolean;
};

export function MessageItem({
  message,
  currentUserId,
  canModerate,
  reactionsEnabled,
  editWindowMinutes,
  onReply,
  onEdit,
  onDelete,
  onToggleReaction,
  onForward,
  canPin = false,
  isPinned = false,
  onTogglePin,
  highlighted = false,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content ?? "");
  const [editError, setEditError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const isSender = message.senderId === currentUserId;
  const isDeleted = !!message.deletedAt;
  const ageMinutes = (Date.now() - new Date(message.createdAt).getTime()) / 60000;
  const canEdit = isSender && !isDeleted && ageMinutes <= editWindowMinutes;
  const canDelete = !isDeleted && (isSender || canModerate);

  async function submitEdit() {
    const result = await onEdit(message.id, editValue);
    if ("error" in result) {
      setEditError(result.error.message);
      return;
    }
    setEditError(null);
    setIsEditing(false);
  }

  return (
    <div
      id={`message-${message.id}`}
      className={`group flex flex-col gap-1 rounded-lg px-3 py-2 hover:bg-black/[.02] dark:hover:bg-white/[.03] ${
        highlighted ? "bg-foreground/10 ring-1 ring-foreground/30" : ""
      }`}
    >
      {message.forwardedFromMessageId != null && (
        <p className="text-xs text-black/40 dark:text-white/40">↪ Forwarded</p>
      )}
      {message.replyToId != null && (
        <p className="border-l-2 border-black/[.15] pl-2 text-xs text-black/50 dark:border-white/[.2] dark:text-white/50">
          {message.replyPreview ?? "…"}
        </p>
      )}
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{message.senderDisplayName}</span>
        <span className="text-xs text-black/40 dark:text-white/40">{formatTime(message.createdAt)}</span>
        {message.editedAt && !isDeleted && (
          <span className="text-xs text-black/40 dark:text-white/40">(edited)</span>
        )}
        {isPinned && <span className="text-xs text-black/40 dark:text-white/40">📌 Pinned</span>}
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            rows={2}
            maxLength={4000}
            className="rounded border border-black/[.1] bg-transparent px-2 py-1 text-sm dark:border-white/[.15]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submitEdit}
              className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setIsEditing(false);
                setEditValue(message.content ?? "");
                setEditError(null);
              }}
              className="text-xs underline underline-offset-4"
            >
              Cancel
            </button>
            {editError && <span className="text-xs text-red-600">{editError}</span>}
          </div>
        </div>
      ) : (
        <p className={`text-sm ${isDeleted ? "italic text-black/40 dark:text-white/40" : ""}`}>
          {isDeleted ? "Message deleted" : message.content}
        </p>
      )}

      {!isDeleted && message.attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {message.attachments.map((a) => {
            const isImage = a.mimeType.startsWith("image/");
            if (isImage && a.url) {
              return (
                <li key={a.id}>
                  <a href={a.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private, signed, short-lived Supabase Storage URL; next/image's remote loader isn't worth wiring up for that */}
                    <img
                      src={a.url}
                      alt={a.fileName}
                      className="max-h-48 max-w-full rounded border border-black/[.08] object-contain dark:border-white/[.145]"
                    />
                  </a>
                </li>
              );
            }
            return (
              <li key={a.id} className="text-xs text-black/50 dark:text-white/50">
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    📎 {a.fileName}
                  </a>
                ) : (
                  <span>📎 {a.fileName} (unavailable)</span>
                )}
                <span className="ml-1 text-black/30 dark:text-white/30">
                  {(a.sizeBytes / 1024).toFixed(0)} KB
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!isDeleted && message.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {message.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              disabled={!reactionsEnabled}
              onClick={() => onToggleReaction(message.id, r.emoji, r.reactedByMe)}
              className={`rounded-full border px-2 py-0.5 text-xs ${
                r.reactedByMe
                  ? "border-foreground bg-foreground/10"
                  : "border-black/[.1] dark:border-white/[.15]"
              } ${reactionsEnabled ? "" : "opacity-50"}`}
            >
              {r.emoji} {r.count}
            </button>
          ))}
        </div>
      )}

      {!isDeleted && (
        <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100">
          {reactionsEnabled && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowEmojiPicker((v) => !v)}
                className="text-xs text-black/50 hover:underline dark:text-white/50"
              >
                React
              </button>
              {showEmojiPicker && (
                <div className="absolute z-10 mt-1 flex gap-1 rounded border border-black/[.1] bg-background p-1 dark:border-white/[.15]">
                  {QUICK_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        onToggleReaction(message.id, emoji, false);
                        setShowEmojiPicker(false);
                      }}
                      className="px-1 text-sm hover:scale-110"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => onReply(message)}
            className="text-xs text-black/50 hover:underline dark:text-white/50"
          >
            Reply
          </button>
          {onForward && (
            <button
              type="button"
              onClick={() => onForward(message)}
              className="text-xs text-black/50 hover:underline dark:text-white/50"
            >
              Forward
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="text-xs text-black/50 hover:underline dark:text-white/50"
            >
              Edit
            </button>
          )}
          {canPin && onTogglePin && (
            <button
              type="button"
              onClick={() => onTogglePin(message.id)}
              className="text-xs text-black/50 hover:underline dark:text-white/50"
            >
              {isPinned ? "Unpin" : "Pin"}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete(message.id)}
              className="text-xs text-red-600 hover:underline"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
