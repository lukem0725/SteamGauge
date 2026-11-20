"use client";

/**
 * components/search-view.tsx
 *
 * The /search page (v1.13): the global search's results on their own page,
 * for anyone, signed in or not. Same API and same browser cache entry as the
 * dropdown in the top bar (`["search", term]`), so a query typed there costs
 * nothing here.
 *
 * The box is a plain GET form (/search?q=…), so it works before JavaScript
 * loads and every result list has a shareable address.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { formatMoney, StatePanel } from "@/components/ui-kit";
import { ApiError, apiGet } from "@/lib/api/client";
import type { SearchPayload, SearchResult } from "@/lib/game-search";

/** Same minimum as the dropdown (and the server's normaliser). */
const MIN_LENGTH = 2;

export function SearchView({ initialQuery }: { initialQuery: string }) {
  const term = initialQuery.trim();
  const search = useQuery({
    queryKey: ["search", term.toLowerCase()],
    queryFn: ({ signal }) => apiGet<SearchPayload>(`/api/search?q=${encodeURIComponent(term)}`, signal),
    enabled: term.length >= MIN_LENGTH,
    staleTime: 10 * 60_000,
  });
  const payload = search.data?.status === "ok" ? search.data.data : null;
  const results = payload?.results ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Search games</h1>
      <form action="/search" method="get" role="search" className="mt-4 flex max-w-2xl gap-2">
        <label htmlFor="search-page-q" className="sr-only">
          Game title
        </label>
        <input
          id="search-page-q"
          name="q"
          type="search"
          defaultValue={term}
          maxLength={100}
          autoComplete="off"
          placeholder="Search Steam games, e.g. Hollow Knight"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-700 bg-chrome px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-steam-400 focus:outline-none focus:ring-2 focus:ring-steam-400/40"
        />
        <button
          type="submit"
          className="min-h-11 shrink-0 rounded-xl bg-steam-400 px-4 text-sm font-semibold text-slate-950 hover:bg-steam-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-200"
        >
          Search
        </button>
      </form>

      <div className="mt-6" aria-live="polite">
        {term.length < MIN_LENGTH ? (
          <p className="text-sm text-slate-400">Type at least {MIN_LENGTH} characters of a game&rsquo;s title.</p>
        ) : search.isPending ? (
          <ul aria-busy="true" aria-label="Searching" className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="h-20 animate-pulse rounded-2xl bg-slate-800/60" />
            ))}
          </ul>
        ) : search.isError ? (
          <StatePanel tone="neutral" title="Search is unavailable right now">
            <p>
              {search.error instanceof ApiError && search.error.status === 429
                ? "Too many searches from this connection. Try again in a moment."
                : "Steam's search did not answer. Try again in a moment."}
            </p>
          </StatePanel>
        ) : results.length === 0 ? (
          <StatePanel tone="neutral" title={`No games found for “${term}”`}>
            <p>Check the spelling, or try fewer words.</p>
          </StatePanel>
        ) : (
          <>
            <p className="text-sm text-slate-400">
              {results.length === 1 ? "1 game" : `${results.length} best matches`} for &ldquo;{term}&rdquo;
              {payload && !payload.steamAvailable ? " (Steam's search is down, so these come from SteamGauge's catalog)" : ""}
            </p>
            <ul className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
              {results.map((result) => (
                <li key={result.appid}>
                  <ResultCard result={result} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: SearchResult }) {
  return (
    <Link
      href={`/game/${result.appid}`}
      className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-surface p-3 transition-colors hover:border-slate-700 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
    >
      {/* Steam CDN capsule; a plain <img> avoids next/image remote configuration. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={result.image}
        alt=""
        width={231}
        height={87}
        loading="lazy"
        decoding="async"
        className="h-[52px] w-[138px] shrink-0 rounded-lg bg-slate-900 object-cover"
      />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-medium text-slate-100">{result.name}</span>
        <span className="mt-0.5 block text-xs text-slate-400">
          {result.comingSoon ? "Coming soon" : result.releaseYear ?? "Release date unknown"}
        </span>
      </span>
      <span className="shrink-0 text-right text-sm">
        {result.isFree ? (
          <span className="font-medium text-slate-200">Free</span>
        ) : result.price === null ? (
          <span className="text-slate-500">—</span>
        ) : (
          <>
            {result.discountPercent > 0 ? (
              <span className="mr-1.5 rounded bg-steam-400/15 px-1.5 py-0.5 text-xs font-semibold text-steam-300">
                -{result.discountPercent}%
              </span>
            ) : null}
            <span className="font-semibold tabular-nums text-slate-50">{formatMoney(result.price, "USD")}</span>
          </>
        )}
      </span>
    </Link>
  );
}
