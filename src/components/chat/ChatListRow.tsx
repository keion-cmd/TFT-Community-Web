import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";

export interface ChatListRowData {
  key: string;
  href: string;
  title: string;
  preview: string | null;
  lastMessageAtLabel: string;
  unreadCount: number;
  isPinned: boolean;
  isActive?: boolean;
}

type Props = {
  row: ChatListRowData;
  onTogglePin: (row: ChatListRowData) => void;
};

// Shared row used by both the desktop sidebar and the mobile /chats list
// (T-CODE-39) — keep in sync with any future avatar/badge changes rather
// than forking a second copy per surface.
export function ChatListRow({ row, onTogglePin }: Props) {
  return (
    <li className="flex items-center gap-2">
      <Link
        href={row.href}
        aria-current={row.isActive ? "page" : undefined}
        className={`flex flex-1 items-center gap-3 rounded-lg p-3 transition-colors ${
          row.isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
        }`}
      >
        <Avatar name={row.title} />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1">
            {row.isPinned && (
              <span aria-label="Pinned" title="Pinned" className="shrink-0 text-xs text-muted-foreground">
                📌
              </span>
            )}
            <span className="truncate font-semibold text-foreground">{row.title}</span>
          </span>
          <span className="truncate text-sm text-muted-foreground">{row.preview ?? "No messages yet"}</span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs text-muted-foreground">{row.lastMessageAtLabel}</span>
          {row.unreadCount > 0 && <Badge variant="accent">{row.unreadCount}</Badge>}
        </span>
      </Link>

      <button
        type="button"
        onClick={() => onTogglePin(row)}
        aria-label={row.isPinned ? "Unpin chat" : "Pin chat"}
        title={row.isPinned ? "Unpin chat" : "Pin chat"}
        className="shrink-0 rounded-lg border border-border p-2 text-sm hover:bg-surface-hover"
      >
        {row.isPinned ? "📌" : "📍"}
      </button>
    </li>
  );
}
