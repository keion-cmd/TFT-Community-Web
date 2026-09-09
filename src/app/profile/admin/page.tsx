import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  approveMember,
  rejectMember,
  suspendMember,
  reinstateMember,
} from "@/app/actions/members";
import { MemberActionForm } from "./MemberActionForm";
import { RoleChangeForm } from "./RoleChangeForm";

export default async function AdminMemberApprovalQueuePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");
  if (profile.roleRank < ADMIN_MIN_RANK) redirect("/profile");

  const admin = createAdminClient();

  const { data: pending } = await admin
    .from("profiles")
    .select("id, username, display_name, created_at")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });

  const { data: members } = await admin
    .from("profiles")
    .select("id, username, display_name, status, role_id, roles ( name, rank )")
    .in("status", ["active", "suspended", "disabled"])
    .order("username", { ascending: true });

  const { data: roles } = await admin.from("roles").select("id, name, rank").order("rank", { ascending: true });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin Tools — Member Approval Queue</h1>
        <div className="flex items-center gap-4">
          <Link href="/profile/admin/positions" className="text-sm underline underline-offset-4">
            Positions Manager
          </Link>
          <Link href="/profile" className="text-sm underline underline-offset-4">
            Back to profile
          </Link>
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Pending approvals{pending && pending.length > 0 ? ` (${pending.length})` : ""}
        </h2>
        {!pending || pending.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">Nothing waiting on review.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((applicant) => (
              <li
                key={applicant.id}
                className="flex flex-col justify-between gap-3 rounded-lg border border-black/[.08] dark:border-white/[.145] p-4 sm:flex-row sm:items-center"
              >
                <div>
                  <p className="font-medium">{applicant.display_name}</p>
                  <p className="text-sm text-black/60 dark:text-white/60">@{applicant.username}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <MemberActionForm
                    action={approveMember}
                    userId={applicant.id}
                    label="Approve"
                    variant="primary"
                  />
                  <MemberActionForm
                    action={rejectMember}
                    userId={applicant.id}
                    label="Reject"
                    variant="danger"
                    requireReason
                    confirmMessage="Reject this application?"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Members
        </h2>
        {!members || members.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No members yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {members.map((member) => {
              const role = Array.isArray(member.roles) ? member.roles[0] : member.roles;
              const roleRank = (role as { rank: number } | null)?.rank ?? 10;
              return (
                <li
                  key={member.id}
                  className="flex flex-col gap-3 rounded-lg border border-black/[.08] dark:border-white/[.145] p-4"
                >
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div>
                      <p className="font-medium">
                        {member.display_name}{" "}
                        <span className="text-xs font-normal text-black/50 dark:text-white/50">
                          ({role?.name ?? "Member"})
                        </span>
                      </p>
                      <p className="text-sm text-black/60 dark:text-white/60">
                        @{member.username} — {member.status}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {member.status === "active" ? (
                        <MemberActionForm
                          action={suspendMember}
                          userId={member.id}
                          label="Suspend"
                          variant="danger"
                          requireReason
                          confirmMessage="Suspend this member? Their sessions are revoked immediately."
                        />
                      ) : (
                        <MemberActionForm
                          action={reinstateMember}
                          userId={member.id}
                          label="Reinstate"
                          variant="primary"
                          confirmMessage="Reinstate this member?"
                        />
                      )}
                      <Link
                        href={`/profile/admin/staff-exit/${member.id}`}
                        className="rounded bg-black/[.06] px-3 py-1.5 text-sm font-medium hover:bg-black/[.1] dark:bg-white/[.1] dark:hover:bg-white/[.15]"
                      >
                        Staff Exit
                      </Link>
                    </div>
                  </div>

                  <RoleChangeForm
                    userId={member.id}
                    username={member.username}
                    currentRoleId={member.role_id}
                    currentRoleName={role?.name ?? "Member"}
                    currentRoleRank={roleRank}
                    viewerRoleRank={profile.roleRank}
                    roles={roles ?? []}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
