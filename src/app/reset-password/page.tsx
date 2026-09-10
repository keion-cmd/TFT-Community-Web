import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <p className="text-center text-lg font-semibold tracking-wide text-accent">TFT</p>

      <Card className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-foreground">Reset your password</h1>

        {!user ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              This link has expired or was already used.
            </p>
            <Link href="/forgot-password" className="text-sm underline underline-offset-4 hover:text-foreground">
              Request a new reset link
            </Link>
          </div>
        ) : (
          <ResetPasswordForm />
        )}
      </Card>
    </main>
  );
}
