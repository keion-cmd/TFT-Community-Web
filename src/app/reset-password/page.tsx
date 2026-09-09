import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold">Reset your password</h1>

      {!user ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-black/60 dark:text-white/60">
            This link has expired or was already used.
          </p>
          <Link href="/forgot-password" className="text-sm underline underline-offset-4">
            Request a new reset link
          </Link>
        </div>
      ) : (
        <ResetPasswordForm />
      )}
    </main>
  );
}
