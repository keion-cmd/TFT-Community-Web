"use client";

import { useState } from "react";
import Link from "next/link";
import type { AttentionRequiredSummary } from "@/app/actions/attentionRequired";

// Dismissal is session-only (component state) per the task's instruction —
// it resets on next load/navigation-remount rather than being persisted.
// A persisted (e.g. per-user "dismissed until") variant would need a new
// column/table and isn't spec'd as required for V1 — worth considering
// later if admins find the reappearance noisy, but not built here.
export function AttentionBanner({ summary }: { summary: AttentionRequiredSummary }) {
  const [dismissed, setDismissed] = useState(false);
  const itemsWithCounts = summary.items.filter((item) => item.count > 0);

  if (dismissed || itemsWithCounts.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          Attention required ({summary.total})
        </h2>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-xs underline underline-offset-4 text-amber-700 dark:text-amber-400"
        >
          Dismiss
        </button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {itemsWithCounts.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="rounded-full border border-amber-500/50 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
            >
              {item.count} {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
