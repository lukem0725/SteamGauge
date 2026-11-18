"use client";

/**
 * components/global-search.tsx
 *
 * The search box in the top bar, on every signed-in page.
 *
 * Typing (debounced 250 ms, at least 2 characters) shows a dropdown of up to
 * 8 games from GET /api/search: capsule art, title, release year and price.
 * Matching forgives typos and partial titles (lib/game-search.ts).
 * Choosing a game, or pressing Enter, opens /game/[appid].
 *
 * Accessibility: the ARIA 1.2 combobox pattern. Arrow keys move through the
 * options, Enter opens the highlighted one (or the first), Escape closes the
 * list and then clears the box, and a live region announces result counts.
 * "/" anywhere outside a text field jumps to the box.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { formatMoney } from "@/components/ui-kit";
import { ApiError, apiGet } from "@/lib/api/client";
import type { SearchPayload, SearchResult } from "@/lib/game-search";

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

/** `value`, once it has stopped changing for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const statusId = useId();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const term = useDebouncedValue(value.trim(), DEBOUNCE_MS);
  const enabled = term.length >= MIN_CHARS;

  const search = useQuery({
    queryKey: ["search", term.toLowerCase()],
    queryFn: ({ signal }) => apiGet<SearchPayload>(`/api/search?q=${encodeURIComponent(term)}`, signal),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
    // Keep showing the last results while the next ones load: no flicker.
    placeholderData: (previous: unknown) => previous as never,
  });

  const results: readonly SearchResult[] =
    enabled && search.data?.status === "ok" ? search.data.data.results : [];
  const pending = value.trim() !== term || (enabled && search.isFetching && results.length === 0);
  const showList = open && value.trim().length >= MIN_CHARS;

  // New results: nothing highlighted until the user moves.
  useEffect(() => setActive(-1), [term]);

  // "/" focuses the search, unless the user is typing somewhere else.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (result: SearchResult | undefined) => {
    if (!result) return;
    setOpen(false);
    setValue("");
    inputRef.current?.blur();
    router.push(`/game/${result.appid}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        const next = current + step;
        return next < 0 ? results.length - 1 : next >= results.length ? 0 : next;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active >= 0 ? active : 0]);
    } else if (event.key === "Escape") {
      if (showList) setOpen(false);
      else setValue("");
    }
  };

  const status = !showList
    ? ""
    : pending
      ? "Searching…"
      : search.isError
        ? search.error instanceof ApiError && search.error.status === 429
          ? "Too many searches. Try again in a moment."
          : "Search is unavailable right now."
        : results.length === 0
          ? `No games found for “${value.trim()}”.`
          : `${results.length} ${results.length === 1 ? "game" : "games"} found. Use the arrow keys to choose one.`;

  return (
    <div
      className="relative min-w-0 flex-1 sm:max-w-md"
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search Steam games
      </label>
      <div className="relative">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        >
          <circle cx="9" cy="9" r="5.5" />
          <path d="m13.5 13.5 3.5 3.5" />
        </svg>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${listId}-option-${active}` : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Search games"
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setValue(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-h-10 w-full rounded-xl border border-slate-700/80 bg-surface pl-9 pr-9 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:border-steam-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400/40 [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-slate-700 px-1.5 text-[11px] text-slate-500 lg:block"
        >
          /
        </kbd>
      </div>

      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {status}
      </p>

      {showList ? (
        <div className="fixed inset-x-2 top-14 z-40 overflow-hidden rounded-2xl border border-slate-700/80 bg-chrome shadow-2xl shadow-black/60 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[min(30rem,calc(100vw-2rem))]">
          <ul id={listId} role="listbox" aria-label="Matching games" className="max-h-[min(28rem,70vh)] overflow-y-auto py-1">
            {results.map((result, index) => (
              <li
                key={result.appid}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === active}
                // Keep focus in the box, so the click is not lost to blur.
                onMouseDown={(event: MouseEvent) => event.preventDefault()}
                onClick={() => go(result)}
                onMouseEnter={() => setActive(index)}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${
                  index === active ? "bg-steam-800/60" : "hover:bg-surface-raised"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.image}
                  alt=""
                  width={92}
                  height={35}
                  loading="lazy"
                  decoding="async"
                  className="h-[35px] w-[92px] shrink-0 rounded bg-slate-800 object-cover"
                />
                {/* Phones: title on its own line, year and price under it. */}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium leading-snug text-slate-100 sm:line-clamp-1">
                    {result.name}
                  </p>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="truncate text-xs text-slate-400">
                      {result.comingSoon ? "Coming soon" : (result.releaseYear ?? "Release date unknown")}
                    </p>
                    <span className="sm:hidden">
                      <ResultPrice result={result} />
                    </span>
                  </div>
                </div>
                <span className="hidden sm:block">
                  <ResultPrice result={result} />
                </span>
              </li>
            ))}
          </ul>
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-400" aria-hidden="true">
              {status}
            </p>
          ) : (
            <p className="hidden border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500 sm:block" aria-hidden="true">
              ↑ ↓ to choose · Enter to open · Esc to close
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ResultPrice({ result }: { result: SearchResult }) {
  if (result.isFree) return <span className="shrink-0 text-xs font-medium text-slate-300">Free</span>;
  if (result.price === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {result.discountPercent > 0 ? (
        <span className="rounded bg-steam-400/15 px-1 py-0.5 text-[11px] font-semibold tabular-nums text-steam-300">
          -{result.discountPercent}%
        </span>
      ) : null}
      <span className="text-sm font-medium tabular-nums text-slate-100">{formatMoney(result.price, "USD")}</span>
    </span>
  );
}
