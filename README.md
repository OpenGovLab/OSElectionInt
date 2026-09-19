<div align="center">

# OSElectionInt

**An explore-first map of American elections — certified results, live filings, and the people running.**

### Built on [**OpenElections**](https://github.com/openelections) — the primary data source

*All 135 OpenElections repositories, mirrored and synced 6-hourly, as the certified-results spine.*

[**▶ Live demo**](https://app.perspectivity.co/hackathon/election/) · [**Demo video**](https://www.loom.com/share/6bd563ab9ac54b7a86fc7d82ba513f97) · [Quick start](#quick-start) · [Architecture](#architecture)

`146,355` contests · `39,396` candidates · `216,822` polling places · `3,235` counties · `38 cycles, 1976–2026`

<br/>

<img src="docs/screenshots/03-texas-senate.png" alt="OSElectionInt — the 2026 Texas Senate race, challengers ranked by money raised" width="100%">

<sub><i>The 2026 Texas Senate race. Challengers lead the panel; the two sitting senators are demoted below them.</i></sub>

</div>

---

## Write-up

**The problem.** American election data is public and almost unusable. Certified results sit in 135
separate OpenElections repositories in a dozen CSV dialects. Candidate filings sit at the FEC.
District boundaries sit at the Census. Who currently holds a seat sits somewhere else again. Nothing
shares a key. So the question a voter actually asks — *who represents me, who is running against
them, and where is their money coming from* — takes a researcher a day and a spreadsheet. The
practical result is that presidential races are over-covered and everything below them is dark.

**Who it helps.** Voters trying to understand a down-ballot race. Local journalists without a data
desk. Civic researchers who currently rebuild this join from scratch every cycle. Challengers in
races nobody is covering, who are invisible precisely because no tool indexes them.

**The solution.** One map, one join key. Every source is normalised onto OCD division IDs, geometry
ships as a single 50.8 MB PMTiles archive read over range requests, and results are pushed into the
map as feature state — so half a century of margins scrubs at 60fps instead of being 38 network
round trips. The panel deliberately inverts the usual hierarchy: challengers lead, ranked by money raised,
and the incumbent is demoted to context. Storage is a deployment choice — MongoDB or Supabase behind
one shared contract.

**Impact.** 146,355 contests, 39,396 candidates and 216,822 historical polling places become one
surface you can pan. A state legislator out-raising two sitting senators 7:1 stops being a filing
buried in FEC bulk data and becomes the first thing you see.

*(273 words)*

---

## What it does

- **Explore-first map.** Pan the globe or the flat map; the panel lists what is in view. Zoom drives
  the level of detail — states, congressional districts, counties.
- **38 cycles, 1976–2026.** Scrub the timeline and watch margins swing. Cuts are cached client-side,
  so playback runs from memory rather than one network round trip per cycle.
- **Challenger-forward.** Most election tools open on the incumbent. This one opens on the people
  trying to take the seat, ranked by money raised, with the sitting member demoted to context.
  In the 2026 Texas Senate race that reads: challengers **$99.6M** to sitting members **$18.8M**.
- **Head-to-head results.** The last contest as a versus card — two portraits, an animated
  tug-of-war bar, raw votes, certified margin.
- **Ask it anything.** A grounded Q&A panel answers in natural language straight from the corpus and
  cites the rows it used. It inherits the same honesty rules as the UI — ask who is running in Texas
  and it names the leading filers by money raised, then tells you unprompted that filing with the FEC
  is not the same as being on the ballot.
- **⌘K command bar, by text or voice.** *"fly to Texas"*, *"show senate"*, *"2016"*, *"play timeline"*,
  *"satellite"*. Deliberately **not** an LLM: a fixed grammar parses it, every command prints a receipt
  saying what actually happened, and anything it does not recognise is declined rather than guessed —
  a navigation control acting on a half-understood instruction is worse than one that says no. Speech
  drops its transcript into the input for you to read and submit, never auto-fires.
- **216,822 historical polling places**, geocoded and placed, with an aerial thumbnail of the building.
- **Voter information** — state election office links for all 50 states.
- **Two interchangeable databases.** MongoDB or Supabase/Postgres, selected by one env var.

---

## Screens

<table>
<tr>
<td width="50%">

<img src="docs/screenshots/01-splash.png" alt="Boot screen — 2024 results filling east to west on a tile cartogram" width="100%">

**Boot screen.** Real 2024 margins fill a tile cartogram **east to west** — the order returns actually arrive in as poll closings cross the time zones. Colours come from the same ramp the map paints with, so the splash can never drift from the dashboard behind it.

</td>
<td width="50%">

<img src="docs/screenshots/02-globe-hover.png" alt="Globe projection with a hover readout over Texas" width="100%">

**Globe + hover.** Hovering any division reads out certified turnout, major-party share, the top two finishers and who currently holds the seat — Cruz 53.1% / Allred 44.6%, with both sitting senators and their next election.

</td>
</tr>
</table>

---

## Quick start

```bash
git clone git@github.com:OpenGovLab/OSElectionInt.git
cd OSElectionInt

# 1 — server
cd server
npm install
cp .env.example .env          # then fill MONGODB_URL (see below)
node src/index.js             # :3050

# 2 — web (second terminal)
cd web
npm install
npm run dev                   # :3051, proxies /api and /tiles to :3050
```

Open **http://localhost:3051**.

**Production build** — `BASE_PATH` is baked in at build time so the app can be served from a sub-path:

```bash
cd web && BASE_PATH=/ npm run build      # server then serves web/dist at :3050
```

### Using Supabase instead of MongoDB

```bash
supabase start                                   # local stack, :54321 / :54322
supabase db reset                                # applies both migrations
export SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
node scripts/mongo_to_supabase.js --limit 5000   # ETL a slice; omit --limit for all

cd server && DATA_BACKEND=supabase node src/index.js
```

Every endpoint returns the same JSON on either backend — enforced by a shared contract
(`server/src/data/contract.js`) both implementations are written against, and verified rather than
asserted:

| Check | Result |
|---|---|
| Full ETL, Mongo → Postgres | **482,838 rows across 8 tables in 60s**, every table matching Mongo exactly |
| Database size once loaded | **245 MB** (`us_polling_places` 127 MB, `us_margins` 66 MB) — fits Supabase's 500 MB free tier |
| Endpoints diffed across backends | **22 checked · 18 identical** |
| Remaining 4 | Benign and understood — see [Known limitations](#known-limitations) |

> **If `supabase start` hangs for you**, it is the Logflare analytics container: it needs a
> Stripe-seeded billing plan and never reports healthy. Nothing here reads it — set
> `[analytics] enabled = false` in `supabase/config.toml` and the stack comes up.

---

## Environment variables

`server/.env` — a template lives at [`server/.env.example`](server/.env.example).

| Variable | Required | What it is |
|---|:--:|---|
| `MONGODB_URL` | ✅ † | The `google_news_database_en_usa` corpus |
| `PORT` | | Defaults to `3050` |
| `TILES_ORIGIN` | | Origin serving the 50.8 MB PMTiles archive. Proxied, never copied |
| `DATA_BACKEND` | | `mongo` (default) or `supabase` |
| `SUPABASE_URL` | ‡ | Project URL |
| `SUPABASE_SERVICE_KEY` | ‡ | Service role key (or `SUPABASE_ANON_KEY` for read-only) |
| `SUPABASE_DB_URL` | ‡ | Postgres connection string — used by the ETL only |
| `CLAWPY_URL` / `CLAWPY_MODEL` | | Grounded Q&A panel. Without them the panel says it is unavailable |
| `GOOGLE_CIVIC_API_KEY` | | Address-level polling places via `voterInfoQuery` |

† required when `DATA_BACKEND=mongo`  ‡ required when `DATA_BACKEND=supabase`

**No key is required to run the map.** Basemaps (OpenFreeMap), imagery (Esri) and the tile archive are
all keyless. The optional keys add the Q&A panel and address-level lookup.

---

## Architecture

```mermaid
flowchart LR
    subgraph SRC["Sources — all public"]
        direction TB
        OE["<b>OpenElections</b><br/>135 repos · 79 GB<br/><i>PRIMARY SOURCE</i>"]
        MEDSL["MIT Election Lab<br/>MEDSL"]
        FEC["FEC bulk data"]
        TIGER["US Census TIGER"]
        MISC["Wikidata · usa.gov<br/>congress-legislators"]
    end

    subgraph ING["Ingest — python/us_election"]
        direction TB
        ETL["ingest_openelections<br/>ingest_medsl<br/>ingest_polling_places<br/>link_portraits<br/>geocode_places<br/>build_voter_info"]
        TILE["ogr2ogr → mapshaper<br/>→ tippecanoe"]
    end

    subgraph STORE["Store — selected by DATA_BACKEND"]
        direction TB
        MONGO[("MongoDB<br/>us_margins · us_divisions<br/>us_candidates · us_officeholders")]
        SUPA[("Supabase / Postgres 17<br/>PostGIS · pg_trgm<br/>RPCs · RLS")]
    end

    PM["<b>us-divisions.pmtiles</b><br/>50.8 MB · one archive<br/>HTTP range requests"]

    REPO["<b>Express :3050</b><br/>ElectionRepo contract<br/><i>one interface, two backends</i>"]

    CLIENT["<b>React 18 + MapLibre GL 5</b><br/>globe / mercator · PMTiles<br/>feature-state choropleth"]

    OE --> ETL
    MEDSL --> ETL
    FEC --> ETL
    MISC --> ETL
    TIGER --> TILE

    ETL --> MONGO
    ETL --> SUPA
    MONGO -. "DATA_BACKEND=mongo" .-> REPO
    SUPA -. "DATA_BACKEND=supabase" .-> REPO

    REPO -->|"JSON — identical either way"| CLIENT
    TILE --> PM
    PM -->|"geometry, never via the DB"| CLIENT

    style OE fill:#1e40af,stroke:#93c5fd,color:#fff
    style PM fill:#0f766e,stroke:#5eead4,color:#fff
    style REPO fill:#7c2d12,stroke:#fdba74,color:#fff
    style CLIENT fill:#4c1d95,stroke:#c4b5fd,color:#fff
```

**The join key is the OCD division ID** (`ocd-division/country:us/state:tx/cd:37`). OpenElections
already emits it, Census GEOIDs map onto it deterministically, and it is promoted to the tile feature
id — so results arrive as MapLibre *feature state* rather than being baked into a giant match
expression. That one decision is what lets the timeline scrub at 60fps.

**Geometry never enters the database.** It lives in a single 50.8 MB PMTiles archive read over HTTP
range requests. No tile server.

### Stack

| Layer | Choice |
|---|---|
| Map | MapLibre GL 5.24 (globe + mercator), PMTiles 4.5 |
| Web | React 18.3, TypeScript 5.7, Vite 6, Tailwind 3.4 |
| Server | Node, Express 4.21 |
| Data | MongoDB (Mongoose 8.9) **or** Supabase/Postgres 17 (supabase-js 2.109, pg 8.23, PostGIS, pg_trgm) |
| Ingest | Python — pandas, pymongo, tippecanoe, ogr2ogr, mapshaper |

---

## Datasets & provenance

**OpenElections is the primary data source.** Every certified vote total the map paints comes from
it — all 135 of its state repositories, mirrored locally at 79 GB and re-synced every six hours.
Everything else in this table exists to make those results legible: geometry to draw them on,
candidate filings to say who is running next, portraits to put faces to names.

Every figure on screen traces to a public source. **No synthetic or generated data is used anywhere.**

| Dataset | Source | Licence | Use |
|---|---|---|---|
| **Certified results — PRIMARY SOURCE** | [**OpenElections**](https://github.com/openelections) — all 135 state repos, 79 GB mirror, synced 6-hourly | Public domain / CC | Every vote total the map paints |
| Results cross-check | [MIT Election Data & Science Lab](https://electionlab.mit.edu/) via Harvard Dataverse | CC0 | Second source; gap-fill |
| Candidate filings & finance | [FEC bulk data](https://www.fec.gov/data/browse-data/) | Public domain | 2026 field, money raised |
| District & county boundaries | [US Census TIGER/cartographic 2023](https://www.census.gov/geographies/mapping-files.html) | Public domain | PMTiles archive |
| Sitting members | [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) | CC0 | Incumbents, committees, bioguide portraits |
| Historical polling places | [PublicI/us-polling-places](https://github.com/PublicI/us-polling-places) | MIT | 2012–2020, 37 states |
| Geocoding | [US Census batch geocoder](https://geocoding.geo.census.gov/) | Public domain | Placing polling places |
| Candidate portraits | [Wikidata](https://www.wikidata.org/) P18 | CC0 / per-file | Non-Congress candidates |
| Voter information | [usa.gov](https://www.usa.gov/election-office) state directory | Public domain | Election office links |
| Basemaps | [OpenFreeMap](https://openfreemap.org/) (vector), [Esri World Imagery](https://www.arcgis.com/) (raster) | ODbL / Esri ToU | Map + aerial thumbnails |

### Two honesty rules baked into the code

1. **Contests whose party labelling is too thin to read are left unpainted**, not painted grey.
   A `major_share` floor drops them. An unreliable margin shown confidently is worse than a gap.

2. **Names and numbers come from different tables, on purpose.** `us_race_candidates` keys each row
   on the raw name string as spelled in one county's source file, so a single ticket appears many
   ways — Texas 2024 president carries **six** Trump spellings, one of which landed in the
   third-party bucket. Reading the largest single row gives Trump **25.9%** of a state he carried
   with **56%**. So candidate tables answer *who*; the certified `us_margins` rows answer *how many*;
   the client joins them on party. Verified: Texas now reads 56.1 / 42.5, reconciling with the
   R+13.88 margin pill beside it.

---

## Known limitations

Measured, not guessed.

**Coverage**
- **No county-level candidate rows exist at all** (25,160 congressional-district + 14,236 statewide,
  nothing else), so the candidate section is omitted on county cuts.
- Only **20 of 51 states** have presidential candidate rows for 2024. Margins cover all 51.
- OpenElections is volunteer-contributed and uneven: 2016 has 51 states, 2025 has a single stray
  contest. The app therefore opens on the *best-covered* cycle, not the newest.
- Only **671 of 4,294** 2026 filers have a portrait — the free source is the Congressional bioguide,
  which by definition only covers people already in federal office. Exactly backwards for
  challengers. `scripts/backfill_portraits.py` closes this from Wikidata but has not been run at scale.

**Geometry**
- The tile archive writes `state` features only to z6. MapLibre does not overzoom past that (the
  higher tiles exist and simply carry no state layer), so state level is camera-clamped to its band.
- `sldl` / `sldu` have geometry but **no certified results** — state-legislative results are not in
  the corpus yet.

**Caveats that are shown, not hidden**
- Polling places are where booths stood **2012–2020**, not current voting locations. Half are
  interpolated along a street rather than matched to a rooftop; the tooltip says which.
- An FEC filing means *registered or past a spending threshold*, **not** ballot-qualified.
- Money raised is money raised. It is not a poll, and the bars are captioned so nobody reads it as one.

**Cross-backend differences** (4 of 22 endpoints; neither engine defines these)
- Float summation order — one dollar of difference in a $7.6M total.
- `null` vs absent inside an embedded JSON string.
- Set ordering in a names list.
- **A bbox `LIMIT` with no `ORDER BY` picks a different 50 polling places per backend.** Both answers
  are valid; the query simply does not define which 50. Worth knowing before anyone treats a booth
  list as stable.

**Engineering**
- The client bundle is ~1.37 MB (386 KB gzipped) and not yet code-split.
- Headless verification of the map is limited — WebGL under SwiftShader does not finish loading in
  CI budget, so map rendering is verified manually.

## Next steps

1. Run the Wikidata portrait backfill at scale — every challenger should have a face.
2. Ingest state-legislative results so `sldl`/`sldu` stop being empty geometry.
3. Per-race narrative intelligence: coverage counts and L/C/R tilt per contest, tiered so a race with
   two articles never gets an invented analysis.
4. Give the OCD ↔ GEOID crosswalk and cycle-versioned boundaries back to OpenElections — it does not
   exist anywhere public, and almost every naive election map gets redistricting wrong.
5. Code-split the bundle; add a service worker for the tile archive.

---

## Repository layout

```
server/          Express API
  src/data/        contract.js   ← the interface both backends implement
                   mongo.js      ← MongoDB
                   supabase.js   ← Supabase/Postgres
                   index.js      ← DATA_BACKEND selector
  src/controller.js
web/             React + MapLibre client
  src/pages/USElectionPage.tsx      the map
  src/components/SplashScreen.tsx   east-to-west results cartogram
  src/components/us-election/       detail panels
supabase/migrations/                schema, PostGIS, RLS, RPCs
scripts/                            ETL + portrait backfill
```

---

## Demo video

**▶ [Watch the demo on Loom](https://www.loom.com/share/6bd563ab9ac54b7a86fc7d82ba513f97)**

<a href="https://www.loom.com/share/6bd563ab9ac54b7a86fc7d82ba513f97">
  <img src="docs/screenshots/03-texas-senate.png" alt="Watch the OSElectionInt demo on Loom" width="100%">
</a>

The core loop, live: boot cartogram → globe → hover a state for certified turnout and the top two
finishers → the 2026 Texas Senate race with challengers ranked by money raised → timeline scrub
across 38 cycles → historical polling places.

## Team

**Solo build.**

| Name | Role | Contact |
|---|---|---|
| **Abdullah Khan Zehady** | Everything — data pipeline, backend, frontend, design | [support@perspectivity.co](mailto:support@perspectivity.co) · [OpenGovLab](https://github.com/OpenGovLab) |

One person across the whole stack: the Python ingest that normalises 135 OpenElections
repositories onto OCD division IDs, the PMTiles build, the dual-backend API, the MapLibre client,
and the visual design.

---

<div align="center">

**[app.perspectivity.co/hackathon/election](https://app.perspectivity.co/hackathon/election/)**

Built on public data. OpenElections · MIT Election Lab · FEC · US Census · Wikidata

</div>
