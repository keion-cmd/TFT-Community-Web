import Link from "next/link";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Forgot your password?</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Enter your email and we&apos;ll send you a reset link.
        </p>
      </div>

      <ForgotPasswordForm />

      <Link href="/login" className="text-sm underline underline-offset-4">
        Back to log in
      </Link>
    </main>
  );
}
