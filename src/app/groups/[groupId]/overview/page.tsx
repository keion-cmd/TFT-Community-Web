import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { getGroupOverview, listEligibleCoordinators } from "@/app/actions/groupOverview";
import { GroupMembersPanel } from "../GroupMembersPanel";
import { CoordinatorPanel } from "./CoordinatorPanel";
import { LocationPanel } from "./LocationPanel";
import { PinnedInfoPanel } from "./PinnedInfoPanel";
import { ResourcesPanel } from "./ResourcesPanel";

function formatSlot(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function GroupOverviewPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const { groupId: groupIdParam } = await params;
  const groupId = Number(groupIdParam);
  if (!Number.isInteger(groupId) || groupId <= 0) notFound();

  const result = await getGroupOverview(groupId);
  if ("error" in result) {
    if (result.error.code === "NOT_FOUND") notFound();
    redirect("/groups");
  }

  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;
  const eligibleResult = isAdmin ? await listEligibleCoordinators(groupId) : null;
  const eligibleCoordinators = eligibleResult && "coordinators" in eligibleResult ? eligibleResult.coordinators : [];

  const { group, members, coordinator, canModerate, upcomingSchedules, pinnedMessage, resources } = result;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{group.name}</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            {group.type}
            {group.location ? ` · ${group.location}` : ""}
          </p>
        </div>
        <Link href={`/groups/${group.id}`} className="text-sm underline underline-offset-4">
          Back to chat
        </Link>
      </div>

      {group.archivedAt && (
        <p className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-sm text-red-600">
          This group is archived.
        </p>
      )}

      {group.description && <p className="text-sm text-black/60 dark:text-white/60">{group.description}</p>}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Members ({members.length})
        </h2>
        <GroupMembersPanel
          groupId={group.id}
          members={members.map((m) => ({
            id: m.id,
            userId: m.userId,
            roleInGroup: m.roleInGroup,
            mutedUntil: m.mutedUntil,
            profile: m.profile
              ? { id: m.profile.id, username: m.profile.username, display_name: m.profile.displayName }
              : null,
          }))}
          currentUserId={profile.id}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Coordinator
        </h2>
        <CoordinatorPanel
          groupId={group.id}
          coordinator={coordinator}
          isAdmin={isAdmin}
          eligibleCoordinators={eligibleCoordinators}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Schedule
        </h2>
        {upcomingSchedules.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No upcoming shifts linked to this group.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcomingSchedules.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]"
              >
                <span>
                  {formatSlot(s.startTime)} – {formatSlot(s.endTime)}
                </span>
                <span className="text-xs text-black/50 dark:text-white/50">{s.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Location
        </h2>
        <LocationPanel groupId={group.id} location={group.location} canEdit={isAdmin || canModerate} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Pinned Info
        </h2>
        <PinnedInfoPanel groupId={group.id} pinnedMessage={pinnedMessage} canModerate={isAdmin || canModerate} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Files / Resources
        </h2>
        <ResourcesPanel
          groupId={group.id}
          resources={resources}
          currentUserId={profile.id}
          canModerate={isAdmin || canModerate}
        />
      </section>

      {isAdmin && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
            Group Settings
          </h2>
          <p className="text-sm text-black/60 dark:text-white/60">
            Only Location is editable here for now — name/description/type/archive editing is a separate task.
          </p>
        </section>
      )}
    </main>
  );
}
