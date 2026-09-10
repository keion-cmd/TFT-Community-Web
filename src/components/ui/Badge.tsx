import { HTMLAttributes } from "react";

type BadgeVariant = "accent" | "success" | "warning" | "danger" | "neutral";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  accent: "bg-accent-muted text-accent-foreground",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-danger-muted text-danger",
  neutral: "bg-surface-hover text-muted-foreground",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "neutral", className = "", ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
