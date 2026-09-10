import type { createClient } from "@/lib/supabase/server";

// Shared "which groups does this user belong to" core, used by both the
// /groups page (its "Your groups" section) and listMyGroups() (its Chats-tab
// list) — factored out after the two queries drifted (T-CODE-47). Callers
// layer their own additional data (unread counts, descriptions, ...) on top.
export type UserGroupRow = {
  id: number;
  name: string;
  type: string;
};

export async function getUserGroups(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<{ data: UserGroupRow[] } | { error: unknown }> {
  const { data: memberships, error: membershipError } = await supabase
    .from("group_members")
    .select("group_id")
    .eq("user_id", userId);

  if (membershipError) {
    console.error("[getUserGroups] failed to fetch group_members", {
      userId,
      error: membershipError,
    });
    return { error: membershipError };
  }

  const groupIds = (memberships ?? []).map((m) => m.group_id);
  if (groupIds.length === 0) return { data: [] };

  const { data: groups, error: groupsError } = await supabase
    .from("groups")
    .select("id, name, type")
    .in("id", groupIds)
    .is("archived_at", null);

  if (groupsError) {
    console.error("[getUserGroups] failed to fetch groups", {
      userId,
      groupIds,
      error: groupsError,
    });
    return { error: groupsError };
  }

  return { data: groups ?? [] };
}
