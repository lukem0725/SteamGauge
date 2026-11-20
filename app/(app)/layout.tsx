/**
 * app/(app)/layout.tsx
 *
 * The shell around every app page (/dashboard, /deals, /wishlist, /search,
 * /game/[appid]): dark page surface, navigation and the site footer. The
 * TanStack Query client comes from <Providers> in app/layout.tsx, which wraps
 * this whole shell, so the global search in the navigation and every page
 * share one client.
 *
 * Since v1.13 it reads the session (shared with the page through
 * getCurrentUser's per-request cache) only to show the account area in the
 * navigation: avatar and name, or "Sign in with Steam". It is never the
 * access check: a layout is not re-rendered on every navigation, so each
 * page decides for itself what a signed-out visitor sees, and every
 * user-only API route checks the session again.
 */
import type { Viewport } from "next";
import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";
import { SiteFooter } from "@/components/footer";
import { getCurrentUser } from "@/lib/auth/current-user";

/** Dark browser chrome and form controls to match the page. */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0e14",
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  // A database failure here must not take every page down: show "Sign in".
  const user = await getCurrentUser().catch(() => null);

  return (
    <div className="flex min-h-dvh flex-col bg-page text-slate-100 antialiased">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-steam-400 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
      >
        Skip to content
      </a>

      <AppNav user={user ? { personaName: user.personaName, avatarUrl: user.avatarUrl } : null} />

      {/* The page grows so the footer sits at the bottom of short pages. */}
      <div id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </div>

      {/* On phones the bottom margin keeps the footer clear of the fixed tab bar. */}
      <SiteFooter className="mb-16 sm:mb-0" />
    </div>
  );
}
