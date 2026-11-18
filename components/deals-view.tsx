"use client";

/**
 * components/deals-view.tsx
 *
 * A dense, SteamDB-style table of current Steam discounts.
 *
 *   GET /api/deals   every deal at once (up to 1,000 rows), already marked
 *                    with price badges and the user's owned / wished /
 *                    watched flags.
 *
 * Filtering, sorting and paging run in the browser (lib/deals-table.ts), so
 * they are instant and cost no requests.
 *
 * Clicking a row (or its name) expands a detail card under it, one at a
 * time: price history, prices at every store, and game facts with the live
 * player count, each loaded only when opened and cached. Nothing in the table
 * leaves the page; the card's "View on Steam" button opens Steam in a new tab. Layout: filter sidebar beside the
 * table from 1024px; on phones the filters fold into a panel above it and the
 * table scrolls sideways inside its own frame.
 *
 * Only types are imported from server-only modules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  GameFactsPanel,
  PriceHistoryPanel,
  StorePriceList,
  useGameInsights,
} from "@/components/game-insights";
import { historyQuery, prefetchGame, useRowPrefetchIntent } from "@/components/game-queries";

import {
  DataAgeTicker,
  ErrorState,
  StatePanel,
  describeWishlistAddError,
  formatMoney,
  primaryButton,
  secondaryButton,
} from "@/components/ui-kit";
import { pageContainer } from "@/components/layout-width";
import { TitleFilter } from "@/components/title-filter";
import { apiGet, apiSend } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  FIRST_DIRECTION,
  PAGE_SIZES,
  STEAM_MIN_REVIEWS_FOR_SCORE,
  countActiveFilters,
  filterDeals,
  paginate,
  sortDeals,
  type DealFilters,
  type DealRow,
  type DealsPayload,
  type PageSize,
  type SortDirection,
  type SortKey,
} from "@/lib/deals-table";

/** After a stale answer, re-check this many times for the refreshed data. */
const STALE_RECHECK_LIMIT = 2;
const STALE_RECHECK_MS = 4_000;

// =============================================================================
// Entry point
// =============================================================================

export interface DealsViewProps {
  /** The verified session user, from the Server Component. */
  readonly user: SessionUser;
}

export function DealsView({ user }: DealsViewProps) {
  return <Deals user={user} />;
}

function Deals({ user }: DealsViewProps) {
  const deals = useQuery({
    // Keyed by user: owned, wished and watched flags are personal.
    queryKey: ["deals", user.steamid],
    queryFn: ({ signal }) => apiGet<DealsPayload>("/api/deals", signal),
    staleTime: 5 * 60_000,
    // Bounded follow-up after a stale answer, not polling (doc 4.1).
    refetchInterval: (query) =>
      query.state.data?.meta.stale && query.state.dataUpdateCount <= STALE_RECHECK_LIMIT
        ? STALE_RECHECK_MS
        : false,
  });

  const result = deals.data;
  const payload = result?.status === "ok" ? result.data : null;

  return (
    <div className="bg-page text-slate-100 antialiased">
      <div className={pageContainer}>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Steam deals</h1>
            <p className="mt-1 text-sm text-slate-400">
              {payload
                ? `${payload.rows.length.toLocaleString("en-US")} discounted ${
                    payload.rows.length === 1 ? "item" : "items"
                  } on Steam right now.`
                : "Current Steam discounts, with price history and your library."}
            </p>
          </div>
          <div className="pt-1">
            <DataAgeTicker meta={result?.meta ?? null} isFetching={deals.isFetching} />
          </div>
        </header>

        <main className="mt-6">
          {deals.isPending ? (
            <DealsSkeleton />
          ) : deals.isError ? (
            <ErrorState
              error={deals.error}
              onRetry={() => void deals.refetch()}
              retrying={deals.isFetching}
              subject="today's deals"
            />
          ) : !payload || payload.rows.length === 0 ? (
            <StatePanel tone="neutral" title="No discounts found right now">
              <p>Steam has no discounted items to show at the moment. The list refreshes hourly.</p>
            </StatePanel>
          ) : (
            <DealsExplorer
              payload={payload}
              steamid={user.steamid}
              onRefresh={() => void deals.refetch()}
              refreshing={deals.isFetching}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// =============================================================================
// Filters + table
// =============================================================================

/** The "Sort by" menu. Column headers set the same state. */
const SORT_CHOICES: readonly { key: SortKey; direction: SortDirection; label: string }[] = [
  { key: "score", direction: "desc", label: "Top deals" },
  { key: "discount", direction: "desc", label: "Biggest discount" },
  { key: "reviews", direction: "desc", label: "Most reviewed" },
  { key: "rating", direction: "desc", label: "Best rated" },
  { key: "price", direction: "asc", label: "Price: low to high" },
  { key: "price", direction: "desc", label: "Price: high to low" },
  { key: "release", direction: "desc", label: "Newest release" },
  { key: "ends", direction: "asc", label: "Sale ending soonest" },
  { key: "name", direction: "asc", label: "Name: A to Z" },
  { key: "name", direction: "desc", label: "Name: Z to A" },
];

const COLUMN_NAMES: Readonly<Record<SortKey, string>> = {
  score: "Top deals",
  name: "Name",
  discount: "Discount",
  price: "Price",
  rating: "Rating",
  reviews: "Reviews",
  release: "Release date",
  ends: "Sale end",
};

function DealsExplorer({
  payload,
  steamid,
  onRefresh,
  refreshing,
}: {
  payload: DealsPayload;
  steamid: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [filters, setFilters] = useState<DealFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>(DEFAULT_SORT);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => filterDeals(payload.rows, filters), [payload.rows, filters]);
  const sorted = useMemo(
    () => sortDeals(filtered, sort.key, sort.direction),
    [filtered, sort.key, sort.direction],
  );
  const slice = paginate(sorted, page, pageSize);

  // Any change to what is listed starts again at page 1.
  const update = (next: Partial<DealFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  };
  const onSort = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: FIRST_DIRECTION[key] },
    );
    setPage(1);
  };

  const active = countActiveFilters(filters);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] min-[90rem]:grid-cols-[16rem_minmax(0,1fr)]">
      {/* Phones and tablets: collapsible. Desktop: always-open sidebar. */}
      <details className="group rounded-2xl border border-slate-800 bg-surface lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between rounded-2xl px-4 text-sm font-medium text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400">
          <span>
            Filters
            {active > 0 ? (
              <span className="ml-2 rounded-full bg-steam-400 px-1.5 py-0.5 text-[11px] font-semibold text-slate-950">
                {active}
              </span>
            ) : null}
          </span>
          <span aria-hidden="true" className="text-slate-500 transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="border-t border-slate-800 p-4">
          <FilterPanel payload={payload} filters={filters} update={update} idPrefix="m" />
        </div>
      </details>
      <aside
        aria-label="Filters"
        className="hidden self-start rounded-2xl border border-slate-800 bg-surface p-4 lg:sticky lg:top-20 lg:block"
      >
        <FilterPanel payload={payload} filters={filters} update={update} idPrefix="d" />
      </aside>

      <section aria-label="Deals" className="min-w-0">
        <ResultsBar
          slice={slice}
          title={filters.title}
          onTitle={(title) => update({ title })}
          sort={sort}
          onSortChoice={(next) => {
            setSort(next);
            setPage(1);
          }}
          pageSize={pageSize}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          onReset={active > 0 ? () => update(DEFAULT_FILTERS) : null}
        />

        {slice.total === 0 ? (
          <div className="mt-3 rounded-2xl border border-slate-800 bg-surface p-8 text-center text-sm text-slate-400">
            {filters.title.trim() ? (
              <>No deals in this list match &ldquo;{filters.title.trim()}&rdquo;. To look up any game on Steam, use the search at the top.{" "}</>
            ) : (
              <>No deals match these filters.{" "}</>
            )}
            <button
              type="button"
              onClick={() => update(DEFAULT_FILTERS)}
              className="font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
            >
              Reset filters
            </button>
          </div>
        ) : (
          <DealsTable rows={slice.items} sort={sort} onSort={onSort} steamid={steamid} />
        )}

        {slice.pageCount > 1 ? (
          <Pager page={slice.page} pageCount={slice.pageCount} onPage={setPage} />
        ) : null}

        <Footnotes payload={payload} onRefresh={onRefresh} refreshing={refreshing} />
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Filter panel
// -----------------------------------------------------------------------------

function FilterPanel({
  payload,
  filters,
  update,
  idPrefix,
}: {
  payload: DealsPayload;
  filters: DealFilters;
  update: (next: Partial<DealFilters>) => void;
  /** The panel is rendered twice (phone + desktop), so ids need a prefix. */
  idPrefix: string;
}) {
  return (
    <div className="space-y-5 text-sm">
      <Fieldset legend="Deal status">
        {!payload.lowsAvailable ? (
          <p className="mb-2 text-xs leading-relaxed text-slate-500">
            Price history is not connected, so these are unavailable.
          </p>
        ) : null}
        <RadioGroup
          name={`${idPrefix}-status`}
          value={filters.status}
          disabled={!payload.lowsAvailable}
          onChange={(status) => update({ status })}
          options={[
            { value: "any", label: "Any discount" },
            { value: "historical", label: "Historical low" },
            { value: "matching", label: "Matching low" },
            { value: "year", label: "1-year low" },
          ]}
        />
      </Fieldset>

      <Fieldset legend="Owned games">
        {!payload.ownershipKnown ? (
          <p className="mb-2 text-xs leading-relaxed text-slate-500">
            Your library is private, so ownership is unknown.
          </p>
        ) : null}
        <RadioGroup
          name={`${idPrefix}-owned`}
          value={filters.owned}
          disabled={!payload.ownershipKnown}
          onChange={(owned) => update({ owned })}
          options={[
            { value: "include", label: "Include" },
            { value: "exclude", label: "Exclude" },
            { value: "only", label: "Only owned" },
          ]}
        />
      </Fieldset>

      <Fieldset legend="Show">
        <Checkbox
          id={`${idPrefix}-wished`}
          checked={filters.wishedOnly}
          onChange={(wishedOnly) => update({ wishedOnly })}
          label="Only my wishlist"
          hint="Steam wishlist or SteamGauge watchlist"
        />
        <Checkbox
          id={`${idPrefix}-games`}
          checked={filters.gamesOnly}
          onChange={(gamesOnly) => update({ gamesOnly })}
          label="Games only (hide DLC)"
        />
        <Checkbox
          id={`${idPrefix}-unrated`}
          checked={filters.hideUnrated}
          onChange={(hideUnrated) => update({ hideUnrated })}
          label="Hide games Steam hasn't rated"
          hint={`Fewer than ${STEAM_MIN_REVIEWS_FOR_SCORE} reviews`}
        />
      </Fieldset>

      <Fieldset legend="Price (USD)">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id={`${idPrefix}-pmin`}
            label="Min"
            value={filters.priceMin}
            step={1}
            onChange={(priceMin) => update({ priceMin })}
          />
          <NumberField
            id={`${idPrefix}-pmax`}
            label="Max"
            value={filters.priceMax}
            step={1}
            onChange={(priceMax) => update({ priceMax })}
          />
        </div>
      </Fieldset>

      <RangeField
        id={`${idPrefix}-rating`}
        label="Minimum rating"
        value={filters.minRating}
        max={95}
        step={5}
        format={(value) => (value === 0 ? "Any" : `${value}%`)}
        onChange={(minRating) => update({ minRating })}
      />

      <Fieldset legend="Minimum reviews">
        <NumberField
          id={`${idPrefix}-reviews`}
          label="Reviews"
          hideLabel
          value={filters.minReviews === 0 ? null : filters.minReviews}
          step={100}
          onChange={(value) => update({ minReviews: value ?? 0 })}
        />
      </Fieldset>

      <RangeField
        id={`${idPrefix}-discount`}
        label="Minimum discount"
        value={filters.minDiscount}
        max={95}
        step={5}
        format={(value) => (value === 0 ? "Any" : `${value}%`)}
        onChange={(minDiscount) => update({ minDiscount })}
      />
    </div>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}

function RadioGroup<V extends string>({
  name,
  value,
  options,
  onChange,
  disabled = false,
}: {
  name: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      {options.map((option) => (
        <label
          key={option.value}
          className={`flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 ${
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-slate-800/60"
          }`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            className="h-4 w-4 accent-steam-400"
          />
          <span className="text-slate-200">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function Checkbox({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-9 cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-slate-800/60"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-steam-400"
      />
      <span>
        <span className="text-slate-200">{label}</span>
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </span>
    </label>
  );
}

function NumberField({
  id,
  label,
  value,
  step,
  onChange,
  hideLabel = false,
}: {
  id: string;
  label: string;
  value: number | null;
  step: number;
  onChange: (value: number | null) => void;
  hideLabel?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-xs text-slate-400"}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        value={value ?? ""}
        placeholder="Any"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const raw = event.target.value.trim();
          const number = Number(raw);
          onChange(raw === "" || !Number.isFinite(number) || number < 0 ? null : number);
        }}
        className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-sm tabular-nums text-slate-100 placeholder:text-slate-600 focus-visible:border-steam-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400/40"
      />
    </div>
  );
}

function RangeField({
  id,
  label,
  value,
  max,
  step,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium uppercase tracking-wider text-slate-500">
          {label}
        </label>
        <output htmlFor={id} className="text-sm font-semibold tabular-nums text-slate-200">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
        className="h-6 w-full cursor-pointer accent-steam-400"
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Results bar, pager, footnotes
// -----------------------------------------------------------------------------

function ResultsBar({
  slice,
  title,
  onTitle,
  sort,
  onSortChoice,
  pageSize,
  onPageSize,
  onReset,
}: {
  slice: { from: number; to: number; total: number };
  title: string;
  onTitle: (title: string) => void;
  sort: { key: SortKey; direction: SortDirection };
  onSortChoice: (sort: { key: SortKey; direction: SortDirection }) => void;
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
  onReset: (() => void) | null;
}) {
  const selectId = useId();
  const sortId = useId();
  const current = `${sort.key}:${sort.direction}`;
  const listed = SORT_CHOICES.some((choice) => `${choice.key}:${choice.direction}` === current);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p aria-live="polite" className="text-sm text-slate-400">
        {slice.total === 0 ? (
          "No matches"
        ) : (
          <>
            Showing{" "}
            <span className="font-semibold tabular-nums text-slate-200">
              {slice.from}–{slice.to}
            </span>{" "}
            of <span className="font-semibold tabular-nums text-slate-200">{slice.total.toLocaleString("en-US")}</span>
          </>
        )}
        {onReset ? (
          <>
            {" · "}
            <button
              type="button"
              onClick={onReset}
              className="font-medium text-steam-300 underline-offset-2 hover:underline"
            >
              Reset filters
            </button>
          </>
        ) : null}
      </p>
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:w-auto">
        <TitleFilter
          value={title}
          onChange={onTitle}
          label="Filter deals by game title"
          placeholder="Filter deals by title"
          className="w-full sm:w-64"
        />
        <div className="flex items-center gap-2">
          <label htmlFor={sortId} className="text-sm text-slate-500">
            Sort by
          </label>
          <select
            id={sortId}
            value={current}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const [key, direction] = event.target.value.split(":") as [SortKey, SortDirection];
              onSortChoice({ key, direction });
            }}
            className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
          >
            {listed ? null : (
              // A column header chose an order the menu does not list.
              <option value={current}>
                {COLUMN_NAMES[sort.key]} ({sort.direction === "asc" ? "ascending" : "descending"})
              </option>
            )}
            {SORT_CHOICES.map((choice) => (
              <option key={`${choice.key}:${choice.direction}`} value={`${choice.key}:${choice.direction}`}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-sm text-slate-500">
          Per page
        </label>
        <select
          id={selectId}
          value={pageSize}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            onPageSize(Number(event.target.value) as PageSize)
          }
          className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        </div>
      </div>
    </div>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  const go = (next: number) => {
    onPage(next);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3">
      <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} className={secondaryButton}>
        <span aria-hidden="true">←</span>
        <span className="ml-1">Previous</span>
      </button>
      <p className="text-sm tabular-nums text-slate-400">
        Page <span className="font-semibold text-slate-200">{page}</span> of {pageCount}
      </p>
      <button
        type="button"
        onClick={() => go(page + 1)}
        disabled={page >= pageCount}
        className={secondaryButton}
      >
        <span className="mr-1">Next</span>
        <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}

function Footnotes({
  payload,
  onRefresh,
  refreshing,
}: {
  payload: DealsPayload;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="mt-6 space-y-1.5 text-xs leading-relaxed text-slate-500">
      {payload.lowsAvailable ? (
        <p>
          <strong className="font-medium text-slate-400">Historical low</strong>: below Steam&rsquo;s
          previous all-time low. <strong className="font-medium text-slate-400">Matching low</strong>:
          equal to it. <strong className="font-medium text-slate-400">1-year low</strong>: at or below
          the lowest price at any tracked store in the past 12 months. A price under the badges shows
          another store&rsquo;s current price when it beats Steam&rsquo;s (for example
          &ldquo;$13.49 at GOG&rdquo;). Price data from{" "}
          <a
            href="https://isthereanydeal.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-slate-700 underline-offset-2 hover:text-slate-300"
          >
            IsThereAnyDeal
          </a>
          .
        </p>
      ) : (
        <p>Price history is not connected, so historical-low badges are not shown.</p>
      )}
      {payload.source === "featured" ? (
        <p>
          Steam&rsquo;s full sale list could not be loaded just now, so this shows Steam&rsquo;s
          featured specials only.
        </p>
      ) : (
        <p>Every discounted game among Steam&rsquo;s top 1,000 sellers, straight from Steam.</p>
      )}
      <p>
        <strong className="font-medium text-slate-400">Top deals</strong> ranks by log10(Steam
        reviews) &times; discount %, so widely reviewed games on sale come first. Ratings are the
        share of positive Steam reviews in all languages. US prices.
      </p>
      {payload.reviewsPending > 0 ? (
        <p>
          Steam ratings for {payload.reviewsPending.toLocaleString("en-US")}{" "}
          {payload.reviewsPending === 1 ? "item is" : "items are"} still loading. They are sorted
          last, and minimum rating and review filters hide them until then.{" "}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="font-medium text-steam-300 underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? "Loading…" : "Load more ratings"}
          </button>
        </p>
      ) : null}
      {payload.partial ? <p>Some deals could not be loaded just now, so this list is shorter than usual.</p> : null}
      {payload.steamWishlist === "empty_or_private" ? (
        <p>Your Steam wishlist is empty or private, so only your SteamGauge watchlist counts as wishlisted.</p>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// The table
// -----------------------------------------------------------------------------

/** Fixed column widths (the table uses table-layout: fixed), summing to 100%. */
const COLUMNS: readonly { key: SortKey | null; label: string; align: "left" | "right"; className: string }[] = [
  { key: "name", label: "Game", align: "left", className: "w-[24%]" },
  { key: "discount", label: "Discount", align: "right", className: "w-[9%]" },
  { key: "price", label: "Price", align: "right", className: "w-[9%]" },
  { key: null, label: "Price status", align: "left", className: "w-[16%]" },
  { key: "rating", label: "Rating", align: "right", className: "w-[12%]" },
  { key: "release", label: "Released", align: "right", className: "w-[9%]" },
  { key: "ends", label: "Sale ends", align: "right", className: "w-[9%]" },
  { key: null, label: "Wishlist", align: "right", className: "w-[12%]" },
];

function DealsTable({
  rows,
  sort,
  onSort,
  steamid,
}: {
  rows: readonly DealRow[];
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
  steamid: string;
}) {
  // One clock for every row, ticking once a minute (sale end times), so a
  // re-render does not hand every row a new `now` and defeat memo().
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [expanded, setExpanded] = useState<number | null>(null);
  // Stable, so opening one row re-renders only that row and the one closing.
  const toggle = useCallback((appid: number) => {
    setExpanded((current) => (current === appid ? null : appid));
  }, []);
  const close = useCallback(() => setExpanded(null), []);

  const frame = useRef<HTMLDivElement>(null);
  const frameWidth = useElementWidth(frame);

  // Hover or keyboard focus on a row loads its drawer data before the click
  // (components/game-queries.ts).
  const queryClient = useQueryClient();
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.appid, row])), [rows]);
  const intent = useRowPrefetchIntent((appid) => {
    prefetchGame(queryClient, appid, { headerImage: rowsById.get(appid)?.headerImage ?? null });
  });
  return (
    // `relative` makes this frame the containing block for the visually hidden
    // text in the rows, so it scrolls with the table instead of widening the
    // whole page on phones.
    <div ref={frame} className="relative mt-3 overflow-x-auto rounded-2xl border border-slate-800 bg-surface">
      <table className="w-full min-w-[56rem] table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">
          Steam deals. Column headers with buttons sort the table. Select a game to show its
          details below its row.
        </caption>
        <thead>
          <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500 min-[90rem]:text-xs min-[90rem]:tracking-wider">
            {COLUMNS.map((column) => {
              const active = column.key !== null && column.key === sort.key;
              return (
                <th
                  key={column.label}
                  scope="col"
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                  }
                  className={`px-2 py-2.5 font-medium min-[90rem]:px-3 ${column.align === "right" ? "text-right" : ""} ${
                    column.className
                  }`}
                >
                  {column.key ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.key as SortKey)}
                      className={`inline-flex min-h-8 items-center gap-0.5 rounded-md uppercase tracking-wide hover:text-slate-200 min-[90rem]:gap-1 min-[90rem]:tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 ${
                        active ? "text-slate-100" : ""
                      }`}
                    >
                      {column.label}
                      {/* Below 1440px (90rem) only the active column shows its arrow, so labels fit. */}
                      <span aria-hidden="true" className={active ? "text-steam-400" : "hidden text-slate-700 min-[90rem]:inline"}>
                        {active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody
          onPointerOver={intent.onPointerOver}
          onPointerLeave={intent.onPointerLeave}
          onFocus={intent.onFocus}
        >
          {rows.map((row) => {
            const open = expanded === row.appid;
            return (
              <Fragment key={row.appid}>
                <DealTableRow row={row} steamid={steamid} now={now} open={open} onToggle={toggle} />
                {open ? (
                  <tr id={`deal-${row.appid}-details`} className="border-b border-slate-800/70">
                    <td colSpan={COLUMNS.length} className="p-0">
                      <DealDetails row={row} width={frameWidth} onClose={close} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Keeps a click on a control from also toggling the row. */
const stopRowToggle = (event: MouseEvent) => event.stopPropagation();

/**
 * One table row. Memoised: its props only change for the row being opened or
 * closed (and once a minute for the clock), so a toggle re-renders two rows,
 * not the whole page. `data-prefetch-appid` lets the table's hover handler
 * find the row without a handler per row.
 */
const DealTableRow = memo(function DealTableRow({
  row,
  steamid,
  now,
  open,
  onToggle,
}: {
  row: DealRow;
  steamid: string;
  now: number;
  open: boolean;
  onToggle: (appid: number) => void;
}) {
  return (
    <tr
      data-prefetch-appid={row.appid}
      onClick={() => onToggle(row.appid)}
      className={`cursor-pointer border-b border-slate-800/70 last:border-0 hover:bg-slate-900/60 ${
        open ? "bg-slate-900/70" : ""
      }`}
    >
      <td className="px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {row.capsuleImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.capsuleImage}
              alt=""
              width={96}
              height={36}
              loading="lazy"
              decoding="async"
              className="h-9 w-24 shrink-0 rounded object-cover"
            />
          ) : (
            <span aria-hidden="true" className="h-9 w-24 shrink-0 rounded bg-slate-800" />
          )}
          <div className="min-w-0">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`deal-${row.appid}-details`}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                onToggle(row.appid);
              }}
              className={`line-clamp-3 max-w-full break-words rounded text-left font-medium leading-snug underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 ${
                open ? "text-steam-300 decoration-steam-400/60" : "text-slate-100 decoration-slate-500"
              }`}
              title={row.name}
            >
              {row.name}
              <span className="sr-only">{open ? ", hide details" : ", show details"}</span>
            </button>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {row.type === "dlc" ? <Chip tone="slate">DLC</Chip> : null}
              {row.owned ? <Chip tone="slate">Owned</Chip> : null}
              {row.wished ? <Chip tone="violet">Steam wishlist</Chip> : null}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <span className="inline-block rounded bg-steam-400/15 px-1.5 py-0.5 font-semibold tabular-nums text-steam-300">
          -{row.discountPercent}%
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
        <span className="font-semibold text-slate-50">{formatMoney(row.price, row.currency)}</span>
        <s className="block text-xs text-slate-500">
          <span className="sr-only">was </span>
          {formatMoney(row.regular, row.currency)}
        </s>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {row.badges.historicalLow ? <Chip tone="steam">Historical low</Chip> : null}
          {row.badges.matchingLow ? <Chip tone="lime">Matching low</Chip> : null}
          {row.badges.yearLow ? <Chip tone="amber">1-year low</Chip> : null}
        </div>
        {row.cheaperElsewhere ? (
          <p
            className="mt-1 truncate text-xs text-slate-400"
            title={`Cheaper at ${row.cheaperElsewhere.shop}: ${formatMoney(row.cheaperElsewhere.price, row.currency)}`}
          >
            <span className="sr-only">Cheaper elsewhere: </span>
            <span className="font-medium tabular-nums text-slate-200">
              {formatMoney(row.cheaperElsewhere.price, row.currency)}
            </span>{" "}
            at {row.cheaperElsewhere.shop}
          </p>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <Rating percent={row.reviewPercent} count={row.reviewCount} label={row.reviewLabel} />
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right text-slate-300">
        {row.comingSoon ? "Coming soon" : formatRelease(row.releaseDate)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right text-slate-300">
        <SaleEnds iso={row.saleEndsAt} now={now} />
      </td>
      <td className="px-3 py-2 text-right" onClick={stopRowToggle}>
        {row.owned ? (
          <span className="sr-only">Owned, no wishlist action</span>
        ) : (
          <WatchToggle row={row} steamid={steamid} />
        )}
      </td>
    </tr>
  );
});

/**
 * The expanded card under a row.
 *
 * Opens in one frame (v1.9): the first render is only the card's shell
 * (image, title, price, buttons, all from the row already on screen) with
 * skeletons. The facts, store prices and the history chart (the expensive
 * part, years of price points) render right after that frame is painted, in
 * a deferred render React can interrupt. Both requests start immediately; if
 * the row was hovered first, their answers are usually already cached.
 */
function DealDetails({
  row,
  width,
  onClose,
}: {
  row: DealRow;
  /** The scroll frame's visible width, so the card stays readable on phones. */
  width: number | null;
  onClose: () => void;
}) {
  const insights = useGameInsights(row.appid, "full", true);
  const data = insights.data?.status === "ok" ? insights.data.data : null;

  // false on the opening render, true in the deferred render that follows.
  const showPanels = useDeferredValue(true, false);

  // Start the history request now rather than when its panel mounts.
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(historyQuery(row.appid));
  }, [queryClient, row.appid]);
  return (
    <div
      // Sticky inside the horizontally scrolling table: the card stays in
      // view and as wide as the visible frame, not the 56rem table.
      className="sticky left-0 border-t border-slate-800 bg-surface-raised p-4 sm:p-5"
      style={width ? { width } : undefined}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {row.headerImage ? (
          // Steam CDN image; a plain <img> avoids next/image remote configuration.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.headerImage}
            alt=""
            width={460}
            height={215}
            // Visible as soon as the card opens, and usually already in the
            // image cache from the hover prefetch.
            loading="eager"
            decoding="async"
            className="aspect-[460/215] w-full shrink-0 rounded-xl bg-slate-900 object-cover sm:w-56 lg:w-64"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-50">{row.name}</h3>
          <p className="mt-0.5 text-sm text-slate-400">
            <span className="font-semibold tabular-nums text-slate-100">{formatMoney(row.price, row.currency)}</span>{" "}
            on Steam, {row.discountPercent}% off
            {row.reviewPercent !== null && row.reviewCount !== null
              ? ` · ${row.reviewPercent}% positive of ${row.reviewCount.toLocaleString("en-US")} reviews`
              : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href={`https://store.steampowered.com/app/${row.appid}/`}
            target="_blank"
            rel="noopener noreferrer"
            className={primaryButton}
          >
            View on Steam
            <span className="sr-only"> (opens in a new tab): {row.name}</span>
          </a>
          <button type="button" onClick={onClose} className={secondaryButton}>
            Close<span className="sr-only"> details for {row.name}</span>
          </button>
        </div>
        </div>
      </div>

      {/* Top row: facts and price breakdown side by side. Bottom row: the
          price history chart, full width so years of history have room. */}
      {showPanels ? (
        <>
          <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <GameFactsPanel appid={row.appid} mode="full" insights={insights} maxTags={3} showFeatures={false} />
            </div>
            <div className="min-w-0">
              {insights.isPending ? (
                <div aria-busy="true" aria-label="Loading store prices" className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
              ) : (
                <StorePriceList
                  data={data?.prices ?? null}
                  steamPrice={row.price}
                  unavailable={!data || data.unavailable.includes("prices")}
                />
              )}
            </div>
          </div>
          <div className="mt-6 border-t border-slate-800 pt-4">
            <PriceHistoryPanel appid={row.appid} eager />
          </div>
        </>
      ) : (
        <DrawerSkeleton />
      )}
    </div>
  );
}

/**
 * The drawer's first frame: placeholders the same size as the panels, so
 * nothing jumps when they fill in.
 */
function DrawerSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading game details">
      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="h-3 w-28 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-40 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-64 animate-pulse rounded bg-slate-800" />
          <div className="h-6 w-full animate-pulse rounded bg-slate-800/60" />
        </div>
        <div className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
      </div>
      <div className="mt-6 border-t border-slate-800 pt-4">
        <div className="h-3 w-24 animate-pulse rounded bg-slate-800" />
        <div className="mt-3 h-4 w-48 animate-pulse rounded bg-slate-800" />
        <div className="mt-3 h-28 animate-pulse rounded-md bg-slate-800/60" />
      </div>
    </div>
  );
}

/** An element's client width, kept current as it resizes. Null until measured. */
function useElementWidth(ref: { readonly current: HTMLElement | null }): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

type ChipTone = "steam" | "lime" | "amber" | "sky" | "violet" | "slate";
const CHIP: Readonly<Record<ChipTone, string>> = {
  steam: "bg-steam-400/15 text-steam-300 ring-steam-400/40",
  lime: "bg-lime-400/10 text-lime-300 ring-lime-400/30",
  amber: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
  sky: "bg-sky-400/10 text-sky-300 ring-sky-400/30",
  violet: "bg-violet-400/10 text-violet-300 ring-violet-400/30",
  slate: "bg-slate-800 text-slate-400 ring-slate-700",
};

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

function Rating({
  percent,
  count,
  label,
}: {
  percent: number | null;
  count: number | null;
  label: string | null;
}) {
  if (count !== null && count < STEAM_MIN_REVIEWS_FOR_SCORE) {
    return (
      <span className="text-xs text-slate-500" title="Steam shows no score below 10 reviews">
        {count === 0 ? "No reviews" : `${count} ${count === 1 ? "review" : "reviews"}`}
      </span>
    );
  }
  if (percent === null) {
    return (
      <span className="text-slate-600" title="Rating not loaded yet">
        —
      </span>
    );
  }
  const tone =
    percent >= 80 ? "text-steam-300" : percent >= 70 ? "text-lime-300" : percent >= 40 ? "text-amber-300" : "text-rose-300";
  return (
    <span title={label ?? undefined}>
      <span className={`font-semibold tabular-nums ${tone}`}>{percent}%</span>
      {count !== null ? (
        <span className="block text-xs tabular-nums text-slate-500">
          {compactNumber.format(count)} reviews
        </span>
      ) : null}
    </span>
  );
}

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function formatRelease(day: string | null): string {
  if (!day) return "—";
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "in 3 days", "in 5 hours", or "—". Exact time in the tooltip. */
function SaleEnds({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-slate-600">—</span>;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return <span className="text-slate-600">—</span>;
  const exact = new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const hours = ms / 3_600_000;
  const text =
    ms <= 0 ? "Ending" : hours < 24 ? `in ${Math.max(1, Math.round(hours))} h` : `in ${Math.round(hours / 24)} d`;
  return (
    <time dateTime={iso} title={exact} className={hours < 24 ? "font-medium text-amber-300" : undefined}>
      {text}
    </time>
  );
}

/**
 * One-tap watch from the table. Steam-wishlisted and watched games link to the
 * wishlist page instead. Nothing is ever sent to Steam.
 */
function WatchToggle({ row, steamid }: { row: DealRow; steamid: string }) {
  const queryClient = useQueryClient();
  const watch = useMutation({
    mutationFn: () => apiSend("POST", "/api/wishlist", { appid: row.appid }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["wishlist", steamid] }),
  });

  if (row.watched || row.wished || watch.isSuccess) {
    return (
      <Link
        href="/wishlist"
        className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-steam-300 hover:bg-steam-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
      >
        <span aria-hidden="true">✓</span>
        {row.watched || watch.isSuccess ? "Watching" : "Wishlisted"}
        <span className="sr-only">: {row.name}. Open your wishlist</span>
      </Link>
    );
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => watch.mutate()}
        disabled={watch.isPending}
        className="inline-flex min-h-9 items-center rounded-lg border border-slate-700 px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-steam-400/60 hover:bg-steam-400/10 hover:text-steam-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 disabled:opacity-60"
      >
        {watch.isPending ? "Adding…" : "Watch"}
        <span className="sr-only">: {row.name}</span>
      </button>
      {watch.isError ? (
        <span role="alert" className="mt-1 max-w-[12rem] whitespace-normal text-[11px] text-rose-300">
          {describeWishlistAddError(watch.error, null)}
        </span>
      ) : null}
    </span>
  );
}

// =============================================================================
// Loading state
// =============================================================================

function DealsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deals" className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] min-[90rem]:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="hidden h-[32rem] animate-pulse rounded-2xl border border-slate-800 bg-surface lg:block" />
      <div>
        <div className="h-12 animate-pulse rounded-2xl bg-slate-900 lg:hidden" />
        <div className="mt-3 h-6 w-48 animate-pulse rounded bg-slate-800" />
        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-800 bg-surface">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-slate-800/70 px-3 py-2 last:border-0">
              <div className="h-[45px] w-[120px] shrink-0 animate-pulse rounded bg-slate-800" />
              <div className="h-4 flex-1 animate-pulse rounded bg-slate-800" />
              <div className="h-4 w-14 animate-pulse rounded bg-slate-800" />
              <div className="h-4 w-14 animate-pulse rounded bg-slate-800" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
