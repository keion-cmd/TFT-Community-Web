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
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent"
      />

      {isPending && <p className="text-xs text-muted-foreground">Searching…</p>}
      {error && <p className="text-xs text-danger">{error}</p>}

      {results && (
        <ul className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-2">
          {results.length === 0 ? (
            <li className="p-2 text-sm text-muted-foreground">No messages found.</li>
          ) : (
            results.map((r) => (
              <li key={r.messageId}>
                <Link
                  href={r.href}
                  className="flex flex-col gap-0.5 rounded p-2 text-sm hover:bg-surface-hover"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{r.chatLabel}</span>
                    <span className="text-xs text-muted-foreground">{formatTime(r.createdAt)}</span>
                  </span>
                  <span className="text-foreground/80">
                    <span className="text-muted-foreground">{r.senderDisplayName}: </span>
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
