"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchProfileWithRole, type AccountStatus } from "@/lib/auth/profile";
import {
  signUpSchema,
  signInSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "@/lib/validation/auth";
import { checkRateLimit, rateLimitMessage, getClientIp } from "@/lib/rate-limit/rateLimit";
import { actionError, type ActionState } from "./types";

// Human-readable, status-specific messages — Phase 6-A: every non-active
// status gets a specific reason, except a genuinely wrong password, which
// stays generic (below) to avoid leaking which accounts exist.
const STATUS_MESSAGES: Record<Exclude<AccountStatus, "active">, ActionState> = {
  pending_approval: actionError(
    "ACCOUNT_PENDING",
    "Your account is still awaiting admin approval.",
  ),
  suspended: actionError(
    "ACCOUNT_SUSPENDED",
    "Your account has been suspended. Contact an admin for details.",
  ),
  disabled: actionError("ACCOUNT_DISABLED", "Your account has been disabled."),
  removed: actionError("ACCOUNT_REMOVED", "This account no longer exists."),
  rejected: actionError(
    "ACCOUNT_REJECTED",
    "Your registration was not approved.",
  ),
};

// Phase 6-F starting limits, hardcoded (admin-tunable is out of scope for
// this task): signUp 3/hour per IP, signIn 5/15min per IP+identifier,
// requestPasswordReset 3/hour per email.
const SIGNUP_LIMIT = 3;
const SIGNUP_WINDOW_SECONDS = 60 * 60;
const SIGNIN_LIMIT = 5;
const SIGNIN_WINDOW_SECONDS = 15 * 60;
const PASSWORD_RESET_LIMIT = 3;
const PASSWORD_RESET_WINDOW_SECONDS = 60 * 60;

export async function signUp(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ip = await getClientIp();
  const signUpLimit = await checkRateLimit(
    `signup:${ip}`,
    SIGNUP_LIMIT,
    SIGNUP_WINDOW_SECONDS,
  );
  if (!signUpLimit.allowed) {
    return actionError("RATE_LIMITED", rateLimitMessage(signUpLimit.retryAfterSeconds));
  }

  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    username: formData.get("username"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid input.",
    );
  }
  const { email, username, password } = parsed.data;

  const admin = createAdminClient();

  // DB also enforces `profiles.username` uniqueness — checking first turns
  // a raw constraint violation into a specific, actionable error.
  const { data: existingUsername } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existingUsername) {
    return actionError("USERNAME_TAKEN", "That username is already taken.");
  }

  const supabase = await createClient();
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (signUpError) {
    const msg = signUpError.message.toLowerCase();
    if (msg.includes("already registered") || msg.includes("already exists")) {
      return actionError(
        "EMAIL_TAKEN",
        "An account with that email already exists.",
      );
    }
    if (msg.includes("password")) {
      return actionError("WEAK_PASSWORD", signUpError.message);
    }
    return actionError("SIGNUP_FAILED", signUpError.message);
  }

  const newUserId = signUpData.user?.id;
  if (!newUserId) {
    return actionError(
      "SIGNUP_FAILED",
      "Could not create the account. Please try again.",
    );
  }

  // Inserted via the service-role client rather than the caller's own
  // session: if this Supabase project requires email confirmation,
  // signUp() returns no session, so `profiles`'s self-only insert policy
  // (auth.uid() = id) would have nothing to authenticate against yet.
  // Registration must land the account in pending_approval either way.
  const { error: profileError } = await admin.from("profiles").insert({
    id: newUserId,
    username,
    display_name: username,
    role_id: 1, // Member — hardcoded server-side, never accepted from the client (spec §6)
    status: "pending_approval",
  });
  if (profileError) {
    // Avoid leaving a signed-in session with no profile row behind — a
    // profile-less session would otherwise bounce forever between the
    // holding screen and the login page in middleware.
    if (signUpData.session) await supabase.auth.signOut();
    return actionError(
      "SIGNUP_FAILED",
      "Your account was created but your profile could not be set up. Contact an admin.",
    );
  }

  await admin.from("approvals").insert({
    user_id: newUserId,
    status: "pending",
  });

  // No confirmed session yet (email confirmation required) — send the user
  // to sign in once they've confirmed, rather than a page that assumes an
  // authenticated user.
  if (!signUpData.session) {
    redirect("/login?registered=1");
  }

  redirect("/pending-approval");
}

export async function signIn(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const rawIdentifier = String(formData.get("identifier") ?? "").toLowerCase();
  const ip = await getClientIp();
  const signInLimit = await checkRateLimit(
    `signin:${ip}:${rawIdentifier}`,
    SIGNIN_LIMIT,
    SIGNIN_WINDOW_SECONDS,
  );
  if (!signInLimit.allowed) {
    return actionError("RATE_LIMITED", rateLimitMessage(signInLimit.retryAfterSeconds));
  }

  const parsed = signInSchema.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid input.",
    );
  }
  const { identifier, password } = parsed.data;
  const genericInvalid = actionError(
    "INVALID_CREDENTIALS",
    "Incorrect email/username or password.",
  );

  let email = identifier;

  if (!identifier.includes("@")) {
    // Username login: Supabase Auth only authenticates by email, and the
    // anon key can't look up another user's email — resolve it server-side
    // via the service-role client instead.
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("username", identifier)
      .maybeSingle();
    if (!profile) return genericInvalid;

    const { data: authUser, error: authUserError } =
      await admin.auth.admin.getUserById(profile.id);
    if (authUserError || !authUser.user?.email) return genericInvalid;
    email = authUser.user.email;
  }

  const supabase = await createClient();
  const { data: signInData, error: signInError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (signInError || !signInData.user) return genericInvalid;

  const profile = await fetchProfileWithRole(supabase, signInData.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    return actionError(
      "ACCOUNT_NOT_FOUND",
      "We couldn't find a profile for this account. Contact an admin.",
    );
  }

  if (profile.status !== "active") {
    // The session Supabase just issued is only useful while status is
    // active — destroy it immediately rather than leaving a live session
    // behind a status the app will refuse to serve anyway.
    await supabase.auth.signOut();
    return STATUS_MESSAGES[profile.status];
  }

  redirect("/profile");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = requestPasswordResetSchema.safeParse({
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid input.",
    );
  }

  // Keyed on the (now-validated) email rather than IP, per Phase 6-F. Note
  // this happens after the zod parse (unlike signIn/signUp) specifically so
  // the limit is keyed on a normalized email, not arbitrary raw input.
  const resetLimit = await checkRateLimit(
    `pwreset:${parsed.data.email.toLowerCase()}`,
    PASSWORD_RESET_LIMIT,
    PASSWORD_RESET_WINDOW_SECONDS,
  );
  if (!resetLimit.allowed) {
    // Deliberately still the generic { success: true } response, not a
    // RATE_LIMITED error — this endpoint never confirms/denies anything
    // about the email (Phase 6-A/no-enumeration), and an explicit
    // rate-limit error would leak "this email/IP combo has been tried
    // repeatedly," which isn't itself sensitive but breaks the "always the
    // same response" invariant already documented below.
    return { success: true };
  }

  const supabase = await createClient();
  const headerList = await headers();
  const origin =
    headerList.get("origin") ??
    `https://${headerList.get("host") ?? "localhost:3000"}`;

  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });

  // Always the same response, regardless of whether the email is
  // registered — never confirm/deny account existence (spec: no user
  // enumeration).
  return { success: true };
}

export async function resetPassword(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid input.",
    );
  }

  const supabase = await createClient();
  // A valid recovery session must already be present (established by
  // src/app/auth/confirm/route.ts when the user followed the emailed
  // link) — this action only ever updates the currently-authenticated
  // user's own password via Supabase Auth.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return actionError(
      "TOKEN_EXPIRED",
      "This password reset link has expired. Request a new one.",
    );
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) {
    return actionError("RESET_FAILED", error.message);
  }

  redirect("/login?reset=1");
}
