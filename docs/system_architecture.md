# SteamGauge — System Architecture

| | |
|---|---|
| **Status** | v1.12.2: peak date removed; ITAD's player stats are counts only (no date field), so the All-Time Peak Players card shows ITAD's count alone · v1.12.1: the All-Time Peak Players card shows "Achieved on Nov 10, 2023" when the date is known; ITAD reports no dates, so that is when SteamGauge's own recording is the highest figure, and otherwise the count stands alone · v1.12: player history chart and every estimate removed; the game page shows a "Current In-Game Players" badge (live from Steam) under the review badge, and a Player peaks panel under About this game with IsThereAnyDeal's 24-hour and all-time peaks ("N/A" when missing) · v1.11.2: every player chart range works: 1m to max draw a dashed "Estimated historical trend" from release (at the all-time peak) to where SteamGauge's tracking began, with rises during Steam sales from IsThereAnyDeal's price history, then the solid recorded line; the all-time card shows IsThereAnyDeal's overall peak and when hourly tracking began · v1.11.1: the players panel no longer shows "Player counts could not be loaded": the route degrades instead of answering 503 when recordings can't be read (for example, migration 0004 not yet run), 24-hour and all-time peaks also come from IsThereAnyDeal, and a dashed, labelled estimate fills 48h and 1w until enough is recorded · v1.11: game page adds the Steam review rating, a player stats header (now, 24-hour peak, recorded all-time peak) and a concurrent-player history chart with 48h–max ranges, from player counts SteamGauge records itself (migration 0004, hourly sampler) · v1.10: Dashboard toolbar (title/tag filter, play status, tag, 10 sorts), Detailed/Compact cards, titles open the game page, bulk library store data · v1.9.1: shared site footer with "Made for MIS325." on every page · v1.9: performance: hover prefetch, one-frame Deals drawer, in-memory cache, CDN sharing of per-game data, cached ITAD ids, parallel Wishlist refresh · v1.8.1: query client moved to the root layout (fixes the "No QueryClient set" boot crash) · v1.8: Steam colour theme, global game search in the top bar with a game page, title filters on Deals, Dashboard and Wishlist · v1.7.2: store links in the price breakdown, new Deals dropdown layout, duplicate-name fix, 5 features max on Wishlist cards · v1.7.1: Wishlist cards show Genres · v1.7: wider layout (1600px) on every tab; Wishlist facts under the image; Deals dropdown with header image, 3 tags, no Features; title text is the row toggle |
| **Date** | 2026-11-19 (v1.11–v1.12.2); 2026-11-17 (v1.8–v1.9); v1.3–v1.7.2: 2026-11-16; v1.2: 2026-11-14 |
| **Scope** | Technical core, data model, Steam data caching strategy, security configuration |
| **Schema source** | `steamlite_init.sql` (applied in Supabase 2026-11-14), plus `0002_price_history.sql`, `0003_search_steam_apps.sql` and `0004_player_counts.sql` (v1.11, not yet applied). Sections 4.4 and 5.6 mirror them. |
| **Stack** | React, Tailwind CSS, Next.js (Route Handlers as serverless functions), Supabase (Postgres) |

---

## 1. Summary

*Renamed from SteamLite to SteamGauge on 2026-11-16 (v1.6). The two applied migrations keep their original filenames (`0001_steamlite_init.sql`), so Supabase's migration history is unchanged.*

SteamGauge is a mobile-first companion web app that shows Steam profile, library, achievement, friend, and store data. The browser never talks to Steam. Every Steam request goes through our Next.js serverless layer, which holds the API key, validates input, and answers from a Supabase-backed cache whenever possible.

Three decisions define the system:

1. **Backend-for-frontend (BFF) proxy.** The Steam Web API key lives only in server environment variables. The client calls `/api/*` on our own origin.
2. **Cache-first reads with a hard quota governor.** Steam is treated as a slow, rationed upstream. Supabase is the system of record for cached Steam data; a Postgres-enforced budget makes it impossible for us to exceed Steam's limits even under load or bugs.
3. **Server-only database access.** Row Level Security is on for every table with no public policies. Only serverless functions (using the Supabase Service Role / secret key) read or write data.

**A note on "bypassing" rate limits.** We do not evade Steam's limits (no key rotation, no proxy pools, no multiple keys). That would breach the Steam Web API Terms of Use and risks key revocation. The strategy is to need far fewer calls than the limit allows, by caching, batching, and deduplicating.

### Assumptions to confirm

- Hosting is Vercel (Hobby or Pro). The design works on any serverless host, but cron and CDN details below assume Vercel.
- Feature set for v1: sign in with Steam, profile summary, owned games, recently played, achievements per game, friends list, game detail page (store data), game news, app name search, tracked apps.
- Expected scale is class-project size (tens to low hundreds of users), with headroom designed in.

---

## 2. Upstream constraints

| Upstream | Host | Auth | Limit | Source of limit |
|---|---|---|---|---|
| Steam Web API | `api.steampowered.com` | API key (query param) | 100,000 calls/day per key | Official, Steam Web API Terms of Use |
| Storefront API | `store.steampowered.com/api` | None | About 200 requests per 5 minutes per IP | Unofficial, community-observed; undocumented and can change |
| Steam OpenID | `steamcommunity.com/openid` | None | Not published | n/a |
| IsThereAnyDeal API (optional) | `api.isthereanydeal.com` | API key in the `ITAD-API-Key` header | 1,000 requests per 5 minutes per key | Official, ITAD API docs |

Implications:

- 100,000/day averages to about 1.16 requests/second. A naive design (5 Steam calls per page view, no cache) exhausts that at roughly 20,000 page views/day, and a single refresh loop bug can burn it in minutes.
- The Storefront limit is per IP. Serverless functions egress from shared, changing IPs, so we can be throttled by traffic that is not ours. Store data must therefore be the most aggressively cached, and the app must degrade gracefully on HTTP 429/403.
- Steam returns 429 without a reliable `Retry-After`. We back off on our own schedule.
- Private profiles return empty or 401/403 responses. That is a valid answer to cache, not an error to retry.

Our self-imposed ceilings sit below the real ones: **80,000/day** for the Web API, **150 per 5 minutes** for the Storefront API, and **600 per 5 minutes** for ITAD (450 for background refreshes).

`IStoreQueryService/Query/v1` (v1.5) takes our key like other Web API methods. It is Steam's own store query and is the source of the deals pool: filters include `price_filters.min_discount_percent` and `global_top_n_sellers`, and with a `data_request` it returns full store items (the same objects as `GetItems`) for up to 1,000 apps per call. It is undocumented by Valve; field names follow the community documentation in section 10.

Three Web API services added in v1.3–v1.4 need no key and no Storefront budget, but are charged to the `webapi` bucket like every other call:

- `IWishlistService/GetWishlist/v1` returns `{appid, priority, date_added}` per wishlisted app. A private wishlist and an empty one give the same empty response, so the UI cannot tell them apart and says so.
- `IStoreBrowseService/GetItems/v1` returns name, images, release date, review summary and current purchase option (with the sale end time) for up to 50 apps per call. It replaces per-app `appdetails` calls for list views and is the main source of review totals.
- `IUserReviewsService/GetAppReviews/v1` returns one app's review totals (`query_summary.total_reviews`, `total_positive`, `review_score_desc`). Valve retired `store.steampowered.com/appreviews/{appid}?json=1` on 2026-10-22 (it now redirects to the store front page), and this is its replacement. We call it **without our key**: Steam documents the key as optional and meant for the app's own publisher. Anonymous callers share a lower Steam-side limit (HTTP 429 when exceeded), and responses may be up to 10 minutes old. It is used only for apps `GetItems` left without review data (section 5.4).

---

## 3. System overview

```
 ┌──────────────────────────── Browser (React + Tailwind) ───────────────────────────┐
 │  Server Components for first paint · Client Components + TanStack Query for data  │
 └───────────────────────────────────────┬───────────────────────────────────────────┘
                                         │ same-origin HTTPS, httpOnly session cookie
                                         ▼
 ┌─────────────────────────── Vercel Edge / CDN (L1 cache) ──────────────────────────┐
 │  Caches public, non-user responses via Cache-Control s-maxage                     │
 └───────────────────────────────────────┬───────────────────────────────────────────┘
                                         ▼
 ┌────────────────────── Next.js Route Handlers (serverless BFF) ────────────────────┐
 │  1. Session + input validation (zod)      4. Quota governor (Postgres RPC)        │
 │  2. Inbound rate limit (per IP/session)   5. Steam client (batch, timeout, retry) │
 │  3. Cache read (Supabase, L2)             6. Normalize → write cache → respond    │
 └──────────────┬─────────────────────────────────────────────────┬──────────────────┘
                │ Supabase secret key (server only)               │ Steam API key (server only)
                ▼                                                 ▼
 ┌──────────── Supabase Postgres ───────────┐      ┌──────────────── Steam ───────────┐
 │ api_cache · rate_buckets · steam_apps    │      │ api.steampowered.com             │
 │ users · sessions · tracked_apps · RLS on │      │ store.steampowered.com           │
 └──────────────────────────────────────────┘      │ steamcommunity.com/openid        │
                ▲                                  └──────────────────────────────────┘
                │ Vercel Cron → /api/cron/* (warm hot keys, purge expired rows)
```

---

## 4. Technical core

### 4.1 Frontend

- **Next.js App Router.** Server Components render the page shell and any data already in cache, so first paint on mobile does not wait on client-side fetches.
- **TanStack Query** in Client Components for interactive data. It gives us the L0 cache: in-memory dedupe, `staleTime` per resource, and background refetch. `refetchOnWindowFocus` is disabled for Steam data so tab switching does not generate traffic.
- **Tailwind, mobile-first.** Base styles target about 360px wide; `sm:`/`md:`/`lg:` add layout for larger screens. Touch targets are at least 44px. Long lists (libraries with 1,000+ games) are virtualized.
- **Images** come from Steam's CDN hosts through `next/image` with an explicit `remotePatterns` allowlist. Image requests do not count against API limits.
- **Page width (v1.7).** Every signed-in tab, the navigation bar, and the loading and error screens share one width from `components/layout-width.ts` (`max-w-[1600px]`, same side padding as before). It is a plain module so Server Components (`loading.tsx`) can import it. Dashboard grids add columns at `xl`/`2xl` so cards keep their proportions instead of stretching.
- **Query client (v1.8.1).** `components/providers.tsx` creates one TanStack Query client (created in `useState`, never at module level, so server renders never share a cache between users) with the app's defaults. `app/layout.tsx` wraps everything inside `<body>` in it. It must sit above the navigation: v1.8 put the global search inside the nav while the client was still provided lower down, in the app shell around page content only, and every page crashed on boot with "No QueryClient set". A test now renders the root layout, app shell, nav and each page together with a stub that fails like the real library when no provider is present.
- **App shell.** `app/(app)/layout.tsx` wraps every signed-in page with the dark page surface and the navigation. All pages and the nav share the root query client, so data loaded on one page survives navigation and an action on one page can refresh another (watching a game from Deals refreshes the Wishlist, and the reverse). Navigation (`components/app-nav.tsx`) links Dashboard, Deals, and Wishlist: a sticky top bar at 640px and wider, and a fixed bottom tab bar on phones. The current page is marked with `aria-current="page"` as well as colour. The layout does not check the session; each page does, because layouts are not re-rendered on every navigation. `loading.tsx` and `error.tsx` in the same folder keep the wait and failure screens in the same dark design; the error screen never shows the error's message.
- **Dashboard** (`/dashboard`). One library request drives the Library Health banner and the library list below it. The banner's three stat cards are toggle buttons (`aria-pressed`) that choose the list: **Games owned** lists every game A to Z, **Lifetime hours** lists every game by playtime (most first), and **Unplayed backlog** (the default) lists games with exactly 0 minutes played, A to Z. The list heading and count follow the selection and are announced politely to screen readers. Lists show 24 games at a time with a "Show more" button. Since v1.10 prices come from one bulk request instead (below); before, each Backlog card looked up its own price with Storefront `appdetails` as it scrolled into view (24 Storefront calls per page). The card's value rating divides the current US store price by a game length that is **simulated** from the AppID and labelled as such in the UI; there is no real length data source yet. After a stale answer the client re-checks at most twice, 4 seconds apart, then stops.
- **Dashboard controls (v1.10).** One toolbar (`components/dashboard-view.tsx`, logic in `lib/library-view.ts`) applies to all three sections the stat cards choose (All games, Lifetime hours, Unplayed backlog). Filters and sort carry over when switching sections.
  - **Filter by title or tag:** every word typed must appear in the title or one of the game's tags.
  - **Play status:** Unplayed (0 minutes), Played, Played in the last 2 weeks. Off in the backlog, which is unplayed games by definition.
  - **Genre or tag:** one Steam tag, listed with how many games in the section carry it. Steam's genre labels (RPG, Action, Strategy) are tags.
  - **Sort:** Section default (A to Z, or by playtime in Lifetime hours), title A–Z / Z–A, hours played both ways, price both ways, release date both ways, last played. Unknown values sort last in both directions. Price and release sorts are disabled until store data loads.
  - **Card size:** Detailed (header art, playtime, release year, last played, 3 tags, current price; unplayed games also get the backlog value meter) or Compact (one dense row: icon, title, playtime, price). 24 detailed or 60 compact per "Show more".
  - Card size and sort are remembered in the browser (`localStorage`, read after the first render so hydration matches); filters last until the page is left.
  - Every game's title links to `/game/[appid]`, the page the top-bar search opens. In Compact rows the link covers the whole row; Detailed cards keep "View on Steam".
  - Lifetime hours shows each game's playtime rank, its place among all owned games, so the number stays the same under any filter or sort.
  - **Not available from Steam:** the date a game was added or bought (no API; "Last played" is offered instead) and "Completed" (Steam does not record completion; inferring it from achievements would need one call per game). Genres proper come only from per-game Storefront `appdetails`, too costly across a library; tags cover them.
- **Library store data (v1.10).** `GET /api/library/store` returns header art, release date, current US price and up to 5 tag names for the signed-in user's games. One `GetItems` call (Web API budget) per 50 games, 3 at a time, for at most 2,000 games, most played first. It is cached per user for 12 hours (stale up to 3 days), keyed by the library's appids, so a purchase makes a new entry. Tag names come from the shared tag list; if that fails, prices and dates still arrive without tags. The list renders from the library alone and fills in when this arrives.
- **Deals** (`/deals`). A dense, SteamDB-style table. One request to `GET /api/deals` returns every discounted game among Steam's global top 1,000 sellers, and the browser filters, sorts and pages them with no further requests.
  - **Expandable rows (v1.6, refined v1.7).** Clicking a row, or the game's title text (the title itself is the button, with `aria-expanded`; there is no arrow icon), opens a detail card directly under that row. The card starts with the game's header image. Below it (v1.7.2), "About this game" and "Price breakdown" sit side by side, and the price history chart gets its own full-width row underneath. Its facts show Genres and at most 3 tags; the Features list is left out here. One card is open at a time; Escape or "Close" folds it. Nothing in the table navigates away: the card's "View on Steam" button opens the store page in a new tab. The card holds the full price history chart, a price breakdown (Steam all-time low, all-time / 1-year / 3-month low at any store, and the current price at every store ITAD tracks, cheapest first), and the game facts below. Its data loads only when opened and is cached. Inside the horizontally scrolling table the card is `position: sticky` and sized to the frame's visible width (measured with a ResizeObserver), so on phones it stays readable while the table scrolls.
  - **Fit at desktop widths (v1.7).** Column widths are percentages of a fixed-layout table that never scrolls sideways from 1280px. Game names wrap to at most 3 lines (full name on hover) instead of being cut to one. Below 1440px (90rem) the filter sidebar is 14rem instead of 16rem, header labels are 11px with tighter spacing, and only the active column shows its sort arrow, so nothing in the header or cells overlaps. At 1440px and up the table looks as before, just wider.
  - **Columns:** game (capsule image, name, DLC/Owned/Steam-wishlist chips), discount, price (regular price struck through), price status badges, Steam review rating (percent positive and review count), release date, sale end time (relative, exact time on hover), and a Watch button.
  - **Sorting:** a "Sort by" menu (Top deals, biggest discount, most reviewed, best rated, price both ways, newest release, sale ending soonest, name both ways), and every column but badges and Watch also sorts from its header (`aria-sort` on the active one). Unknown values sort last in both directions.
  - **Default order, "Top deals"** (v1.5, as specified): `score = log10(total Steam reviews) × discount%`. Games with fewer than 10 reviews (Steam's own threshold for showing a score) or unknown reviews get no score and sort last. Examples: 640,000 reviews at 75% off scores 436; 200,000 at 50% scores 265; 1,100 at 90% scores 274; 50 at 90% scores 153. Known trade-off: a small game at a very deep discount can outrank a major title at a moderate one (1,000 reviews at 90% = 270 beats 100,000 at 50% = 250). Restricting the pool to top sellers is what keeps the long tail out. Implemented as `dealScore` in `lib/deals-table.ts`.
  - **Paging:** 25, 50 (default) or 100 rows per page. Any filter or sort change returns to page 1.
  - **Filters** (sticky sidebar at 1024px and wider, a collapsible panel on phones): deal status (any discount, historical low, matching low, 1-year low); owned games (include, exclude, only owned); only my wishlist (Steam wishlist or SteamGauge watchlist); games only (hides DLC, on by default); hide games Steam hasn't rated (fewer than 10 reviews; on by default; unreleased games and rows whose reviews are still loading are kept); price range in dollars; minimum rating; minimum reviews; minimum discount.
  - **Badges** (from IsThereAnyDeal, `lib/deals-table.ts`): *Historical low* when the price is below Steam's all-time low, or equals it and ITAD flags the deal as a new low. *Matching low* when it equals Steam's all-time low otherwise. *1-year low* when it is at or below the lowest price at any store in the past year.
  - **Not built, by design:** a "2-year low" (ITAD exposes all-time, 1-year and 3-month lows only; the 1-year low stands in) and a "rare deal" badge (no data source).
  - **Data sources (v1.5, Steam first):**
    1. **Pool.** `IStoreQueryService/Query` with `released_only`, games and DLC, `price_filters.min_discount_percent = 1` and `global_top_n_sellers = 1000`, 200 apps per page, 5 cached pages. Each page includes Steam's name, art, release date, review totals, price, discount and sale end in the same response. If Steam sends only ids, `GetItems` fills in the store data. Undiscounted and free apps are dropped.
    2. **Enrichment by Steam AppID (ITAD).** `lookup/id/shop/61` maps `app/{appid}` to ITAD ids, then `games/prices/v3` (no shop filter) gives the Steam all-time low and its deal flag, the 1-year low at any store, and every store's current price. The cheapest non-Steam price is kept only when it beats Steam's and shown as e.g. "$13.49 at GOG". This takes two ITAD calls per page.
    3. **Reviews still missing** after step 1 are filled as in section 5.4. Rows still waiting are counted in `reviewsPending`, sorted last, and explained under the table with a "Load more ratings" button.
  - **Not used: ITAD's deals list.** It drove the pool in v1.3–v1.4, which surfaced mostly obscure titles (the highest-reviewed game on page 1 had about 800 reviews) and missed major sale titles. ITAD is now only asked about apps by AppID.
  - **Fallbacks.** Without `ITAD_API_KEY`: the same Steam pool, no badges, deal-status filter disabled. If Steam's query fails on every page: Steam's featured specials (`featuredcategories`, a few dozen games), enriched the same way, with a note under the table.
  - Ownership comes from the cached owned-games list; a private library disables the owned filter rather than guessing. The cost-per-hour ranking and backlog-genre warnings of v1.2 were removed with the card grid.
- **Wishlist** (`/wishlist`). Shows the user's real Steam wishlist merged with their SteamGauge watchlist.
  - **Steam sync is read-only.** `GetWishlist` is called with the session's SteamID (cached 30 minutes). Steam wishlist entries show their Steam rank ("Steam wishlist #3"). SteamGauge never writes to Steam; watching, notes and removal change only `tracked_apps` in Supabase. The 50-game limit applies to the local watchlist only; Steam entries are capped at 500 for display.
  - **Sorting:** a "Sort by" toolbar directly above the list: on sale first (default), Steam wishlist order, date added (newest or oldest), title A–Z or Z–A, price low–high or high–low, biggest discount, best rated. Sorting runs in the browser (`lib/wishlist-sort.ts`); the choice is remembered in that browser (localStorage, wrapped so blocked storage falls back to the default). Missing values sort last; ties keep Steam wishlist order. "Best rated" treats fewer than 10 reviews as unrated. Each item carries `listOrder` (Steam rank, then watch-only games newest first) so Steam order survives re-sorting. Review totals missing from `GetItems` are filled as on Deals, at most 20 new lookups per request.
  - **Privacy:** an empty response is shown as "empty or private", with a link to Steam's privacy settings (Game details must be Public).
  - **Lows line:** with ITAD configured, each card states Steam's all-time low and the 1-year low at any store.
  - **Chart history** comes from ITAD (`GET /games/history/v2`, Steam shop only, lowest price per day), so a game shows years of history the first time it is opened. The request always sends `since=2003-01-01T00:00:00Z`: without `since`, ITAD returned only about the last three months (ITAD's docs state no default). The chart always shows 6M, 1Y, 2Y and All buttons with All selected; a range longer than the history is disabled, with the start date in its tooltip, and "Since {date}" is shown beside the buttons. Without ITAD, or if ITAD fails or has no record, the chart falls back to SteamGauge's own recorded history below.
  - **Cards:** each has a discount status badge (on sale with percentage, full price, free, or price unavailable). Games are watched from global search (the game page's "Watch" button) or by pasting a Steam store link or AppID into the filter box (v1.8). Each card loads its price history when it scrolls into view and shows a single-series step-line chart (a price holds until it changes) with a crosshair readout on hover, touch, or arrow keys, a marked low point, and a table view of the same data. Above the chart a plain statement says whether the current price is the lowest on record. With the local record that claim needs 7 or more recorded days; with less, any price is trivially the lowest and the UI says how many days remain instead.
- **Game facts (v1.6),** shown in expanded Deals rows and on every Wishlist card (`components/game-insights.tsx`, `GET /api/apps/[appid]/insights`):
  - **Live players** from `ISteamUserStats/GetNumberOfCurrentPlayers`, with the age of the count.
  - **Developer(s), publisher(s), franchise** and the most-voted **tags** from `GetItems` (`basic_info`, `include_tag_count = 12`); tag names from `IStoreService/GetTagList`.
  - **Genres and descriptors** ("Single-player", "Steam Achievements") from Storefront `appdetails`, which also backs up developer and publisher.
  - **Placement:** on a Wishlist card, "About this game" sits in the left column directly under the header image (on phones, under the image before the title); price history stays on the right.
  - **Two modes protect the Storefront budget:**
    - `mode=full` (an expanded Deals row: one user action) fetches `appdetails` if it is not cached, and adds ITAD's store prices.
    - `mode=card` (Wishlist cards) skips store prices and loads when the card scrolls into view. Since v1.7.1 it also fetches `appdetails` when it is not cached, so cards show Genres (directly above Tags, the same chips as the Deals dropdown). Each game's `appdetails` is fetched at most once a day for all users, every call passes the Storefront quota gate, and when that budget is spent the card shows no genres and marks them `unavailable`.
  - **Failure handling:** each source is independent; a failing one hides only its own section (`unavailable`).
  - **Duplicates (v1.7.2):** Steam can list one descriptor under several category ids (e.g. "DualSense Controller Support" twice), which caused a React duplicate-key error. Names are deduplicated (case-insensitive) when the facts are built, and again in the component before any limit is applied; list keys combine the name and its position.
  - **Limits:** Deals dropdown: 3 tags, no Features. Wishlist cards: all tags, at most 5 Features.
  - **Store links (v1.7.2):** in the price breakdown, each store name links to the game at that store in a new tab (`rel="noopener noreferrer"`). The link is the `url` ITAD returns for that deal, usually an ITAD redirect that may carry an affiliate tag; only absolute `https` links are kept, and Steam's row links to the Steam store page directly. The price repeats the link for mouse users but is out of the tab order. The ITAD store-prices cache key gained `v2` because the payload now includes `url`.
- **Recorded price history (fallback).** Steam publishes no historical prices. Every live price fetch through `getAppPrice` or `getAppDetails` is recorded in `price_history` (section 4.4). "Lowest recorded" therefore means lowest since SteamGauge first saw the app, not lowest ever, and the wishlist page says so.
- **Colour theme (v1.8).** Tailwind 4 is configured in CSS, so there is no `tailwind.config.js`; the tokens live in the `@theme` block of `app/globals.css`:
  - `page` `#171D25` (Steam navy) is the outer background; `chrome` `#0B0E14` is the top bar and phone tab bar; `surface` `#0F1219` and `surface-raised` `#141922` are cards and panels.
  - `steam-50` … `steam-950` replace the old emerald accent. `steam-400` is `#66C0F4` (Steam light blue) and `steam-700` is `#417A9B`. Neutral greys moved from `zinc` to `slate`, which leans blue to match the navy.
  - The price chart line is `#3A9AD6`, not `#66C0F4`: the lighter blue is too bright for a data mark on the dark card (OKLCH lightness 0.77, above the 0.48–0.67 band), and `#3A9AD6` passes the lightness, contrast and colour-blind separation checks against the green "low" marker and `#141922`.
- **Global search (v1.8).** A search box sits in the sticky top bar on every signed-in page (`components/global-search.tsx`, placed in `components/app-nav.tsx`).
  - It waits 250 ms after typing stops and needs 2 characters before it asks `GET /api/search`. Results stay on screen while the next ones load, and each query is cached in the browser for 10 minutes.
  - The dropdown shows up to 8 games: capsule image, title, release year (or "Coming soon"), and price with the discount, or "Free". On phones it spans the screen under the bar and titles wrap to two lines with the price under them.
  - It follows the ARIA 1.2 combobox pattern: `aria-expanded`, `aria-controls`, `aria-activedescendant`, a listbox of options and a polite status line. Up and Down move through results (wrapping), Enter opens the highlighted result or the first one, Escape closes and then clears, and "/" focuses the box from anywhere on the page.
  - Choosing a game opens `/game/[appid]`.
- **Game page (v1.8).** `app/(app)/game/[appid]/page.tsx` checks the session and the AppID (404 for anything that is not 1–9,999,999), then renders `components/game-view.tsx`. The page shows the header image, type and release date, title, short description (as text), price, "View on Steam" (new tab) and "Watch" (adds to the SteamGauge watchlist). Below that are the same game facts, store price list and full price history chart as the Deals dropdown. It reuses `GET /api/apps/[appid]`, `/insights?mode=full` and the history route, so it adds no new upstream calls.
- **Game page additions (v1.11).**
  - **Review rating** (`components/review-badge.tsx`), under the description: Steam's label as a badge ("Very Positive") and "91% of 128,734 user reviews are positive". It comes from full-mode insights, which now also reads the cached `GetAppReviews` summary (3 days fresh, 14 days stale; the same entry Deals and Wishlist use). Colours follow Steam: positive labels `#66C0F4` (9.3:1 on the card), mixed `#B9A074` (Steam's tan, 7.4:1, used instead of gray so "Mixed" does not read as "no data"), negative a `#A34C25` tint with `#E0805A` text (6.6:1; `#A34C25` alone is only 3.2:1). The label decides the tone; the 70%/40% thresholds are used only when Steam gives no label. For labels like "8 user reviews" it shows "X% positive" instead. While facts load it shows a skeleton; if Steam could not be asked, "Steam reviews are unavailable right now."
  - *v1.11–v1.11.2 also had a concurrent-player history chart below the price history, with range buttons (48h to max) and, where too little was recorded, a dashed modelled estimate. It was removed in v1.12 (ADR-35), along with `components/player-history.tsx`, `lib/player-history.ts` and `GET /api/apps/[appid]/players`.*
- **Player figures (v1.12, `components/player-metrics.tsx`).** Every figure is a reported number, never an estimate. Both pieces read the full-mode insights request the page already makes, so they add no requests.
  - **"Current In-Game Players" badge** in the header, directly under the review badge: Steam's live count (`GetNumberOfCurrentPlayers`, cached 10 minutes), with a green dot in Steam's in-game green `#90BA3C` and the count's age on hover. The "playing now" line in About this game is hidden on this page (`showPlayers={false}`), so the count is not shown twice; Deals and Wishlist keep it.
  - **Player peaks panel** directly under About this game: two `#0B0E14` cards, **24-Hour Peak Players** (ITAD `players.day`, "IsThereAnyDeal · daily snapshot") and **All-Time Peak Players** (ITAD `players.peak`, "IsThereAnyDeal · historical peak"), with "Peaks tracked from Steam by IsThereAnyDeal" linked underneath.
  - **No peak date (v1.12.2).** ITAD's `players` object is counts only (`recent`, `day`, `week`, `peak`); `ItadPlayersData` in `lib/steam/composites.ts` and its parser read exactly those four, and nothing else is stored. The all-time card therefore shows ITAD's count with no date. *v1.12.1 briefly showed "Achieved on …" from SteamGauge's own recordings when they held the highest figure; that was removed (ADR-37), along with `recordedAllTimePeak`, `allTimeAt`, `allTimeSource` and `formatPeakDate`.*
  - **Formatting:** whole numbers with thousands separators ("1,248,592", `formatPlayerCount`). Anything missing shows "N/A" in the same fixed-height card (`min-h-[6.5rem]`), with a note: "Not tracked for this game" (ITAD has no figure, common for niche titles), "Couldn't be loaded just now" (ITAD failed; `playerPeaks` is in `unavailable`), or "Not available" (no ITAD key). The badge shows "N/A Current In-Game Players" when Steam has no count. While loading, both show skeletons.
  - **Data:** insights in full mode includes `playerPeaks: { day, allTime }` from `getItadPlayers` (ITAD `games/info/v2` `players.day` and `players.peak`, cached 1 hour for everyone). It is null in card mode and without an ITAD key. A game ITAD has no counts for gives `{ day: null, allTime: null }`, which is not an error. An ITAD failure marks the `playerPeaks` section unavailable, so, like any incomplete answer, the response is not shared by the CDN and a hover prefetch is declined.
- **Player count recordings (v1.11; kept but not shown since v1.12.2).** Neither Steam nor any public API publishes historical player counts, and SteamDB's terms forbid scraping its charts, so SteamGauge records its own for a future measured chart:
  - Every live `GetNumberOfCurrentPlayers` refresh (the 10-minute insights cache) records a reading through `record_player_count`, via the `onRefreshed` hook in `lib/steam/endpoints.ts` (`lib/steam/player-recorder.ts`; never throws, logs only the Postgres error code).
  - `GET /api/cron/sample-players` reads current players for up to 300 games an hour: watched games first (most watchers first), then games viewed in the last 14 days. It runs 5 at a time on the cron quota tier and stops early on `quota_exhausted` or `throttled`, then purges fine-grained rows older than 31 days. Since v1.12, opening a game's details (insights in full mode, not a hover prefetch) notes interest (`note_player_interest`, at most once an hour per game) after the response is sent.
  - Nothing reads the recordings since v1.12.2 (v1.12.1 used them to date the all-time peak). To stop collecting, disable the GitHub workflow; the per-view recording costs no extra Steam calls.
- **Title filters (v1.8).** Deals, Dashboard and Wishlist each have a filter box (`components/title-filter.tsx`) that narrows the list already on screen. They never call the server or change the URL.
  - Matching uses `matchesTitle` in `lib/title-search.ts`: every word typed must appear in the title, in any order. Case, accents, ™/®/© and punctuation are ignored, and Roman numerals match digits ("civilization 6" finds "Civilization VI").
  - Deals: next to "Sort by". The title is part of the filter state, counts as an active filter, and "Reset filters" clears it.
  - Dashboard: above the list for the chosen stat card. The text is kept when switching cards, and each game keeps its playtime rank.
  - Wishlist: replaces the old "add by AppID or link" form. Typing a title filters the list. A pasted Steam store link or App ID shows that game if it is on the list, and otherwise offers "Watch app N", which does what the old form did. When the SteamGauge watchlist is full, a notice says so.
- **Performance (v1.9).** Measured in Chrome with 50 Deals rows, 300-point price histories and the drawer's data already cached:

  | | Drawer on screen | Fully filled | Longest frame |
  |---|---|---|---|
  | v1.8, normal CPU | 72 ms | 72 ms | 56 ms |
  | v1.9, normal CPU | 9 ms | 43 ms | 17 ms |
  | v1.8, 4× slower CPU | 374 ms | 374 ms | 300 ms |
  | v1.9, 4× slower CPU | 53 ms | 117 ms | 50 ms |

  - **Hover prefetch (Deals).** When the mouse rests on a row for 120 ms, or a row's button gets keyboard focus, the drawer's two requests (full-mode insights and price history) start, and its header image is warmed in the browser's cache. Touch and pen never prefetch (a tap is the click). One set of handlers on the `<tbody>` finds the row from `data-prefetch-appid`, so rows need no handlers. It is skipped when the data is cached and fresh or already loading, when the browser sends Save-Data, and when 3 rows are already prefetching. The queries are defined once in `components/game-queries.ts`, so the prefetch fills exactly the entry the drawer reads; opening a row whose prefetch is still running shares that request.
  - **Prefetches are cheap guesses.** They carry the `x-steamgauge-prefetch: 1` header. The server answers them from a lower quota tier (section 5.5), limits them to 120 per user per minute, and returns 503 `prefetch_declined` instead of degraded data. The history route never falls back to the Storefront for one. A declined prefetch caches nothing in the browser. If the drawer opened while it ran, the browser repeats the request as a normal load.
  - **One-frame drawer.** Opening re-renders only the two rows involved: rows are memoised, the toggle callback is stable, and the sale-end clock ticks once a minute instead of changing on every render. The first render of the drawer is its shell (image, title, price, buttons, all from the row) with skeletons the size of the panels. The facts, store prices and chart follow in a deferred render (`useDeferredValue(true, false)`), which React can interrupt; on a fast machine they often land in the same frame. The history request starts with the shell, not when its panel mounts.
  - **Chart cost.** Most of the old 72 ms was the price chart's collapsed "Show price changes as a table", which formatted every price change on every open, and new `Intl` formatter objects created per call. The table's rows are now built only when it is opened, and `formatMoney`/`formatDay` reuse one formatter per format with identical output. The chart's share of an open fell from about 50 ms to under 1 ms.
  - **Wishlist cards** have no drawer, and each card already loads when it nears the screen, so a hover handler would add nothing. Instead cards start loading 800 px ahead (was 120 px), so the next card is usually ready when it scrolls in.
- **Degraded states are first-class UI.** Every data view handles: fresh, stale (shows "updated 3h ago"), private profile, and upstream unavailable.

### 4.2 API layer (BFF)

Route Handlers under `app/api/`. The proxy exposes **fixed, purpose-built endpoints only**. It is never a generic pass-through that forwards arbitrary paths or URLs to Steam.

| Our endpoint | Steam call(s) | Auth required |
|---|---|---|
| `GET /api/auth/steam/login` | OpenID redirect | No |
| `GET /api/auth/steam/callback` | OpenID `check_authentication` | No |
| `POST /api/auth/logout` | none | Yes |
| `GET /api/players/[steamid]` | `ISteamUser/GetPlayerSummaries` | Yes |
| `GET /api/players/[steamid]/games` | `IPlayerService/GetOwnedGames` | Yes |
| `GET /api/players/[steamid]/recent` | `IPlayerService/GetRecentlyPlayedGames` | Yes |
| `GET /api/players/[steamid]/friends` | `ISteamUser/GetFriendList` + batched summaries | Yes |
| `GET /api/players/[steamid]/achievements/[appid]` | `ISteamUserStats/GetPlayerAchievements` | Yes |
| `GET /api/apps/[appid]` | Storefront `appdetails` | No (CDN cacheable) |
| `GET /api/apps/[appid]/schema` | `ISteamUserStats/GetSchemaForGame` | No (CDN cacheable) |
| `GET /api/apps/[appid]/news` | `ISteamNews/GetNewsForApp` | No (CDN cacheable) |
| `GET /api/resolve/[vanity]` | `ISteamUser/ResolveVanityURL` | Yes |
| `GET /api/deals` | `IStoreQueryService/Query` (5 pages of 200, store data included), ITAD ID lookup + prices by AppID, `GetAppReviews` (at most 30 per request, only where reviews are missing), `GetOwnedGames`, `GetWishlist`; fallback: Storefront `featuredcategories` + `GetItems` + ITAD | Yes |
| `GET /api/library/store` | `GetOwnedGames` (cached), `GetItems` with tags (50 per call, at most 2,000 games), `GetTagList` (cached) (v1.10) | Yes, own library only |
| `GET /api/search?q=` | Storefront `storesearch` + `GetItems` (capsule, release, price), cached 24 h for everyone; `search_steam_apps` catalog RPC | Yes, plus 60 searches/minute per user |
| `GET /api/wishlist` | `IWishlistService/GetWishlist`, `GetItems` for the Steam wishlist plus the watchlist, `GetAppReviews` (at most 20 per request, only where needed), ITAD ID lookup + prices (lows) | Yes |
| `POST /api/wishlist` | Storefront `appdetails`, only if the app is not cached | Yes |
| `DELETE /api/wishlist/[appid]` | none | Yes |
| `GET /api/apps/[appid]/insights?mode=full\|card` | `GetNumberOfCurrentPlayers`, `GetItems` (one app), `GetTagList`, Storefront `appdetails` (full mode only), ITAD lookup + prices (full mode only), `GetAppReviews` (full mode, v1.11), ITAD `games/info/v2` player peaks (full mode, v1.12); all cached | Yes |
| `GET /api/wishlist/[appid]/history` | ITAD ID lookup + `games/history` (all years); fallback: Storefront `appdetails` (price only), then reads `price_history` | Yes |
| `GET /api/cron/track-prices` | Storefront `appdetails` (price only) per tracked app, at most 100 per run | `CRON_SECRET` bearer token |
| `GET /api/cron/sample-players` | `GetNumberOfCurrentPlayers` for up to 300 games per run, cron quota tier (v1.11) | `CRON_SECRET` bearer token |

The wishlist routes were first planned as `/api/apps/tracked`; they were built as `/api/wishlist` (2026-11-15) and that is the name of record.

Notes on the search and wishlist routes:

- **Search (v1.8)** replaces the planned `/api/apps/search`. `lib/game-search.ts` asks two sources in parallel and merges them:
  - **Steam's store search** (`/api/storesearch/`, the endpoint behind the store's own search box) handles partial titles and returns up to 10 apps. The term is normalised first (lower case, no accents or symbols, 2–64 characters), so "Witcher 3" and "witcher® 3" share one cache entry. If a multi-word query finds nothing, it retries once with the longest word and keeps only results close to the full query. One `GetItems` call then adds capsule images, release dates and prices. The result is cached globally for 24 hours (stale up to 7 days), so a popular query costs Storefront budget once a day at most.
  - **The `steam_apps` catalog** via the `search_steam_apps` function (migration 0003). It uses `pg_trgm` word similarity (threshold 0.45) on the existing `steam_apps_name_trgm` index, which forgives typos like "holow knigt" that Steam's search misses.
  - Ranking: each Steam hit scores 0.6 × title similarity + 0.4 × its position in Steam's order. Each catalog-only hit scores 0.6 × the better of the two similarity measures. Hits below 0.45 are dropped and the top 8 are returned. Steam's hits are upserted into `steam_apps` in the background, so the catalog grows from searches.
  - If Steam fails, catalog results are returned with `steamAvailable: false`. The request fails only when both sources fail.
  - Fuse.js was not used: it needs the whole title list in memory, while Steam's index and Postgres trigrams search the full catalog without shipping it anywhere. Title similarity is a small, tested Dice-coefficient scorer (`fuzzyScore` in `lib/title-search.ts`).
  - The route requires a session, rejects `q` longer than 100 characters (400), and allows 60 searches a minute per user (429, `Retry-After: 30`). The limit's bucket key is `user:<first 24 hex of sha256(steamid)>:search`, so `rate_buckets` never holds a SteamID. Responses carry `Cache-Control: private, max-age=300`.
- **Per-game routes: caching and prefetch (v1.9, `lib/api/game-cache.ts`).** `GET /api/apps/[appid]/insights` and `GET /api/wishlist/[appid]/history` return the same data to every user, so a complete answer is sent with a shared `Cache-Control` the CDN may use:
  - History: `public, s-maxage=3600, stale-while-revalidate=86400`.
  - Insights: `public, s-maxage=600, stale-while-revalidate=3600`, shorter because it carries the live player count (10 minutes) and every store's price (1 hour).
  - An answer our own cache marked stale: `public, s-maxage=60, stale-while-revalidate=600`. An answer with an `unavailable` section: `private, no-store`, never shared.
  - `GET /api/apps/[appid]` already used `public, s-maxage=3600, stale-while-revalidate=86400`.
  - `/api/deals` and `/api/wishlist` stay `private, no-store`: they carry owned, wished and watched flags, and a shared cache would show one user's list to another.
  - Consequence: the CDN can serve a cached per-game answer without running the route, so its session check does not apply to cache hits. The data is public Steam and ITAD data; the check still guards every request that reaches the function and spends quota.
  - Requests with `x-steamgauge-prefetch: 1` are hover prefetches (section 4.1): lower quota tier, 120 per user per minute (`user:<hash>:prefetch`), and 503 `prefetch_declined` instead of degraded data or a Storefront fallback.
- **Wishlist** routes are always scoped to the SteamID in the verified session. There is no SteamID in the URL or body, so one user cannot read or change another's list.
  - `GET` returns the Steam wishlist merged with the watchlist (section 4.1), with `steamStatus` (`ok`, `empty_or_private`, `unavailable`) and `lowsAvailable`. If Steam cannot be reached the watchlist is still returned. A price that cannot be loaded marks only that item `unavailable`.
  - `POST` takes `{ appid, note? }`. It refuses a 51st app (409 `wishlist_full`), loads the app's details (404 `app_not_found` if Steam has no such app), ensures the `steam_apps` row, then upserts the `tracked_apps` row. Repeating the call is safe; the note changes only if one is sent.
  - `DELETE` removes one row and returns 204 whether or not the row existed.
  - `POST` and `DELETE` reject any request whose `Origin` header is not `APP_ORIGIN` (403 `bad_origin`), before looking at the session.
  - `history` returns daily prices and a `lowStatus`, with `source: "itad" | "local"`. With ITAD the claim "lowest on record" needs only one point, because the record is ITAD's full history; with the local record it still needs 7 days. It is not personal data; any signed-in user may read it.
- **Price tracking job.** `GET /api/cron/track-prices` refreshes the price of every tracked app once a day so history grows even when nobody opens the app. Schedule it in `vercel.json` (`{ "crons": [{ "path": "/api/cron/track-prices", "schedule": "17 9 * * *" }] }`). It answers 401 unless the request carries `Authorization: Bearer $CRON_SECRET`, and refuses to run at all if that secret is unset or shorter than 16 characters.
- **Player sampling job (v1.11).** `GET /api/cron/sample-players` (bearer check shared with track-prices in `lib/api/cron-auth.ts`, constant-time) returns `{ apps, read, failed, stoppedEarly, purged }`. It is **not** in `vercel.json`: Vercel's Hobby plan runs cron jobs at most once a day, and an hourly sampler needs more. `.github/workflows/sample-players.yml` calls it at minute 11 of every hour (and on manual dispatch) using the repository secrets `STEAMGAUGE_URL` and `CRON_SECRET`; it does nothing if they are unset. On Vercel Pro, add `{ "path": "/api/cron/sample-players", "schedule": "11 * * * *" }` to `vercel.json` instead. Supabase `pg_cron` with `pg_net` would also work.

Every handler runs the same pipeline, implemented once in `lib/steam/cached-fetch.ts`:

```
validate → authorize → rate-limit caller → cache lookup → (lease + quota + fetch) → respond
```

Response envelope, so the UI can always show data age:

```json
{ "status": "ok|private|not_found", "data": { }, "meta": { "source": "cache|steam", "fetchedAt": "ISO-8601", "stale": false } }
```

`private` and `not_found` are HTTP 200 with `data: null`: they are valid answers about the data. Failures are `{ "error": "<code>" }` with a matching HTTP status (400, 401, 500, 502, 503) and a `Retry-After` header where waiting helps. The helpers in `lib/api/respond.ts` produce both forms.

Implemented so far: the two auth routes, `GET /api/players/[steamid]/games`, `GET /api/apps/[appid]`, `GET /api/apps/[appid]/insights`, `GET /api/deals`, `GET /api/search`, the four wishlist routes, the price-tracking cron route, the player sampling cron route (v1.11), and `POST /api/auth/logout`. Still to build: the other player and app routes in the table, and per-session inbound rate limiting on data routes (section 6.4). Data routes require Next.js 15.1 or later (`after`, async `params`).

### 4.3 Suggested layout

```
app/
  page.tsx                  # landing: sign-in screen; redirects signed-in visitors to /dashboard (implemented)
  layout.tsx                # root: <html>/<body>, global CSS, <Providers> around everything (implemented)
  (app)/layout.tsx          # shell for signed-in pages: surface, navigation (implemented)
  (app)/loading.tsx         # dark skeleton shown while a page verifies the session (implemented)
  (app)/error.tsx           # dark error screen for anything a page throws (implemented)
  (app)/dashboard/page.tsx  # verifies the session, renders the dashboard (implemented)
  (app)/game/[appid]/page.tsx  # verifies the session and AppID, renders the game page (implemented, v1.8)
  (app)/                    # still to write: profile, library, friends
  globals.css               # Tailwind 4 entry and @theme colour tokens (page, chrome, surface, steam-*)
  (app)/deals/page.tsx      # verifies the session, renders the deals table (implemented)
  (app)/wishlist/page.tsx   # verifies the session, renders the wishlist (implemented)
components/
  app-nav.tsx               # top bar + phone tab bar, active page, global search, sign-out form (implemented)
  global-search.tsx         # search box + autocomplete dropdown (ARIA combobox) (implemented, v1.8)
  game-view.tsx             # client view for /game/[appid]: header with review and live player badges, facts, player peaks, prices, price history (implemented, v1.8; v1.11; v1.12)
  review-badge.tsx          # Steam review label + "X% of N user reviews are positive", Steam colours (implemented, v1.11)
  player-metrics.tsx        # "Current In-Game Players" badge and the 24-hour / all-time peak cards (counts only), N/A when missing (implemented, v1.12)
  title-filter.tsx          # labelled filter box used by Deals, Dashboard and Wishlist (implemented, v1.8)
  game-queries.ts           # per-game query definitions, hover prefetch, row intent detection (implemented, v1.9)
  game-card.tsx             # Dashboard cards: detailed and compact, title links to /game/[appid], value meter (implemented, v1.10)
  footer.tsx                # site footer: "Made for MIS325.", Valve/Steam notice; sign-in page and app shell (implemented, v1.9.1)
  dashboard-view.tsx        # client view: stat-card filter (all/playtime/backlog), library list, data age ticker (implemented)
  deals-view.tsx            # client view: filter sidebar, sortable paged deals table (implemented)
  wishlist-view.tsx         # client view: Steam wishlist + watchlist, sync status, lows, watch/remove (implemented)
  layout-width.ts           # one page width for all tabs and the nav, importable by Server Components (implemented)
  game-insights.tsx         # shared: price history panel, game facts, store price list (implemented)
  price-history-chart.tsx   # step-line price chart with 6M/1Y/2Y/All ranges, readout and table view (implemented)
  providers.tsx             # client providers: the one TanStack Query client and its defaults (implemented, v1.8.1)
  ui-kit.tsx                # shared: data age ticker, value meter, state panels, lazy-load hook (implemented)
  api/                      # route handlers listed above
  api/cron/                 # track-prices, sample-players (v1.11); warm + purge jobs still to write (protected by CRON_SECRET)
lib/
  steam/
    client.ts               # the ONLY module that reads STEAM_API_KEY (implemented)
    endpoints.ts            # typed wrappers + validators: getPlayerSummary, getOwnedGames,
                            #   getAppDetails (implemented); other resources still to add
    cached-fetch.ts         # cache/lease/quota pipeline: cachedFetch() (implemented)
    ttl.ts                  # TTL policy table, cache keys (section 5.3) (implemented)
    specials.ts             # parser for Storefront featuredcategories (implemented)
    store-items.ts          # IStoreBrowseService/GetItems parser and batched fetch (implemented)
    composites.ts           # multi-call refreshes: Steam sale pages + ITAD enrichment, wishlist view, ITAD history (implemented)
    reviews.ts              # GetAppReviews summary parser (implemented)
    insights.ts             # parsers: live players, GetItems metadata, tag list (implemented)
    search.ts               # storesearch parser + GetItems enrichment for global search (implemented, v1.8)
    library-store.ts        # GetItems with tags for a whole library (implemented, v1.10)
    memory-cache.ts         # per-instance LRU in front of api_cache, fresh-only for reads (implemented, v1.9)
    review-backfill.ts      # bounded fill-in of missing review totals: bulk cache read + capped lookups (implemented)
    player-recorder.ts      # records one player count reading via record_player_count; never throws (implemented, v1.11)
  itad/client.ts            # the ONLY module that reads ITAD_API_KEY; allowlisted endpoints (implemented)
  supabase/server.ts        # server-only admin client (implemented)
  auth/shared.ts            # cookie names, origin, rate limit, safe logging (implemented)
  auth/session.ts           # cookie -> verified user, or null (implemented)
  api/respond.ts            # response envelope and error helpers for data routes (implemented)
  api/client.ts             # browser-side fetch for our API: envelope check, ApiError, retry rules (implemented)
  api/game-cache.ts         # shared Cache-Control and prefetch rules for the per-game routes, server only (implemented, v1.9)
  api/cron-auth.ts          # constant-time CRON_SECRET bearer check for cron routes, server only (implemented, v1.11)
  api/user-limit.ts         # per-user limits in rate_buckets (search, prefetch), server only (implemented, v1.9)
  prefetch-header.ts        # the prefetch request header name, shared by browser and server (implemented, v1.9)
  deals.ts                  # assembles deal rows with owned/wished/watched flags and badges, server only (implemented)
  deals-table.ts            # pure filter/sort/paginate/badge rules and the Top deals score, shared by server and browser (implemented)
  game-insights.ts          # gathers one game's facts from cached sources, full/card modes, server only (implemented)
  wishlist-sort.ts          # pure wishlist sort orders for the browser (implemented)
  wishlist.ts               # Steam wishlist + watchlist merge, add, remove, server only (implemented)
  price-history.ts          # record and read our own daily price observations, server only (implemented)
  player-counts.ts          # notes interest, hourly sampler (recordings kept, not shown), server only (implemented, v1.11)
  library-view.ts           # pure Dashboard filters, sorts and store payload types, shared by server and browser (implemented, v1.10)
  library.ts                # builds /api/library/store: picks games, attaches tag names, server only (implemented, v1.10)
  title-search.ts           # pure title normalising, inline matching and fuzzy scoring, shared by server and browser (implemented, v1.8)
  game-search.ts            # global search: Steam + catalog, merged and ranked, server only (implemented, v1.8)
  value.ts                  # cost-per-hour maths and the SIMULATED game length, shared by server and browser (implemented)
  validation.ts             # zod schemas: steamid, appid, vanity, search, country (implemented)
supabase/migrations/        # SQL: steamlite_init.sql is migration 0001; 0002_price_history.sql; 0003_search_steam_apps.sql (v1.8); 0004_player_counts.sql (v1.11)
.github/workflows/sample-players.yml  # hourly call to /api/cron/sample-players (v1.11)
```

`lib/steam/client.ts`, `lib/itad/client.ts` and `lib/supabase/server.ts` start with `import "server-only"` so a build fails if any of them is ever imported into client code.

### 4.4 Data model

Ten tables in the `public` schema: seven created by `steamlite_init.sql` (migration 0001), `price_history` by `supabase/migrations/0002_price_history.sql`, and `player_counts` and `player_counts_daily` by `0004_player_counts.sql` (v1.11). Any schema change must be made as a new migration and reflected here in the same pull request.

| Table | Purpose | Primary key |
|---|---|---|
| `users` | One row per person who has signed in with Steam | `steamid` |
| `sessions` | Server-side login sessions | `id` (uuid) |
| `openid_nonces` | Replay protection for Steam OpenID responses | `nonce` |
| `api_cache` | Shared cache of normalized Steam responses (section 5.6) | `key` |
| `rate_buckets` | Fixed-window counters for Steam budgets, the circuit breaker, and inbound rate limits (section 5.6) | (`bucket`, `window_kind`, `window_start`) |
| `steam_apps` | Local catalog of Steam apps for name search | `appid` |
| `tracked_apps` | Apps a user has chosen to follow (the wishlist) | (`user_steamid`, `appid`) |
| `price_history` | Lowest store price observed per app, country, and UTC day | (`appid`, `cc`, `observed_on`) |
| `player_counts` | Highest concurrent-player reading per app and 10-minute slot, kept 31 days (v1.11) | (`appid`, `observed_at`) |
| `player_counts_daily` | Highest reading per app and UTC day, kept indefinitely (v1.11) | (`appid`, `day`) |

Relationships:

```
users (steamid) ──┬──< sessions (user_steamid)        ON DELETE CASCADE
                  └──< tracked_apps (user_steamid)    ON DELETE CASCADE
steam_apps (appid) ──< tracked_apps (appid)           ON DELETE CASCADE
steam_apps (appid) ──< price_history (appid)          ON DELETE CASCADE
steam_apps (appid) ──< player_counts (appid)          ON DELETE CASCADE
steam_apps (appid) ──< player_counts_daily (appid)    ON DELETE CASCADE

api_cache, rate_buckets, openid_nonces: no foreign keys
```

```sql
create table users (
  steamid        text primary key check (steamid ~ '^7656119[0-9]{10}$'),
  persona_name   text,
  avatar_url     text,
  profile_url    text,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,            -- SHA-256 of the cookie token
  user_steamid  text not null references users (steamid) on delete cascade,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  check (expires_at > created_at)
);

create table openid_nonces (
  nonce       text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '10 minutes')
);

create table steam_apps (
  appid          integer primary key check (appid > 0),
  name           text not null,
  app_type       text,                           -- game | dlc | demo | ...
  header_image   text,
  is_free        boolean,
  last_modified  timestamptz,                    -- as reported by Steam
  updated_at     timestamptz not null default now()
);

create table tracked_apps (
  user_steamid  text not null references users (steamid) on delete cascade,
  appid         integer not null references steam_apps (appid) on delete cascade,
  note          text check (note is null or char_length(note) <= 500),
  created_at    timestamptz not null default now(),
  primary key (user_steamid, appid)
);
```

`price_history` (migration 0002):

```sql
create table price_history (
  appid             integer not null references steam_apps (appid) on delete cascade,
  cc                text    not null check (cc ~ '^[a-z]{2}$'),
  observed_on       date    not null,                      -- UTC calendar day
  currency          text    not null check (currency ~ '^[A-Z]{3}$'),
  price_initial     integer not null check (price_initial >= 0),   -- minor units
  price_final       integer not null check (price_final >= 0),     -- minor units
  discount_percent  integer not null check (discount_percent between 0 and 100),
  observed_at       timestamptz not null default now(),
  primary key (appid, cc, observed_on)
);
```

Rows are written only by the function `record_price_observation(appid, cc, currency, price_initial, price_final, discount_percent)`. It keeps the **lowest** price seen that day (a later, higher observation does not overwrite it, so a sale that ends mid-day is not lost), does nothing for an app that is not in `steam_apps`, and returns whether a row changed. Like `take_quota`, it is `SECURITY INVOKER` with an empty `search_path` and executable only by `service_role`. The table has RLS enabled with no policies and no grants to `anon` or `authenticated`. The primary key serves every read (all days for one app and country, in date order), so there is no extra index. A read returns at most the 1,000 most recent days per app.

`player_counts` and `player_counts_daily` (migration 0004, v1.11), plus a new column `steam_apps.players_viewed_at timestamptz` (when someone last viewed the game page; drives sampling):

```sql
create table player_counts (
  appid        integer     not null references steam_apps (appid) on delete cascade,
  observed_at  timestamptz not null,   -- start of a 10-minute UTC slot
  players      integer     not null check (players >= 0),
  primary key (appid, observed_at)
);
create index player_counts_observed_at_idx on player_counts (observed_at);  -- for the purge

create table player_counts_daily (
  appid    integer     not null references steam_apps (appid) on delete cascade,
  day      date        not null,       -- UTC calendar day
  peak     integer     not null check (peak >= 0),
  peak_at  timestamptz not null,       -- when that peak was read
  primary key (appid, day)
);
```

Functions, all `SECURITY INVOKER` with `search_path = ''`, executable by `service_role` only; both tables have RLS on with no policies and no grants to `anon` or `authenticated`. The migration runs in one transaction and can be re-run.

- `record_player_count(appid, players, at)` keeps the higher reading for the 10-minute slot and for the day (with the time of the day's peak). Does nothing (returns false) for an app not in `steam_apps`.
- `note_player_interest(appid)` sets `players_viewed_at`, at most once an hour per game.
- `player_count_stats(appid)` returns the 24-hour peak and its time, the all-time recorded peak and its time, and the first recorded day.
- `player_count_series(appid, since, bucket_seconds)` returns the highest reading per bucket. Buckets under a day read `player_counts`; a day or longer read `player_counts_daily`. Bucket size must be 600 seconds to 31 days.
- `player_sample_targets(limit)` lists watched games by number of watchers, then games viewed in the last 14 days.
- `purge_player_counts(keep_days default 31)` deletes old 10-minute rows (never fewer than 7 days kept) and returns the count. Daily peaks are never purged.

Size: one game sampled hourly writes about 720 fine rows a month (bounded by the purge) and 365 daily rows a year. 300 games is about 216,000 fine rows plus 110,000 daily rows a year, a few tens of MB.

Constraints and what they mean for application code:

- **SteamIDs are `text`, never a number.** A SteamID64 is larger than JavaScript's safe integer range, so a numeric type would be silently corrupted in the browser or in JSON. The `CHECK` on `users.steamid` matches the zod pattern in section 6.4.
- **Deleting a user cascades** to `sessions` and `tracked_apps`. Cached player data in `api_cache` is not linked by foreign key and must be deleted explicitly by `owner_steamid` (section 6.6).
- **`tracked_apps.appid` must exist in `steam_apps`.** The handler that tracks an app upserts the `steam_apps` row first, in the same request.
- **`sessions.token_hash` is unique** and the only lookup path from a cookie. The raw token is never stored.
- **`openid_nonces.nonce` is the primary key**, so inserting a reused nonce fails with a unique violation. The callback handler treats that failure as a replay and rejects the sign-in.
- **`tracked_apps.note`** is capped at 500 characters in the database as well as in the API validator.

Indexes:

| Index | Table (columns) | Used by |
|---|---|---|
| `sessions_user_steamid_idx` | `sessions (user_steamid)` | Log out everywhere, cascade deletes |
| `sessions_expires_at_idx` | `sessions (expires_at)` | Purge job |
| `openid_nonces_expires_at_idx` | `openid_nonces (expires_at)` | Purge job |
| `api_cache_stale_until_idx` | `api_cache (stale_until)` | Purge job |
| `api_cache_owner_steamid_idx` | `api_cache (owner_steamid)`, partial: non-null only | "Delete my data" |
| `rate_buckets_window_start_idx` | `rate_buckets (window_start)` | Purge job |
| `steam_apps_name_trgm` | `steam_apps`, GIN on `name gin_trgm_ops` | App name search |
| `tracked_apps_appid_idx` | `tracked_apps (appid)` | Cascade deletes, "who tracks this app" |

App name search uses the `pg_trgm` extension. `name ILIKE '%term%'` and `name % 'term'` both use the GIN index; search terms shorter than 3 characters cannot use it and are rejected by the API validator.

**Catalog population (decided 2026-11-14): lazy, on demand.** `steam_apps` is not bulk-synced from Steam. A row is written when an app is first requested:

1. A handler needs app `N` (game detail page, or `POST /api/wishlist`).
2. It checks the local cache first: `api_cache` key `app:N:details:{cc}` and the `steam_apps` row.
3. On a miss it fetches Storefront `appdetails` through the normal cache/lease/quota pipeline, stores the response in `api_cache`, and upserts `steam_apps` (`appid`, `name`, `app_type`, `header_image`, `is_free`, `updated_at`) from the same response.
4. Every later refresh of that app's details re-upserts the row, so renamed games stay current.

This costs no Steam calls beyond the `appdetails` fetch the page already needs, so the budgets in section 5.5 are unchanged. If the Storefront quota is exhausted and the app is not yet in the catalog, `POST /api/wishlist` returns 503 with `Retry-After`. If Steam reports the app does not exist, the handler returns 404 and writes nothing to `steam_apps`.

**Consequence for search.** The catalog only holds apps someone has already viewed, tracked or found through search, so on a new deployment it is nearly empty. Since v1.8 global search also asks Steam's store search, which knows every title, and adds what it finds to `steam_apps`; the catalog then supplies typo matches (section 4.2). See section 9.

---

## 5. Data caching strategy

### 5.1 Cache layers

| Layer | Where | Holds | Lifetime | Purpose |
|---|---|---|---|---|
| L0 | Browser (TanStack Query) | Everything the user has viewed | Minutes, per session | Zero-network navigation and dedupe |
| L1 | CDN (`Cache-Control`) | Public app data only: store details, schemas, news, and since v1.9 complete game facts and price histories | `s-maxage` + `stale-while-revalidate` | Requests never reach a function |
| L1.5 | Function memory (`lib/steam/memory-cache.ts`, v1.9) | Entries this instance read or wrote recently, at most 24 MB of JSON | Until the entry's `fresh_until` | Saves a warm instance the database round trip |
| L2 | Supabase `api_cache` | All normalized Steam responses | Per-resource TTL | Shared across all users and all function instances |
| L3 | Steam | Source of truth | n/a | Only on a true miss or expired entry |

L2 is the important one. Serverless instances share no memory, so an in-process cache cannot replace it. Postgres is the one place every instance can see.

L1.5 (v1.9) is only a shortcut in front of it, with rules that keep instances consistent:
- `cachedFetch` serves a memory entry only while it is fresh. A stale entry goes to Postgres, where the lease decides who refreshes it, so no instance keeps serving data another has already replaced. (An instance only refreshes a row that Postgres shows as stale, so a fresh memory entry is never out of date.)
- `peekCached` may use fresh or stale entries, as it does from Postgres.
- Lease placeholders are never stored. Entries are held as JSON text and parsed on every hit, so requests never share a mutable object.
- The session check for player data runs before any cache layer.
- A future "delete my data" must also call `forgetMemoryCache` for the user's keys.

User-scoped responses are sent with `Cache-Control: private, no-store` so the CDN never stores one user's data for another.

### 5.2 Read path

For a cache key `K`:

1. **Fresh hit** (`now < fresh_until`): return immediately. Zero Steam calls.
2. **Stale hit** (`fresh_until ≤ now < stale_until`): return the stale value immediately, then attempt a background refresh (stale-while-revalidate). The user never waits on Steam for data we already have.
3. **Miss or fully expired**: attempt a blocking refresh.

A refresh is three guarded steps:

- **Acquire a lease.** An atomic `UPDATE ... WHERE lease_until < now()` claims the key for about 15 seconds. If another instance holds the lease, this request does not call Steam; it serves stale data or polls the cache briefly. This is the stampede guard: 50 simultaneous viewers of one game page cause one Steam call, not 50.
- **Take quota.** Call `take_quota()` (section 5.5). If the budget is spent, do not call Steam.
- **Fetch, normalize, write.** On success, store the payload with new `fresh_until`/`stale_until`. On failure, keep the old payload and extend `stale_until` (stale-if-error).

If quota is denied or Steam fails and no cached value exists, return HTTP 503 with `Retry-After` and a clear UI message.

Implementation details (`lib/steam/cached-fetch.ts`):

- **Lease on a missing key.** There is no row to update, so the engine inserts an already-expired placeholder row (`status = 'ok'`, `payload = null`, all three timestamps at the epoch) that holds the lease. The primary key lets exactly one instance's insert succeed. A placeholder is never served.
- **Waiting on someone else's lease.** A request that misses while another instance holds the lease re-reads the cache every 500 ms for up to 3 seconds, then fails with 503 and `Retry-After: 2`.
- **Refresh deadline.** A refresh is aborted after 12 seconds so it always ends inside its 15-second lease.
- **Failure backoff.** When a blocking fetch fails, the lease is left to expire rather than released, so the same key is not retried for up to 15 seconds.
- **Stale-if-error.** When a background refresh fails for any reason (Steam down, quota spent, bad payload), `stale_until` is moved to one hour from now if that is later, capped at 24 hours beyond the resource's normal stale lifetime. Rows past `stale_until` are never served.
- **Background work on serverless.** The engine cannot keep a function alive by itself. Route Handlers pass `waitUntil: (work) => after(() => work)` using `after` from `next/server`; without it a platform may freeze the function once the response is sent and the refresh is lost.
- **Validation.** The caller supplies a `validate` function that returns the normalized data, or `private` / `not_found` for negative answers Steam reports inside an HTTP 200. What `validate` returns is what is stored in `payload`. If a deploy changes a payload's shape, its cache key must change too.
- **Authorization.** Player-scoped resources are refused without a session before any database or Steam access.
- **Endpoint wrappers** (`lib/steam/endpoints.ts`). Each wrapper supplies the `validate` function and maps Steam's fields to the shape the UI consumes (`PlayerSummary`, `OwnedGames`, `AppDetails`); that mapped shape is what is cached. Negative answers recognised inside HTTP 200: an empty `players` list is `not_found`, an empty `response` object from `GetOwnedGames` is `private`, and Storefront `success: false` is `not_found`. A private profile's summary is still `ok`, with `isPublic: false`. `getPlayerSummary` updates `users.persona_name`, `avatar_url`, and `profile_url` for SteamIDs that have signed in, and `getAppDetails` upserts `steam_apps` (section 4.4).
- **Bulk cache-only read.** `peekCached(resource, argsList)` returns the servable cached entry (or null) for many keys of one **global** resource; player-scoped resources are refused because it has no session check. It is best effort: a database error makes every entry null.
- **Not yet built:** batched `GetPlayerSummaries` for friends lists (section 5.4) and the user-forced refresh with its 2-minute cooldown (section 5.3).

### 5.3 TTL policy

| Resource | Cache key | Fresh for | Serve stale up to | Rationale |
|---|---|---|---|---|
| Player summary (name, avatar, status) | `player:{steamid}:summary` | 5 min | 24 h | Online status changes often; identity rarely |
| Owned games | `player:{steamid}:games` | 1 h | 7 d | Changes on purchase; playtime drifts slowly |
| Recently played | `player:{steamid}:recent` | 15 min | 24 h | The most "live" library view |
| Friends list | `player:{steamid}:friends` | 6 h | 7 d | Rarely changes |
| Player achievements | `player:{steamid}:ach:{appid}` | 30 min | 7 d | Changes only while playing that game |
| Achievement schema | `app:{appid}:schema` | 7 d | 30 d | Changes only on game updates |
| Store app details | `app:{appid}:details:{cc}` | 24 h | 14 d | Tightest upstream limit; mostly static |
| Store price only | `app:{appid}:price:{cc}` | 3 h | 24 h | Shorter so sale prices stay reasonably current |
| Game news | `app:{appid}:news` | 1 h | 7 d | Low frequency |
| Vanity URL → SteamID | `vanity:{name}` | 30 d | 30 d | Effectively permanent |
| Store specials (trending discounts) | `store:specials:{cc}` | 1 h | 24 h | One call serves every user; sales change slowly |
| Steam sale page (200 discounted top sellers + store data + ITAD) | `deals:steam-sale:{cc}:{page}` | 1 h | 24 h | Global; one refresh serves every user. Replaced `deals:itad:*` in v1.5 |
| Deals fallback (featured specials + store data + ITAD) | `deals:featured:v2:{cc}` | 1 h | 24 h | Used only if the sale query fails |
| Steam wishlist IDs | `player:{steamid}:wishlist-ids` | 30 min | 24 h | Used by Deals for the Wished flag |
| Wishlist view (Steam wishlist + watchlist + lows) | `player:{steamid}:wishlist:{fnv1a(watchlist appids)}` | 30 min | 24 h | Key changes when the watchlist changes, so a watched game appears at once |
| ITAD price history (all years) | `app:{appid}:itad-history:full:{cc}` | 12 h | 7 d | Global; history only grows. The `full` segment was added in v1.4 so entries holding ITAD's 3-month default are never reused |
| Steam review totals | `app:{appid}:reviews` | 3 d | 14 d | Global; review counts move slowly. Read in bulk by Deals and the Wishlist |
| Live concurrent players | `app:{appid}:players` | 10 min | 2 h | Global; the only fast-moving game fact. Each live refresh is also recorded in `player_counts` (v1.11) |
| Developer, publisher, franchise, tag ids | `app:{appid}:store-meta:{cc}` | 24 h | 14 d | Global; GetItems for one app |
| Steam tag names | `store:tags:english` | 7 d | 30 d | One entry for every user and game |
| One game's prices at every store (ITAD), with store links | `app:{appid}:itad-prices:v2:{cc}` | 1 h | 24 h | Global; expanded Deals rows only |
| Global search results (Steam storesearch + GetItems) | `search:{cc}:{normalised term}` | 24 h | 7 d | Global; one Storefront call per query per day serves every user (v1.8) |
| Library store data (art, release, price, tags for owned games) | `player:{steamid}:library-store:{cc}:{fnv1a(appids)}` | 12 h | 3 d | Per user; a purchase changes the key (v1.10) |
| ITAD player peaks (recent, 24 h, 7 d, all-time) | `app:{appid}:itad-players` | 1 h | 24 h | Global; the game page's 24-hour and all-time peak cards, via full-mode insights (v1.11.1; v1.12) |
| Steam AppID → ITAD game id | `app:{appid}:itad-id` | 30 d | 90 d | Global; ids never change. Written in bulk by every Deals and Wishlist refresh, so an expanded row's prices and history skip the lookup call (v1.9) |
| Private profile / not found | same key, `status = 'private'` | 30 min | 30 min | Negative caching stops retry storms |

TTLs live in one file (`lib/steam/ttl.ts`) so they can be tuned from observed usage. The signed-in user gets a manual "Refresh" button for their own profile, limited to one forced refresh per resource per 2 minutes.

### 5.4 Call-reduction techniques

- **Batching.** `GetPlayerSummaries` accepts up to 100 SteamIDs per call. A 250-person friends list costs 3 calls rather than 250. Only IDs missing or expired in cache are requested, and each result is cached under its own key.
- **Field trimming.** Storefront calls pass `filters=` so we request only the fields we render. Price is fetched separately from the heavy description payload.
- **Shared app data.** App details, schemas, and news are identical for every user. They are cached once, globally, and are CDN-cacheable.
- **Lazy loading.** Achievements are fetched for a game only when the user opens that game, never for a whole library up front.
- **No client polling.** No resource refetches on a timer in the browser.
- **Cron warming, bounded.** A scheduled job refreshes only the most-viewed app keys, within a fixed share of the daily budget, during off-peak hours.
- **Review fill-in, bounded** (`lib/steam/review-backfill.ts`). For list rows that `GetItems` left without review totals:
  1. **Cache first, in bulk.** `peekCached` reads up to 100 `app:{appid}:reviews` entries per database query, with no Steam calls, no leases and no refreshes. Fresh and stale entries are both used.
  2. **Then a few live lookups.** At most 30 per Deals request (20 per Wishlist request), at most 4 in flight, each through the normal quota gate and charged to `webapi`. Games come before DLC, then ITAD's own order.
  3. **Bounded wait.** The response waits at most 2.5 s. Lookups still running continue through `after` (the route sets `maxDuration = 30`) and land in the cache for the next request.
  4. **Stop on pushback.** The first quota or throttle failure stops the rest. Nothing here ever fails the request.
  A cold table therefore fills in over a few loads; a warm one costs only database reads. Unreleased games are skipped.

### 5.5 Quota governor

A single Postgres function is the only gate to Steam. Because it is one atomic statement in the database, it holds across every concurrent serverless instance.

Budgets (fixed windows):

| Upstream | Window | Ceiling | Reserved |
|---|---|---|---|
| `webapi` | 1 day (resets 00:00 Pacific, matching Valve's day) | 80,000 | Tiered by request priority, see below |
| `webapi` | 1 minute | 120 | Smooths bursts |
| `store` | 5 minutes | 150; 90 for hover prefetches (v1.9) | Prefetches stop at 60% so they cannot use up the shared Storefront budget |
| `itad` | 5 minutes | 600 (interactive), 450 (background and prefetch) | Composite refreshes are charged per ITAD call, before every attempt |

Daily tiers. Each tier is the ceiling passed to `take_quota` for the same `webapi` day bucket, so lower-priority work is cut off first:

| Request priority | May call Steam while today's usage is under |
|---|---|
| Cron warming, background (stale-while-revalidate) refresh | 56,000 (70%) |
| Hover prefetch (`priority: "prefetch"`, v1.9) | 56,000 (70%) |
| Cache miss, anonymous request | 72,000 (90%) |
| Cache miss, signed-in user | 80,000 (100%) |

At 80,000 no Steam Web API calls are made and the app runs entirely from cache until the window resets.

**Prefetch refusals release their lease (v1.9).** A failed refresh normally keeps its 15-second lease, so other requests wait instead of repeating a failed call. When a prefetch is refused by its lower ceiling, no upstream call was made and a click has more budget, so the lease is released at once. Without this, a declined hover made the click on the same row wait out the lease and show "unavailable" (found by the v1.9 tests).

**Parallel where the data allows (v1.9).** Independent upstream calls inside one refresh run together: the Wishlist refresh now asks `GetItems` and ITAD prices at the same time (it used to wait for `GetItems`), and insights already ran its five sources with `Promise.allSettled`. ITAD's lookup (Steam AppID → ITAD id) must finish before prices or history can be asked, so those cannot run in parallel. The id is cached instead (section 5.3), which removes the lookup from an expanded row's path entirely.

**Enforcement in code.** `lib/steam/client.ts` will not open a connection until the caller's `acquire` callback returns true, and it calls `acquire` again before every retry. The cache pipeline implements `acquire` with `take_quota` plus the breaker check, so no code path reaches Steam without being charged.

**Composite refreshes.** Deals pages, the wishlist view and ITAD history each need several upstream calls. They are one cache entry each, refreshed by one plan (`composite`) that receives an `UpstreamIO` with `webApi`, `store` and `itad` functions; every call inside is charged to its own bucket through the same `acquire`. A failed `GetItems` batch drops only those apps' store data (counted as `missingStoreData`); an ITAD failure drops only the lows, except quota and throttle errors, which abort the refresh so stale data is served.

**Circuit breaker.** An HTTP 429 from any upstream, or a 403 from the Storefront, opens a breaker row in `rate_buckets` (`window_kind = 'breaker'`) for that upstream: 60 seconds on first trip, doubling up to 15 minutes. In a breaker row `window_start` is the time of the trip and `used` is its level (1 to 5); the breaker is open until `window_start + min(60 × 2^(level−1), 900)` seconds. A trip within 10 minutes of the previous one closing raises the level by one, otherwise it restarts at 1. While open, no calls are made and stale data is served. A 401/403 from the Web API does not open the breaker: with a JSON body it means the profile is not public (cached as `private`), and without one it means the API key was rejected (logged as a configuration fault). Retries for 5xx/timeouts are capped at 2, with exponential backoff and jitter, and each retry consumes quota.

### 5.6 Schema (cache and quota)

```sql
create table api_cache (
  key            text primary key,
  payload        jsonb,
  status         text not null default 'ok'
                 check (status in ('ok', 'private', 'not_found')),
  fetched_at     timestamptz not null default now(),
  fresh_until    timestamptz not null,
  stale_until    timestamptz not null,
  lease_until    timestamptz not null default 'epoch',
  owner_steamid  text
                 check (owner_steamid is null or owner_steamid ~ '^7656119[0-9]{10}$'),
  check (stale_until >= fresh_until)
);
create index api_cache_stale_until_idx on api_cache (stale_until);
create index api_cache_owner_steamid_idx on api_cache (owner_steamid)
  where owner_steamid is not null;

create table rate_buckets (
  bucket        text not null,
  window_kind   text not null,                   -- day | minute | 5min | breaker
  window_start  timestamptz not null,
  used          integer not null default 0 check (used >= 0),
  primary key (bucket, window_kind, window_start)
);
create index rate_buckets_window_start_idx on rate_buckets (window_start);

-- Atomic: increments and returns true only if the result stays at or under the ceiling.
create function take_quota(p_upstream text, p_kind text, p_window timestamptz,
                           p_ceiling integer, p_cost integer default 1)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare ok boolean;
begin
  if p_upstream is null or p_kind is null or p_window is null
     or p_ceiling is null or p_cost is null then
    raise exception 'take_quota: arguments must not be null';
  end if;
  if p_cost < 1 then
    raise exception 'take_quota: p_cost must be >= 1 (got %)', p_cost;
  end if;

  insert into public.rate_buckets (bucket, window_kind, window_start, used)
  values (p_upstream, p_kind, p_window, 0)
  on conflict (bucket, window_kind, window_start) do nothing;

  update public.rate_buckets
     set used = used + p_cost
   where bucket = p_upstream and window_kind = p_kind
     and window_start = p_window and used + p_cost <= p_ceiling
  returning true into ok;

  return coalesce(ok, false);
end;
$$;
```

Notes:

- `api_cache.owner_steamid` is set for `player:*` keys so a user's cached data can be found and deleted. It is deliberately not a foreign key to `users`: most cached players (friends, looked-up profiles) are not SteamGauge users.
- `api_cache.status` is restricted to `ok`, `private`, or `not_found`. The last two are negative-cache entries (section 5.3).
- `rate_buckets.bucket` holds three kinds of value: Steam upstreams (`webapi`, `store`), breaker rows for those upstreams, and inbound rate-limit subjects (`ip:<hash>`, `session:<id>`; section 6.4). All of them go through `take_quota`. Its first parameter keeps the name `p_upstream` and maps to the `bucket` column.
- `take_quota` raises an exception for null arguments or a cost below 1, and returns `false` without changing anything when the budget is spent. Callers must treat an exception as "do not call Steam".

A daily cron deletes `api_cache` rows past `stale_until`, `rate_buckets` rows older than 7 days, expired `sessions`, and expired `openid_nonces`.

### 5.7 Capacity check

Rough worst case for one active user session with a cold cache: 1 summary + 1 owned games + 1 recent + 1 friends + 3 batched friend summaries + about 5 achievement views = **about 12 Web API calls**. With the TTLs above, a returning user within the hour costs close to zero.

At the 80,000/day ceiling that supports roughly 6,000 fully cold sessions per day, which is far beyond expected use. The binding constraint is the Storefront API: 150 uncached game pages per 5 minutes. The 24-hour TTL, global sharing, and CDN layer are what make that workable.

---

## 6. Security configuration

### 6.1 Secrets

| Variable | Exposure | Notes |
|---|---|---|
| `STEAM_API_KEY` | Server only | Read in exactly one module. Never prefixed `NEXT_PUBLIC_`. |
| `SUPABASE_SECRET_KEY` (`sb_secret_...`) | Server only | Bypasses RLS. Never sent to the browser. |
| `SESSION_SECRET` | Server only | 32+ random characters. HMAC key that turns a client IP into a rate-limit bucket name. Session tokens are random and opaque, so nothing is signed with it. |
| `APP_ORIGIN` | Server only (not secret) | Public origin of the deployment, for example `https://steamgauge.example.com`. Used for the OpenID `realm` and `return_to` and for all auth redirects, so a forged `Host` header cannot redirect a sign-in. |
| `CRON_SECRET` | Server only | Required as a bearer token on `/api/cron/*`. |
| `ITAD_API_KEY` | Server only, optional | Read only in `lib/itad/client.ts`, sent only in the `ITAD-API-Key` header (never in a URL). Without it, deals use Steam Specials and charts use the local record. |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Not a secret. |

Rules:

- Use Supabase's **publishable/secret key** format, not the legacy `anon`/`service_role` JWT keys, which Supabase is retiring in late 2026. Since v1 has no browser-side Supabase access, the publishable key is not shipped at all.
- Separate values for Development, Preview, and Production environments. Register a separate Steam key for development if possible so local testing cannot spend production quota.
- `.env*` files are git-ignored; enable GitHub secret scanning and push protection on the repo.
- A CI check fails the build if any `NEXT_PUBLIC_*` variable name contains `SECRET`, `KEY`, or `STEAM` (other than an explicit allowlist).
- Steam requires the key as a URL query parameter. Therefore: never log full upstream URLs, redact `key=` in error reporting, and never return upstream error bodies or URLs to the client.
- Rotation: rotate the Steam key and Supabase secret key on any suspected leak and whenever a team member leaves the project.

### 6.2 Authentication (Sign in with Steam)

Steam uses **OpenID 2.0**, not OAuth, and is not a built-in Supabase Auth provider. We verify OpenID ourselves and issue our own session.

Implemented in `app/api/auth/steam/login/route.ts`, `app/api/auth/steam/callback/route.ts`, and `lib/auth/shared.ts`.

1. `/api/auth/steam/login` creates a 256-bit random `state` value, stores it in the `__Host-steam_openid_state` cookie (10-minute lifetime), and redirects (307) to Steam with `realm` set to `APP_ORIGIN` and `return_to` set to `APP_ORIGIN/api/auth/steam/callback?state=<state>`. Link to it with a plain `<a href>`, not `next/link`, so a prefetch cannot replace the state cookie mid-flow.
2. `/api/auth/steam/callback` must:
   - Check the `state` query parameter matches the cookie, in constant time.
   - Reject any query parameter that appears more than once, so we cannot validate one value while Steam verifies another.
   - Check `openid.return_to` equals our own callback URL, including the state, exactly.
   - Check `openid.op_endpoint` is Steam's endpoint and that `openid.signed` covers `op_endpoint`, `claimed_id`, `identity`, `return_to`, `response_nonce`, and `assoc_handle`.
   - Check the timestamp in `openid.response_nonce` is at most 5 minutes old.
   - Re-post the parameters to `https://steamcommunity.com/openid/login` with `openid.mode=check_authentication` and require `is_valid:true`. **Never trust the returned parameters without this server-to-server check.**
   - Require `openid.claimed_id` to match `^https://steamcommunity\.com/openid/id/(7656119\d{10})$` and take the SteamID only from that capture group.
   - Reject a reused `openid.response_nonce`: insert it into `openid_nonces` (10-minute expiry) and treat a unique violation as a replay.
3. Upsert the `users` row, insert a `sessions` row holding the SHA-256 hash of a new random token, and set the cookie to the raw token. The upsert writes only `steamid` and `last_login_at`; `persona_name`, `avatar_url`, and `profile_url` are filled by the player-summary pipeline, so sign-in never depends on the Steam Web API or its quota.
4. Redirect (303) to `/dashboard` (`POST_LOGIN_PATH`). On any failure the browser is sent to the landing page, `/?auth_error=<code>` (`SIGNED_OUT_PATH`), with one of `cancelled`, `invalid_state`, `verification_failed`, `rate_limited`, or `server_error`; the precise reason goes only to the server log. The state cookie is cleared on every outcome.

**Landing page and sign-out.** `/` redirects a visitor with a valid session to `/dashboard`; otherwise it shows the sign-in screen and, for a known `auth_error` code, one of a fixed set of messages (the code from the URL only ever selects our own text). A database failure during that check shows the sign-in screen rather than an error. `POST /api/auth/logout` deletes the session row, clears the cookie, and redirects (303) to `/`. It accepts only same-origin POSTs and is called by a plain HTML form in the navigation, so it works without JavaScript.

Session cookie: `__Host-session`, an opaque 256-bit random token (stored only as `sessions.token_hash`), `HttpOnly; Secure; SameSite=Lax; Path=/`, 7-day lifetime. Logout deletes the session row. Rotation on use is planned for the session reader and is not yet implemented.

Both routes are limited to 10 requests per minute per IP (section 6.4). Auth log lines contain a route, a reason code, and at most an error class name or Postgres error code: never parameters, cookies, tokens, SteamIDs, or IP addresses.

We never see or handle a Steam password. Signing in proves SteamID ownership only; it grants us no extra Steam API access.

### 6.3 Database security

- **RLS enabled on all seven tables, with no policies** for the `anon` or `authenticated` roles. With no browser Supabase client, nothing is reachable through the public Data API. All access is through Route Handlers using the Service Role key (in Supabase's current key format, the secret key `sb_secret_...`, which runs as the `service_role` Postgres role and bypasses RLS).
- **Default table grants are revoked** from `anon` and `authenticated` on all seven tables, as a second layer behind RLS.
- Authorization is enforced in application code: every handler that touches user-owned rows filters by the SteamID from the verified session, never from a request parameter.
- `take_quota` has `EXECUTE` revoked from `public`, `anon`, and `authenticated` and granted only to `service_role`. It runs as `SECURITY INVOKER` with an empty `search_path`. Any future RPC function follows the same pattern.
- The six player-count functions (v1.11, migration 0004) follow the same pattern: `SECURITY INVOKER`, `search_path = ''`, `EXECUTE` for `service_role` only, and RLS on both tables with no policies. Tested on Postgres 16: `anon` and `authenticated` are denied on the tables and the functions.
- `search_steam_apps` (v1.8, migration 0003) follows that pattern: `SECURITY INVOKER`, `search_path = ''` with `extensions.`-qualified `pg_trgm` calls, `EXECUTE` for `service_role` only, input limited to 3–64 characters and results to 1–25 rows. It sets `pg_trgm.word_similarity_threshold = 0.45` for its own calls only. Tested on Postgres 16: `anon` and `authenticated` are refused, the trigram index is used, and the migration can be run again safely.
- Run Supabase's Security Advisor before each release and resolve every finding.
- If a later version adds browser-side Supabase (for example Realtime), that requires real RLS policies and a design review first. Do not ship the secret key to enable it.

### 6.4 Proxy hardening

- **Input validation with zod on every parameter:** SteamID `^7656119\d{10}$`, AppID integer 1–9,999,999, vanity name `^[A-Za-z0-9_-]{2,32}$`, country code from a fixed list, search term 2–64 characters after normalising (global search; the catalog function needs 3), tracked-app note at most 500 characters. Invalid input returns 400 before any cache or Steam access.
- **No SSRF surface.** Upstream hosts are hard-coded constants. No request value ever becomes part of a hostname or path segment without validation; `redirect: "error"` on upstream fetches.
- **Inbound rate limiting** (rows in `rate_buckets`, checked with `take_quota`): 60 requests/minute per session, 30/minute per IP for unauthenticated endpoints, 10/minute per IP on auth endpoints. Global search has its own limit of 60 per minute per user (v1.8), keyed by a SteamID hash. Hover prefetches are limited to 120 per minute per user (v1.9) the same way (`lib/api/user-limit.ts`).
- **Authentication required** for all player endpoints, so anonymous traffic cannot spend our quota looking up arbitrary SteamIDs.
- **Upstream timeouts** of 5 seconds via `AbortController`; responses are schema-validated before caching so malformed upstream data cannot poison the cache.
- **CSRF.** All state-changing endpoints are `POST`/`DELETE`, check the `Origin` header against our own origin, and rely on `SameSite=Lax`.
- **CORS.** No `Access-Control-Allow-Origin` header is sent; the API is same-origin only.
- **Cron endpoints** reject any request without `Authorization: Bearer $CRON_SECRET`.

### 6.5 HTTP security headers

Set globally in `next.config` / middleware:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{per-request}';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://*.steamstatic.com https://*.akamaihd.net;
  connect-src 'self';
  frame-ancestors 'none'; base-uri 'self';
  form-action 'self' https://steamcommunity.com
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

`GetItems` image URLs are on `shared.akamai.steamstatic.com`, already covered by `*.steamstatic.com`. ITAD images are not used, and ITAD is called only from the server, so `connect-src` stays `'self'`. Verify the exact Steam image hostnames against real responses during development and tighten `img-src` to match. Game descriptions and news from Steam contain HTML: render as plain text, or sanitize with an allowlist sanitizer (for example DOMPurify) before any use of `dangerouslySetInnerHTML`.

### 6.6 Privacy and Steam terms compliance

- Respect profile privacy. If Steam says a profile is private, show that and stop. Never attempt alternate routes to the data.
- Data minimization: store only fields we display. Friend lists are stored as SteamIDs plus the cached public summary.
- Deletion: a "Delete my data" action deletes the `users` row (which cascades to `sessions` and `tracked_apps`) and then deletes all `api_cache` rows where `owner_steamid` matches. The second step is explicit because `api_cache` has no foreign key to `users`.
- Retention: cached player data expires at `stale_until` (maximum 7 days) and is purged by cron.
- Steam Web API Terms: one key, stay under 100,000 calls/day, keep the key confidential, publish a privacy policy, and do not use Steam data for unsolicited marketing.
- IsThereAnyDeal: price lows and history shown in the app are attributed to IsThereAnyDeal with a link. Check their API terms before launch.
- Branding: footer text stating SteamGauge is not affiliated with Valve, with "Powered by Steam" attribution linking to the Steam store. Since v1.9.1 one shared footer (`components/footer.tsx`) carries it on the sign-in page and on every signed-in page (before, signed-in pages had none), with the line "Made for MIS325." above it. Colours: `footer` token `#101822`, slate-400 text (7.0:1) and a steam-300 accent (10.5:1). On phones it sits above the fixed tab bar.
- The Storefront API is undocumented and unsupported. Treat it as a dependency that can change or disappear, and keep store features isolated behind `lib/steam/endpoints.ts`.

---

## 7. Observability

- Structured JSON logs per request: route, cache result (`fresh`/`stale`/`miss`), upstream called, latency, status. No SteamIDs paired with IPs, no keys, no upstream URLs.
- A small internal `/admin/quota` page (team SteamIDs only) reading `rate_buckets`: today's usage versus ceiling, current 5-minute store window, breaker state, and cache hit ratio.
- Alerts (email or Discord webhook from cron): daily usage above 70%, breaker open longer than 10 minutes, cache hit ratio below 80%.
- **Target: at least 90% of API requests served without a Steam call.**

---

## 8. Architecture decisions

| # | Decision | Alternative considered | Why |
|---|---|---|---|
| ADR-1 | BFF proxy in Next.js Route Handlers | Browser calls Steam directly | Steam key cannot be exposed; Steam does not send CORS headers for browser use |
| ADR-2 | Supabase Postgres as the shared cache | Redis (Upstash) | One fewer service and bill; class-scale traffic does not need sub-millisecond reads; SQL makes quota accounting atomic. Revisit if p95 cache reads exceed 150 ms |
| ADR-3 | Generic `api_cache` JSONB table | Fully normalized tables per entity | Faster to build, one code path for TTL/lease logic. `steam_apps` is the one normalized exception, because app names must be searchable |
| ADR-4 | Custom session after Steam OpenID | Supabase Auth with minted JWTs | Steam is not a native Supabase provider; server-only data access makes Supabase Auth unnecessary in v1 |
| ADR-5 | Server-only DB access, RLS deny-all | Browser Supabase client with RLS policies | Smallest attack surface; all quota and authorization logic stays in one place |
| ADR-6 | Stale-while-revalidate with leases | Strict TTL expiry | Users never wait on Steam for known data; leases prevent stampedes across stateless instances |
| ADR-7 | Self-imposed ceilings at 80% of Steam's | Use the full limit | Headroom for retries, clock skew, and mistakes; a revoked key ends the project |
| ADR-8 | One `rate_buckets` table and one `take_quota` function for Steam budgets, breaker, and inbound limits | Separate tables per concern | A single audited code path for every counter |
| ADR-9 | SteamIDs stored as `text` with a format `CHECK` | `bigint` | SteamID64 exceeds JavaScript's safe integer range |
| ADR-10 | GIN trigram index for app name search | GiST trigram, or Postgres full-text search | Catalog is read-heavy and GIN is faster to query; substring matching suits game titles better than word stemming |
| ADR-11 | Populate `steam_apps` lazily from `appdetails` responses | Scheduled full sync of Steam's app list | No extra Steam calls and no sync job to run; the catalog holds only apps our users care about. Trade-off: search covers only apps already seen |
| ADR-12 | Wishlist at `/api/wishlist` (first planned as `/api/apps/tracked`), identified by session only | `/api/players/[steamid]/tracked` | No SteamID in the request means no way to address another user's list |
| ADR-13 | Steam client requires a quota callback before every attempt | Client calls Steam freely, callers remember to check quota | Makes the governor impossible to skip, and charges retries automatically |
| ADR-14 | IsThereAnyDeal for price lows and multi-year history, optional | Keep only our own recorded history; scrape SteamDB | ITAD has an official keyed API with years of Steam prices; SteamDB has no public API. Optional so the app still runs without a key |
| ADR-15 | Deals filtered, sorted and paged in the browser over at most 1,000 rows | Server-side query per filter change | One cached payload serves every filter combination with zero extra upstream calls; 1,000 rows is small for a phone |
| ADR-16 | Steam wishlist is read-only; watchlist stays in Supabase | Write watch actions back to the Steam wishlist | Steam offers no supported write API for third parties, and the user asked for no push-back |
| ADR-17 | Badges use a 1-year low in place of the requested 2-year low; no "rare deal" badge | Compute a 2-year low from full history per row | That would cost one ITAD history call per deal (up to 1,000 per refresh); ITAD's deal list already carries all-time and 1-year lows |
| ADR-18 | Review totals: batched `GetItems` first, then per-app `GetAppReviews` only for gaps, cached per app for all users and capped per request | Call the store `appreviews` URL for every row | That URL was retired on 2026-10-22. One call per row would be up to 1,000 calls per refresh; the per-app cache plus caps keeps a warm table at zero calls |
| ADR-19 | Default deals order is a "Top deals" score: log10(reviews) × discount% (v1.5), with sub-10-review titles hidden by default | Sort by rating, or by discount alone; log10(reviews)² × discount% | Rating alone surfaces tiny games with a handful of perfect reviews; discount alone surfaces shovelware. The squared variant favours major titles more strongly and remains a one-line change |
| ADR-21 | Wishlist cards fetch Storefront `appdetails` (for genres) lazily, per card in view, cached 24 h for everyone (revised v1.7.1) | Cache-only reads (v1.6), which left Genres empty on most cards | `appdetails` is Steam's only source of genre names. The 24-hour shared cache, lazy loading and the Storefront quota gate bound the cost; developer, publisher and tags still come from the Web API |
| ADR-22 | Global search asks Steam's store search and our `pg_trgm` catalog in parallel and ranks them with a small tested scorer (v1.8) | Fuse.js over a title list; the catalog alone; `IStoreQueryService` text search | Fuse.js would need the whole title list in the browser or in memory. The catalog alone starts empty on a new deployment. Steam's store search knows every title, and the trigram catalog covers the typos it misses |
| ADR-23 | The Wishlist filter box also accepts a Steam link or App ID and offers "Watch" when that game is not on the list (v1.8) | Keep a separate add-by-ID form; only filter | One box keeps the toolbar short on phones and keeps the old way to add a game. Finding a game by name now goes through global search and its game page |
| ADR-24 | Per-instance memory cache in front of Postgres, serving fresh entries only (v1.9) | No in-process cache; serve stale from memory too | Saves the database round trip on warm instances without letting instances disagree: freshness is decided by Postgres and leases as before |
| ADR-25 | Complete per-game answers (insights, history) are CDN-cacheable; personal lists stay private (v1.9) | `s-maxage` on every route, as first requested | Deals and Wishlist responses contain owned, wished and watched flags; sharing them would leak one user's list to others. Per-game data is public, so sharing it is safe even though cache hits skip the session check |
| ADR-26 | Hover prefetch uses its own lower quota tier and is declined rather than answered with degraded data (v1.9) | Prefetch as a normal request | A mouse sweep must not use up the shared Storefront budget, and a refused guess must not fill the browser cache with a half-empty answer that a click would then show |
| ADR-27 | Cache Steam AppID → ITAD ids instead of trying to parallelise lookup and prices (v1.9) | `Promise.all` over lookup, prices and history | Prices and history need the id, so they cannot start before the lookup. Recording ids from the bulk Deals/Wishlist lookups removes the call from the drawer's path for nearly every row |
| ADR-28 | Dashboard store data in one bulk `GetItems` request per user, replacing per-card Storefront lookups (v1.10) | Per-card `appdetails` as before; per-game insights for every card | Sorting by price or release and filtering by tag need data for every game, not just visible cards. `GetItems` covers 50 games per call on the Web API budget, so a 1,000-game library costs 20 calls a day instead of up to 1,000 Storefront calls |
| ADR-29 | Record our own concurrent-player readings for the history chart (v1.11) | Scrape SteamDB; show only the live count; fake a history from the live count | No Steam or public API serves history, and SteamDB's terms forbid scraping. Recording is honest and cheap (one `GetNumberOfCurrentPlayers` call per game per hour, at most 7,200 Web API calls a day). The cost is that history starts at deployment, so the page labels peaks "recorded" and links to SteamDB |
| ADR-30 | Two tables: 10-minute slots for 31 days, daily peaks forever (v1.11) | One table of every reading; time-series extension | Short ranges need fine detail; long ranges only need the daily high. Keeps storage bounded with plain Postgres and no extension |
| ADR-31 | Hourly sampling through GitHub Actions, not `vercel.json` (v1.11) | Vercel cron (Hobby runs once a day); sample only on page views | Hobby's daily limit would give one reading a day. Any scheduler that sends the bearer token works; the route does not care who calls it |
| ADR-32 | Player line `#7DA213` instead of `#A4D037` (line removed in v1.12); Steam's tan for "Mixed" reviews instead of gray (v1.11) | The requested colours | `#A4D037` is too light for a data line on the dark card and outshines the price chart's blue; `#7DA213` is the same hue and passes the palette checks. Gray reads as "no data" |
| ADR-33 | *Superseded by ADR-35.* Players panel degrades per source; peaks also from ITAD; a labelled estimate only for 48h and 1w (v1.11.1) | Keep the 503 and the error banner; generate a realistic-looking history for every range and show it like measured data | One missing source should not blank the whole panel. ITAD gives real peaks at once. An estimate shown as data would mislead users, so it is dashed, labelled in the chart, tooltip, table and caption, and kept out of the stat cards. Ranges past a week have nothing to anchor a curve to, so they show recordings or the "not enough readings" state |
| ADR-34 | *Superseded by ADR-35.* Long ranges get an estimated historical trend anchored on release, the all-time peak, the handover point and ITAD's sale log (v1.11.2; revises ADR-33's "48h and 1w only") | Keep long ranges disabled until recordings cover them; a flat line at today's level | Requested, so every range shows a continuous line. The curve is pinned to real anchors (release day, all-time peak, today's level, real sale dates) and labelled in the legend, tooltip, table and caption, with a "Tracking began" marker where measured data takes over. Where the all-time peak actually happened is unknown; the model assumes release week, and the caption says real peaks can fall at other times |
| ADR-35 | Remove the player history chart and every estimate; show only reported figures: Steam's live count in a header badge, ITAD's 24-hour and all-time peaks in a panel, "N/A" when missing (v1.12) | Keep the chart with labelled estimates (v1.11.1–v1.11.2) | Requested. Exact, sourced numbers are easier to trust than a modelled curve, however well labelled. Recording continues so a measured chart can return later; ITAD peaks ride on the insights request the page already makes |
| ADR-37 | No peak date on the all-time card; ITAD's count only (v1.12.2; supersedes ADR-36) | Keep dating from our recordings when they hold the highest figure | ITAD's player data has no date field. A date from a different source than the number beside it, shown for only some games, read as inconsistent; the card now shows exactly what ITAD verifies |
| ADR-36 | *Superseded by ADR-37.* Date the all-time peak only from SteamGauge's own recordings, when they hold the highest figure; otherwise show the count alone (v1.12.1) | A date from ITAD (requested); SteamDB's chart; the release date or "today" as a stand-in | ITAD's API has no peak date and SteamDB has no API (and forbids scraping). A stand-in date would be a guess shown as fact. Our readings carry their real time, so when ours is the peak, the date is exact |
| ADR-20 | The deals pool comes from Steam (discounted apps among the global top 1,000 sellers); ITAD only enriches by Steam AppID | ITAD's deals list as the pool, with a reverse lookup to AppIDs | The ITAD-driven pool was dominated by obscure titles and missed major sales. Steam's own query defines "on sale" exactly as the store does |

---

## 9. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Shared serverless egress IPs get throttled by the Storefront API | Game pages fail on cold cache | Long TTLs, CDN layer, stale-if-error, breaker; pre-warm popular apps |
| Storefront API changes or is restricted | Store features break | Isolated module; fall back to Web API data where available |
| Supabase free tier pauses inactive projects and has storage caps | Outage or cache eviction | Daily cron keeps the project active; purge job bounds table size |
| Vercel Hobby cron frequency and function duration limits | Warming is limited | Warm job is optional by design; keep batch sizes small |
| Most users have private profiles | Empty app experience | Clear onboarding screen explaining which Steam privacy settings to change |
| `storesearch` (Steam's store search box endpoint) is undocumented and may change or be throttled | Global search falls back to the catalog only; titles not yet in `steam_apps` cannot be found | Results cached 24 h globally; debounce, 2-character minimum and a per-user limit bound the calls; the catalog keeps answering. The response parser was written from observed responses; verify one live call before launch |
| The catalog is lazily populated, so typo-tolerant search finds little on a new deployment | Misspelled titles return nothing at first | Every Steam search result is added to `steam_apps`; seeding from owned-games responses (open question 3) would help further |
| Storefront `featuredcategories` response differs from what the parser expects (written without access to a live response) | Deals page shows an error or an empty list | Verify against a real response before launch; the parser skips items it cannot read rather than failing |
| Price history is thin for weeks after launch, and has gaps if the daily job does not run | "Lowest recorded" is rarely claimable at first | Schedule the daily job; the UI states days recorded and withholds the claim under 7 days |
| `IStoreQueryService/Query` is undocumented by Valve. The filter names (`price_filters.min_discount_percent`, `global_top_n_sellers`) and the store `type` values (0 game, 4 DLC) come from community documentation | If a filter is ignored, the pool is wider or unranked; if the method fails, Deals falls back to featured specials | Undiscounted rows are dropped regardless; verify one live response before launch and check the pool contains known sale titles |
| ITAD endpoint paths (`/lookup/id/shop/61/v1`, `/games/prices/v3`, `/games/history/v2`) and the deal `flag` value `"N"` (new historical low) were written from the docs without a live call | Deals fall back to Steam Specials; badges may mark too few historical lows | Make one call to each with a real key before launch and adjust `ENDPOINTS` in `lib/itad/client.ts` |
| `GetItems` field names (`best_purchase_option.active_discounts[].discount_end_date`, `reviews.summary_filtered`, `assets.asset_url_format`) written without a live response | Missing sale end, rating, or images | Parser skips what it cannot read and falls back to Steam's standard image paths; verify before launch |
| `GetAppReviews` called anonymously shares Steam's lower keyless rate limit, which other traffic from the same serverless IPs also uses | Some ratings stay "loading" longer | Per-app cache (3 days fresh, 14 usable), 30 lookups per request, 4 in flight, stop at the first 429; the circuit breaker applies |
| `GetAppReviews` with `purchase_type` 0 (Steam purchases) is assumed to match the store page's score; the docs and community examples disagree on which value most tools use | Review counts may be lower than another site shows | Chosen to match the store page; change `purchase_type` in `cached-fetch.ts` (and bump the cache key) if needed |
| ITAD's documentation states no default for `since` on the history log; the 3-month window was observed, not documented | If ITAD changes the parameter, charts could shorten again | `since` is always sent explicitly; a test asserts it |
| ITAD deal `url` (store link) written from the documented deal object without a live response | A store row without a link | Rows without a valid https link are shown unlinked; verify before launch |
| `GetItems` `basic_info.developers / publishers / franchises` and `tags` field names, and `GetTagList`, written without a live response | A missing section on the facts panel | Each is optional; developer and publisher fall back to `appdetails`; verify before launch |
| A private Steam wishlist looks the same as an empty one | User sees "empty or private" when theirs is just private | UI explains the Game details privacy setting and links to it |
| Next.js or the host changes how a Route Handler's own `Cache-Control` is treated | Per-game answers stop being shared by the CDN (slower, not wrong) | Check the response headers on a deployed preview; the in-memory and Postgres caches still apply |
| Hover prefetch raises request volume | More function invocations and database reads per visit | 120 ms intent delay, no touch prefetch, skip when cached or loading, 3 in flight, 120 per user per minute, lower quota tier |
| ITAD has no player figures for many niche games (v1.12) | Peak cards show "N/A" | Shown as "N/A · Not tracked for this game" in the same card size; the live Steam count is unaffected |
| The hourly sampler is not scheduled (secrets unset, GitHub disables scheduled workflows after 60 days without repository activity) | Readings only when someone views a game; gaps in the recordings (not shown since v1.12) | Nothing shows the recordings yet, so gaps cost nothing today; the job's JSON result shows `read` and `stoppedEarly`; re-enable the workflow or move to Vercel Pro or `pg_cron` |
| Sampling 300 games an hour uses up to 7,200 Web API calls a day | Less headroom for user requests | Runs on the cron quota tier and stops on `quota_exhausted` or `throttled`; `SAMPLE_MAX_APPS` can be lowered |
| ITAD `games/info/v2` `players` fields (`day` = 24-hour peak, `peak` = all-time) taken from the documented response sample without a live call (v1.11.1) | A card labelled with the wrong window. ITAD's own game pages show the Peak figure beside "Last two weeks", so `peak` may cover a recent window rather than all time | Each field is optional and validated; compare one well-known game's `peak` against its SteamDB all-time peak before launch, and relabel the card if it is a two-week figure |
| Quota bug (for example a refresh loop) | Budget burned | Governor is enforced in the database, not in app code; per-minute ceiling limits damage |

Open questions for the team:

1. Confirm hosting tier and whether cron jobs are available at the frequency we want.
2. Which country codes do we support for store pricing? Each one multiplies store cache entries. Until decided, `SUPPORTED_COUNTRY_CODES` in `lib/validation.ts` is `["us"]` only.
3. Proposed, not yet decided: also upsert `steam_apps` from each user's `GetOwnedGames` response (requested with `include_appinfo`, which returns every owned game's name). This costs no extra Steam calls and would fill the catalog with a user's whole library at first sign-in. Those rows would have `name` only until the app is viewed.
4. Who owns the production Steam API key, and what domain is it registered to?

---

## 10. References

- Steam Web API Terms of Use: https://steamcommunity.com/dev/apiterms
- Steam Web API documentation: https://partner.steamgames.com/doc/webapi_overview
- Supabase API keys: https://supabase.com/docs/guides/api/api-keys
- Supabase migration to publishable/secret keys: https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
- Storefront rate limit (community-observed): https://steamdb.info/blog/5
- IsThereAnyDeal API documentation: https://docs.isthereanydeal.com/
- IWishlistService/GetWishlist (community documentation): https://steamapi.xpaw.me/#IWishlistService/GetWishlist
- IStoreBrowseService/GetItems (community documentation): https://steamapi.xpaw.me/#IStoreBrowseService/GetItems
- ISteamUserStats/GetNumberOfCurrentPlayers (Steamworks documentation): https://partner.steamgames.com/doc/webapi/ISteamUserStats
- IUserReviewsService/GetAppReviews (Steamworks documentation): https://partner.steamgames.com/doc/webapi/IUserReviewsService
- IStoreQueryService/Query (community documentation): https://steamapi.xpaw.me/IStoreQueryService and https://github.com/benhurk/IStoreQueryService-Query-v1-Documentation
