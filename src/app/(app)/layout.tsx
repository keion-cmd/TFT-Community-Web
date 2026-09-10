import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/session";
import { BottomNav } from "@/components/nav/BottomNav";
import { NotificationBell } from "./notifications/NotificationBell";

// Shared shell for every authenticated screen — per
// docs/TFT-Revision-UnifiedApp.md section B ("one shell, same nav for
// everyone") and the T-CODE-17 finding that no shared nav shell existed.
// Auth/unauthenticated screens (login, register, forgot-password,
// pending-approval) live outside the `(app)` route group and don't get
// this chrome.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="text-sm font-semibold tracking-wide text-accent">TFT</span>
        <NotificationBell userId={profile.id} />
      </header>

      <div className="flex-1 pb-16">{children}</div>

      <BottomNav />
    </div>
  );
}
