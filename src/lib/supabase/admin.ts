import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// SERVER-ONLY. Uses the service role key, which bypasses Row Level Security.
// Do not import this from a Client Component or expose it to the browser.
//
// Reserved for the narrow set of writes the current RLS policies genuinely
// cannot express for an authenticated-but-not-self actor (see
// supabase/migrations/0001_init.sql): `profiles` only has a self-update
// policy, and there is no admin-override RPC yet for approving/suspending
// members or changing roles. Every caller of this client MUST independently
// re-verify the caller's role/rank from the database first (see
// src/lib/auth/session.ts) — this client trusts nothing on its own.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL are not configured.",
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
