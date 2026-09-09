"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth/session";
import { updateOwnProfileSchema } from "@/lib/validation/members";
import { actionError, type ActionState } from "./types";

// Phase 4-B `updateOwnProfile` — the only field-level plumbing the "Basic
// Profile screen (own profile view/edit)" needs. `uploadAvatar` is not
// implemented in this pass: file MIME-sniffing/size limits/signed URLs
// (Phase 6-E) are scoped with the Messaging/attachments phase, not
// Auth + Members.
export async function updateOwnProfile(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const profile = await getCurrentProfile();
  if (!profile) {
    return actionError("NOT_AUTHENTICATED", "You must be signed in.");
  }

  const parsed = updateOwnProfileSchema.safeParse({
    displayName: formData.get("displayName"),
    bio: formData.get("bio"),
  });
  if (!parsed.success) {
    return actionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid input.",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: parsed.data.displayName,
      bio: parsed.data.bio || null,
    })
    .eq("id", profile.id);

  if (error) {
    return actionError("VALIDATION_ERROR", "Could not update your profile.");
  }

  revalidatePath("/profile");
  return { success: true };
}
