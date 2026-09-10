"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { touchLastSeen } from "@/app/actions/presence";
import { PRESENCE_ONLINE_CHANNEL } from "@/lib/messaging/presence";

const OnlineUsersContext = createContext<Set<string>>(new Set());

// Global Presence channel — one per session, mounted once in (app)/layout.tsx
// so every screen shares the same online/offline view (per
// docs/messaging-audit.md §12: "presence channel usage" was the flagged
// gap). Presence's own join/leave events are the source of truth for
// online/offline; nothing here is polled or client-self-reported.
//
// Private channel (see 0013_presence_typing.sql): membership in this
// channel's topic is gated the same way postgres_changes reads are gated
// elsewhere, even though for the global channel that boundary is as wide as
// "any authenticated approved user" (profiles are already globally
// readable, so this adds no new exposure).
export function PresenceProvider({ currentUserId, children }: { currentUserId: string; children: React.ReactNode }) {
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(PRESENCE_ONLINE_CHANNEL, {
      config: { presence: { key: currentUserId }, private: true },
    });

    channel.on("presence", { event: "sync" }, () => {
      setOnlineIds(new Set(Object.keys(channel.presenceState())));
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        channel.track({ onlineAt: new Date().toISOString() });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId]);

  // Keep the current user's own last_active_at fresh while they're actively
  // using the app: touch_last_seen() is self-only (0013_presence_typing.sql),
  // so this has to be a self-call rather than something a peer's leave event
  // can drive. On mount and whenever the tab regains visibility, not on a
  // timer — cheap enough not to need debouncing beyond that.
  useEffect(() => {
    touchLastSeen(currentUserId);
    const onVisible = () => {
      if (document.visibilityState === "visible") touchLastSeen(currentUserId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [currentUserId]);

  return <OnlineUsersContext.Provider value={onlineIds}>{children}</OnlineUsersContext.Provider>;
}

export function useOnlineUsers(): Set<string> {
  return useContext(OnlineUsersContext);
}

export function useIsOnline(userId: string | null | undefined): boolean {
  const online = useOnlineUsers();
  return userId != null && online.has(userId);
}
