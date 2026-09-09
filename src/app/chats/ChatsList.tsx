"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  listMyGroups,
  listMyDirectMessages,
  type GroupChatSummary,
  type DmChatSummary,
} from "@/app/actions/messaging";

type ChatRow = {
  key: string;
  href: string;
  title: string;
  subtitle: string;
  lastMessageAt: string | null;
  preview: string | null;
  unreadCount: number;
};

function toRows(groups: GroupChatSummary[], dms: DmChatSummary[]): ChatRow[] {
  const groupRows: ChatRow[] = groups.map((g) => ({
    key: `group:${g.id}`,
    href: `/groups/${g.id}`,
    title: g.name,
    subtitle: g.type,
    lastMessageAt: g.lastMessageAt,
    preview: g.lastMessagePreview,
    unreadCount: g.unreadCount,
  }));
  const dmRows: ChatRow[] = dms.map((d) => ({
    key: `dm:${d.otherUserId}`,
    href: `/dm/${d.otherUserId}`,
    title: d.otherDisplayName,
    subtitle: `@${d.otherUsername}`,
    lastMessageAt: d.lastMessageAt,
    preview: d.lastMessagePreview,
    unreadCount: d.unreadCount,
  }));
  return [...groupRows, ...dmRows].sort((a, b) => {
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
};

export function ChatsList({ currentUserId, initialGroups, initialDms }: Props) {
  const [rows, setRows] = useState<ChatRow[]>(() => toRows(initialGroups, initialDms));
  const groupIdsRef = useRef(initialGroups.map((g) => g.id));
  const hasSubscribedOnce = useRef(false);

  async function refetch() {
    const [groupsResult, dmsResult] = await Promise.all([listMyGroups(), listMyDirectMessages()]);
    const groups = "groups" in groupsResult ? groupsResult.groups : [];
    const dms = "dms" in dmsResult ? dmsResult.dms : [];
    groupIdsRef.current = groups.map((g) => g.id);
    setRows(toRows(groups, dms));
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
    return <p className="text-sm text-black/60 dark:text-white/60">No conversations yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.key}>
          <Link
            href={row.href}
            className="flex items-center justify-between gap-3 rounded-lg border border-black/[.08] p-4 hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.05]"
          >
            <div className="flex flex-col">
              <span className="font-medium">{row.title}</span>
              <span className="text-sm text-black/60 dark:text-white/60">
                {row.preview ?? "No messages yet"}
              </span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs text-black/40 dark:text-white/40">{formatTime(row.lastMessageAt)}</span>
              {row.unreadCount > 0 && (
                <span className="rounded-full bg-foreground px-2 py-0.5 text-xs font-medium text-background">
                  {row.unreadCount}
                </span>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
