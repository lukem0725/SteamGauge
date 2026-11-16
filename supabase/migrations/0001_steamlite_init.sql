-- =============================================================================
-- SteamLite: database initialization (run once in the Supabase SQL Editor)
-- =============================================================================
-- SECURITY MODEL: NO BROWSER RLS POLICIES ARE NEEDED, AND NONE ARE DEFINED.
--
-- The browser never talks to Supabase. Our Next.js backend proxy (Route
-- Handlers) is the only client, and it communicates exclusively with the
-- Supabase Service Role key (in the current key format: the secret key,
-- sb_secret_..., which runs as the service_role Postgres role). That role
-- bypasses Row Level Security.
--
-- RLS is still ENABLED on every table below, with zero policies. The effect is
-- deny-all for the anon and authenticated roles, so nothing is readable or
-- writable through the public Data API even if the project URL and publishable
-- key are known. Do not add policies, and never ship the Service Role key to
-- the browser. Authorization is enforced in the proxy, using the SteamID from
-- the verified session.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

begin;

-- Lets the script find pg_trgm whether it lives in "extensions" (Supabase
-- default) or "public". Applies to this transaction only.
set local search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
-- Trigram matching for fast ILIKE / similarity search on app names.
create extension if not exists pg_trgm with schema extensions;


-- -----------------------------------------------------------------------------
-- 2. Core tables
-- -----------------------------------------------------------------------------

-- One row per person who has signed in with Steam.
-- SteamID64 is stored as text: it exceeds JavaScript's safe integer range.
create table if not exists public.users (
  steamid        text primary key
                 check (steamid ~ '^7656119[0-9]{10}$'),
  persona_name   text,
  avatar_url     text,
  profile_url    text,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);

-- Server-side sessions. The cookie holds an opaque random token; only its
-- SHA-256 hash is stored here.
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  user_steamid  text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  check (expires_at > created_at)
);

-- Replay protection for Steam OpenID: a response nonce may be used once.
create table if not exists public.openid_nonces (
  nonce       text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '10 minutes')
);

-- Shared cache of normalized Steam responses (architecture doc section 5.6).
--   fresh_until : before this, serve from cache with no Steam call
--   stale_until : before this, serve stale and refresh in the background
--   lease_until : stampede guard; one instance refreshes a key at a time
create table if not exists public.api_cache (
  key            text primary key,
  payload        jsonb,
  status         text not null default 'ok'
                 check (status in ('ok', 'private', 'not_found')),
  fetched_at     timestamptz not null default now(),
  fresh_until    timestamptz not null,
  stale_until    timestamptz not null,
  lease_until    timestamptz not null default 'epoch',
  -- Set for player:* keys so "delete my data" can find them. Deliberately NOT
  -- a foreign key: cached players (e.g. friends) are often not SteamLite users.
  owner_steamid  text
                 check (owner_steamid is null or owner_steamid ~ '^7656119[0-9]{10}$'),
  check (stale_until >= fresh_until)
);

-- Fixed-window counters used by take_quota(). One table serves:
--   Steam budgets    bucket = 'webapi' | 'store'
--   circuit breaker  window_kind = 'breaker'
--   inbound limits   bucket = 'ip:<hash>' | 'session:<id>'
create table if not exists public.rate_buckets (
  bucket        text not null,
  window_kind   text not null,          -- day | minute | 5min | breaker
  window_start  timestamptz not null,
  used          integer not null default 0 check (used >= 0),
  primary key (bucket, window_kind, window_start)
);

-- Local catalog of Steam apps, for name search without calling Steam.
create table if not exists public.steam_apps (
  appid          integer primary key check (appid > 0),
  name           text not null,
  app_type       text,                  -- game | dlc | demo | ...
  header_image   text,
  is_free        boolean,
  last_modified  timestamptz,           -- as reported by Steam
  updated_at     timestamptz not null default now()
);

-- Apps a user has chosen to follow.
create table if not exists public.tracked_apps (
  user_steamid  text not null,
  appid         integer not null,
  note          text check (note is null or char_length(note) <= 500),
  created_at    timestamptz not null default now(),
  primary key (user_steamid, appid)
);


-- -----------------------------------------------------------------------------
-- 3. Foreign keys
-- -----------------------------------------------------------------------------
-- Deleting a user removes their sessions and tracked apps.
alter table public.sessions
  drop constraint if exists sessions_user_steamid_fkey;
alter table public.sessions
  add constraint sessions_user_steamid_fkey
  foreign key (user_steamid) references public.users (steamid)
  on delete cascade;

alter table public.tracked_apps
  drop constraint if exists tracked_apps_user_steamid_fkey;
alter table public.tracked_apps
  add constraint tracked_apps_user_steamid_fkey
  foreign key (user_steamid) references public.users (steamid)
  on delete cascade;

-- A tracked app must exist in the catalog. The proxy upserts the steam_apps
-- row before inserting into tracked_apps.
alter table public.tracked_apps
  drop constraint if exists tracked_apps_appid_fkey;
alter table public.tracked_apps
  add constraint tracked_apps_appid_fkey
  foreign key (appid) references public.steam_apps (appid)
  on delete cascade;


-- -----------------------------------------------------------------------------
-- 4. Indexes
-- -----------------------------------------------------------------------------
create index if not exists sessions_user_steamid_idx
  on public.sessions (user_steamid);
create index if not exists sessions_expires_at_idx
  on public.sessions (expires_at);

create index if not exists openid_nonces_expires_at_idx
  on public.openid_nonces (expires_at);

-- Purge job: delete from api_cache where stale_until < now()
create index if not exists api_cache_stale_until_idx
  on public.api_cache (stale_until);
create index if not exists api_cache_owner_steamid_idx
  on public.api_cache (owner_steamid)
  where owner_steamid is not null;

create index if not exists rate_buckets_window_start_idx
  on public.rate_buckets (window_start);

-- Trigram GIN index: makes  name ILIKE '%term%'  and  name % 'term'  fast.
create index if not exists steam_apps_name_trgm
  on public.steam_apps using gin (name gin_trgm_ops);

create index if not exists tracked_apps_appid_idx
  on public.tracked_apps (appid);


-- -----------------------------------------------------------------------------
-- 5. Row Level Security: enabled everywhere, no policies (deny-all)
-- -----------------------------------------------------------------------------
alter table public.users          enable row level security;
alter table public.sessions       enable row level security;
alter table public.openid_nonces  enable row level security;
alter table public.api_cache      enable row level security;
alter table public.rate_buckets   enable row level security;
alter table public.steam_apps     enable row level security;
alter table public.tracked_apps   enable row level security;

-- Defense in depth: remove the default table grants for browser-facing roles.
revoke all on table
  public.users, public.sessions, public.openid_nonces, public.api_cache,
  public.rate_buckets, public.steam_apps, public.tracked_apps
from anon, authenticated;


-- -----------------------------------------------------------------------------
-- 6. take_quota(): atomic quota governor (architecture doc sections 5.5 / 5.6)
-- -----------------------------------------------------------------------------
-- Adds p_cost to the counter for (bucket, kind, window) and returns TRUE only
-- if the result stays at or under p_ceiling. Returns FALSE, changing nothing,
-- if the budget is spent. The check and the increment are one UPDATE, so the
-- ceiling holds across any number of concurrent serverless instances.
--
-- Example (80,000/day Steam Web API budget, day starting 00:00 Pacific):
--   select public.take_quota(
--     'webapi', 'day',
--     date_trunc('day', now() at time zone 'America/Los_Angeles')
--       at time zone 'America/Los_Angeles',
--     80000);
create or replace function public.take_quota(
  p_upstream  text,
  p_kind      text,
  p_window    timestamptz,
  p_ceiling   integer,
  p_cost      integer default 1
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ok boolean;
begin
  if p_upstream is null or p_kind is null or p_window is null
     or p_ceiling is null or p_cost is null then
    raise exception 'take_quota: arguments must not be null';
  end if;
  if p_cost < 1 then
    raise exception 'take_quota: p_cost must be >= 1 (got %)', p_cost;
  end if;

  -- Make sure the window row exists. Concurrent callers are safe: the loser
  -- of the insert race simply does nothing.
  insert into public.rate_buckets (bucket, window_kind, window_start, used)
  values (p_upstream, p_kind, p_window, 0)
  on conflict (bucket, window_kind, window_start) do nothing;

  -- Atomic check-and-increment. The row lock serializes concurrent callers,
  -- and the WHERE clause is re-evaluated after the lock is acquired.
  update public.rate_buckets
     set used = used + p_cost
   where bucket       = p_upstream
     and window_kind  = p_kind
     and window_start = p_window
     and used + p_cost <= p_ceiling
  returning true into ok;

  return coalesce(ok, false);
end;
$$;

-- Only the backend may call it.
revoke all on function public.take_quota(text, text, timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.take_quota(text, text, timestamptz, integer, integer)
  to service_role;

commit;
