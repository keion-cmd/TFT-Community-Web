"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeRole } from "@/app/actions/roles";

type RoleOption = { id: number; name: string; rank: number };

type Props = {
  userId: string;
  username: string;
  currentRoleId: number;
  currentRoleName: string;
  currentRoleRank: number;
  viewerRoleRank: number;
  roles: RoleOption[];
};

const SUPER_ADMIN_TIER_RANK = 50;

// Phase 6-C: standard confirm listing consequences for most role changes;
// Super-Admin-tier changes (promoting into it or demoting out of it) get
// the heavier re-type-the-target's-username confirmation instead.
export function RoleChangeForm({
  userId,
  username,
  currentRoleId,
  currentRoleName,
  currentRoleRank,
  viewerRoleRank,
  roles,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedRoleId, setSelectedRoleId] = useState(currentRoleId);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const isSuperAdminTierChange =
    currentRoleRank >= SUPER_ADMIN_TIER_RANK || (selectedRole?.rank ?? 0) >= SUPER_ADMIN_TIER_RANK;
  const canEditThisRow = viewerRoleRank >= SUPER_ADMIN_TIER_RANK || currentRoleRank < SUPER_ADMIN_TIER_RANK;
  const availableRoles = roles.filter(
    (r) => viewerRoleRank >= SUPER_ADMIN_TIER_RANK || r.rank < SUPER_ADMIN_TIER_RANK,
  );

  const noChange = selectedRoleId === currentRoleId;
  const confirmSatisfied = isSuperAdminTierChange ? confirmText.trim() === username : true;

  if (!canEditThisRow) {
    return (
      <p className="text-xs text-black/50 dark:text-white/50">
        Only a Super Admin can change this member&apos;s role.
      </p>
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (noChange) return;
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }

    if (!isSuperAdminTierChange) {
      const ok = window.confirm(
        `Change ${username}'s role from ${currentRoleName} to ${selectedRole?.name}? This takes effect immediately.`,
      );
      if (!ok) return;
    } else if (!confirmSatisfied) {
      setError(`Type "${username}" to confirm this Super Admin tier change.`);
      return;
    }

    startTransition(async () => {
      const result = await changeRole(userId, selectedRoleId, reason.trim());
      if ("error" in result) {
        setError(result.error.message);
        return;
      }
      setSuccess(true);
      setReason("");
      setConfirmText("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded border border-black/[.08] dark:border-white/[.145] p-3">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-black/60 dark:text-white/60">Role</label>
        <select
          value={selectedRoleId}
          onChange={(event) => setSelectedRoleId(Number(event.target.value))}
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-2 py-1 text-sm"
        >
          {availableRoles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </div>

      {!noChange && (
        <>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (required)"
            rows={2}
            className="w-full rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-2 py-1 text-sm"
          />
          {isSuperAdminTierChange && (
            <input
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={`Type "${username}" to confirm`}
              className="w-full rounded border border-red-400/60 bg-transparent px-2 py-1 text-sm"
            />
          )}
          <button
            type="submit"
            disabled={isPending || (isSuperAdminTierChange && !confirmSatisfied)}
            className="w-fit rounded bg-black/[.08] px-3 py-1.5 text-sm font-medium hover:bg-black/[.12] disabled:opacity-50 dark:bg-white/[.1] dark:hover:bg-white/[.15]"
          >
            {isPending ? "Working…" : "Save role change"}
          </button>
        </>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-emerald-600">Role updated.</p>}
    </form>
  );
}
