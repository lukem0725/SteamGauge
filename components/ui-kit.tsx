"use client";

/**
 * components/ui-kit.tsx
 *
 * Pieces shared by every signed-in view (dashboard, deals): the query
 * provider, the Data Age ticker, the value meter, and the loading-failure
 * panels. Dark theme throughout: zinc-950 page, charcoal cards.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError, retryDelay, shouldRetry } from "@/lib/api/client";
import type { CacheMeta } from "@/lib/steam/cached-fetch";
import type { ValueLevel } from "@/lib/value";

export const SIGN_IN_PATH = "/api/auth/steam/login";

// =============================================================================
// Query provider
// =============================================================================

/**
 * One QueryClient, with our defaults, for every signed-in page. Rendered once
 * by app/(app)/layout.tsx, so data loaded on one page is still there when the
 * user navigates to another, and an action on one page (watching a game from
 * Deals) can refresh another's data (the Wishlist).
 */
export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Steam data does not change because a tab regained focus (doc 4.1).
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            retry: shouldRetry,
            retryDelay,
          },
        },
      }),
  );
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// =============================================================================
// Value rating colours
// =============================================================================

/** Tailwind classes for each value level. 4 is best. */
export const VALUE_TONE: Readonly<Record<ValueLevel, { text: string; bar: string }>> = {
  4: { text: "text-emerald-300", bar: "bg-emerald-400" },
  3: { text: "text-lime-300", bar: "bg-lime-400" },
  2: { text: "text-amber-300", bar: "bg-amber-400" },
  1: { text: "text-rose-300", bar: "bg-rose-400" },
};

// =============================================================================
// Data Age ticker, money, meter, state panels
// =============================================================================

/**
 * Tells the user how old the numbers on screen are, from the `meta` block of
 * the API envelope:
 *
 *   source "steam"            "Live via Steam"
 *   source "cache"            "Cached 14m ago"
 *   stale (refresh running)   amber dot, "updating"
 */
export function DataAgeTicker({ meta, isFetching }: { meta: CacheMeta | null; isFetching: boolean }) {
  // Re-render every 30 s so "14m ago" keeps counting without a refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!meta) {
    return (
      <TickerShell tone="muted" pulse={isFetching}>
        {isFetching ? "Loading" : "No data"}
      </TickerShell>
    );
  }

  const updating = meta.stale || isFetching;
  const label =
    meta.source === "steam" ? "Live via Steam" : `Cached ${formatAge(meta.fetchedAt, now)}`;

  return (
    <TickerShell
      tone={updating ? "amber" : meta.source === "steam" ? "emerald" : "muted"}
      pulse={updating}
      title={`Fetched from Steam at ${new Date(meta.fetchedAt).toLocaleString()}`}
    >
      {label}
      {updating ? <span className="text-amber-300/80"> · updating</span> : null}
    </TickerShell>
  );
}

function TickerShell({
  tone,
  pulse,
  title,
  children,
}: {
  tone: "emerald" | "amber" | "muted";
  pulse: boolean;
  title?: string;
  children: ReactNode;
}) {
  const dot =
    tone === "emerald" ? "bg-emerald-400" : tone === "amber" ? "bg-amber-400" : "bg-zinc-500";
  return (
    <p
      role="status"
      aria-live="polite"
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium leading-none text-zinc-400"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
      />
      <span className="whitespace-nowrap">{children}</span>
    </p>
  );
}

function formatAge(fetchedAtIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fetchedAtIso)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatMoney(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency}`;
  }
}

export function ValueMeter({ level, bar }: { level: 0 | 1 | 2 | 3 | 4; bar: string }) {
  return (
    <div aria-hidden="true" className="mt-2 flex gap-1">
      {[1, 2, 3, 4].map((segment) => (
        <span
          key={segment}
          className={`h-1.5 flex-1 rounded-full ${segment <= level ? bar : "bg-zinc-800"}`}
        />
      ))}
    </div>
  );
}

export function StatePanel({
  tone,
  title,
  children,
  actions,
}: {
  tone: "neutral" | "amber" | "rose";
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const border =
    tone === "amber"
      ? "border-amber-400/30"
      : tone === "rose"
        ? "border-rose-400/30"
        : "border-zinc-800";
  return (
    <section className={`rounded-3xl border ${border} bg-[#131316] p-6 text-center sm:p-10`}>
      <h2 className="text-lg font-semibold text-zinc-50">{title}</h2>
      <div className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-400">{children}</div>
      {actions ? (
        <div className="mt-6 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          {actions}
        </div>
      ) : null}
    </section>
  );
}

export const primaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60";

export function ErrorState({
  error,
  onRetry,
  retrying,
  subject = "your library",
}: {
  error: Error;
  onRetry: () => void;
  retrying: boolean;
  /** What failed to load, as it reads mid-sentence: "your library", "today's deals". */
  subject?: string;
}) {
  const api = error instanceof ApiError ? error : null;

  if (api?.status === 401) {
    return (
      <StatePanel
        tone="neutral"
        title="Your session has ended"
        actions={
          // A plain link on purpose: next/link would prefetch the login route.
          <a href={SIGN_IN_PATH} className={primaryButton}>
            Sign in through Steam
          </a>
        }
      >
        <p>Sign in again to see {subject}.</p>
      </StatePanel>
    );
  }

  const { title, body } = describeError(api, subject);
  return (
    <StatePanel
      tone="rose"
      title={title}
      actions={
        <button type="button" onClick={onRetry} disabled={retrying} className={primaryButton}>
          {retrying ? "Retrying…" : "Try again"}
        </button>
      }
    >
      <p>{body}</p>
    </StatePanel>
  );
}

function describeError(
  api: ApiError | null,
  subject: string,
): { title: string; body: string } {
  const wait = api?.retryAfterSeconds
    ? ` Try again in about ${Math.ceil(api.retryAfterSeconds)} seconds.`
    : " Try again in a moment.";

  switch (api?.code) {
    case "quota_exhausted":
      return {
        title: "We have reached our Steam request limit",
        body: `SteamLite limits how often it calls Steam, and that budget is used up for now.${wait}`,
      };
    case "throttled":
    case "upstream_unavailable":
    case "busy":
      return {
        title: "Steam is not responding right now",
        body: `We could not load ${subject} from Steam and have no saved copy to show.${wait}`,
      };
    case "network":
      return {
        title: "You appear to be offline",
        body: "We could not reach SteamLite. Check your connection and try again.",
      };
    default:
      return {
        title: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not be loaded`,
        body: "Something went wrong on our side. Trying again may fix it.",
      };
  }
}

// =============================================================================
// Wishlist messages
// =============================================================================

/** Plain-language reason a game could not be added to the wishlist. */
export function describeWishlistAddError(error: unknown, limit: number | null): string {
  const api = error instanceof ApiError ? error : null;
  switch (api?.code) {
    case "app_not_found":
      return "Steam has no game with that ID, or it is not sold in the US store.";
    case "wishlist_full":
      return `Your wishlist is full${limit ? ` (${limit} games)` : ""}. Remove one to add another.`;
    case "invalid_body":
      return "Enter a Steam store link or a numeric App ID.";
    case "auth_required":
      return "Your session has ended. Reload the page and sign in again.";
    case "network":
      return "You appear to be offline. Check your connection and try again.";
    default:
      return api?.status === 503
        ? "Steam is busy right now, so we could not look that game up. Try again in a moment."
        : "The game could not be added. Try again.";
  }
}

// =============================================================================
// Lazy loading
// =============================================================================

/** True from the first time the element comes near the viewport, and stays true. */
export function useInViewOnce<T extends Element>(): [(node: T | null) => void, boolean] {
  const [inView, setInView] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    // Very old browsers: just load.
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    observer.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.current?.disconnect();
          observer.current = null;
        }
      },
      { rootMargin: "120px" },
    );
    observer.current.observe(node);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, inView];
}
