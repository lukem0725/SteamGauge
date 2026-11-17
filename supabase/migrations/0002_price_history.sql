-- =============================================================================
-- SteamGauge migration 0002: price history (run once in the Supabase SQL Editor)
-- =============================================================================
-- Steam does not publish historical prices, so SteamGauge records its own: one
-- row per app, per country, per UTC day, holding the LOWEST price it observed
-- that day. History therefore begins on the day this migration is applied.
--
-- Same security model as migration 0001: RLS enabled with no policies, and
-- only the backend (service_role, via the Supabase secret key) can reach it.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

begin;

create table if not exists public.price_history (
  appid             integer not null,
  cc                text    not null check (cc ~ '^[a-z]{2}$'),
  observed_on       date    not null,                       -- UTC calendar day
  currency          text    not null check (currency ~ '^[A-Z]{3}$'),
  price_initial     integer not null check (price_initial >= 0),   -- minor units
  price_final       integer not null check (price_final >= 0),     -- minor units
  discount_percent  integer not null check (discount_percent between 0 and 100),
  observed_at       timestamptz not null default now(),
  primary key (appid, cc, observed_on)
);

-- A price row only makes sense for an app in the catalog. Removing the app
-- removes its history.
alter table public.price_history
  drop constraint if exists price_history_appid_fkey;
alter table public.price_history
  add constraint price_history_appid_fkey
  foreign key (appid) references public.steam_apps (appid)
  on delete cascade;

-- The primary key (appid, cc, observed_on) already serves every read we do:
-- "all days for one app and country, in date order".

alter table public.price_history enable row level security;
revoke all on table public.price_history from anon, authenticated;

-- -----------------------------------------------------------------------------
-- record_price_observation(): keep the lowest price seen per app, country, day
-- -----------------------------------------------------------------------------
-- Returns TRUE if a row was inserted or lowered, FALSE if nothing changed
-- (today's row already holds an equal or lower price, or the app is not in
-- the catalog). Keeping the daily minimum means a sale that ends mid-day is
-- not overwritten by the full price observed later that day.
create or replace function public.record_price_observation(
  p_appid             integer,
  p_cc                text,
  p_currency          text,
  p_price_initial     integer,
  p_price_final       integer,
  p_discount_percent  integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed boolean;
begin
  if not exists (select 1 from public.steam_apps where appid = p_appid) then
    return false;
  end if;

  insert into public.price_history as h
    (appid, cc, observed_on, currency, price_initial, price_final, discount_percent)
  values
    (p_appid, lower(p_cc), (now() at time zone 'utc')::date,
     p_currency, p_price_initial, p_price_final, p_discount_percent)
  on conflict (appid, cc, observed_on) do update
    set currency         = excluded.currency,
        price_initial    = excluded.price_initial,
        price_final      = excluded.price_final,
        discount_percent = excluded.discount_percent,
        observed_at      = now()
    where excluded.price_final < h.price_final
  returning true into changed;

  return coalesce(changed, false);
end;
$$;

revoke all on function
  public.record_price_observation(integer, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function
  public.record_price_observation(integer, text, text, integer, integer, integer)
  to service_role;

commit;
