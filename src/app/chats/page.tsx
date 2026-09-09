import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { listMyGroups, listMyDirectMessages } from "@/app/actions/messaging";
import { ChatsList } from "./ChatsList";
import { NotificationBell } from "@/app/notifications/NotificationBell";

export default async function ChatsPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const [groupsResult, dmsResult] = await Promise.all([listMyGroups(), listMyDirectMessages()]);
  const groups = "groups" in groupsResult ? groupsResult.groups : [];
  const dms = "dms" in dmsResult ? dmsResult.dms : [];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Chats</h1>
        <div className="flex items-center gap-4">
          <NotificationBell userId={profile.id} />
          <Link href="/groups" className="text-sm underline underline-offset-4">
            Browse groups
          </Link>
          <Link href="/profile" className="text-sm underline underline-offset-4">
            Back to profile
          </Link>
        </div>
      </div>

      <ChatsList currentUserId={profile.id} initialGroups={groups} initialDms={dms} />
    </main>
  );
}
