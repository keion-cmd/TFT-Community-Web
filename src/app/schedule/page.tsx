import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { listSchedules } from "@/app/actions/scheduling";
import { ScheduleBoard } from "./ScheduleBoard";

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export default async function SchedulePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;

  // Default window: yesterday through two weeks out. Prev/Next week
  // controls in ScheduleBoard shift this client-side via listSchedules.
  const rangeStart = isoDaysFromNow(-1);
  const rangeEnd = isoDaysFromNow(14);
  const result = await listSchedules(rangeStart, rangeEnd);
  const initialSchedules = "schedules" in result ? result.schedules : [];

  const admin = createAdminClient();
  const { data: positions } = isAdmin
    ? await admin.from("positions").select("id, name").eq("is_active", true).order("name", { ascending: true })
    : { data: [] as { id: number; name: string }[] };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Schedule</h1>
        <Link href="/profile" className="text-sm underline underline-offset-4">
          Back to profile
        </Link>
      </div>

      <ScheduleBoard
        currentUserId={profile.id}
        isAdmin={isAdmin}
        positions={positions ?? []}
        initialSchedules={initialSchedules}
        initialRangeStart={rangeStart}
        initialRangeEnd={rangeEnd}
      />
    </main>
  );
}
