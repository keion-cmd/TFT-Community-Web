import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { deactivatePosition } from "@/app/actions/positions";
import { PositionForm } from "./PositionForm";
import { PositionActionForm } from "./PositionActionForm";

export default async function PositionsManagerPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");
  if (profile.roleRank < ADMIN_MIN_RANK) redirect("/profile");

  const admin = createAdminClient();

  const { data: positions } = await admin
    .from("positions")
    .select("id, name, description, min_role_id, is_exclusive, is_active, roles ( name )")
    .order("is_active", { ascending: false })
    .order("name", { ascending: true });

  const { data: roles } = await admin
    .from("roles")
    .select("id, name, rank")
    .order("rank", { ascending: true });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin Tools — Positions Manager</h1>
        <Link href="/profile/admin" className="text-sm underline underline-offset-4">
          Back to admin tools
        </Link>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Create a position
        </h2>
        <PositionForm mode="create" roles={roles ?? []} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          All positions
        </h2>
        {!positions || positions.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No positions yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {positions.map((position) => {
              const role = Array.isArray(position.roles) ? position.roles[0] : position.roles;
              return (
                <li
                  key={position.id}
                  className={`flex flex-col justify-between gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145] sm:flex-row sm:items-center ${
                    position.is_active ? "" : "opacity-60"
                  }`}
                >
                  <div>
                    <p className="font-medium">
                      {position.name}{" "}
                      {!position.is_active && (
                        <span className="text-xs font-normal text-red-600">(inactive)</span>
                      )}
                      {position.is_exclusive && (
                        <span className="text-xs font-normal text-black/50 dark:text-white/50">
                          {" "}
                          · exclusive
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-black/60 dark:text-white/60">
                      Min role: {role?.name ?? "Member"}
                    </p>
                    {position.description && (
                      <p className="text-sm text-black/60 dark:text-white/60">{position.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/profile/admin/positions/${position.id}`}
                      className="text-sm underline underline-offset-4"
                    >
                      Manage →
                    </Link>
                    {position.is_active && (
                      <PositionActionForm
                        action={deactivatePosition}
                        hiddenFields={[{ name: "positionId", value: String(position.id) }]}
                        label="Deactivate"
                        variant="danger"
                        confirmMessage="Deactivate this position? Existing holders and history are kept, but no new holders can be assigned."
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
