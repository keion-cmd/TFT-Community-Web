import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ registered?: string; reset?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <p className="text-center text-lg font-semibold tracking-wide text-accent">TFT</p>

      <Card className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-foreground">Log in</h1>

        {params.registered && (
          <p className="rounded-lg bg-success-muted p-3 text-sm text-success">
            Check your email to confirm your account, then log in below.
          </p>
        )}
        {params.reset && (
          <p className="rounded-lg bg-success-muted p-3 text-sm text-success">
            Your password has been reset. Log in with your new password.
          </p>
        )}
        {params.error === "link_expired" && (
          <p className="rounded-lg bg-danger-muted p-3 text-sm text-danger">
            That link has expired. Request a new one.
          </p>
        )}

        <LoginForm />

        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <Link href="/forgot-password" className="underline underline-offset-4 hover:text-foreground">
            Forgot password?
          </Link>
          <p>
            No account?{" "}
            <Link href="/register" className="underline underline-offset-4 hover:text-foreground">
              Register
            </Link>
          </p>
        </div>
      </Card>
    </main>
  );
}
