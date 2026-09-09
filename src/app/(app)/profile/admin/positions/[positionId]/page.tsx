import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokePosition, listEligibleReplacements } from "@/app/actions/positions";
import { PositionForm } from "../PositionForm";
import { PositionActionForm } from "../PositionActionForm";
import { AssignHolderForm } from "./AssignHolderForm";

export default async function PositionDetailPage({
  params,
}: {
  params: Promise<{ positionId: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");
  if (profile.roleRank < ADMIN_MIN_RANK) redirect("/profile");

  const { positionId: positionIdParam } = await params;
  const positionId = Number(positionIdParam);
  if (!Number.isInteger(positionId) || positionId <= 0) notFound();

  const admin = createAdminClient();

  const { data: position } = await admin
    .from("positions")
    .select("id, name, description, min_role_id, is_exclusive, is_active, roles ( name )")
    .eq("id", positionId)
    .maybeSingle();
  if (!position) notFound();

  const { data: holderRows } = await admin
    .from("user_positions")
    .select("id, user_id, assigned_at")
    .eq("position_id", positionId)
    .is("revoked_at", null)
    .order("assigned_at", { ascending: true });

  // Two round trips instead of an embedded select — user_positions has
  // three FKs to profiles (user_id/assigned_by/revoked_by), so an embed
  // needs a disambiguation hint; explicit queries keep this simple and
  // match the rest of this codebase (see src/lib/auth/profile.ts).
  const holderUserIds = (holderRows ?? []).map((row) => row.user_id);
  const { data: holderProfiles } = holderUserIds.length
    ? await admin.from("profiles").select("id, username, display_name").in("id", holderUserIds)
    : { data: [] as { id: string; username: string; display_name: string }[] };
  const profileById = new Map((holderProfiles ?? []).map((p) => [p.id, p]));
  const holders = (holderRows ?? []).map((row) => ({
    id: row.id,
    profile: profileById.get(row.user_id) ?? null,
  }));

  const { data: roles } = await admin
    .from("roles")
    .select("id, name, rank")
    .order("rank", { ascending: true });

  const eligibleResult = await listEligibleReplacements(positionId);
  const eligibleUsers = "users" in eligibleResult ? eligibleResult.users : [];

  const role = Array.isArray(position.roles) ? position.roles[0] : position.roles;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{position.name}</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Min role: {role?.name ?? "Member"}
            {position.is_exclusive && " · exclusive"}
          </p>
        </div>
        <Link href="/profile/admin/positions" className="text-sm underline underline-offset-4">
          Back to positions
        </Link>
      </div>

      {!position.is_active && (
        <p className="rounded-lg border border-red-600/30 bg-red-600/10 p-3 text-sm text-red-600">
          This position is inactive. Existing holders and history are preserved, but new holders
          cannot be assigned.
        </p>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Edit position
        </h2>
        <PositionForm
          mode="edit"
          roles={roles ?? []}
          position={{
            id: position.id,
            name: position.name,
            description: position.description,
            minRoleId: position.min_role_id,
            isExclusive: position.is_exclusive,
          }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Current holders{holders.length > 0 ? ` (${holders.length})` : ""}
        </h2>
        {holders.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">No one currently holds this position.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {holders.map((holder) => (
              <li
                key={holder.id}
                className="flex flex-col justify-between gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145] sm:flex-row sm:items-center"
              >
                <div>
                  <p className="font-medium">{holder.profile?.display_name ?? "Unknown member"}</p>
                  <p className="text-sm text-black/60 dark:text-white/60">
                    @{holder.profile?.username ?? "unknown"}
                  </p>
                </div>
                <PositionActionForm
                  action={revokePosition}
                  hiddenFields={[{ name: "userPositionId", value: String(holder.id) }]}
                  label="Revoke"
                  variant="danger"
                  requireReason
                  confirmMessage={`Revoke ${holder.profile?.display_name ?? "this holder"}'s position?`}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
          Assign a new holder
        </h2>
        {position.is_active ? (
          <AssignHolderForm positionId={position.id} eligibleUsers={eligibleUsers} />
        ) : (
          <p className="text-sm text-black/60 dark:text-white/60">
            Reactivate this position before assigning new holders.
          </p>
        )}
      </section>
    </main>
  );
}
