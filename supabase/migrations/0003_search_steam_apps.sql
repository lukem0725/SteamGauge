-- =============================================================================
-- SteamGauge migration 0003: typo-tolerant game search over steam_apps
-- (run once in the Supabase SQL Editor, after 0001 and 0002)
-- =============================================================================
-- Global search asks Steam's store search first. This function adds forgiving
-- matches from SteamGauge's own catalog (steam_apps), using pg_trgm word
-- similarity, so "witchr 3" still finds "The Witcher 3: Wild Hunt" once that
-- game is in the catalog. Every search result is added to the catalog, so it
-- grows with use.
--
-- It uses the existing GIN trigram index steam_apps_name_trgm (migration 0001):
-- the <% operator is index-assisted. Words shorter than 3 characters have no
-- trigrams, so the function returns nothing for them.
--
-- Same security model as 0001/0002: SECURITY INVOKER, empty search_path, and
-- EXECUTE only for service_role (the backend's secret key).
--
-- Safe to re-run: CREATE OR REPLACE and idempotent grants.
-- =============================================================================

begin;

create or replace function public.search_steam_apps(p_query text, p_limit integer default 10)
returns table (appid integer, name text, header_image text, score real)
language sql
stable
security invoker
set search_path = ''
-- Lower than the default 0.6 so one or two wrong letters still match.
set pg_trgm.word_similarity_threshold = 0.45
as $$
  select a.appid,
         a.name,
         a.header_image,
         extensions.word_similarity(p_query, a.name) as score
    from public.steam_apps as a
   where char_length(btrim(coalesce(p_query, ''))) between 3 and 64
     and p_query operator(extensions.<%) a.name
   order by score desc, char_length(a.name), a.name
   limit least(greatest(coalesce(p_limit, 10), 1), 25);
$$;

revoke all on function public.search_steam_apps(text, integer) from public, anon, authenticated;
grant execute on function public.search_steam_apps(text, integer) to service_role;

commit;
