import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/session";
import { listMyGroups, listMyDirectMessages, listPinnedChats } from "@/app/actions/messaging";
import { ChatsList } from "./ChatsList";
import { ChatSearch } from "./ChatSearch";

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
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 sm:p-10">
      <h1 className="text-xl font-semibold">Chats</h1>

      <ChatSearch />

      <ChatsList currentUserId={profile.id} initialGroups={groups} initialDms={dms} initialPinned={pinned} />
    </main>
  );
}
