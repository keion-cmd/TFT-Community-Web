// Sender-only edit window. Named constant per T-CODE-08 spec; if this needs
// to become an admin-configurable setting later, follow schedule_settings'
// key/value pattern (supabase/migrations/0001_init.sql) rather than adding
// bespoke settings UI now.
//
// Lives outside app/actions/messaging.ts because a "use server" file may
// only export async functions — a plain constant export breaks the build
// (Next.js: "A 'use server' file can only export async functions").
export const EDIT_WINDOW_MINUTES = 15;

// Canonical DM pair ordering — lexicographic on the uuid string — so a DM
// thread (and, since T-CODE-44, a DM-scoped attachment storage path)
// resolves to the same low/high pair regardless of who initiates it. Lives
// here rather than in messaging.ts because a "use server" file may only
// export async functions (see note above), and attachments.ts needs this
// same ordering to compute a signed upload URL before any message exists.
export function dmPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
