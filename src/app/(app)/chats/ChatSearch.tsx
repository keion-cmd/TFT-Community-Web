"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { searchMessages, type MessageSearchResult } from "@/app/actions/messaging";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ChatSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults(null);
      setError(null);
      return;
    }
    startTransition(async () => {
      const result = await searchMessages(trimmed);
      if ("error" in result) {
        setError(result.error.message);
        setResults(null);
        return;
      }
      setError(null);
      setResults(result.results);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          runSearch(e.target.value);
        }}
        placeholder="Search messages…"
        className="rounded border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.15]"
      />

      {isPending && <p className="text-xs text-black/50 dark:text-white/50">Searching…</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}

      {results && (
        <ul className="flex flex-col gap-1 rounded-lg border border-black/[.08] p-2 dark:border-white/[.145]">
          {results.length === 0 ? (
            <li className="p-2 text-sm text-black/50 dark:text-white/50">No messages found.</li>
          ) : (
            results.map((r) => (
              <li key={r.messageId}>
                <Link
                  href={r.href}
                  className="flex flex-col gap-0.5 rounded p-2 text-sm hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{r.chatLabel}</span>
                    <span className="text-xs text-black/40 dark:text-white/40">{formatTime(r.createdAt)}</span>
                  </span>
                  <span className="text-black/70 dark:text-white/70">
                    <span className="text-black/50 dark:text-white/50">{r.senderDisplayName}: </span>
                    {r.snippet}
                  </span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
