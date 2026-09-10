import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/session";
import { listMyGroups, listMyDirectMessages, listPinnedChats } from "@/app/actions/messaging";
import { ChatsList } from "@/components/chat/ChatsList";
import { ChatSearch } from "@/components/chat/ChatSearch";
import { ChatShell } from "@/components/chat/ChatShell";

export default async function ChatsPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const [groupsResult, dmsResult, pinnedResult] = await Promise.all([
    listMyGroups(),
    listMyDirectMessages(),
    listPinnedChats(),
  ]);
  const groups = "groups" in groupsResult ? groupsResult.groups : [];
  const dms = "dms" in dmsResult ? dmsResult.dms : [];
  const pinned = "pinned" in pinnedResult ? pinnedResult.pinned : { groupIds: [], dmUserIds: [] };

  return (
    <ChatShell
      showSidebarOnMobile
      sidebar={
        <>
          <h1 className="text-xl font-semibold text-foreground">Chats</h1>
          <ChatSearch />
          <ChatsList currentUserId={profile.id} initialGroups={groups} initialDms={dms} initialPinned={pinned} />
        </>
      }
    >
      <div className="hidden h-full flex-1 items-center justify-center p-10 text-sm text-muted-foreground lg:flex">
        Select a chat to start messaging.
      </div>
    </ChatShell>
  );
}
