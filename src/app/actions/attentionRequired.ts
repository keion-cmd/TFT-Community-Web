"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthorizationError } from "@/lib/auth/session";
import type { ActionError } from "./types";

function fromAuthzError(err: unknown): ActionError {
  if (err instanceof AuthorizationError) {
    const AUTHZ_MESSAGES: Record<AuthorizationError["code"], ActionError> = {
      NOT_AUTHENTICATED: { code: "NOT_AUTHENTICATED", message: "You must be signed in." },
      ACCOUNT_NOT_ACTIVE: { code: "ACCOUNT_NOT_ACTIVE", message: "Your account is not active." },
      INSUFFICIENT_RANK: { code: "INSUFFICIENT_RANK", message: "You do not have permission to do this." },
    };
    return AUTHZ_MESSAGES[err.code];
  }
  return { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." };
}

export type AttentionRequiredItem = {
  key: "pendingApprovals" | "unclaimedSchedules" | "missedSchedules" | "failedBroadcasts" | "vacantPositions";
  label: string;
  count: number;
  href: string;
};

export type AttentionRequiredSummary = {
  items: AttentionRequiredItem[];
  total: number;
};

// ============================================================
// getAttentionRequiredSummary — Role >= Admin. Per docs/TFT-Revision-
// UnifiedApp.md section B ("Attention Required" is a banner, not a
// dashboard page) and this task's Phase 5-F instruction (no dedicated
// aggregation table — the Phase5-Realtime doc itself was not found in this
// repo, so that instruction is taken from this task's own text): every
// count below is a live read against the source tables at request time,
// computed fresh on each call, not backed by any persisted/streamed
// aggregate.
// ============================================================
export async function getAttentionRequiredSummary(): Promise<
  { summary: AttentionRequiredSummary } | { error: ActionError }
> {
  try {
    await requireAdmin();
  } catch (err) {
    return { error: fromAuthzError(err) };
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const [
    { count: pendingApprovals },
    { count: unclaimedSchedules },
    { count: missedSchedules },
    { count: failedBroadcasts },
    { data: activePositions },
    { data: activeHoldings },
  ] = await Promise.all([
    admin.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    admin
      .from("schedules")
      .select("id", { count: "exact", head: true })
      .eq("status", "available")
      .gt("start_time", nowIso),
    admin.from("schedules").select("id", { count: "exact", head: true }).eq("status", "missed"),
    admin.from("broadcast_targets").select("id", { count: "exact", head: true }).eq("status", "failed"),
    admin.from("positions").select("id").eq("is_active", true),
    admin.from("user_positions").select("position_id").is("revoked_at", null),
  ]);

  // Vacant = active position with zero active (non-revoked) holders — no
  // "vacant" flag exists on positions, so this is a set difference computed
  // here rather than a single query, same live-derivation approach as
  // everything else in this summary.
  const heldPositionIds = new Set((activeHoldings ?? []).map((h) => h.position_id));
  const vacantPositions = (activePositions ?? []).filter((p) => !heldPositionIds.has(p.id)).length;

  const items: AttentionRequiredItem[] = [
    {
      key: "pendingApprovals",
      label: "Pending member approvals",
      count: pendingApprovals ?? 0,
      href: "/profile/admin",
    },
    {
      key: "unclaimedSchedules",
      label: "Unclaimed schedule slots",
      count: unclaimedSchedules ?? 0,
      href: "/schedule",
    },
    {
      key: "missedSchedules",
      label: "Missed shifts",
      count: missedSchedules ?? 0,
      href: "/schedule",
    },
    {
      key: "failedBroadcasts",
      label: "Failed broadcast deliveries",
      count: failedBroadcasts ?? 0,
      href: "/profile/admin/broadcast/history",
    },
    {
      key: "vacantPositions",
      label: "Vacant positions",
      count: vacantPositions,
      href: "/profile/admin/positions",
    },
  ];

  const total = items.reduce((sum, item) => sum + item.count, 0);

  return { summary: { items, total } };
}
