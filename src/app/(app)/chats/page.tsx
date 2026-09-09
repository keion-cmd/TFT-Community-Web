import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/session";
import { listMyGroups, listMyDirectMessages } from "@/app/actions/messaging";
import { ChatsList } from "./ChatsList";

export default async function ChatsPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const [groupsResult, dmsResult] = await Promise.all([listMyGroups(), listMyDirectMessages()]);
  const groups = "groups" in groupsResult ? groupsResult.groups : [];
  const dms = "dms" in dmsResult ? dmsResult.dms : [];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 sm:p-10">
      <h1 className="text-xl font-semibold">Chats</h1>

      <ChatsList currentUserId={profile.id} initialGroups={groups} initialDms={dms} />
    </main>
  );
}
