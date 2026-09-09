"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/app/actions/auth";
import { initialActionState } from "@/app/actions/types";

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(
    requestPasswordReset,
    initialActionState,
  );

  if (state.success) {
    return (
      <p className="rounded bg-emerald-600/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
        If an account exists for that email, a reset link is on its way.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? "Sending…" : "Send reset link"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
    </form>
  );
}
