import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { RegisterForm } from "./RegisterForm";

export default function RegisterPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <p className="text-center text-lg font-semibold tracking-wide text-accent">TFT</p>

      <Card className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Create an account</h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ll get instant access once you sign up.
          </p>
        </div>

        <RegisterForm />

        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="underline underline-offset-4 hover:text-foreground">
            Log in
          </Link>
        </p>
      </Card>
    </main>
  );
}
