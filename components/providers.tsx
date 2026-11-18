"use client";

/**
 * components/providers.tsx
 *
 * Client-side providers for the whole app. Rendered once, in app/layout.tsx,
 * around everything inside <body>, so every client component (the global
 * search in the top bar, the Dashboard, Deals and Wishlist views, the game
 * page) shares ONE TanStack Query client.
 *
 * Sharing one client means data loaded on one page is still there after
 * navigating to another, and an action on one page (watching a game from
 * Deals) can refresh another page's data (the Wishlist).
 *
 * Why the client lives in useState: a module-level `new QueryClient()` would
 * be shared between all users' requests during server rendering, leaking one
 * user's cached data into another's page. useState creates exactly one client
 * per browser tab (and per server render), and keeps it across re-renders.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { retryDelay, shouldRetry } from "@/lib/api/client";

/** Our defaults for every query in the app. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Steam data does not change because a tab regained focus (doc 4.1).
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: shouldRetry,
        retryDelay,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
