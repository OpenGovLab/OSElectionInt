# ElectionIntOS

The US election dashboard from Perspectivity, running on its own.

One process on **:3050** serves both halves — the API under `/api/us-election`
and the built web app with an SPA fallback. The parent deployment splits these
across two containers behind nginx; here a single port is the point, so the
dashboard can be run without standing up the rest of the platform.

## Run it

```sh
cd server && npm install && cp .env.example .env   # fill in MONGODB_URL
cd ../web  && npm install && npm run build
cd ../server && npm start                          # http://localhost:3050
```

For frontend work, `cd web && npm run dev` serves on **:3051** and proxies
`/api` and `/tiles` to :3050, so the app talks to the same origin in
development as it does in production.

## What it needs

| | |
|---|---|
| **MongoDB** | the `google_news_database_en_usa` collections written by `python/us_election/` — `us_margins`, `us_divisions`, `us_candidates`, `us_officeholders`, `us_election_news`, `us_polling_places`, `us_place_geo`, `us_voter_info` |
| **PMTiles** | the 53 MB `us-divisions` archive, **proxied** from `TILES_ORIGIN`, never copied — it is content-hashed and duplicating it means two copies drifting apart at the next tile build |
| **Basemaps** | OpenFreeMap and Esri World Imagery, both keyless |
| `CLAWPY_URL` | optional — the grounded Q&A panel; without it the panel says so |
| `GOOGLE_CIVIC_API_KEY` | optional — address-level polling places |

Nothing here writes to the database. The ingest pipeline stays in the parent
repo, and this reads what it produces.

## How it relates to the parent

`server/src/controller.js`, `server/src/routes.js`, `web/src/pages/`,
`web/src/components/us-election/` and `web/src/config/` are **copied verbatim**
from `Drishtikon.life`. Only import paths were rewritten. That is deliberate:
the two can be diffed, and a fix in either can be carried across. Three things
are adapted rather than copied, each because the parent's version carries a
dependency this app has no reason to take on:

- **`server/src/db.js`** — the parent is multi-tenant and picks a connection
  per request from an `X-Site` header. This serves one tenant, so the
  `getModelForLanguage` signature is kept and its arguments ignored, which
  leaves the controller diffable.
- **`server/src/cache.js`** — a Map instead of Redis. One process, so Redis
  would be a second service to run before the dashboard starts.
- **`web/src/lib/api.ts` and `web/src/lib/theme.ts`** — the parent's axios
  client resolves a tenant from the hostname and its theme comes from a Redux
  store. Both are reduced to the same call shape without the machinery.

`web/tsconfig.json` mirrors the parent's `tsconfig.app.json` on purpose,
including its looser strictness. Compiling copied files under stricter settings
would mean editing them, and every edit is a place the two silently diverge.

## Known limits

Inherited from the data, not the app — all of it documented in the parent's
`python/us_election/`:

- Polling places are **historical, 2012–2020, 37 states**. Where booths stood,
  never where to vote. ~64k of 281k have addresses the Census geocoder could
  not resolve and are not drawn.
- House districts are loaded for **2022 and 2024 only**. Earlier cycles ran on
  boundaries the 2023 Census geometry does not draw.
- Voter information is **links to state election offices**, not rules. ID
  requirements and deadlines change and vary by county; the office that decides
  them is what gets surfaced.
