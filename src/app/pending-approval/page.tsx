import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchProfileWithRole } from "@/lib/auth/profile";
import { signOut } from "@/app/actions/auth";
import type { AccountStatus } from "@/lib/auth/profile";

// Doubles as the generic holding screen for every non-active status
// (Phase 2 lists only "Pending Approval" as a screen; suspended/disabled/
// removed/rejected reuse it with status-specific copy rather than adding
// pages outside this task's allowed screen list).
const STATUS_COPY: Record<Exclude<AccountStatus, "active">, { title: string; body: string }> = {
  pending_approval: {
    title: "Your account is awaiting approval",
    body: "An admin needs to review your registration before you can access TFT. Check back soon.",
  },
  suspended: {
    title: "Your account is suspended",
    body: "An admin has suspended your access. Reach out to a Super Admin if you believe this is a mistake.",
  },
  disabled: {
    title: "Your account is disabled",
    body: "This account has been disabled. Contact an admin for details.",
  },
  removed: {
    title: "This account has been removed",
    body: "Contact an admin if you believe this is a mistake.",
  },
  rejected: {
    title: "Your registration was not approved",
    body: "Contact an admin if you'd like to know more.",
  },
};

const FALLBACK_COPY = {
  title: "We couldn't load your account",
  body: "Sign out and try logging in again, or contact an admin if this keeps happening.",
};

export default async function PendingApprovalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await fetchProfileWithRole(supabase, user.id);
  if (profile?.status === "active") redirect("/profile");

  // A signed-in user with no profile row is an edge case (see
  // src/app/actions/auth.ts's signUp), not a status to redirect away from
  // — render a fallback instead of bouncing back toward /login, which
  // would just loop with middleware.
  const copy = profile ? STATUS_COPY[profile.status] : FALLBACK_COPY;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6 text-center">
      <h1 className="text-xl font-semibold">{copy.title}</h1>
      <p className="text-sm text-black/60 dark:text-white/60">{copy.body}</p>
      <form action={signOut}>
        <button type="submit" className="text-sm underline underline-offset-4">
          Sign out
        </button>
      </form>
    </main>
  );
}
