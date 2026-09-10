import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMessages, listMyGroups, listMyDirectMessages, listPinnedChats } from "@/app/actions/messaging";
import { MessageThread } from "@/components/messaging/MessageThread";
import { PresenceAvatar } from "@/components/messaging/PresenceAvatar";
import { ChatsList } from "@/components/chat/ChatsList";
import { ChatSearch } from "@/components/chat/ChatSearch";
import { ChatShell } from "@/components/chat/ChatShell";

export default async function DmThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const { userId: recipientId } = await params;
  if (recipientId === profile.id) redirect("/chats");

  const { m } = await searchParams;
  const highlightMessageId = m != null && Number.isInteger(Number(m)) ? Number(m) : null;

  const admin = createAdminClient();
  const { data: recipient } = await admin
    .from("profiles")
    .select("id, username, display_name, avatar_url, status")
    .eq("id", recipientId)
    .maybeSingle();
  if (!recipient || recipient.status !== "active") notFound();

  // A search deep link may point at a message older than the default
  // 100-message window (see T-CODE-34 report) — widen it to the max the
  // schema allows so the target message is actually present to scroll to.
  const messagesResult = await listMessages({ recipientId }, highlightMessageId != null ? 200 : undefined);
  if ("error" in messagesResult) {
    if (messagesResult.error.code === "NOT_AUTHENTICATED" || messagesResult.error.code === "ACCOUNT_NOT_ACTIVE") {
      redirect("/login");
    }
    notFound();
  }

  const [groupsResult, dmsResult, pinnedResult] = await Promise.all([
    listMyGroups(),
    listMyDirectMessages(),
    listPinnedChats(),
  ]);
  const sidebarGroups = "groups" in groupsResult ? groupsResult.groups : [];
  const sidebarDms = "dms" in dmsResult ? dmsResult.dms : [];
  const sidebarPinned = "pinned" in pinnedResult ? pinnedResult.pinned : { groupIds: [], dmUserIds: [] };

  return (
    <ChatShell
      showSidebarOnMobile={false}
      sidebar={
        <>
          <h1 className="text-xl font-semibold text-foreground">Chats</h1>
          <ChatSearch />
          <ChatsList
            currentUserId={profile.id}
            initialGroups={sidebarGroups}
            initialDms={sidebarDms}
            initialPinned={sidebarPinned}
          />
        </>
      }
    >
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 sm:p-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PresenceAvatar userId={recipient.id} name={recipient.display_name} src={recipient.avatar_url} />
            <div>
              <h1 className="text-xl font-semibold">{recipient.display_name}</h1>
              <p className="text-sm text-black/60 dark:text-white/60">@{recipient.username}</p>
            </div>
          </div>
          <Link href="/chats" className="text-sm underline underline-offset-4 lg:hidden">
            Back to chats
          </Link>
        </div>

        <MessageThread
          target={{ recipientId }}
          currentUserId={profile.id}
          currentUserDisplayName={profile.displayName}
          initialMessages={messagesResult.messages}
          canModerate={false}
          isGroup={false}
          highlightMessageId={highlightMessageId}
        />
      </main>
    </ChatShell>
  );
}
