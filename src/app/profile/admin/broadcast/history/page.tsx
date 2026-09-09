import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { listBroadcastHistory } from "@/app/actions/broadcast";
import { BroadcastHistoryRow } from "./BroadcastHistoryRow";

export default async function BroadcastHistoryPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");
  if (profile.roleRank < ADMIN_MIN_RANK) redirect("/profile");

  const result = await listBroadcastHistory({ limit: 20 });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Broadcast History</h1>
        <div className="flex items-center gap-4">
          <Link href="/profile/admin/broadcast" className="text-sm underline underline-offset-4">
            Compose
          </Link>
          <Link href="/profile/admin" className="text-sm underline underline-offset-4">
            Back to Admin Tools
          </Link>
        </div>
      </div>

      {"error" in result ? (
        <p className="text-sm text-red-600">{result.error.message}</p>
      ) : result.broadcasts.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No broadcasts sent yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {result.broadcasts.map((broadcast) => (
            <BroadcastHistoryRow key={broadcast.id} broadcast={broadcast} />
          ))}
        </ul>
      )}
    </main>
  );
}
