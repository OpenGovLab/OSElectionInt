-- OSElectionInt — RPC functions
--
-- The aggregate-shaped contract methods. PostgREST can express a filter and a
-- sort but not a two-stage group-and-slice, so these live as functions called
-- via supabase.rpc(). Each returns jsonb already shaped the way the client
-- consumes it, so the Node layer normalises nothing.
--
-- All are STABLE (they read, never write) and SECURITY INVOKER (they run as
-- the caller, so the read-only RLS policies still apply — a function must not
-- become a way around the row policies on the tables beneath it).

-- ─────────────────────────────────────────────────────────────────────────
-- election_years(level) → { office: [ {year, count}, ... ] }
-- Which cycles actually hold rows, so the UI can open on the best-covered one
-- rather than the newest. Coverage is volunteer-contributed and uneven: 2016
-- has 51 states, 2025 a single stray contest.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function election_years(
  p_level text default 'state',
  p_election_type text default 'general'
) returns jsonb
language sql stable security invoker as $$
  select coalesce(jsonb_object_agg(office, years), '{}'::jsonb)
  from (
    select office,
           jsonb_agg(jsonb_build_object('year', year, 'count', n)
                     order by year desc) as years
    from (
      select office, year, count(*)::int as n
      from us_margins
      where level = p_level and election_type = p_election_type
      group by office, year
    ) per_year
    group by office
  ) per_office;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- election_top_candidates(level, office, election_type, year)
--   → [ { ocd_id, top: [ {name, party, photo, bioguide, sitting?} ] } ]
--
-- WHO ran. NAMES AND PARTIES ONLY — no vote counts leave this function, and
-- callers must not compute a share from it.
--
-- us_race_candidates keys a row on the raw name string as it appeared in one
-- county's source file, so one ticket is spelled many ways: Texas 2024
-- president carries six Trump variants, one of which landed in OTH. Reading
-- the largest single row gives Trump 25.9% of a state he carried with 56% —
-- a figure that would sit directly beside a margin pill saying R+13.9 and
-- contradict it. Summing the variants per party gets closer but is still not
-- certified: measured against us_margins, Texas lands 5.4% low and New York
-- 57% low, because coverage is partial and party labelling leaks.
--
-- So votes are summed HERE FOR ORDERING ONLY, inside the function, and are
-- projected away before returning. The division of labour is: this answers
-- "who", us_margins answers "how many", and the client joins them on party.
-- At most one candidate per party keeps that join unambiguous.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function election_top_candidates(
  p_level text default 'state',
  p_office text default 'president',
  p_election_type text default 'general',
  p_year integer default null
) returns jsonb
language sql stable security invoker as $$
  with cut as (
    select coalesce(
      p_year,
      (select max(year) from us_race_candidates
        where office = p_office
          and election_type = p_election_type
          and ocd_id ~ case p_level
                when 'state' then '^ocd-division/country:us/state:[a-z]{2}$'
                when 'cd'    then '/cd:'
                when 'county' then '/county:'
                when 'sldu'  then '/sldu:'
                when 'sldl'  then '/sldl:'
                else '.' end)
    ) as year
  ),
  -- Collapse the spelling variants to one entry per party, keeping the
  -- best-voted spelling as the display name.
  per_party as (
    select c.ocd_id,
           c.party,
           sum(c.votes) as votes,
           (array_agg(c.name     order by c.votes desc nulls last))[1] as name,
           (array_agg(c.photo    order by c.votes desc nulls last))[1] as photo,
           (array_agg(c.bioguide order by c.votes desc nulls last))[1] as bioguide
    from us_race_candidates c, cut
    where c.office = p_office
      and c.election_type = p_election_type
      and c.year = cut.year
      and c.ocd_id ~ case p_level
            when 'state' then '^ocd-division/country:us/state:[a-z]{2}$'
            when 'cd'    then '/cd:'
            when 'county' then '/county:'
            when 'sldu'  then '/sldu:'
            when 'sldl'  then '/sldl:'
            else '.' end
    group by c.ocd_id, c.party
  ),
  -- Rank parties within a division and keep the top two.
  ranked as (
    select *, row_number() over (partition by ocd_id order by votes desc nulls last) as rn
    from per_party
  ),
  -- The same bioguide join getDivision uses, for the same reason: a name
  -- match put the wrong Begich on the page once already. A candidate with no
  -- bioguide is simply never flagged, which is right for a challenger who has
  -- never held federal office.
  sitting as (
    select distinct bioguide from us_officeholders
    where office = p_office and bioguide is not null
  )
  select coalesce(jsonb_agg(row), '[]'::jsonb) from (
    select jsonb_build_object(
      'ocd_id', r.ocd_id,
      'top', jsonb_agg(
        case when s.bioguide is not null then
          jsonb_build_object('name', r.name, 'party', r.party,
                             'photo', r.photo, 'bioguide', r.bioguide,
                             'sitting', true)
        else
          jsonb_build_object('name', r.name, 'party', r.party,
                             'photo', r.photo, 'bioguide', r.bioguide)
        end order by r.rn)
    ) as row
    from ranked r
    left join sitting s on s.bioguide = r.bioguide
    where r.rn <= 2
    group by r.ocd_id
  ) rows;
$$;

-- The year actually used, so the caller can echo it back like the Mongo path
-- does. Kept separate because the function above returns rows, not scalars.
create or replace function election_latest_year(
  p_level text default 'state',
  p_office text default 'president',
  p_election_type text default 'general',
  p_table text default 'margins'
) returns integer
language plpgsql stable security invoker as $$
declare
  v_pattern text := case p_level
      when 'state' then '^ocd-division/country:us/state:[a-z]{2}$'
      when 'cd'    then '/cd:'
      when 'county' then '/county:'
      when 'sldu'  then '/sldu:'
      when 'sldl'  then '/sldl:'
      else '.' end;
  v_year integer;
begin
  if p_table = 'candidates' then
    select max(year) into v_year from us_race_candidates
     where office = p_office and election_type = p_election_type
       and ocd_id ~ v_pattern;
  else
    select max(year) into v_year from us_margins
     where level = p_level and office = p_office
       and election_type = p_election_type;
  end if;
  return v_year;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- election_stats() → corpus size for the splash.
-- Counted live: a number baked into a splash is a claim that quietly stops
-- being true the next time an ingest runs, and nothing fails when it does.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function election_stats()
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object(
    'contests',   (select count(*) from us_margins),
    'divisions',  (select count(*) from us_divisions where level = 'county'),
    'candidates', (select count(*) from us_race_candidates),
    -- Only the rows that actually carry coordinates: the collection is
    -- populated long before the geocoder runs.
    'places',     (select count(*) from us_polling_places where loc is not null)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- election_capabilities() → which overlays this deployment can serve.
--
-- Feature detection from the DATA, not from config: a table existing but
-- empty means the overlay is not ready, and saying otherwise is a lie the
-- reader discovers by clicking.
--
-- candidateHomes and pollingPlaces test for COORDINATES rather than mere row
-- existence. Both tables populate long before the geocoder runs, and an
-- overlay offered against unplaced rows toggles on to an empty map.
-- `limit 1` inside the exists() keeps these cheap on 280k rows.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function election_capabilities()
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object(
    'races',          exists(select 1 from us_candidates      limit 1),
    'electionNews',   exists(select 1 from us_election_news   limit 1),
    'margins',        exists(select 1 from us_margins         limit 1),
    'officeholders',  exists(select 1 from us_officeholders   limit 1),
    'candidateHomes', exists(select 1 from us_candidates
                              where home->>'lat' is not null  limit 1),
    'pollingPlaces',  exists(select 1 from us_polling_places
                              where loc is not null           limit 1)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- election_polling_points(w, s, e, n, limit, year)
--
-- Historical booths inside a bbox. ST_MakeEnvelope + the GiST index turns
-- this into an index scan; without PostGIS it is a sequential scan of 217k
-- placed rows on every pan.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function election_polling_points(
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_limit integer default 800,
  p_year integer default null
) returns table (
  name text, address text, year integer, location_type text,
  county_name text, state text, geo_match text, county_source text,
  lng double precision, lat double precision
)
language sql stable security invoker as $$
  select p.name, p.address, p.year, p.location_type,
         p.county_name, p.state, p.geo_match, p.county_source,
         st_x(p.loc::geometry) as lng,
         st_y(p.loc::geometry) as lat
  from us_polling_places p
  where p.loc is not null
    and st_intersects(
          p.loc,
          st_makeenvelope(p_west, p_south, p_east, p_north, 4326)::geography)
    and (p_year is null or p.year = p_year)
  limit greatest(1, least(p_limit, 3000));
$$;

grant execute on function election_years(text, text)                      to anon, authenticated;
grant execute on function election_top_candidates(text, text, text, integer) to anon, authenticated;
grant execute on function election_latest_year(text, text, text, text)    to anon, authenticated;
grant execute on function election_stats()                                to anon, authenticated;
grant execute on function election_capabilities()                         to anon, authenticated;
grant execute on function election_polling_points(
  double precision, double precision, double precision, double precision,
  integer, integer) to anon, authenticated;
