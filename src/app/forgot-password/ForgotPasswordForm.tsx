"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/app/actions/auth";
import { initialActionState } from "@/app/actions/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(
    requestPasswordReset,
    initialActionState,
  );

  if (state.success) {
    return (
      <p className="rounded-lg bg-success-muted p-3 text-sm text-success">
        If an account exists for that email, a reset link is on its way.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium text-foreground">
          Email
        </label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <Button type="submit" loading={isPending}>
        {isPending ? "Sending…" : "Send reset link"}
      </Button>
      {state.error && <p className="text-sm text-danger">{state.error.message}</p>}
    </form>
  );
}
