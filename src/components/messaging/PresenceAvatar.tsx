"use client";

import { Avatar, type AvatarProps } from "@/components/ui/Avatar";
import { useIsOnline } from "@/components/presence/PresenceProvider";

// Thin client wrapper so Server Component thread headers (dm/[userId]/page.tsx)
// can show a live online dot without becoming Client Components themselves.
export function PresenceAvatar({ userId, ...avatarProps }: AvatarProps & { userId: string }) {
  const online = useIsOnline(userId);
  return <Avatar {...avatarProps} online={online} />;
}
