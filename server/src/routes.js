const express = require("express");

const {
  getMargins,
  getTopCandidates,
  getYears,
  getDivision,
  getOfficeholders,
  getRace2026,
  chat,
  getCandidate,
  searchPeople,
  getRacePoints,
  getDivisionPoints,
  getNewsPoints,
  getNewsArticles,
  getCandidatePlaces,
  getCapabilities,
  getStats,
  getVoterInfo,
  getEarlyVote,
  getIssues,
  getAdSpend,
  getAdSpendTop,
  getPacs,
  getPac,
  getPacsForCandidate,
  getAdSpendMap,
  getStanceMap,
  getStanceFilter,
  getStanceClusters,
  getPolling2026,
  getResultsTimeline,
  getResultsLive,
  getPositions,
  getPlacePhoto,
  getPollingPoints,
  getPlacePhotoImage,
} = require("./controller");
const cacheMiddleware = require("./cache");

const router = express.Router();

// Historical certified results never change, so these can cache hard. The
// cache middleware already keys by req.site.redisPrefix, so BD and US cannot
// serve each other's payloads.
const longCache = cacheMiddleware(60 * 60);

router.get("/margins", longCache, getMargins);
// The two leading finishers per geography — one call so hover has a name
// without a request per mouse move.
router.get("/top-candidates", longCache, getTopCandidates);
router.get("/years", longCache, getYears);
router.get("/capabilities", longCache, getCapabilities);
router.get("/stats", longCache, getStats);
// Issue positions: the menu, then who stands where on one of them.
// Current locations, distinct from the historical 2012-2020 layer.
// Election night. A 1-hour cache would be a lie on a count that moves every
// few minutes, so these get a short one: enough to absorb a dashboard full of
// clients, short enough that nobody reads a stale total as the live one.
const liveCache = cacheMiddleware(20);
router.get("/results-live/timeline", liveCache, getResultsTimeline);
router.get("/results-live/latest", liveCache, getResultsLive);
router.get("/results-live", liveCache, getResultsLive);
router.get("/polling-2026", longCache, getPolling2026);
// Outside spending: FEC independent expenditures for and against a
// candidate. Spending only — the FEC never reports advertising creative.
router.get("/ad-spend/top", longCache, getAdSpendTop);
// Federal committee registry joined to what each committee spent.
// for-candidate is declared BEFORE /:id or Express matches it as an id.
router.get("/pacs/for-candidate", longCache, getPacsForCandidate);
router.get("/pacs/:id", longCache, getPac);
router.get("/pacs", longCache, getPacs);
router.get("/ad-spend/map", longCache, getAdSpendMap);
router.get("/ad-spend", longCache, getAdSpend);
router.get("/issues", longCache, getIssues);
// Stance: where people sit on an issue's policy axis.
router.get("/stance/map", longCache, getStanceMap);
router.get("/stance/filter", longCache, getStanceFilter);
router.get("/stance/clusters", longCache, getStanceClusters);
router.get("/positions", longCache, getPositions);
// Ballots already cast, and the party registration of who cast them.
router.get("/early-vote", longCache, getEarlyVote);
router.get("/voter-info", longCache, getVoterInfo);
router.get("/polling-points", longCache, getPollingPoints);
router.get("/place-photo", longCache, getPlacePhoto);
router.get("/place-photo/image", getPlacePhotoImage);
// What is on the ballot this cycle, per division, in one call.
router.get("/race-2026", longCache, getRace2026);
router.get("/officeholders", longCache, getOfficeholders);
router.get("/candidate", longCache, getCandidate);
router.get("/races", longCache, getRacePoints);
router.get("/division-points", longCache, getDivisionPoints);
// Election coverage as map points, keyed by the person each story names.
router.get("/news-points", longCache, getNewsPoints);
// The stories behind the rings — image, headline, source, coverage lean.
router.get("/news-articles", longCache, getNewsArticles);
// Candidate home towns, grouped by city — real coordinates, not centroids.
router.get("/candidate-places", longCache, getCandidatePlaces);
router.get("/search", longCache, searchPeople);

// Not cached: every question is different, and the LLM call is the cost.
router.post("/chat", express.json({ limit: "8kb" }), chat);
// Query param, not a path segment — OCD ids contain slashes.
router.get("/division", longCache, getDivision);

module.exports = router;
