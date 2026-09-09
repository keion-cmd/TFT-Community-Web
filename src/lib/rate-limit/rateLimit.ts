import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase 6-F. Counters live in Postgres (see
// supabase/migrations/0006_rate_limiting.sql) rather than in-memory —
// this app runs on Vercel serverless, where each invocation can land on a
// different instance with its own process memory, so an in-memory map
// would undercount (every instance would allow its own separate quota)
// and would reset on every cold start/redeploy. Postgres is already the
// source of truth for everything else here, so a shared counter table
// costs one extra round trip per check and no new infrastructure/service.
//
// Known limitation: this adds a DB round trip to every rate-limited action,
// and correctness depends on Postgres being reachable — if the DB call
// itself errors out, checkRateLimit() fails OPEN (allows the request)
// rather than blocking real users on an infra hiccup. It is not a
// distributed edge-level defense (a flood still reaches this server code
// before being rejected) — for that, a CDN/edge-level limiter (e.g.
// Vercel's own or an external service) would be needed on top of this.

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

// Runs the check-and-increment as a single atomic upsert inside Postgres
// (see check_rate_limit() in the migration) so two concurrent requests for
// the same key can't both read "under limit" and both be let through.
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("check_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })
    .single<{ allowed: boolean; retry_after_seconds: number }>();

  if (error || !data) {
    // Fail open: a rate-limit infra problem should not take down real
    // sign-ins/messages/etc. The limits below are abuse mitigation, not a
    // security boundary the rest of the app depends on being airtight.
    return { allowed: true };
  }

  if (data.allowed) return { allowed: true };
  return { allowed: false, retryAfterSeconds: data.retry_after_seconds };
}

export function rateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  if (minutes <= 1) {
    return "Too many attempts. Please try again in a minute.";
  }
  return `Too many attempts. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

// Best-effort client IP for IP-keyed limits. Vercel sets `x-forwarded-for`
// on every request; this is not spoof-proof against a client that controls
// its own direct connection, but Vercel's edge network overwrites this
// header for traffic that actually reaches it, so it's trustworthy for
// requests that went through Vercel (which is the only deployment target
// here per the task scope).
export async function getClientIp(): Promise<string> {
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return headerList.get("x-real-ip") ?? "unknown";
}
