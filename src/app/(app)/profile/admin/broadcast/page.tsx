import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { BroadcastComposeForm } from "./BroadcastComposeForm";

export default async function BroadcastCenterPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");
  if (profile.roleRank < ADMIN_MIN_RANK) redirect("/profile");

  const admin = createAdminClient();
  const { data: groups } = await admin
    .from("groups")
    .select("id, name, type")
    .is("archived_at", null)
    .order("name", { ascending: true });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Broadcast Center</h1>
        <div className="flex items-center gap-4">
          <Link href="/profile/admin/broadcast/history" className="text-sm underline underline-offset-4">
            History
          </Link>
          <Link href="/profile/admin" className="text-sm underline underline-offset-4">
            Back to Admin Tools
          </Link>
        </div>
      </div>

      <BroadcastComposeForm groups={groups ?? []} />
    </main>
  );
}
