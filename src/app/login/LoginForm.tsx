"use client";

import { useActionState } from "react";
import { signIn } from "@/app/actions/auth";
import { initialActionState } from "@/app/actions/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(signIn, initialActionState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="identifier" className="text-sm font-medium text-foreground">
          Email or username
        </label>
        <Input id="identifier" name="identifier" required autoComplete="username" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium text-foreground">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>
      <Button type="submit" loading={isPending}>
        {isPending ? "Logging in…" : "Log in"}
      </Button>
      {state.error && <p className="text-sm text-danger">{state.error.message}</p>}
    </form>
  );
}
