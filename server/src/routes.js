const express = require("express");

const {
  getMargins,
  getTopCandidates,
  getYears,
  getDivision,
  getOfficeholders,
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
  getIssues,
  getPolling2026,
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
router.get("/polling-2026", longCache, getPolling2026);
router.get("/issues", longCache, getIssues);
router.get("/positions", longCache, getPositions);
router.get("/voter-info", longCache, getVoterInfo);
router.get("/polling-points", longCache, getPollingPoints);
router.get("/place-photo", longCache, getPlacePhoto);
router.get("/place-photo/image", getPlacePhotoImage);
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
