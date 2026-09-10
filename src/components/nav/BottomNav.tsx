"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Per docs/TFT-Revision-UnifiedApp.md section B: one bottom nav, same 5
// tabs for every role — Admin Tools lives inside Profile, not a 6th item.
const NAV_ITEMS = [
  { href: "/chats", label: "Chats", matchPrefixes: ["/chats", "/dm"] },
  { href: "/groups", label: "Groups", matchPrefixes: ["/groups"] },
  { href: "/schedule", label: "Schedule", matchPrefixes: ["/schedule"] },
  { href: "/notifications", label: "Notifications", matchPrefixes: ["/notifications"] },
  { href: "/profile", label: "Profile", matchPrefixes: ["/profile"] },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface">
      {NAV_ITEMS.map((item) => {
        const isActive = item.matchPrefixes.some(
          (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        );
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`flex flex-1 flex-col items-center gap-1 border-t-2 py-3 text-xs font-medium transition-colors ${
              isActive
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
