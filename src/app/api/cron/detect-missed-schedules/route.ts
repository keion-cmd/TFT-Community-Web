import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Cron-only endpoint: no user session involved, so it sits outside the
// auth-gated middleware matcher (see src/middleware.ts's "api/cron"
// exclusion) and is protected by a shared-secret header instead, matching
// Vercel Cron's documented "Authorization: Bearer <CRON_SECRET>" convention
// (vercel.json wires the cron trigger up to this route — see repo root).
//
// NOT ACTIVATED in this task: vercel.json declares the schedule, but
// nothing here deploys it — that requires a real Vercel project/deployment,
// out of scope per this task's instructions. Calling this route today only
// works if CRON_SECRET is set in the local/deployed environment and the
// caller supplies it.
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if the env var isn't configured
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const supabaseAdmin = createAdminClient();
  const { data, error } = await supabaseAdmin.rpc("detect_missed_schedules");

  if (error) {
    return NextResponse.json({ error: "DETECTION_FAILED", message: error.message }, { status: 500 });
  }

  return NextResponse.json({ flagged: data?.length ?? 0, schedules: data ?? [] });
}
