import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { fetchProfileWithRole } from "@/lib/auth/profile";

// Pages reachable without an active session. `/auth/confirm` handles both
// signup-confirmation and password-reset links, so it must stay reachable
// regardless of the caller's auth state.
const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/auth/confirm",
];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function middleware(request: NextRequest) {
  // Mutated by the Supabase client's `setAll` below so refreshed auth
  // cookies ride along on the response — see the @supabase/ssr Next.js
  // middleware pattern this follows.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // `getUser()`, not `getSession()`: this re-validates against the Auth
  // server on every request instead of trusting a locally-decoded JWT,
  // per Phase 6-B ("never trust... always re-derive").
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  if (!user) {
    if (isPublicPath(pathname)) return response;
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const profile = await fetchProfileWithRole(supabase, user.id);

  if (!profile || profile.status !== "active") {
    if (pathname === "/pending-approval") return response;
    return NextResponse.redirect(new URL("/pending-approval", request.url));
  }

  // Active user: no reason to show the login/register/holding screens again.
  if (isPublicPath(pathname) || pathname === "/pending-approval" || pathname === "/") {
    return NextResponse.redirect(new URL("/profile", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // api/cron/* excluded: those routes have no user session to check
    // (called by the Vercel Cron trigger, not a browser) and gate
    // themselves on a shared secret instead — see
    // src/app/api/cron/detect-missed-schedules/route.ts. Without this
    // exclusion, this middleware would redirect every cron request to
    // /login before the route handler ever ran.
    "/((?!_next/static|_next/image|favicon.ico|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
