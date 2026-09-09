import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { ADMIN_MIN_RANK } from "@/lib/auth/profile";
import { signOut } from "@/app/actions/auth";
import { ProfileEditForm } from "./ProfileEditForm";

export default async function ProfilePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Profile</h1>
        <form action={signOut}>
          <button type="submit" className="text-sm underline underline-offset-4">
            Sign out
          </button>
        </form>
      </div>

      <section className="flex flex-col gap-1 rounded-lg border border-black/[.08] dark:border-white/[.145] p-5">
        <p className="text-sm text-black/60 dark:text-white/60">@{profile.username}</p>
        <p className="text-sm text-black/60 dark:text-white/60">Role: {profile.roleName}</p>
      </section>

      <ProfileEditForm displayName={profile.displayName} bio={profile.bio ?? ""} />

      <section className="flex flex-col gap-2">
        <Link
          href="/chats"
          className="rounded-lg border border-black/[.08] p-4 text-sm font-medium hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.05]"
        >
          Chats →
        </Link>
        <Link
          href="/groups"
          className="rounded-lg border border-black/[.08] p-4 text-sm font-medium hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.05]"
        >
          Groups →
        </Link>
        <Link
          href="/schedule"
          className="rounded-lg border border-black/[.08] p-4 text-sm font-medium hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.05]"
        >
          Schedule →
        </Link>
      </section>

      {profile.roleRank >= ADMIN_MIN_RANK && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
            Admin Tools
          </h2>
          <Link
            href="/profile/admin"
            className="rounded-lg border border-black/[.08] dark:border-white/[.145] p-4 text-sm font-medium hover:bg-black/[.03] dark:hover:bg-white/[.05]"
          >
            Member Approval Queue →
          </Link>
          <Link
            href="/profile/admin/positions"
            className="rounded-lg border border-black/[.08] dark:border-white/[.145] p-4 text-sm font-medium hover:bg-black/[.03] dark:hover:bg-white/[.05]"
          >
            Positions Manager →
          </Link>
        </section>
      )}
    </main>
  );
}
