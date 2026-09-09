import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMessages } from "@/app/actions/messaging";
import { MessageThread } from "@/components/messaging/MessageThread";

export default async function DmThreadPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const { userId: recipientId } = await params;
  if (recipientId === profile.id) redirect("/chats");

  const admin = createAdminClient();
  const { data: recipient } = await admin
    .from("profiles")
    .select("id, username, display_name, status")
    .eq("id", recipientId)
    .maybeSingle();
  if (!recipient || recipient.status !== "active") notFound();

  const messagesResult = await listMessages({ recipientId });
  if ("error" in messagesResult) {
    if (messagesResult.error.code === "NOT_AUTHENTICATED" || messagesResult.error.code === "ACCOUNT_NOT_ACTIVE") {
      redirect("/login");
    }
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{recipient.display_name}</h1>
          <p className="text-sm text-black/60 dark:text-white/60">@{recipient.username}</p>
        </div>
        <Link href="/chats" className="text-sm underline underline-offset-4">
          Back to chats
        </Link>
      </div>

      <MessageThread
        target={{ recipientId }}
        currentUserId={profile.id}
        initialMessages={messagesResult.messages}
        canModerate={false}
        isGroup={false}
      />
    </main>
  );
}
