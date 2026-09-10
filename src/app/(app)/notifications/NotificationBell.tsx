"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getUnreadCount } from "@/app/actions/notifications";
import { Badge } from "@/components/ui/Badge";

// Dropped into each screen's existing ad hoc header row (this repo has no
// shared nav shell yet — see T-CODE-17 report) rather than a new nav
// component. Subscribes to this user's own notifications rows, same
// postgres_changes-per-filtered-column pattern MessageThread.tsx uses for
// live messages (Phase 5-E) — refetching the count on any insert/update is
// simplest-and-correct here, same rationale as that component's refetch().
export function NotificationBell({ userId }: { userId: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refetch() {
      const result = await getUnreadCount();
      if (!cancelled && "count" in result) setCount(result.count);
    }

    refetch();

    const supabase = createClient();
    const channel = supabase.channel(`notifications:${userId}`);
    channel
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        () => refetch(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return (
    <Link href="/notifications" className="relative text-sm text-foreground hover:text-accent">
      Notifications
      {count !== null && count > 0 && (
        <Badge
          variant="danger"
          className="absolute -right-3 -top-2 min-w-4 justify-center px-1 py-0 text-[10px] leading-4"
        >
          {count > 99 ? "99+" : count}
        </Badge>
      )}
    </Link>
  );
}
