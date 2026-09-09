import Link from "next/link";
import { RegisterForm } from "./RegisterForm";

export default function RegisterPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Create an account</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Your account will wait for admin approval before you can sign in.
        </p>
      </div>

      <RegisterForm />

      <p className="text-sm">
        Already have an account?{" "}
        <Link href="/login" className="underline underline-offset-4">
          Log in
        </Link>
      </p>
    </main>
  );
}
