-- =============================================================================
-- 0004_player_counts.sql  (SteamGauge v1.11)
--
-- Concurrent-player history recorded by SteamGauge itself.
--
-- Steam's Web API only reports how many people are playing right now
-- (ISteamUserStats/GetNumberOfCurrentPlayers). It has no history, and SteamDB,
-- which has years of it, offers no API and does not allow scraping. So we
-- record our own readings from the day this migration runs: peaks and charts
-- mean "since SteamGauge started recording this game", and the UI says so.
--
-- Two tables:
--   player_counts        one row per app per 10-minute slot (the highest
--                        reading in that slot); kept 31 days, for the 48h,
--                        1w and 1m chart ranges
--   player_counts_daily  one row per app per UTC day: that day's peak and
--                        when it was seen; kept forever (small), for 3m and
--                        longer ranges and the all-time recorded peak
--
-- Written only through record_player_count(). Read through
-- player_count_stats() and player_count_series(). Same security model as the
-- rest of the schema: RLS on with no policies, no grants to anon or
-- authenticated, functions SECURITY INVOKER with an empty search_path and
-- EXECUTE for service_role only.
--
-- Safe to run more than once.
-- =============================================================================

begin;

-- Which games to sample: watched games, and games someone viewed recently.
-- Set by note_player_interest() at most once an hour per game.
alter table public.steam_apps
  add column if not exists players_viewed_at timestamptz;

create table if not exists public.player_counts (
  appid        integer     not null references public.steam_apps (appid) on delete cascade,
  observed_at  timestamptz not null,   -- start of a 10-minute UTC slot
  players      integer     not null check (players >= 0),
  primary key (appid, observed_at)
);
-- For the purge of rows older than 31 days.
create index if not exists player_counts_observed_at_idx on public.player_counts (observed_at);

create table if not exists public.player_counts_daily (
  appid    integer     not null references public.steam_apps (appid) on delete cascade,
  day      date        not null,       -- UTC calendar day
  peak     integer     not null check (peak >= 0),
  peak_at  timestamptz not null,       -- when that peak was read
  primary key (appid, day)
);

alter table public.player_counts enable row level security;
alter table public.player_counts_daily enable row level security;
revoke all on table public.player_counts from anon, authenticated;
revoke all on table public.player_counts_daily from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Write: one reading. Keeps the highest value per slot and per day. Does
-- nothing (returns false) for an app that is not in steam_apps.
-- -----------------------------------------------------------------------------
create or replace function public.record_player_count(
  p_appid   integer,
  p_players integer,
  p_at      timestamptz default now()
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_slot timestamptz;
begin
  if p_appid is null or p_players is null or p_at is null then
    raise exception 'record_player_count: arguments must not be null';
  end if;
  if p_players < 0 then
    raise exception 'record_player_count: p_players must be >= 0 (got %)', p_players;
  end if;
  if p_at > now() + interval '5 minutes' then
    raise exception 'record_player_count: p_at is in the future';
  end if;
  if not exists (select 1 from public.steam_apps a where a.appid = p_appid) then
    return false;
  end if;

  v_slot := to_timestamp(floor(extract(epoch from p_at) / 600) * 600);

  insert into public.player_counts as c (appid, observed_at, players)
  values (p_appid, v_slot, p_players)
  on conflict (appid, observed_at)
  do update set players = greatest(c.players, excluded.players);

  insert into public.player_counts_daily as d (appid, day, peak, peak_at)
  values (p_appid, (p_at at time zone 'UTC')::date, p_players, p_at)
  on conflict (appid, day)
  do update set peak = excluded.peak, peak_at = excluded.peak_at
  where excluded.peak > d.peak;

  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Marks a game as recently viewed, so the sampler keeps recording it. At most
-- one write per game per hour.
-- -----------------------------------------------------------------------------
create or replace function public.note_player_interest(p_appid integer)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.steam_apps
     set players_viewed_at = now()
   where appid = p_appid
     and (players_viewed_at is null or players_viewed_at < now() - interval '1 hour');
$$;

-- -----------------------------------------------------------------------------
-- Read: peaks for the stats banner.
--   peak_24h / peak_24h_at   highest 10-minute slot in the last 24 hours
--   peak_all / peak_all_at   highest daily peak ever recorded (latest on ties)
--   first_day                first day with a recording
-- -----------------------------------------------------------------------------
create or replace function public.player_count_stats(p_appid integer)
returns table (
  peak_24h     integer,
  peak_24h_at  timestamptz,
  peak_all     integer,
  peak_all_at  timestamptz,
  first_day    date
)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.players, r.observed_at, a.peak, a.peak_at, f.first_day
  from (select 1) one
  left join lateral (
    select c.players, c.observed_at
      from public.player_counts c
     where c.appid = p_appid and c.observed_at >= now() - interval '24 hours'
     order by c.players desc, c.observed_at desc
     limit 1
  ) r on true
  left join lateral (
    select d.peak, d.peak_at
      from public.player_counts_daily d
     where d.appid = p_appid
     order by d.peak desc, d.day desc
     limit 1
  ) a on true
  left join lateral (
    select min(d.day) as first_day from public.player_counts_daily d where d.appid = p_appid
  ) f on true;
$$;

-- -----------------------------------------------------------------------------
-- Read: the chart series. The highest reading per bucket since p_since.
-- Buckets under a day come from the 10-minute table (31 days kept); a day or
-- longer from the daily table.
-- -----------------------------------------------------------------------------
create or replace function public.player_count_series(
  p_appid          integer,
  p_since          timestamptz,
  p_bucket_seconds integer
)
returns table (t timestamptz, players integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_appid is null or p_since is null or p_bucket_seconds is null then
    raise exception 'player_count_series: arguments must not be null';
  end if;
  if p_bucket_seconds < 600 or p_bucket_seconds > 31 * 86400 then
    raise exception 'player_count_series: bucket must be 600 s to 31 days (got %)', p_bucket_seconds;
  end if;

  if p_bucket_seconds < 86400 then
    return query
      select to_timestamp(floor(extract(epoch from c.observed_at) / p_bucket_seconds) * p_bucket_seconds),
             max(c.players)::integer
        from public.player_counts c
       where c.appid = p_appid and c.observed_at >= p_since
       group by 1
       order by 1;
  else
    return query
      select to_timestamp(
               floor(extract(epoch from (d.day::timestamp at time zone 'UTC')) / p_bucket_seconds) * p_bucket_seconds
             ),
             max(d.peak)::integer
        from public.player_counts_daily d
       where d.appid = p_appid and d.day >= (p_since at time zone 'UTC')::date
       group by 1
       order by 1;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sampler: which games to read this run. Watched games first (most watchers
-- first), then games viewed in the last 14 days (most recent first).
-- -----------------------------------------------------------------------------
create or replace function public.player_sample_targets(p_limit integer)
returns table (appid integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select x.appid
    from (
      select t.appid, 0 as tier, count(*)::bigint as watchers, null::timestamptz as viewed
        from public.tracked_apps t
       group by t.appid
      union all
      select a.appid, 1, 0, a.players_viewed_at
        from public.steam_apps a
       where a.players_viewed_at >= now() - interval '14 days'
    ) x
   group by x.appid
   order by min(x.tier), max(x.watchers) desc, max(x.viewed) desc nulls last, x.appid
   limit greatest(1, least(coalesce(p_limit, 300), 1000));
$$;

-- -----------------------------------------------------------------------------
-- Housekeeping: drop 10-minute rows older than p_keep_days (daily peaks stay).
-- -----------------------------------------------------------------------------
create or replace function public.purge_player_counts(p_keep_days integer default 31)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_keep_days is null or p_keep_days < 7 then
    raise exception 'purge_player_counts: keep at least 7 days';
  end if;
  delete from public.player_counts where observed_at < now() - make_interval(days => p_keep_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- -----------------------------------------------------------------------------
-- Only the server (service_role) may call these.
-- -----------------------------------------------------------------------------
revoke execute on function public.record_player_count(integer, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.note_player_interest(integer) from public, anon, authenticated;
revoke execute on function public.player_count_stats(integer) from public, anon, authenticated;
revoke execute on function public.player_count_series(integer, timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.player_sample_targets(integer) from public, anon, authenticated;
revoke execute on function public.purge_player_counts(integer) from public, anon, authenticated;

grant execute on function public.record_player_count(integer, integer, timestamptz) to service_role;
grant execute on function public.note_player_interest(integer) to service_role;
grant execute on function public.player_count_stats(integer) to service_role;
grant execute on function public.player_count_series(integer, timestamptz, integer) to service_role;
grant execute on function public.player_sample_targets(integer) to service_role;
grant execute on function public.purge_player_counts(integer) to service_role;

commit;
