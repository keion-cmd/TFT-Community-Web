import Link from "next/link";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ registered?: string; reset?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Log in</h1>

      {params.registered && (
        <p className="rounded bg-emerald-600/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
          Check your email to confirm your account, then log in below.
        </p>
      )}
      {params.reset && (
        <p className="rounded bg-emerald-600/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
          Your password has been reset. Log in with your new password.
        </p>
      )}
      {params.error === "link_expired" && (
        <p className="rounded bg-red-600/10 p-3 text-sm text-red-700 dark:text-red-400">
          That link has expired. Request a new one.
        </p>
      )}

      <LoginForm />

      <div className="flex flex-col gap-2 text-sm">
        <Link href="/forgot-password" className="underline underline-offset-4">
          Forgot password?
        </Link>
        <p>
          No account?{" "}
          <Link href="/register" className="underline underline-offset-4">
            Register
          </Link>
        </p>
      </div>
    </main>
  );
}
