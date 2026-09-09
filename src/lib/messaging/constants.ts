// Sender-only edit window. Named constant per T-CODE-08 spec; if this needs
// to become an admin-configurable setting later, follow schedule_settings'
// key/value pattern (supabase/migrations/0001_init.sql) rather than adding
// bespoke settings UI now.
//
// Lives outside app/actions/messaging.ts because a "use server" file may
// only export async functions — a plain constant export breaks the build
// (Next.js: "A 'use server' file can only export async functions").
export const EDIT_WINDOW_MINUTES = 15;
