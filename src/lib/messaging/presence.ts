// Shared Presence/typing tuning — lives here (not app/actions) since these
// are plain constants consumed by Client Components, same rationale as
// EDIT_WINDOW_MINUTES in constants.ts.

// Global online/offline channel — every active session joins this one
// regardless of what thread (if any) is open.
export const PRESENCE_ONLINE_CHANNEL = "presence:online-users";

// No further keystrokes for this long -> stop broadcasting "typing".
export const TYPING_STOP_DEBOUNCE_MS = 3000;

// If no typing:stop arrives within this long after the last typing:start
// we've seen for a given peer, treat them as no longer typing client-side
// (guards against a dropped connection leaving a stuck indicator).
export const TYPING_STALE_MS = 5000;
