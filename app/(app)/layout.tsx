/**
 * app/(app)/layout.tsx
 *
 * The shell around every signed-in page (/dashboard, /deals, /wishlist):
 * dark page surface, navigation, and one shared TanStack Query client.
 *
 * It does not check the session. Each page does that itself, because a
 * layout is not re-rendered on every navigation and must not be the only
 * thing standing between a visitor and private data.
 */
import type { Viewport } from "next";
import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";
import { AppQueryProvider } from "@/components/ui-kit";

/** Dark browser chrome and form controls to match the page. */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#09090b",
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 antialiased">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-emerald-400 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-zinc-950"
      >
        Skip to content
      </a>

      <AppNav />

      <AppQueryProvider>
        {/* Bottom padding clears the fixed tab bar on phones. */}
        <div id="main-content" tabIndex={-1} className="pb-16 focus:outline-none sm:pb-0">
          {children}
        </div>
      </AppQueryProvider>
    </div>
  );
}
