import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <p className="text-center text-lg font-semibold tracking-wide text-accent">TFT</p>

      <Card className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Forgot your password?</h1>
          <p className="text-sm text-muted-foreground">
            Enter your email and we&apos;ll send you a reset link.
          </p>
        </div>

        <ForgotPasswordForm />

        <Link href="/login" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Back to log in
        </Link>
      </Card>
    </main>
  );
}
