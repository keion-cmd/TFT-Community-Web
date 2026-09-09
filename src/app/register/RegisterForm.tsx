"use client";

import { useActionState } from "react";
import { signUp } from "@/app/actions/auth";
import { initialActionState } from "@/app/actions/types";

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(signUp, initialActionState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="username" className="text-sm font-medium">
          Username
        </label>
        <input
          id="username"
          name="username"
          required
          minLength={3}
          maxLength={24}
          autoComplete="username"
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
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
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-foreground text-background px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? "Creating account…" : "Register"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
    </form>
  );
}
