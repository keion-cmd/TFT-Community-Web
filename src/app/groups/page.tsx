import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";
import { CreateGroupForm } from "./CreateGroupForm";
import { JoinGroupButton } from "./JoinGroupButton";

export default async function GroupsBrowsePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  // Session client, RLS-governed — NOT the service-role client. This is
  // what makes "staff/admin-only groups the user isn't a member of don't
  // appear at all" an actually-enforced property rather than an assumption:
  // the "groups visible per type" policy (0002_group_overview.sql) is what
  // filters this query, not app-layer logic. Confirmed by reading both
  // permissive SELECT policies together (0001 + 0002 combine via OR) — see
  // the comment above joinGroup in src/app/actions/messaging.ts and the
  // T-CODE-08 report.
  const supabase = await createClient();
  const { data: visibleGroups } = await supabase
    .from("groups")
    .select("id, name, type, description, archived_at")
    .is("archived_at", null)
    .order("name", { ascending: true });

  const { data: myMemberships } = await supabase
    .from("group_members")
    .select("group_id")
    .eq("user_id", profile.id);
  const myGroupIds = new Set((myMemberships ?? []).map((m) => m.group_id));

  const groups = visibleGroups ?? [];
  const myGroups = groups.filter((g) => myGroupIds.has(g.id));
  const joinableGroups = groups.filter((g) => !myGroupIds.has(g.id));

  const isAdmin = profile.roleRank >= ADMIN_MIN_RANK;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Groups</h1>
        <Link href="/chats" className="text-sm underline underline-offset-4">
          Back to chats
        </Link>
      </div>

      {isAdmin && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
            + Create Group
          </h2>
          <CreateGroupForm />
        </section>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Your groups
        </h2>
        {myGroups.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">You haven&apos;t joined any groups yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {myGroups.map((g) => (
              <li
                key={g.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
              >
                <div>
                  <p className="font-medium">{g.name}</p>
                  <p className="text-sm text-black/60 dark:text-white/60">{g.type}</p>
                </div>
                <Link href={`/groups/${g.id}`} className="text-sm underline underline-offset-4">
                  Open →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Joinable groups
        </h2>
        {joinableGroups.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">Nothing to join right now.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {joinableGroups.map((g) => (
              <li
                key={g.id}
                className="flex flex-col justify-between gap-3 rounded-lg border border-black/[.08] p-4 sm:flex-row sm:items-center dark:border-white/[.145]"
              >
                <div>
                  <p className="font-medium">{g.name}</p>
                  <p className="text-sm text-black/60 dark:text-white/60">{g.type}</p>
                  {g.description && <p className="text-sm text-black/60 dark:text-white/60">{g.description}</p>}
                </div>
                <JoinGroupButton groupId={g.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
