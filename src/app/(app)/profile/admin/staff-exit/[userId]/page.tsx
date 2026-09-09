import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStaffExitChecklist } from "@/app/actions/staffExit";
import { listEligibleReplacements } from "@/app/actions/positions";
import { listEligibleScheduleAssignees } from "@/app/actions/scheduling";
import { listEligibleCoordinators } from "@/app/actions/groupOverview";
import { StaffExitItemRow } from "./StaffExitItemRow";
import { FinalizeExitForm } from "./FinalizeExitForm";

export default async function StaffExitPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;

  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");
  if (profile.roleRank < ADMIN_MIN_RANK) redirect("/profile");

  const admin = createAdminClient();
  const { data: target } = await admin
    .from("profiles")
    .select("id, username, display_name")
    .eq("id", userId)
    .maybeSingle();
  if (!target) notFound();

  const checklist = await getStaffExitChecklist(userId);
  if ("error" in checklist) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6 sm:p-10">
        <p className="text-sm text-red-600">{checklist.error.message}</p>
      </main>
    );
  }

  const [positionEligibility, scheduleEligibility, groupEligibility] = await Promise.all([
    Promise.all(
      checklist.positions.map((item) => listEligibleReplacements(item.positionId)),
    ),
    Promise.all(
      checklist.schedules.map((item) => listEligibleScheduleAssignees(item.itemId)),
    ),
    Promise.all(
      checklist.groups
        .filter((g) => g.itemType === "group_coordinator")
        .map((item) => listEligibleCoordinators(item.itemId)),
    ),
  ]);

  const coordinatorGroups = checklist.groups.filter((g) => g.itemType === "group_coordinator");
  const moderatorGroups = checklist.groups.filter((g) => g.itemType === "group_moderator");

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          Staff Exit — {target.display_name} (@{target.username})
        </h1>
        <Link href="/profile/admin" className="text-sm underline underline-offset-4">
          Back to Admin Tools
        </Link>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Positions
        </h2>
        {checklist.positions.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No active positions held.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {checklist.positions.map((item, index) => {
              const eligibility = positionEligibility[index];
              const eligibleUsers =
                "users" in eligibility
                  ? eligibility.users.map((u) => ({ userId: u.id, username: u.username, displayName: u.displayName }))
                  : [];
              return (
                <StaffExitItemRow
                  key={item.itemId}
                  itemType="position"
                  itemId={item.itemId}
                  label={item.positionName}
                  eligibleUsers={eligibleUsers}
                />
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Future schedules
        </h2>
        {checklist.schedules.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No upcoming schedule slots.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {checklist.schedules.map((item, index) => {
              const eligibility = scheduleEligibility[index];
              const eligibleUsers = "users" in eligibility ? eligibility.users : [];
              return (
                <StaffExitItemRow
                  key={item.itemId}
                  itemType="schedule"
                  itemId={item.itemId}
                  label={`${item.date} — ${new Date(item.startTime).toLocaleString()}`}
                  eligibleUsers={eligibleUsers}
                />
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Managed groups
        </h2>
        {checklist.groups.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No coordinator or moderator seats.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {coordinatorGroups.map((item, index) => {
              const eligibility = groupEligibility[index];
              const eligibleUsers =
                "coordinators" in eligibility
                  ? eligibility.coordinators.map((c) => ({
                      userId: c.userId,
                      username: c.username,
                      displayName: c.displayName,
                    }))
                  : [];
              return (
                <StaffExitItemRow
                  key={`coordinator-${item.itemId}`}
                  itemType="group_coordinator"
                  itemId={item.itemId}
                  label={`${item.groupName} — Coordinator`}
                  eligibleUsers={eligibleUsers}
                />
              );
            })}
            {moderatorGroups.map((item) => (
              <li
                key={`moderator-${item.itemId}`}
                className="flex flex-col gap-1 rounded border border-black/[.08] dark:border-white/[.145] p-3"
              >
                <p className="text-sm font-medium">{item.groupName} — Moderator</p>
                <p className="text-xs text-black/50 dark:text-white/50">
                  Non-blocking — no reassign/vacate action exists for a moderator seat in this
                  workflow. Change this manually in the group&apos;s member list if needed.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Owned resources
        </h2>
        {checklist.resources.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No owned group resources.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {checklist.resources.map((item) => (
              <li
                key={item.itemId}
                className="flex flex-col gap-1 rounded border border-black/[.08] dark:border-white/[.145] p-3"
              >
                <p className="text-sm font-medium">
                  {item.title} <span className="text-xs text-black/50 dark:text-white/50">({item.groupName})</span>
                </p>
                <p className="text-xs text-black/50 dark:text-white/50">
                  Non-blocking — resource ownership does not need to be transferred to finalize this exit.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <FinalizeExitForm
        userId={target.id}
        username={target.username}
        disabled={checklist.hasBlockingItems}
      />
    </main>
  );
}
