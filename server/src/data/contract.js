/**
 * The data-access contract.
 *
 * OSElectionInt reads the same election corpus from either MongoDB or
 * Supabase (Postgres). Which one is a deployment choice, not a code change:
 * set DATA_BACKEND=mongo|supabase and nothing above this layer moves.
 *
 * The methods here are PURPOSE-BUILT, not a generic query language. That is
 * deliberate. A thin "findOne/aggregate" wrapper would only be Mongo's API
 * wearing a different name, and every aggregation pipeline would leak into
 * the Postgres implementation as something it has to emulate. Naming the
 * QUESTION instead — "which years have data for this level", "who are the
 * top two per division" — lets each backend answer it the way its engine is
 * actually good at: a pipeline on one side, a GROUP BY or an RPC on the other.
 *
 * Every method returns PLAIN JSON in the exact shape the controller already
 * sends to the client. Backends normalise to this; the controller does no
 * per-backend branching. If a backend cannot answer, it throws — callers
 * decide whether that is fatal or a degraded panel.
 *
 * ── Correctness note that outlives either backend ─────────────────────────
 * topCandidates() returns NAMES AND PARTIES ONLY, at most one per party, and
 * must never return vote counts. us_race_candidates keys each row on the raw
 * name string as it appeared in one county's source file, so a single ticket
 * is spelled many ways — Texas 2024 president carries six Trump variants, one
 * of which lands in OTH. Reading the largest single row gives Trump 25.9% of
 * a state he carried with 56%. Vote numbers come from margins(); this answers
 * "who", margins() answers "how many", and the client joins them on party.
 * A Postgres implementation that "helpfully" sums votes here reintroduces a
 * bug we have already paid for.
 */

/**
 * @typedef {Object} ElectionRepo
 *
 * @property {(a: {level:string, office:string, electionType:string}) =>
 *   Promise<number|null>} latestYear
 *   Most recent cycle that actually holds rows for this cut. Null when none —
 *   coverage is volunteer-contributed and uneven, so "latest" is a query, not
 *   a constant.
 *
 * @property {(a: {level:string, office:string, electionType:string,
 *   year:number, minMajorShare:number}) => Promise<Array<{
 *     ocd_id:string, margin:number|null, winner_party:string,
 *     votes:Object, total:number, major_share:number }>>} margins
 *   The choropleth. minMajorShare drops contests whose party labelling is too
 *   thin to paint honestly; such rows are omitted, never painted grey.
 *
 * @property {(a: {level:string}) =>
 *   Promise<Record<string, Array<{year:number, count:number}>>>} years
 *   Cycles per office for the timeline, with row counts so the UI can open on
 *   the best-covered cycle rather than the newest.
 *
 * @property {(a: {level:string, office:string, electionType:string,
 *   year:number}) => Promise<Array<{ ocd_id:string, top:Array<{
 *     name:string, party:string, photo:string|null,
 *     bioguide:string|null }> }>>} topCandidates
 *   At most one candidate PER PARTY. No vote counts — see the note above.
 *
 * @property {(ocdId:string, limit:number) => Promise<{
 *   division:Object|null, history:Array, holders:Array,
 *   candidates:Array, pastCandidates:Array }>} division
 *
 * @property {(a: {level:string}) => Promise<Object>} divisionPoints
 *   GeoJSON FeatureCollection of label centroids.
 *
 * @property {(a: {office:string}) => Promise<Array>} officeholders
 *
 * @property {(fecId:string) => Promise<{ candidate:Object|null,
 *   record:Object|null, opponents:Array }>} candidateByFec
 *
 * @property {(q:string, limit:number) => Promise<Array>} searchPeople
 *
 * @property {(a: {cycle:number}) => Promise<Object>} racePoints
 * @property {(a: {cycle:number}) => Promise<Object>} candidatePlaces
 * @property {(a: {limit:number}) => Promise<Object>} newsPoints
 *
 * @property {(a: {ocdId?:string, limit:number}) => Promise<Array<{
 *   ocd_id:string, name:string|null, state:string|null, title:string,
 *   url:string, image:string|null, source:string|null,
 *   published_at:string|null, person:string|null, party:string|null,
 *   office:string|null, tilt:number|null, left:number, center:number,
 *   right:number, total_sources:number|null }>>} newsArticles
 *   Individual stories for the card rail, newest first. Order by `matched_at`
 *   — `published_at` is the relative string the source rendered ("2 hours
 *   ago"), kept for display and useless for sorting.
 *
 * @property {(a: {bbox:number[], limit:number}) => Promise<Object>} pollingPoints
 *   bbox is [west, south, east, north]. Mongo answers with 2dsphere, Postgres
 *   with PostGIS; both return the same FeatureCollection.
 *
 * @property {(state:string) => Promise<Object|null>} voterInfo
 *
 * @property {(a: {category:string, office?:string, role?:string,
 *   minN:number}) => Promise<Array<Object>>} stanceMap
 *   One row per person for a stance map layer. Anyone without a centroid is
 *   omitted rather than emitted at 0,0.
 *
 * @property {(a: {category:string, min?:number, max?:number, label?:string,
 *   party?:string, state?:string, office?:string, role?:string,
 *   minN:number, limit:number}) => Promise<Array<Object>>} stanceFilter
 *   Everyone whose position on one issue falls in a band, with the quotes
 *   that produced it. Filtered and sorted on MEDIAN, never mean — a single
 *   misread quote moves a mean and barely moves a median.
 *
 * @property {(a: {category:string, minN:number}) =>
 *   Promise<Array<Object>>} stanceClusters
 *   Per-state aggregate carrying the split either side of zero as well as a
 *   central value: an evenly divided delegation and a uniformly moderate one
 *   share a median and are not the same fact.
 *
 * @property {() => Promise<Map<string, Object>>} stanceCoverage
 *   People with a CLASSIFIED stance per category, which is a smaller set than
 *   people with quotes — the UI must know an issue is filterable before it
 *   offers a filter.
 *
 * @property {() => Promise<{ races:boolean, electionNews:boolean,
 *   margins:boolean, officeholders:boolean, candidateHomes:boolean,
 *   pollingPlaces:boolean }>} capabilities
 *   Feature detection, not configuration. candidateHomes and pollingPlaces
 *   must count rows that carry COORDINATES, not merely rows: both collections
 *   are populated long before the geocoder runs, and an overlay offered
 *   against unplaced rows toggles on to an empty map.
 *
 * @property {() => Promise<{ contests:number, divisions:number,
 *   candidates:number, places:number }>} stats
 *
 * @property {() => Promise<void>} [close]
 */

/** Collections/tables, named once so both backends agree on spelling. */
const TABLES = {
  divisions: "us_divisions",
  margins: "us_margins",
  raceCandidates: "us_race_candidates",
  candidates: "us_candidates",
  officeholders: "us_officeholders",
  pollingPlaces: "us_polling_places",
  news: "us_election_news",
  voterInfo: "us_voter_info",
  raceRoster: "us_race_roster",
  polling2026: "us_polling_2026",
  issuePositions: "us_issue_positions",
};

/**
 * Stance axes live in scripts/data/issue_axes.json and are read at runtime,
 * not copied here. Choosing what the poles of an issue ARE is an editorial
 * argument rather than a measurement, so it belongs in one reviewable file;
 * a second copy in server code would drift from it silently and the UI would
 * start labelling people against poles nobody agreed to.
 */
const AXES_PATH = require("path")
  .join(__dirname, "..", "..", "..", "scripts", "data", "issue_axes.json");

let axesCache = null;
function loadAxes() {
  if (axesCache) return axesCache;
  try {
    // eslint-disable-next-line global-require
    axesCache = require(AXES_PATH).axes ?? {};
  } catch {
    // A missing axis file must degrade the stance endpoints, never take the
    // whole API down: everything else here is unrelated to it.
    axesCache = {};
  }
  return axesCache;
}

const LEVELS = ["state", "county", "cd", "sldu", "sldl"];
const OFFICES = ["president", "us_senate", "us_house", "governor"];

/**
 * us_race_candidates carries no `level` column — the level is implicit in the
 * shape of the OCD id, so a level filter is expressed as one. Mongo uses these
 * as $regex; Postgres as `~` / LIKE. Only state and cd shapes are populated.
 */
const LEVEL_OCD_PATTERN = {
  state: "^ocd-division/country:us/state:[a-z]{2}$",
  cd: "/cd:",
  county: "/county:",
  sldu: "/sldu:",
  sldl: "/sldl:",
};

module.exports = {
  TABLES, LEVELS, OFFICES, LEVEL_OCD_PATTERN, loadAxes, AXES_PATH,
};
