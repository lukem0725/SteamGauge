/**
 * app/(app)/layout.tsx
 *
 * The shell around every signed-in page (/dashboard, /deals, /wishlist):
 * dark page surface and navigation. The TanStack Query client comes from
 * <Providers> in app/layout.tsx, which wraps this whole shell, so the global
 * search in the navigation and every page share one client.
 *
 * It does not check the session. Each page does that itself, because a
 * layout is not re-rendered on every navigation and must not be the only
 * thing standing between a visitor and private data.
 */
import type { Viewport } from "next";
import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";

/** Dark browser chrome and form controls to match the page. */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0e14",
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-page text-slate-100 antialiased">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-steam-400 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
      >
        Skip to content
      </a>

      <AppNav />

      {/* Bottom padding clears the fixed tab bar on phones. */}
      <div id="main-content" tabIndex={-1} className="pb-16 focus:outline-none sm:pb-0">
        {children}
      </div>
    </div>
  );
}
