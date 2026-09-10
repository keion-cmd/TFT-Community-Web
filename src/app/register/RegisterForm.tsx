"use client";

import { useActionState } from "react";
import { signUp } from "@/app/actions/auth";
import { initialActionState } from "@/app/actions/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(signUp, initialActionState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="username" className="text-sm font-medium text-foreground">
          Username
        </label>
        <Input
          id="username"
          name="username"
          required
          minLength={3}
          maxLength={24}
          autoComplete="username"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium text-foreground">
          Email
        </label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
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
          minLength={8}
          autoComplete="new-password"
        />
      </div>
      <Button type="submit" loading={isPending}>
        {isPending ? "Creating account…" : "Register"}
      </Button>
      {state.error && <p className="text-sm text-danger">{state.error.message}</p>}
    </form>
  );
}
