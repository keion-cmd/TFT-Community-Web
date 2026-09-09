import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/auth/session";
import { listNotifications } from "@/app/actions/notifications";
import { NotificationsList } from "./NotificationsList";

export default async function NotificationsPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.status !== "active") redirect("/pending-approval");

  const result = await listNotifications({ limit: 20 });
  const initialNotifications = "notifications" in result ? result.notifications : [];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6 sm:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <Link href="/profile" className="text-sm underline underline-offset-4">
          Back to profile
        </Link>
      </div>

      {"error" in result ? (
        <p className="text-sm text-red-600">{result.error.message}</p>
      ) : (
        <NotificationsList initialNotifications={initialNotifications} grouped />
      )}
    </main>
  );
}
