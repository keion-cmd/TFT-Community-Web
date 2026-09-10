import type { ReactNode } from "react";

type Props = {
  /** Chats search + list — mounted once, shared between the mobile list screen and the desktop sidebar. */
  sidebar: ReactNode;
  /** Page-specific content: the open thread (dm/group) or a placeholder (bare /chats). */
  children: ReactNode;
  /**
   * True only on the /chats route itself, where the "sidebar" content IS the
   * mobile screen. False on /dm/[userId] and /groups/[groupId], where mobile
   * shows the thread full-screen and the list stays off-screen, exactly as
   * before this change.
   */
  showSidebarOnMobile: boolean;
};

// Desktop (lg+): persistent left sidebar + main content, both visible at
// once. Mobile: unchanged — the route system already renders only one of
// list-screen or thread-screen at a time, so this is a CSS-only split with
// a single ChatsList mount (no duplicate realtime subscriptions).
export function ChatShell({ sidebar, children, showSidebarOnMobile }: Props) {
  return (
    <div className="flex flex-1 flex-col lg:flex-row lg:items-start">
      <aside
        className={`flex-col gap-4 border-border p-4 lg:sticky lg:top-0 lg:flex lg:w-80 lg:shrink-0 lg:border-r lg:p-6 ${
          showSidebarOnMobile ? "flex" : "hidden"
        }`}
      >
        {sidebar}
      </aside>

      <div className={`flex-1 flex-col ${showSidebarOnMobile ? "hidden lg:flex" : "flex"}`}>{children}</div>
    </div>
  );
}
