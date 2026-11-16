# SteamLite — System Architecture

| | |
|---|---|
| **Status** | v1.2, schema deployed; catalog population and tracked-app/search endpoints decided; core `lib/` modules implemented |
| **Date** | 2026-11-14 |
| **Scope** | Technical core, data model, Steam data caching strategy, security configuration |
| **Schema source** | `steamlite_init.sql` (applied in Supabase 2026-11-14). Sections 4.4 and 5.6 mirror it. |
| **Stack** | React, Tailwind CSS, Next.js (Route Handlers as serverless functions), Supabase (Postgres) |

---

## 1. Summary

SteamLite is a mobile-first companion web app that shows Steam profile, library, achievement, friend, and store data. The browser never talks to Steam. Every Steam request goes through our Next.js serverless layer, which holds the API key, validates input, and answers from a Supabase-backed cache whenever possible.

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

Implications:

- 100,000/day averages to about 1.16 requests/second. A naive design (5 Steam calls per page view, no cache) exhausts that at roughly 20,000 page views/day, and a single refresh loop bug can burn it in minutes.
- The Storefront limit is per IP. Serverless functions egress from shared, changing IPs, so we can be throttled by traffic that is not ours. Store data must therefore be the most aggressively cached, and the app must degrade gracefully on HTTP 429/403.
- Steam returns 429 without a reliable `Retry-After`. We back off on our own schedule.
- Private profiles return empty or 401/403 responses. That is a valid answer to cache, not an error to retry.

Our self-imposed ceilings sit below the real ones: **80,000/day** for the Web API and **150 per 5 minutes** for the Storefront API.

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
- **App shell.** `app/(app)/layout.tsx` wraps every signed-in page with the dark page surface, the navigation, and one shared TanStack Query client, so data loaded on one page survives navigation and an action on one page can refresh another (watching a game from Deals refreshes the Wishlist, and the reverse). Navigation (`components/app-nav.tsx`) links Dashboard, Deals, and Wishlist: a sticky top bar at 640px and wider, and a fixed bottom tab bar on phones. The current page is marked with `aria-current="page"` as well as colour. The layout does not check the session; each page does, because layouts are not re-rendered on every navigation. `loading.tsx` and `error.tsx` in the same folder keep the wait and failure screens in the same dark design; the error screen never shows the error's message.
- **Dashboard** (`/dashboard`). One library request drives the Library Health banner and the Backlog Guardian deck (games with exactly 0 minutes played, at most 24 cards). Each card looks up its store price only when it scrolls into view, so a visit costs at most 24 Storefront lookups, each shared by all users for 24 hours. The card's value rating divides the current US store price by a game length that is **simulated** from the AppID and labelled as such in the UI; there is no real length data source yet. After a stale answer the client re-checks at most twice, 4 seconds apart, then stops.
- **Deals** (`/deals`). One request to `GET /api/deals` returns trending discounted games (Steam's "Specials" list plus any top seller on sale) already scored and ranked by cost per hour: sale price divided by completion time, lower is better. The completion time is the same **simulated** figure the dashboard uses (`lib/value.ts`), so the ranking is illustrative until a real length source exists. Each deal carries a `watched` flag from the user's wishlist and offers a one-tap "Watch this game" button (hidden for owned games) that becomes an "In wishlist" link. Each deal is cross-referenced with the user's library: owned games are flagged, and a yellow warning badge appears when the user does not own the game but has unplayed games in one of its genres. Backlog genres come from the first 24 unplayed games by name (the same ones the dashboard deck shows), so a cold request costs at most about 55 Storefront lookups, each then shared by all users for 24 hours. A private or unavailable library removes the warnings but not the list.
- **Wishlist** (`/wishlist`). Lists the user's tracked games with a discount status badge (on sale with percentage, full price, free, or price unavailable), discounted games first. Games are added by pasting a Steam store link or AppID. Each card loads its own price history when it scrolls into view and shows a single-series step-line chart (a price holds until it changes) with a crosshair readout on hover, touch, or arrow keys, a marked low point, and a table view of the same data. Above the chart a plain statement says whether the current price is the lowest SteamLite has recorded. That claim is made only with 7 or more recorded days; with less, any price is trivially the lowest and the UI says how many days remain instead.
- **Price history is ours, and it starts when we start.** Steam publishes no historical prices. Every live price fetch through `getAppPrice` or `getAppDetails` is recorded in `price_history` (section 4.4). "Lowest recorded" therefore means lowest since SteamLite first saw the app, not lowest ever, and the wishlist page says so.
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
| `GET /api/deals` | Storefront `featuredcategories`, `GetOwnedGames`, `appdetails` per sale item and per sampled backlog game | Yes |
| `GET /api/apps/search?q=` | none (reads `steam_apps`) | No |
| `GET /api/wishlist` | Storefront `appdetails` (price only) per tracked app | Yes |
| `POST /api/wishlist` | Storefront `appdetails`, only if the app is not cached | Yes |
| `DELETE /api/wishlist/[appid]` | none | Yes |
| `GET /api/wishlist/[appid]/history` | Storefront `appdetails` (price only), then reads `price_history` | Yes |
| `GET /api/cron/track-prices` | Storefront `appdetails` (price only) per tracked app, at most 100 per run | `CRON_SECRET` bearer token |

The wishlist routes were first planned as `/api/apps/tracked`; they were built as `/api/wishlist` (2026-11-15) and that is the name of record.

Notes on the search and wishlist routes:

- **Routing.** `search` is a static segment, which Next.js matches before the dynamic `/api/apps/[appid]`. It cannot collide with an AppID, since AppIDs are numeric.
- **Search** runs `name ILIKE '%q%'` against `steam_apps`, served by the `steam_apps_name_trgm` index. `q` is trimmed, must be 3 to 64 characters, and has `%`, `_`, and `\` escaped before it is placed in the pattern. Results are capped at 20. It never calls Steam, so it costs no quota; the per-IP inbound limit (section 6.4) still applies. Response: `[{ appid, name, app_type, header_image }]`.
- **Wishlist** routes are always scoped to the SteamID in the verified session. There is no SteamID in the URL or body, so one user cannot read or change another's list.
  - `GET` returns the user's tracked apps (newest first, at most 50) with each one's current price through the 3-hour `appPrice` cache. A price that cannot be loaded marks only that item `unavailable`.
  - `POST` takes `{ appid, note? }`. It refuses a 51st app (409 `wishlist_full`), loads the app's details (404 `app_not_found` if Steam has no such app), ensures the `steam_apps` row, then upserts the `tracked_apps` row. Repeating the call is safe; the note changes only if one is sent.
  - `DELETE` removes one row and returns 204 whether or not the row existed.
  - `POST` and `DELETE` reject any request whose `Origin` header is not `APP_ORIGIN` (403 `bad_origin`), before looking at the session.
  - `history` returns SteamLite's recorded daily prices for the app and a `lowStatus`. It is not personal data; any signed-in user may read it.
- **Price tracking job.** `GET /api/cron/track-prices` refreshes the price of every tracked app once a day so history grows even when nobody opens the app. Schedule it in `vercel.json` (`{ "crons": [{ "path": "/api/cron/track-prices", "schedule": "17 9 * * *" }] }`). It answers 401 unless the request carries `Authorization: Bearer $CRON_SECRET`, and refuses to run at all if that secret is unset or shorter than 16 characters.

Every handler runs the same pipeline, implemented once in `lib/steam/cached-fetch.ts`:

```
validate → authorize → rate-limit caller → cache lookup → (lease + quota + fetch) → respond
```

Response envelope, so the UI can always show data age:

```json
{ "status": "ok|private|not_found", "data": { }, "meta": { "source": "cache|steam", "fetchedAt": "ISO-8601", "stale": false } }
```

`private` and `not_found` are HTTP 200 with `data: null`: they are valid answers about the data. Failures are `{ "error": "<code>" }` with a matching HTTP status (400, 401, 500, 502, 503) and a `Retry-After` header where waiting helps. The helpers in `lib/api/respond.ts` produce both forms.

Implemented so far: the two auth routes, `GET /api/players/[steamid]/games`, `GET /api/apps/[appid]`, `GET /api/deals`, the four wishlist routes, the price-tracking cron route, and `POST /api/auth/logout`. Still to build: `/api/apps/search`, the other player and app routes in the table, and per-session inbound rate limiting on data routes (section 6.4). Data routes require Next.js 15.1 or later (`after`, async `params`).

### 4.3 Suggested layout

```
app/
  page.tsx                  # landing: sign-in screen; redirects signed-in visitors to /dashboard (implemented)
  (app)/layout.tsx          # shell for signed-in pages: surface, navigation, shared query client (implemented)
  (app)/loading.tsx         # dark skeleton shown while a page verifies the session (implemented)
  (app)/error.tsx           # dark error screen for anything a page throws (implemented)
  (app)/dashboard/page.tsx  # verifies the session, renders the dashboard (implemented)
  (app)/                    # still to write: profile, library, game detail, friends
  (app)/deals/page.tsx      # verifies the session, renders the deals ranking (implemented)
  (app)/wishlist/page.tsx   # verifies the session, renders the wishlist (implemented)
components/
  app-nav.tsx               # top bar + phone tab bar, active page, sign-out form (implemented)
  dashboard-view.tsx        # client view: health banner, backlog deck, data age ticker (implemented)
  deals-view.tsx            # client view: cost-per-hour ranking with backlog warnings (implemented)
  wishlist-view.tsx         # client view: tracked games, discount status, add/remove (implemented)
  price-history-chart.tsx   # single-series step-line price chart with readout and table view (implemented)
  ui-kit.tsx                # shared: query provider, data age ticker, value meter, state panels, lazy-load hook (implemented)
  api/                      # route handlers listed above
  api/cron/                 # warm + purge jobs (protected by CRON_SECRET)
lib/
  steam/
    client.ts               # the ONLY module that reads STEAM_API_KEY (implemented)
    endpoints.ts            # typed wrappers + validators: getPlayerSummary, getOwnedGames,
                            #   getAppDetails (implemented); other resources still to add
    cached-fetch.ts         # cache/lease/quota pipeline: cachedFetch() (implemented)
    ttl.ts                  # TTL policy table, cache keys (section 5.3) (implemented)
  supabase/server.ts        # server-only admin client (implemented)
  auth/shared.ts            # cookie names, origin, rate limit, safe logging (implemented)
  auth/session.ts           # cookie -> verified user, or null (implemented)
  api/respond.ts            # response envelope and error helpers for data routes (implemented)
  api/client.ts             # browser-side fetch for our API: envelope check, ApiError, retry rules (implemented)
  deals.ts                  # deals ranking and backlog cross-reference, server only (implemented)
  wishlist.ts               # list, add, remove tracked apps for the session user, server only (implemented)
  price-history.ts          # record and read our own daily price observations, server only (implemented)
  value.ts                  # cost-per-hour maths and the SIMULATED game length, shared by server and browser (implemented)
  validation.ts             # zod schemas: steamid, appid, vanity, search, country (implemented)
supabase/migrations/        # SQL: steamlite_init.sql is migration 0001; 0002_price_history.sql
```

`lib/steam/client.ts` and `lib/supabase/server.ts` start with `import "server-only"` so a build fails if either is ever imported into client code.

### 4.4 Data model

Eight tables in the `public` schema: seven created by `steamlite_init.sql` (migration 0001) and `price_history` by `supabase/migrations/0002_price_history.sql`. Any schema change must be made as a new migration and reflected here in the same pull request.

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

Relationships:

```
users (steamid) ──┬──< sessions (user_steamid)        ON DELETE CASCADE
                  └──< tracked_apps (user_steamid)    ON DELETE CASCADE
steam_apps (appid) ──< tracked_apps (appid)           ON DELETE CASCADE
steam_apps (appid) ──< price_history (appid)          ON DELETE CASCADE

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

**Consequence: search only finds apps someone has already viewed or tracked.** On a new deployment the catalog is empty and search returns nothing. See section 9 for the mitigation under consideration.

---

## 5. Data caching strategy

### 5.1 Cache layers

| Layer | Where | Holds | Lifetime | Purpose |
|---|---|---|---|---|
| L0 | Browser (TanStack Query) | Everything the user has viewed | Minutes, per session | Zero-network navigation and dedupe |
| L1 | CDN (`Cache-Control`) | Public app data only (store details, schemas, news) | `s-maxage` + `stale-while-revalidate` | Requests never reach a function |
| L2 | Supabase `api_cache` | All normalized Steam responses | Per-resource TTL | Shared across all users and all function instances |
| L3 | Steam | Source of truth | n/a | Only on a true miss or expired entry |

L2 is the important one. Serverless instances share no memory, so an in-process cache would be nearly useless. Postgres is the one place every instance can see.

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
| Private profile / not found | same key, `status = 'private'` | 30 min | 30 min | Negative caching stops retry storms |

TTLs live in one file (`lib/steam/ttl.ts`) so they can be tuned from observed usage. The signed-in user gets a manual "Refresh" button for their own profile, limited to one forced refresh per resource per 2 minutes.

### 5.4 Call-reduction techniques

- **Batching.** `GetPlayerSummaries` accepts up to 100 SteamIDs per call. A 250-person friends list costs 3 calls rather than 250. Only IDs missing or expired in cache are requested, and each result is cached under its own key.
- **Field trimming.** Storefront calls pass `filters=` so we request only the fields we render. Price is fetched separately from the heavy description payload.
- **Shared app data.** App details, schemas, and news are identical for every user. They are cached once, globally, and are CDN-cacheable.
- **Lazy loading.** Achievements are fetched for a game only when the user opens that game, never for a whole library up front.
- **No client polling.** No resource refetches on a timer in the browser.
- **Cron warming, bounded.** A scheduled job refreshes only the most-viewed app keys, within a fixed share of the daily budget, during off-peak hours.

### 5.5 Quota governor

A single Postgres function is the only gate to Steam. Because it is one atomic statement in the database, it holds across every concurrent serverless instance.

Budgets (fixed windows):

| Upstream | Window | Ceiling | Reserved |
|---|---|---|---|
| `webapi` | 1 day (resets 00:00 Pacific, matching Valve's day) | 80,000 | Tiered by request priority, see below |
| `webapi` | 1 minute | 120 | Smooths bursts |
| `store` | 5 minutes | 150 | None |

Daily tiers. Each tier is the ceiling passed to `take_quota` for the same `webapi` day bucket, so lower-priority work is cut off first:

| Request priority | May call Steam while today's usage is under |
|---|---|
| Cron warming, background (stale-while-revalidate) refresh | 56,000 (70%) |
| Cache miss, anonymous request | 72,000 (90%) |
| Cache miss, signed-in user | 80,000 (100%) |

At 80,000 no Steam Web API calls are made and the app runs entirely from cache until the window resets.

**Enforcement in code.** `lib/steam/client.ts` will not open a connection until the caller's `acquire` callback returns true, and it calls `acquire` again before every retry. The cache pipeline implements `acquire` with `take_quota` plus the breaker check, so no code path reaches Steam without being charged.

**Circuit breaker.** An HTTP 429 from either upstream, or a 403 from the Storefront, opens a breaker row in `rate_buckets` (`window_kind = 'breaker'`) for that upstream: 60 seconds on first trip, doubling up to 15 minutes. In a breaker row `window_start` is the time of the trip and `used` is its level (1 to 5); the breaker is open until `window_start + min(60 × 2^(level−1), 900)` seconds. A trip within 10 minutes of the previous one closing raises the level by one, otherwise it restarts at 1. While open, no calls are made and stale data is served. A 401/403 from the Web API does not open the breaker: with a JSON body it means the profile is not public (cached as `private`), and without one it means the API key was rejected (logged as a configuration fault). Retries for 5xx/timeouts are capped at 2, with exponential backoff and jitter, and each retry consumes quota.

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

- `api_cache.owner_steamid` is set for `player:*` keys so a user's cached data can be found and deleted. It is deliberately not a foreign key to `users`: most cached players (friends, looked-up profiles) are not SteamLite users.
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
| `APP_ORIGIN` | Server only (not secret) | Public origin of the deployment, for example `https://steamlite.example.com`. Used for the OpenID `realm` and `return_to` and for all auth redirects, so a forged `Host` header cannot redirect a sign-in. |
| `CRON_SECRET` | Server only | Required as a bearer token on `/api/cron/*`. |
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
- Run Supabase's Security Advisor before each release and resolve every finding.
- If a later version adds browser-side Supabase (for example Realtime), that requires real RLS policies and a design review first. Do not ship the secret key to enable it.

### 6.4 Proxy hardening

- **Input validation with zod on every parameter:** SteamID `^7656119\d{10}$`, AppID integer 1–9,999,999, vanity name `^[A-Za-z0-9_-]{2,32}$`, country code from a fixed list, search term 3–64 characters after trimming, tracked-app note at most 500 characters. Invalid input returns 400 before any cache or Steam access.
- **No SSRF surface.** Upstream hosts are hard-coded constants. No request value ever becomes part of a hostname or path segment without validation; `redirect: "error"` on upstream fetches.
- **Inbound rate limiting** (rows in `rate_buckets`, checked with `take_quota`): 60 requests/minute per session, 30/minute per IP for unauthenticated endpoints, 10/minute per IP on auth endpoints.
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

Verify the exact Steam image hostnames against real responses during development and tighten `img-src` to match. Game descriptions and news from Steam contain HTML: render as plain text, or sanitize with an allowlist sanitizer (for example DOMPurify) before any use of `dangerouslySetInnerHTML`.

### 6.6 Privacy and Steam terms compliance

- Respect profile privacy. If Steam says a profile is private, show that and stop. Never attempt alternate routes to the data.
- Data minimization: store only fields we display. Friend lists are stored as SteamIDs plus the cached public summary.
- Deletion: a "Delete my data" action deletes the `users` row (which cascades to `sessions` and `tracked_apps`) and then deletes all `api_cache` rows where `owner_steamid` matches. The second step is explicit because `api_cache` has no foreign key to `users`.
- Retention: cached player data expires at `stale_until` (maximum 7 days) and is purged by cron.
- Steam Web API Terms: one key, stay under 100,000 calls/day, keep the key confidential, publish a privacy policy, and do not use Steam data for unsolicited marketing.
- Branding: footer text stating SteamLite is not affiliated with Valve, with "Powered by Steam" attribution linking to `steampowered.com`.
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

---

## 9. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Shared serverless egress IPs get throttled by the Storefront API | Game pages fail on cold cache | Long TTLs, CDN layer, stale-if-error, breaker; pre-warm popular apps |
| Storefront API changes or is restricted | Store features break | Isolated module; fall back to Web API data where available |
| Supabase free tier pauses inactive projects and has storage caps | Outage or cache eviction | Daily cron keeps the project active; purge job bounds table size |
| Vercel Hobby cron frequency and function duration limits | Warming is limited | Warm job is optional by design; keep batch sizes small |
| Most users have private profiles | Empty app experience | Clear onboarding screen explaining which Steam privacy settings to change |
| Search returns few or no results because the catalog is lazily populated | Search feels broken on a new deployment | Seed from owned-games responses (open question 3); show "no matches yet" with a link to open a game by Steam URL or AppID |
| Storefront `featuredcategories` response differs from what the parser expects (written without access to a live response) | Deals page shows an error or an empty list | Verify against a real response before launch; the parser skips items it cannot read rather than failing |
| Price history is thin for weeks after launch, and has gaps if the daily job does not run | "Lowest recorded" is rarely claimable at first | Schedule the daily job; the UI states days recorded and withholds the claim under 7 days |
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
