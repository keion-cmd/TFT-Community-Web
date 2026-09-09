import type { EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Required plumbing for requestPasswordReset/resetPassword (Phase 4-A) to
// work at all: Supabase emails a link containing a `token_hash`, and only a
// Route Handler (not a Server Component) can write the resulting session
// into cookies — src/lib/supabase/server.ts's `setAll` is a no-op outside
// Server Actions/Route Handlers. Follows Supabase's documented Next.js SSR
// pattern for email-link confirmation (also handles signup confirmation
// links if this project has email confirmation enabled).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=link_expired`,
  );
}
