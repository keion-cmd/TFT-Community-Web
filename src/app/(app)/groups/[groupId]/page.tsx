import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMessages, listMyGroups, listMyDirectMessages, listPinnedChats } from "@/app/actions/messaging";
import { MessageThread } from "@/components/messaging/MessageThread";
import { ChatsList } from "@/components/chat/ChatsList";
import { ChatSearch } from "@/components/chat/ChatSearch";
import { ChatShell } from "@/components/chat/ChatShell";
import { GroupMembersPanel } from "./GroupMembersPanel";

export default async function GroupThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const { groupId: groupIdParam } = await params;
  const groupId = Number(groupIdParam);
  if (!Number.isInteger(groupId) || groupId <= 0) notFound();

  const { m } = await searchParams;
  const highlightMessageId = m != null && Number.isInteger(Number(m)) ? Number(m) : null;

  // Session client, not the service-role client: this read must go through
  // RLS's "groups visible per type" policy (0002_group_overview.sql) so an
  // ineligible user gets a clean 404 rather than an app-layer guess at
  // visibility. See T-CODE-08 report re: confirming this isn't just assumed.
  const supabase = await createClient();
  const { data: group } = await supabase
    .from("groups")
    .select("id, name, type, description, location, pinned_message_id, archived_at")
    .eq("id", groupId)
    .maybeSingle();
  if (!group) notFound();

  const { data: membership } = await supabase
    .from("group_members")
    .select("id, role_in_group, muted_until")
    .eq("group_id", groupId)
    .eq("user_id", profile.id)
    .maybeSingle();

  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;
  if (!membership && !isAdmin) redirect("/groups");

  const canModerate = isAdmin || membership?.role_in_group === "moderator" || membership?.role_in_group === "coordinator";

  const messagesResult = await listMessages({ groupId }, highlightMessageId != null ? 200 : undefined);
  const initialMessages = "messages" in messagesResult ? messagesResult.messages : [];

  const admin = createAdminClient();
  const { data: memberRows } = await admin
    .from("group_members")
    .select("id, user_id, role_in_group, muted_until")
    .eq("group_id", groupId)
    .order("joined_at", { ascending: true });
  const memberUserIds = (memberRows ?? []).map((m) => m.user_id);
  const { data: memberProfiles } = memberUserIds.length
    ? await admin.from("profiles").select("id, username, display_name").in("id", memberUserIds)
    : { data: [] as { id: string; username: string; display_name: string }[] };
  const profileById = new Map((memberProfiles ?? []).map((p) => [p.id, p]));
  const members = (memberRows ?? []).map((m) => ({
    id: m.id,
    userId: m.user_id,
    roleInGroup: m.role_in_group,
    mutedUntil: m.muted_until,
    profile: profileById.get(m.user_id) ?? null,
  }));

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
          <div>
            <Link href={`/groups/${group.id}/overview`} className="hover:underline">
              <h1 className="text-xl font-semibold">{group.name}</h1>
            </Link>
            <p className="text-sm text-black/60 dark:text-white/60">
              {group.type}
              {group.location ? ` · ${group.location}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href={`/groups/${group.id}/overview`} className="text-sm underline underline-offset-4">
              Overview
            </Link>
            <Link href="/chats" className="text-sm underline underline-offset-4 lg:hidden">
              Back to chats
            </Link>
          </div>
        </div>

        {group.archived_at && (
          <p className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-sm text-red-600">
            This group is archived.
          </p>
        )}

        {group.description && <p className="text-sm text-black/60 dark:text-white/60">{group.description}</p>}

        <MessageThread
          target={{ groupId }}
          currentUserId={profile.id}
          initialMessages={initialMessages}
          canModerate={canModerate}
          isGroup
          pinnedMessageId={group.pinned_message_id}
          highlightMessageId={highlightMessageId}
        />

        {canModerate && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
              Members
            </h2>
            <GroupMembersPanel groupId={groupId} members={members} currentUserId={profile.id} />
          </section>
        )}
      </main>
    </ChatShell>
  );
}
