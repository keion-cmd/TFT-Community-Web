"use client";

import { useActionState } from "react";
import { initialActionState, type ActionState } from "@/app/actions/types";

type HiddenField = { name: string; value: string };

type Props = {
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  hiddenFields: HiddenField[];
  label: string;
  variant?: "primary" | "danger" | "neutral";
  requireReason?: boolean;
  confirmMessage?: string;
};

const VARIANT_CLASSES: Record<NonNullable<Props["variant"]>, string> = {
  primary: "bg-emerald-600 hover:bg-emerald-500 text-white",
  danger: "bg-red-600 hover:bg-red-500 text-white",
  neutral:
    "bg-black/[.06] hover:bg-black/[.1] dark:bg-white/[.1] dark:hover:bg-white/[.15]",
};

// Generalized version of the Member Approval Queue's confirm-before-submit
// action form (T-CODE-04), parameterized over hidden fields instead of a
// single hardcoded userId so it can drive deactivatePosition/revokePosition.
export function PositionActionForm({
  action,
  hiddenFields,
  label,
  variant = "neutral",
  requireReason,
  confirmMessage,
}: Props) {
  const [state, formAction, isPending] = useActionState(action, initialActionState);

  return (
    <form
      action={formAction}
      className="flex flex-col items-start gap-2"
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {hiddenFields.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}
      {requireReason && (
        <textarea
          name="reason"
          required
          placeholder="Reason (required)"
          rows={2}
          className="w-full min-w-[220px] rounded border border-black/[.1] dark:border-white/[.15] bg-transparent px-2 py-1 text-sm"
        />
      )}
      <button
        type="submit"
        disabled={isPending}
        className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${VARIANT_CLASSES[variant]}`}
      >
        {isPending ? "Working…" : label}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error.message}</p>}
      {state.success && <p className="text-sm text-emerald-600">Done.</p>}
    </form>
  );
}
