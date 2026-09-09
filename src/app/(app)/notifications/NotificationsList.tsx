"use client";

import { useMemo, useState, useTransition } from "react";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type NotificationDTO,
  type NotificationCategory,
} from "@/app/actions/notifications";

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  messaging: "Messaging",
  scheduling: "Scheduling",
  admin: "Admin",
};

const CATEGORY_ORDER: NotificationCategory[] = ["messaging", "scheduling", "admin"];

function describe(notification: NotificationDTO): string {
  const p = notification.payload;
  switch (notification.type) {
    case "schedule_cancelled":
      return `A schedule slot was cancelled${p.reason ? `: ${p.reason}` : "."}`;
    case "schedule_assigned":
      return "You were assigned to a schedule slot.";
    case "schedule_missed":
      return "A claimed schedule slot was marked missed.";
    case "admin":
      return typeof p.message === "string" ? p.message : "Admin notification.";
    default:
      return notification.type.replace(/_/g, " ");
  }
}

function NotificationRow({
  notification,
  onRead,
}: {
  notification: NotificationDTO;
  onRead: (id: number) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const isUnread = notification.readAt === null;

  function handleMarkRead() {
    startTransition(async () => {
      const result = await markNotificationRead(notification.id);
      if ("success" in result) onRead(notification.id);
    });
  }

  return (
    <li
      className={`flex items-start justify-between gap-3 rounded-lg border p-4 text-sm ${
        isUnread
          ? "border-black/[.15] bg-black/[.03] dark:border-white/[.2] dark:bg-white/[.06]"
          : "border-black/[.08] dark:border-white/[.145]"
      }`}
    >
      <div className="flex flex-col gap-1">
        <p className={isUnread ? "font-medium" : ""}>{describe(notification)}</p>
        <p className="text-xs text-black/50 dark:text-white/50">
          {new Date(notification.createdAt).toLocaleString()}
        </p>
      </div>
      {isUnread && (
        <button
          type="button"
          disabled={isPending}
          onClick={handleMarkRead}
          className="shrink-0 rounded bg-black/[.06] px-3 py-1.5 text-xs font-medium hover:bg-black/[.1] disabled:opacity-50 dark:bg-white/[.1] dark:hover:bg-white/[.15]"
        >
          {isPending ? "…" : "Mark read"}
        </button>
      )}
    </li>
  );
}

export function NotificationsList({
  initialNotifications,
  grouped,
}: {
  initialNotifications: NotificationDTO[];
  grouped: boolean;
}) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [isPending, startTransition] = useTransition();
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(initialNotifications.length < 20);
  const [error, setError] = useState<string | null>(null);

  const hasUnread = notifications.some((n) => n.readAt === null);

  function markOneRead(id: number) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
  }

  function handleMarkAllRead() {
    setError(null);
    startTransition(async () => {
      const result = await markAllNotificationsRead();
      if ("error" in result) {
        setError(result.error.message);
        return;
      }
      setNotifications((prev) => prev.map((n) => (n.readAt === null ? { ...n, readAt: new Date().toISOString() } : n)));
    });
  }

  async function loadMore() {
    if (notifications.length === 0) return;
    setLoadingMore(true);
    setError(null);
    const lastId = notifications[notifications.length - 1].id;
    const result = await listNotifications({ beforeId: lastId, limit: 20 });
    setLoadingMore(false);
    if ("error" in result) {
      setError(result.error.message);
      return;
    }
    if (result.notifications.length < 20) setExhausted(true);
    setNotifications((prev) => [...prev, ...result.notifications]);
  }

  const groups = useMemo(() => {
    if (!grouped) return null;
    const byCategory = new Map<NotificationCategory, NotificationDTO[]>();
    for (const n of notifications) {
      const list = byCategory.get(n.category) ?? [];
      list.push(n);
      byCategory.set(n.category, list);
    }
    return CATEGORY_ORDER.map((category) => ({ category, items: byCategory.get(category) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [notifications, grouped]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-black/60 dark:text-white/60">
          {notifications.length === 0 ? "No notifications." : `${notifications.length} loaded`}
        </p>
        <button
          type="button"
          disabled={isPending || !hasUnread}
          onClick={handleMarkAllRead}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {isPending ? "Marking…" : "Mark all read"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {notifications.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">You&apos;re all caught up.</p>
      ) : groups ? (
        <div className="flex flex-col gap-8">
          {groups.map(({ category, items }) => (
            <section key={category} className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
                {CATEGORY_LABELS[category]}
              </h2>
              <ul className="flex flex-col gap-2">
                {items.map((n) => (
                  <NotificationRow key={n.id} notification={n} onRead={markOneRead} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {notifications.map((n) => (
            <NotificationRow key={n.id} notification={n} onRead={markOneRead} />
          ))}
        </ul>
      )}

      {!exhausted && notifications.length > 0 && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={loadMore}
          className="self-center rounded border border-black/[.1] px-4 py-2 text-sm disabled:opacity-50 dark:border-white/[.15]"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
