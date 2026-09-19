-- OSElectionInt — election corpus schema
--
-- Mirrors the MongoDB collections written by python/us_election so the same
-- dashboard can read from either engine (see server/src/data/contract.js).
-- Everything here is DERIVED data: the authoritative copy is the ingest's
-- output, and this schema is reloadable from it at any time by
-- scripts/mongo_to_supabase.js. Nothing in the app writes to these tables.
--
-- Column vs jsonb: anything filtered, sorted or joined on is a real column so
-- it can be indexed. Genuinely nested blobs that are only ever passed through
-- to the client (votes, home, committees, finance, ideology, spectrum) stay
-- jsonb rather than being shredded into columns nothing queries.

create extension if not exists postgis;
create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────
-- us_divisions — the geography spine.
-- Written by build_divisions.py. Read by every other table's join and by the
-- label/centroid endpoints. Actual polygons live in the PMTiles archive, NOT
-- here; this holds identity, hierarchy and a centroid to hang labels on.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_divisions (
  ocd_id      text primary key,
  level       text not null,
  name        text not null,
  state       text,
  geoid       text,
  match_key   text,
  parent_ocd  text,
  aliases     text[],
  bbox        jsonb,
  -- geography, not geometry: bbox and radius queries here are in degrees on a
  -- sphere and PostGIS's geography type does that without a projection step.
  centroid    geography(Point, 4326)
);
create index if not exists us_divisions_level_idx    on us_divisions (level);
create index if not exists us_divisions_state_idx    on us_divisions (state);
create index if not exists us_divisions_parent_idx   on us_divisions (parent_ocd);
create index if not exists us_divisions_centroid_idx on us_divisions using gist (centroid);

-- ─────────────────────────────────────────────────────────────────────────
-- us_margins — certified results, one row per (division, cycle, contest).
-- Written by ingest_openelections.py + ingest_medsl.py. This is what the
-- choropleth is painted from and the ONLY trustworthy source of vote counts.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_margins (
  id             text primary key,          -- Mongo _id: composite natural key
  ocd_id         text not null,
  level          text not null,
  office         text not null,
  year           integer not null,
  election_type  text not null,
  district       integer,
  margin         double precision,          -- signed: -DEM .. +REP; null = unpaintable
  winner_party   text,
  votes          jsonb,                     -- {DEM, REP, OTH}
  total          bigint,
  major_share    double precision,          -- share carrying a usable party label
  source         text,
  source_files   integer
);
-- The choropleth's exact filter, and the ordering `latestYear` needs.
create index if not exists us_margins_cut_idx
  on us_margins (level, office, election_type, year desc);
create index if not exists us_margins_ocd_idx  on us_margins (ocd_id);
create index if not exists us_margins_year_idx on us_margins (year desc);

-- ─────────────────────────────────────────────────────────────────────────
-- us_race_candidates — who appeared on past ballots.
-- Written by ingest_openelections.py. Read for names and faces ONLY.
--
-- Each row is keyed on the raw name string as it appeared in ONE county's
-- source file, so a single ticket is spelled many ways — Texas 2024 president
-- carries six Trump variants, one of which lands in OTH. Vote totals here are
-- therefore fragments, never a contest total. See election_top_candidates().
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_race_candidates (
  id             text primary key,
  ocd_id         text not null,
  office         text not null,
  year           integer not null,
  election_type  text not null,
  district       integer,
  name           text not null,
  party          text,
  votes          bigint,
  vote_share     double precision,
  led_in_data    boolean,
  bioguide       text,
  photo          text,
  photo_source   text
);
create index if not exists us_race_candidates_cut_idx
  on us_race_candidates (office, election_type, year, ocd_id);
create index if not exists us_race_candidates_ocd_idx on us_race_candidates (ocd_id);
create index if not exists us_race_candidates_bio_idx on us_race_candidates (bioguide)
  where bioguide is not null;
-- searchPeople does a case-insensitive substring match; trigram makes that an
-- index scan instead of a sequential one.
create index if not exists us_race_candidates_name_trgm
  on us_race_candidates using gin (name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────
-- us_candidates — forward-looking FEC filings for the current cycle.
-- Written by ingest_candidates.py / ingest_candidate_places.py.
--
-- `home` is the address on the FEC filing — usually home, sometimes a PO box
-- or a campaign office, and never verified by the FEC. `status` is the
-- incumbent/challenger/open-seat axis the detail panel is built around.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_candidates (
  id                   text primary key,    -- Mongo _id: "cycle|fec_id"
  fec_id               text not null,
  ocd_id               text not null,
  name                 text not null,
  party                text,
  party_raw            text,
  office               text,
  level                text,
  state                text,
  district             integer,
  cycle                integer not null,
  election_yr          integer,
  status               text,                -- incumbent | challenger | open seat
  ballot_status        text,                -- FILED ≠ ballot-qualified
  receipts             double precision,
  cash_on_hand         double precision,
  individual_contrib   double precision,
  pac_contrib          double precision,
  disbursements        double precision,
  debts                double precision,
  pcc                  text,                -- principal campaign committee
  coverage_end         text,
  bioguide             text,
  photo                text,
  photo_source         text,
  home                 jsonb
);
create index if not exists us_candidates_cycle_office_idx on us_candidates (cycle, office);
create index if not exists us_candidates_ocd_idx     on us_candidates (ocd_id);
create index if not exists us_candidates_fec_idx     on us_candidates (fec_id);
create index if not exists us_candidates_receipts_idx on us_candidates (receipts desc nulls last);
create index if not exists us_candidates_bio_idx     on us_candidates (bioguide)
  where bioguide is not null;
create index if not exists us_candidates_name_trgm
  on us_candidates using gin (name gin_trgm_ops);
-- candidateHomes capability + candidate-places both test for coordinates.
create index if not exists us_candidates_home_lat_idx
  on us_candidates (((home->>'lat') is not null));

-- ─────────────────────────────────────────────────────────────────────────
-- us_officeholders — who holds the seat right now.
-- Written by ingest_officeholders.py. Bioguide is the identity key: name
-- matching put the wrong Begich on the page once already.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_officeholders (
  id             text primary key,
  ocd_id         text not null,
  bioguide       text,
  name           text not null,
  party          text,
  party_raw      text,
  office         text,
  level          text,
  state          text,
  district       integer,
  senate_class   integer,
  term_start     text,
  term_end       text,
  next_election  text,
  up_next_cycle  boolean,
  url            text,
  photo          text,
  photo_source   text,
  fec_ids        text[],
  committees     jsonb,
  finance        jsonb,
  ideology       jsonb,
  updated_at     text
);
create index if not exists us_officeholders_office_idx on us_officeholders (office);
create index if not exists us_officeholders_ocd_idx    on us_officeholders (ocd_id);
create index if not exists us_officeholders_state_idx  on us_officeholders (state);
create index if not exists us_officeholders_bio_idx    on us_officeholders (bioguide)
  where bioguide is not null;
create index if not exists us_officeholders_next_idx   on us_officeholders (next_election);
create index if not exists us_officeholders_name_trgm
  on us_officeholders using gin (name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────
-- us_polling_places — where booths stood, 2012-2020, 37 states.
-- Written by ingest_polling_places.py + geocode_places.py.
--
-- HISTORICAL, not current. `geo_match` says whether a point is a rooftop hit
-- or interpolated along a street segment; roughly half are the latter.
-- Only ~217k of ~282k rows carry coordinates — the rest never geocoded.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_polling_places (
  id             text primary key,
  ocd_id         text,
  name           text,
  address        text,
  precinct_name  text,
  location_type  text,
  county_name    text,
  county_source  text,
  state          text,
  year           integer,
  election_date  text,
  geo_match      text,
  source         text,
  source_date    text,
  loc            geography(Point, 4326)
);
-- The bbox query is over 217k placed rows; without GiST this is a seq scan.
create index if not exists us_polling_places_loc_idx  on us_polling_places using gist (loc);
create index if not exists us_polling_places_year_idx on us_polling_places (year);
create index if not exists us_polling_places_ocd_idx  on us_polling_places (ocd_id);

-- ─────────────────────────────────────────────────────────────────────────
-- us_election_news — coverage matched to a division by a named person.
-- Written by the narrative-intelligence matcher. `spectrum` carries AllSides
-- bucket counts and a weighted tilt; `rated` is how many outlets had a rating
-- at all, which is why tilt must be null rather than 0 when nothing did.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_election_news (
  id             text primary key,
  event_id       text,
  ocd_id         text not null,
  person         text,
  person_kind    text,
  office         text,
  party          text,
  state          text,
  district       integer,
  title          text,
  url            text,
  image          text,
  source         text,
  total_sources  integer,
  published_at   text,
  matched_at     text,
  spectrum       jsonb
);
create index if not exists us_election_news_ocd_idx on us_election_news (ocd_id);

-- ─────────────────────────────────────────────────────────────────────────
-- us_voter_info — the link to each state's own election office.
-- Written by build_voter_info.py. Deliberately links rather than transcribes:
-- rules change and differ by county, and a stale copy can cost someone a vote.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists us_voter_info (
  state                text primary key,    -- Mongo _id: 2-letter code
  name                 text,
  election_office_url  text,
  source               text,
  source_url           text,
  http_status          text,
  is_state             boolean,
  url_corrected        boolean,
  checked_at           text
);

-- ─────────────────────────────────────────────────────────────────────────
-- Row level security.
--
-- This is a public, read-only civic dataset: certified results, published
-- filings and government links. Anyone may read it. NOBODY writes through
-- PostgREST — the only writer is scripts/mongo_to_supabase.js, which connects
-- as the service role over a direct Postgres connection and bypasses RLS.
-- So each table gets exactly one policy: select, for anon and authenticated.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'us_divisions','us_margins','us_race_candidates','us_candidates',
    'us_officeholders','us_polling_places','us_election_news','us_voter_info'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select to anon, authenticated using (true)',
      t || '_read', t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;
