"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewBroadcast, sendBroadcast, type BroadcastPreview } from "@/app/actions/broadcast";

type Group = { id: number; name: string; type: string };

// Preview is a confirm-style gate, not just a visual preview: Send stays
// disabled until a preview has been fetched for the *current* form state.
// Editing the form after previewing marks the preview stale and re-disables
// Send until the user previews again.
export function BroadcastComposeForm({ groups }: { groups: Group[] }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [previewedSignature, setPreviewedSignature] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isPreviewing, startPreview] = useTransition();
  const [isSending, startSend] = useTransition();

  const signature = useMemo(
    () => JSON.stringify({ message, attachmentUrl, selectedIds: [...selectedIds].sort() }),
    [message, attachmentUrl, selectedIds],
  );
  const isStale = previewedSignature !== null && previewedSignature !== signature;

  function toggleGroup(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
    setSent(false);
  }

  function handlePreview() {
    setError(null);
    startPreview(async () => {
      const result = await previewBroadcast(message, attachmentUrl || undefined, selectedIds);
      if ("error" in result) {
        setError(result.error.message);
        setPreview(null);
        setPreviewedSignature(null);
        return;
      }
      setPreview(result.preview);
      setPreviewedSignature(signature);
    });
  }

  function handleSend() {
    if (!preview || isStale) return;
    if (!window.confirm(`Send this broadcast to ${preview.count} group${preview.count === 1 ? "" : "s"}?`)) {
      return;
    }
    setError(null);
    startSend(async () => {
      const result = await sendBroadcast(message, attachmentUrl || undefined, selectedIds, idempotencyKey);
      if ("error" in result) {
        setError(result.error.message);
        return;
      }
      setSent(true);
      setPreview(null);
      setPreviewedSignature(null);
      setMessage("");
      setAttachmentUrl("");
      setSelectedIds([]);
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-lg border border-black/[.08] dark:border-white/[.145] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Compose
        </h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="broadcast-message" className="text-sm font-medium">
            Message
          </label>
          <textarea
            id="broadcast-message"
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setSent(false);
            }}
            maxLength={4000}
            rows={5}
            placeholder="What do you want to tell these groups?"
            className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="broadcast-attachment" className="text-sm font-medium">
            Attachment URL (optional)
          </label>
          <input
            id="broadcast-attachment"
            type="url"
            value={attachmentUrl}
            onChange={(event) => {
              setAttachmentUrl(event.target.value);
              setSent(false);
            }}
            placeholder="https://..."
            className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Target groups</p>
          {groups.length === 0 ? (
            <p className="text-sm text-black/60 dark:text-white/60">No groups available.</p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded border border-black/[.08] dark:border-white/[.145] p-2">
              {groups.map((group) => (
                <li key={group.id}>
                  <label className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/[.03] dark:hover:bg-white/[.05]">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(group.id)}
                      onChange={() => toggleGroup(group.id)}
                    />
                    <span className="font-medium">{group.name}</span>
                    <span className="text-black/50 dark:text-white/50">({group.type})</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={handlePreview}
          disabled={isPreviewing || message.trim().length === 0 || selectedIds.length === 0}
          className="self-start rounded bg-black/[.06] px-4 py-2 text-sm font-medium hover:bg-black/[.1] disabled:opacity-50 dark:bg-white/[.1] dark:hover:bg-white/[.15]"
        >
          {isPreviewing ? "Loading preview…" : "Preview"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {sent && <p className="text-sm text-emerald-600">Broadcast sent.</p>}
      </section>

      {preview && (
        <section className="flex flex-col gap-3 rounded-lg border border-black/[.08] dark:border-white/[.145] p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
            Preview
          </h2>
          {isStale && (
            <p className="text-sm text-amber-600">
              You changed the compose form — preview again before sending.
            </p>
          )}
          <p className="text-sm">
            <span className="font-medium">From:</span> {preview.sender.displayName} (@{preview.sender.username})
          </p>
          <p className="whitespace-pre-wrap text-sm">{preview.message}</p>
          {preview.attachmentUrl && (
            <p className="text-sm text-black/60 dark:text-white/60">
              Attachment: <span className="underline">{preview.attachmentUrl}</span>
            </p>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {preview.count} group{preview.count === 1 ? "" : "s"}
            </p>
            <ul className="flex flex-wrap gap-2">
              {preview.groups.map((g) => (
                <li key={g.id} className="rounded bg-black/[.06] px-2 py-1 text-xs dark:bg-white/[.1]">
                  {g.name} ({g.type})
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={isSending || isStale}
            className="self-start rounded bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {isSending ? "Sending…" : "Send Broadcast"}
          </button>
        </section>
      )}
    </div>
  );
}
