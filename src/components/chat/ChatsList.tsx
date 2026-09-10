"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ChatListRow, type ChatListRowData } from "./ChatListRow";
import {
  listMyGroups,
  listMyDirectMessages,
  listPinnedChats,
  pinChat,
  unpinChat,
  type GroupChatSummary,
  type DmChatSummary,
  type PinnedChats,
} from "@/app/actions/messaging";

type ChatRow = {
  key: string;
  href: string;
  title: string;
  subtitle: string;
  lastMessageAt: string | null;
  preview: string | null;
  unreadCount: number;
  pinTarget: { groupId: number } | { userId: string };
  isPinned: boolean;
};

function toRows(groups: GroupChatSummary[], dms: DmChatSummary[], pinned: PinnedChats): ChatRow[] {
  const pinnedGroupIds = new Set(pinned.groupIds);
  const pinnedDmUserIds = new Set(pinned.dmUserIds);

  const groupRows: ChatRow[] = groups.map((g) => ({
    key: `group:${g.id}`,
    href: `/groups/${g.id}`,
    title: g.name,
    subtitle: g.type,
    lastMessageAt: g.lastMessageAt,
    preview: g.lastMessagePreview,
    unreadCount: g.unreadCount,
    pinTarget: { groupId: g.id },
    isPinned: pinnedGroupIds.has(g.id),
  }));
  const dmRows: ChatRow[] = dms.map((d) => ({
    key: `dm:${d.otherUserId}`,
    href: `/dm/${d.otherUserId}`,
    title: d.otherDisplayName,
    subtitle: `@${d.otherUsername}`,
    lastMessageAt: d.lastMessageAt,
    preview: d.lastMessagePreview,
    unreadCount: d.unreadCount,
    pinTarget: { userId: d.otherUserId },
    isPinned: pinnedDmUserIds.has(d.otherUserId),
  }));

  return [...groupRows, ...dmRows].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (!a.lastMessageAt && !b.lastMessageAt) return 0;
    if (!a.lastMessageAt) return 1;
    if (!b.lastMessageAt) return -1;
    return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
  });
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type Props = {
  currentUserId: string;
  initialGroups: GroupChatSummary[];
  initialDms: DmChatSummary[];
  initialPinned: PinnedChats;
};

export function ChatsList({ currentUserId, initialGroups, initialDms, initialPinned }: Props) {
  const pathname = usePathname();
  const [rows, setRows] = useState<ChatRow[]>(() => toRows(initialGroups, initialDms, initialPinned));
  const groupIdsRef = useRef(initialGroups.map((g) => g.id));
  const hasSubscribedOnce = useRef(false);
  const [, startTransition] = useTransition();

  async function refetch() {
    const [groupsResult, dmsResult, pinnedResult] = await Promise.all([
      listMyGroups(),
      listMyDirectMessages(),
      listPinnedChats(),
    ]);
    const groups = "groups" in groupsResult ? groupsResult.groups : [];
    const dms = "dms" in dmsResult ? dmsResult.dms : [];
    const pinned = "pinned" in pinnedResult ? pinnedResult.pinned : { groupIds: [], dmUserIds: [] };
    groupIdsRef.current = groups.map((g) => g.id);
    setRows(toRows(groups, dms, pinned));
  }

  function handleTogglePin(row: ChatRow) {
    // Optimistic toggle so the row re-sorts immediately; refetch() below
    // reconciles with the server on the next realtime tick regardless.
    setRows((prev) =>
      prev
        .map((r) => (r.key === row.key ? { ...r, isPinned: !r.isPinned } : r))
        .sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          if (!a.lastMessageAt && !b.lastMessageAt) return 0;
          if (!a.lastMessageAt) return 1;
          if (!b.lastMessageAt) return -1;
          return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
        }),
    );
    startTransition(async () => {
      const action = row.isPinned ? unpinChat : pinChat;
      const target = row.pinTarget;
      const result =
        "groupId" in target ? await action(target.groupId, undefined) : await action(undefined, target.userId);
      if ("error" in result) refetch(); // rollback the optimistic toggle on failure
    });
  }

  // Per-user live-update strategy (Phase 5-E's "per-user channel" for the
  // Chats list): the schema has no single column to filter "every message
  // that touches me" in one postgres_changes subscription, so this
  // approximates it with one filtered channel per group the user belongs to
  // (captured at mount) plus two dm_user_a/dm_user_b filters covering every
  // DM regardless of partner. New group memberships picked up after this
  // component mounts aren't watched until the next full page load — flagged
  // in the T-CODE-08 report rather than silently assumed complete.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`user:${currentUserId}:chats`);

    for (const groupId of groupIdsRef.current) {
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `group_id=eq.${groupId}` },
        () => refetch(),
      );
    }
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `dm_user_a=eq.${currentUserId}` },
      () => refetch(),
    );
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `dm_user_b=eq.${currentUserId}` },
      () => refetch(),
    );

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        if (hasSubscribedOnce.current) refetch(); // reconnect = refetch, per Phase 5-E
        hasSubscribedOnce.current = true;
      }
    });

    return () => {
      supabase.removeChannel(channel);
      hasSubscribedOnce.current = false;
    };
  }, [currentUserId]);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversations yet.</p>;
  }

  function toRowData(row: ChatRow): ChatListRowData {
    return {
      key: row.key,
      href: row.href,
      title: row.title,
      preview: row.preview,
      lastMessageAtLabel: formatTime(row.lastMessageAt),
      unreadCount: row.unreadCount,
      isPinned: row.isPinned,
      isActive: pathname === row.href,
    };
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <ChatListRow key={row.key} row={toRowData(row)} onTogglePin={() => handleTogglePin(row)} />
      ))}
    </ul>
  );
}
