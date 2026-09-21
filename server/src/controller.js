const repo = require("./data");

/**
 * US election map data.
 *
 * Reads the collections built by python/us_election/: `us_divisions` (identity
 * and hierarchy — geometry lives in the PMTiles archive, never here) and
 * `us_margins` (party totals and a signed margin per geography per contest).
 *
 * Every query routes through the repo layer (src/data), so the storage engine
 * is a deployment choice — DATA_BACKEND=mongo|supabase — and nothing in this
 * file knows what a collection is. What stays here is HTTP: parsing and
 * validating parameters, choosing status codes, and shaping the envelope.
 */

// Margin is signed: negative = Democratic, positive = Republican.
const OFFICES = ["president", "us_senate", "us_house", "governor"];
const LEVELS = ["state", "cd", "county", "sldu", "sldl"];

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/**
 * GET /api/us-election/margins
 * The paint layer. One row per geography for a single contest type + year.
 *
 * `min_major_share` refuses to return contests whose party labelling is too
 * thin to trust — roughly 11% of corpus rows carry no party at all, and a
 * margin computed from a badly-labelled contest is worse than a blank one.
 */
exports.getMargins = async (req, res) => {
  try {
    const { level = "state", office = "president", election_type = "general" } = req.query;
    if (!LEVELS.includes(level)) {
      return res.status(400).json({ success: false, message: `level must be one of ${LEVELS}` });
    }
    if (!OFFICES.includes(office)) {
      return res.status(400).json({ success: false, message: `office must be one of ${OFFICES}` });
    }
    const minShare = req.query.min_major_share !== undefined
      ? Number(req.query.min_major_share) : 0.8;

    let year = parseInt(req.query.year, 10);
    if (!Number.isFinite(year)) {
      // default to the most recent year that actually has data for this cut
      year = await repo.latestYear({ level, office, electionType: election_type });
      if (year === null) return res.json({ success: true, data: { year: null, rows: [] } });
    }

    const rows = await repo.margins({
      level, office, electionType: election_type, year, minMajorShare: minShare,
    });

    res.json({ success: true, data: { year, level, office, election_type, count: rows.length, rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/top-candidates
 *
 * WHO ran, for every geography in one contest type + year. The map needs a
 * name to put on a hover, and the per-division endpoint cannot serve that —
 * it would be a round trip per mouse move.
 *
 * This returns NAMES AND PARTIES ONLY, deliberately. It does not return vote
 * counts or shares, and callers must not compute them from this collection.
 *
 * The reason is that `us_race_candidates` keys a row on the raw name string
 * as it appeared in each county's source file, and the same ticket is spelled
 * many ways. Texas 2024 president has 59 rows, six of which are Trump:
 * "Donald J. Trump", "Donald J. Trump/jd Vance", "Donald J. Trump / Jd Vance",
 * "Donald J. Trump Jd Vance", "Donald J Trump", and one that landed in OTH as
 * "Donald J. Trump/jd Vance Rep". Reading the largest single row gives Trump
 * 25.87% of a state he carried with 56% — a figure that would sit directly
 * beside a margin pill saying R+13.9 and contradict it.
 *
 * Summing the variants per party gets closer but is still not certified:
 * measured against us_margins, Texas lands 5.4% low and New York 57% low,
 * because coverage of this collection is partial and party labelling leaks.
 *
 * So the division of labour is: this endpoint answers "who", and `us_margins`
 * — the same rows the choropleth is painted from — answers "how many". The
 * client pairs them on `party`, which is why at most one candidate per party
 * is returned: it keeps that join unambiguous. A share shown next to a margin
 * can then never disagree with it, because both came from the same record.
 *
 * `us_race_candidates` carries no `level` field — the level is implicit in
 * the shape of the OCD id, so the repo expresses a level filter as one. Only
 * two shapes are actually populated: bare state ids and `/cd:` ids. There are
 * no county-level candidate rows at all (checked: 25,160 cd + 14,236 state,
 * nothing else), which is why a county cut legitimately returns an empty list
 * rather than an error — the client omits the section.
 */
exports.getTopCandidates = async (req, res) => {
  try {
    const { level = "state", office = "president", election_type = "general" } = req.query;
    if (!LEVELS.includes(level)) {
      return res.status(400).json({ success: false, message: `level must be one of ${LEVELS}` });
    }
    if (!OFFICES.includes(office)) {
      return res.status(400).json({ success: false, message: `office must be one of ${OFFICES}` });
    }

    let year = parseInt(req.query.year, 10);
    if (!Number.isFinite(year)) {
      year = await repo.latestCandidateYear({
        level, office, electionType: election_type,
      });
      if (year === null) {
        return res.json({ success: true, data: { year: null, level, office, election_type, count: 0, rows: [] } });
      }
    }

    const rows = await repo.topCandidates({
      level, office, electionType: election_type, year,
    });

    res.json({ success: true, data: { year, level, office, election_type, count: rows.length, rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/years
 * Which (year, office) combinations actually have data — drives the UI's year
 * picker so it can only offer cuts that will render.
 */
exports.getYears = async (req, res) => {
  try {
    const { level = "state", election_type = "general" } = req.query;
    const byOffice = await repo.years({ level, electionType: election_type });
    res.json({ success: true, data: byOffice });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/officeholders
 *
 * Who currently holds each seat, and when it is next on the ballot. This is
 * what keeps the map meaningful between certified results — margins only know
 * the past, and for the House that is two years at a time.
 *
 * `up_by` filters to seats facing voters on or before a date, which is how the
 * client asks "what is on the ballot this cycle".
 */
exports.getOfficeholders = async (req, res) => {
  try {
    const { office, state, up_by: upBy } = req.query;
    if (office && !OFFICES.includes(office)) {
      return res.status(400).json({ success: false, message: `office must be one of ${OFFICES}` });
    }

    const rows = await repo.officeholders({ office, state, upBy });

    res.json({ success: true, data: { count: rows.length, rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/division?ocd_id=...
 *
 * Panel detail: what this division is, its result history, and who holds it.
 *
 * The id is a query parameter, not a path segment, because OCD ids contain
 * slashes — "ocd-division/country:us/state:tx/cd:28". Percent-encoding them
 * does not help: the encoded slashes are decoded before Express routes, so
 * a /division/:ocdId route sees four extra path segments and 404s.
 */
exports.getDivision = async (req, res) => {
  try {
    const ocdId = String(req.query.ocd_id || req.params.ocdId || "");
    if (!ocdId) {
      return res.status(400).json({ success: false, message: "ocd_id is required" });
    }
    const limit = clampInt(req.query.limit, 40, 1, 200);
    const data = await repo.division(ocdId, limit);
    if (!data) return res.status(404).json({ success: false, message: "unknown division" });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/us-election/chat
 * Grounded Q&A. Returns the records the answer was built from so a reader can
 * check it — an unsourced answer about someone's ballot is worth very little.
 */
exports.chat = async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) {
      return res.status(400).json({ success: false, message: "question is required" });
    }
    if (question.length > 500) {
      return res.status(400).json({ success: false, message: "question too long" });
    }
    const { ask } = require("../services/usElectionChat");
    const out = await ask(req, question, req.body?.ocd_id);
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/candidate?fec_id=...  (or ?name=&ocd_id=)
 *
 * One candidate, incumbent or challenger. FEC filings give money for everyone;
 * only sitting members also have a voting record and committees, so those are
 * merged in when the name matches an officeholder. A challenger legitimately
 * has no voting record — the UI must say that rather than look broken.
 */
exports.getCandidate = async (req, res) => {
  try {
    const { fec_id: fecId, name, ocd_id: ocdId } = req.query;
    if (!fecId && !name) {
      return res.status(400).json({ success: false, message: "fec_id or name is required" });
    }
    const data = await repo.candidateByFec({ fecId, name, ocdId });
    if (!data) {
      return res.status(404).json({ success: false, message: "candidate not found" });
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/search?q=
 * Find a person by name without knowing their district — the way most readers
 * arrive, since people remember a name long before a district number.
 */
exports.searchPeople = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, data: { rows: [] } });

    const rows = await repo.searchPeople(q);

    res.json({ success: true, data: { rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/races?cycle=2026&office=&min_receipts=
 *
 * Contested races as map points: candidates aggregated to their division's
 * centroid, ready to render as circles.
 *
 * One circle per RACE, not per candidate. Every candidate for a seat shares
 * that seat's geography, so per-candidate points would stack on the identical
 * coordinate — and spreading them out would invent a location the data does
 * not have. A Senate candidate's "position" is an entire state. The circle
 * says "a contested race is somewhere in here", which is true; a pin would
 * say "this person is here", which is not.
 */
exports.getRacePoints = async (req, res) => {
  try {
    const cycle = parseInt(req.query.cycle, 10) || 2026;
    const minReceipts = req.query.min_receipts !== undefined
      ? Number(req.query.min_receipts) : 5000;
    if (req.query.office && !OFFICES.includes(req.query.office)) {
      return res.status(400).json({ success: false, message: `office must be one of ${OFFICES}` });
    }

    const features = await repo.racePoints({
      cycle, office: req.query.office, minReceipts,
    });
    if (!features.length) return res.json({ success: true, data: { cycle, features: [] } });

    res.json({ success: true, data: { cycle, count: features.length, features } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/division-points?level=state
 *
 * Centroids for labelling. A polygon that spans several tiles gets labelled
 * once per tile, which is why Texas, California and Florida each appeared
 * three or four times on the map. Labels drawn from a point source render
 * exactly once per division.
 */
exports.getDivisionPoints = async (req, res) => {
  try {
    const level = String(req.query.level || "state");
    if (!LEVELS.includes(level)) {
      return res.status(400).json({ success: false, message: `level must be one of ${LEVELS}` });
    }
    const features = await repo.divisionPoints({ level });
    res.json({ success: true, data: { level, count: features.length, features } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/capabilities
 *
 * Which overlays this deployment can actually serve. The client hides a
 * toggle whose data is not configured rather than showing one that renders
 * nothing — an empty layer looks like a bug, an absent layer looks like a
 * feature that has not shipped.
 *
 * Derived from the data, not from config: a collection existing but empty
 * means the overlay is not ready, and saying otherwise would be a lie the
 * user discovers by clicking.
 */
exports.getCapabilities = async (req, res) => {
  try {
    const data = await repo.capabilities();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


/**
 * GET /api/us-election/news-points
 *
 * Election coverage placed on the map by the person it names.
 *
 * Circles are coloured by the LEAN OF THE COVERAGE, not by the party of the
 * candidate — which is the point of putting news on this map at all. Two
 * races with identical polling can be covered very differently, and that
 * asymmetry is invisible on a results choropleth.
 *
 * The link is a named person, never a mentioned place: an article naming
 * Henry Cuellar belongs on TX-28. "Texas sues California" is about neither
 * place in the way a map would imply.
 */
/**
 * GET /api/us-election/news-articles?ocd_id=&limit=
 *
 * The stories themselves, for the rail under the map. news-points answers
 * "where is there coverage"; this answers "what does it say".
 *
 * `published_at` is passed through verbatim as the relative string the source
 * rendered it with. It is deliberately not converted to a date: the scrape
 * captured "2 hours ago" at a moment we no longer know precisely, so turning
 * it into a timestamp would invent precision. Ordering uses matched_at.
 */
exports.getNewsArticles = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 40, 1, 200);
    const ocdId = req.query.ocd_id ? String(req.query.ocd_id) : undefined;
    const rows = await repo.newsArticles({ ocdId, limit });
    res.json({ success: true, data: { count: rows.length, rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNewsPoints = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 400, 1, 2000);
    const features = await repo.newsPoints({ limit });
    if (!features.length) return res.json({ success: true, data: { features: [] } });

    res.json({ success: true, data: { count: features.length, features } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


/**
 * GET /api/us-election/candidate-places
 *
 * Where the people running actually live — the first layer on this map with
 * real coordinates rather than a polygon's centroid. Every other point here
 * says "somewhere inside this shape"; this one says "this town".
 *
 * Grouped by city, not per candidate. Four people filing from Austin are one
 * dot that says four, because four dots on the same coordinate is a rendering
 * artifact pretending to be data.
 *
 * The honest caveat travels with the data: this is the address on the FEC
 * filing, which is usually home and is sometimes a PO box or a campaign
 * office. `po_box` counts the ones we can see are boxes, so the readout can
 * say so instead of asserting a residence the FEC never verified.
 *
 * GOVERNORS ARE ABSENT and it is not an oversight. The FEC regulates federal
 * candidates only, so gubernatorial filings live in fifty separate state
 * systems with no common format. See ingest_candidate_places.py.
 */
exports.getCandidatePlaces = async (req, res) => {
  try {
    const cycle = clampInt(req.query.cycle, 2026, 1990, 2100);
    const limit = clampInt(req.query.limit, 600, 1, 3000);

    const features = await repo.candidatePlaces({ cycle, limit });

    res.json({ success: true, data: { count: features.length, features } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


/**
 * GET /api/us-election/voter-info?state=TX[&address=...]
 *
 * How to vote where you are. This endpoint hands back LINKS to the office that
 * runs the election, never our own transcription of the rules.
 *
 * That is a deliberate limit, not a gap. ID requirements, registration
 * deadlines and early-voting windows change, they differ by county inside a
 * state, and a reader who acts on a stale one can lose their vote. There is no
 * free maintained feed of them — the U.S. Vote Foundation's is a licensed
 * product — so publishing our own copy would mean guaranteeing something we
 * cannot keep current. The state's own page is always right by definition.
 *
 * Address-level polling places come from Google's Civic Information API when
 * GOOGLE_CIVIC_API_KEY is configured. Its `representatives` endpoint was turned
 * down in April 2025; `voterInfoQuery`, which this uses, was not. Even so it is
 * strictly an enhancement: coverage varies by election and locality, the data
 * expires after election day, and a blank answer does NOT mean someone cannot
 * vote. The official link is always returned alongside, and the UI leads with
 * it when the lookup is empty.
 */
/**
 * GET /api/us-election/issues
 *
 * The issue menu, with the coverage behind each entry so the UI can avoid
 * offering a category that will open on an empty room.
 */
exports.getIssues = async (req, res) => {
  try {
    const rows = await repo.issueCategories();
    res.json({ success: true, data: { count: rows.length, rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/us-election/positions?ocd_id=          — everyone here
 * GET /api/us-election/positions?category=&state= — one issue, who says what
 *
 * Coverage is incumbency-biased by a factor of about five, so every row
 * carries its own quote counts. A thin record means little is written down,
 * not that someone has no convictions, and the client is given the numbers
 * it needs to say that rather than implying the opposite by omission.
 */
exports.getPositions = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 40, 1, 200);
    const category = req.query.category ? String(req.query.category) : null;
    const ocdId = req.query.ocd_id ? String(req.query.ocd_id) : null;
    if (!category && !ocdId && !req.query.fec_id && !req.query.bioguide) {
      return res.status(400).json({
        success: false,
        message: "category, ocd_id, fec_id or bioguide is required",
      });
    }
    // A single person, when the caller already knows who they mean. Saves the
    // client warming a whole per-state index to render one panel.
    if (req.query.fec_id || req.query.bioguide) {
      const person = await repo.positionsForPerson({
        fecId: req.query.fec_id, bioguide: req.query.bioguide,
      });
      return res.json({ success: true, data: { person: person ?? null } });
    }
    const rows = category
      ? await repo.positionsByIssue({
        category, ocdId, state: req.query.state, office: req.query.office, limit,
      })
      : await repo.positionsForDivision({ ocdId });
    res.json({
      success: true,
      data: {
        category, ocd_id: ocdId, count: rows.length, rows,
        source: "OnTheIssues.org",
        caveat: "Positions are compiled by OnTheIssues.org from public "
          + "statements, votes and debates. Coverage is far deeper for people "
          + "who have held office: the median sitting member has 51 recorded "
          + "positions against a challenger's 11. An empty or thin record "
          + "means little has been written down, not that a candidate holds "
          + "no position.",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getVoterInfo = async (req, res) => {
  try {
    const state = String(req.query.state || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ success: false, message: "state must be a 2-letter code" });
    }
    const office = await repo.voterInfo(state);

    const out = { state, office: office || null, polling: null, lookupStatus: "not_requested" };

    const address = String(req.query.address || "").trim();
    const key = process.env.GOOGLE_CIVIC_API_KEY;
    if (address && !key) out.lookupStatus = "unconfigured";
    if (address && key) {
      const url = "https://www.googleapis.com/civicinfo/v2/voterinfo"
        + `?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}`;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (!r.ok) {
          // A 400 here is routine: Civic returns it when it holds no election
          // for that address. That is "nothing to show", not "you cannot vote".
          out.lookupStatus = r.status === 400 ? "no_election_data" : "error";
        } else {
          out.lookupStatus = "ok";
          out.polling = {
            pollingLocations: j.pollingLocations || [],
            earlyVoteSites: j.earlyVoteSites || [],
            dropOffLocations: j.dropOffLocations || [],
            election: j.election || null,
          };
        }
      } catch {
        out.lookupStatus = "error";
      }
    }
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


/**
 * GET /api/us-election/place-photo?lat=&lng=
 *
 * A picture of a polling place. There is exactly one free source that has one
 * for all of them, and it is overhead.
 *
 * Esri's World Imagery — already serving this map's satellite basemap — has an
 * aerial tile of every location, keyless and free. At z18 that is the building
 * and its parking lot, which is genuinely useful: you can see the entrance,
 * whether there is parking, how far it sits from the road.
 *
 * WIKIMEDIA COMMONS WAS TRIED AND REJECTED. Its geosearch has something within
 * 250m of 24% of these places, which sounded workable until the results were
 * read: it returns whatever is geotagged near a point, not what is AT it. Real
 * examples from three test coordinates — a portrait of the actress Tovah
 * Feldshuh, a photograph of a vintage aircraft, and a top-down shot of a
 * railway junction. Captioned as a polling place, any of those is worse than
 * showing nothing, and no title or category filter makes "photographed near
 * here" mean "this is the building".
 *
 * Google Street View is the ideal ground-level shot and remains unwired: its
 * API is billed per image and its terms forbid caching what it returns.
 */

const TILE_Z = 18;
const ESRI_TILE = "https://server.arcgisonline.com/ArcGIS/rest/services"
  + "/World_Imagery/MapServer/tile";

/** Slippy-map tile holding a coordinate. */
const tileFor = (lat, lng, z) => {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
  return { z, x, y };
};

exports.getPlacePhoto = async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, message: "lat and lng are required" });
    }
    const z = Math.min(19, Math.max(14, Number(req.query.zoom) || TILE_Z));
    const { x, y } = tileFor(lat, lng, z);
    res.json({ success: true, data: {
      aerial: {
        url: `${ESRI_TILE}/${z}/${y}/${x}`,
        zoom: z,
        attribution: "Imagery: Esri, Maxar, Earthstar Geographics",
      },
    } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** The image itself, streamed through so the API key stays server-side. */
exports.getPlacePhotoImage = async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_CIVIC_API_KEY;
    if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(404).end();
    const url = `https://maps.googleapis.com/maps/api/streetview?size=640x360`
      + `&location=${lat},${lng}&fov=80&key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(404).end();
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    // Not cached: the Maps terms do not allow storing this imagery.
    res.set("Cache-Control", "no-store");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(404).end();
  }
};


/**
 * GET /api/us-election/polling-points?bbox=w,s,e,n&year=&limit=
 *
 * Polling places in the viewport, for the map layer.
 *
 * THESE ARE HISTORICAL. The corpus runs 2012-2020 across 37 states and stops
 * there — nobody publishes current polling places in bulk, so this says where
 * the booths WERE, never where to vote. Every response carries `historical:
 * true` and the year range it drew from so the caller cannot render it as
 * current by accident.
 *
 * Bbox-bounded and capped because there are 216,822 placed rows: sending them
 * all would be tens of megabytes and would paint the country as one solid
 * block of dots at any zoom where the country is visible.
 */
exports.getPollingPoints = async (req, res) => {
  try {
    const parts = String(req.query.bbox || "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return res.status(400).json({ success: false, message: "bbox=w,s,e,n is required" });
    }
    const limit = clampInt(req.query.limit, 800, 1, 3000);
    const year = Number(req.query.year);

    const features = await repo.pollingPoints({ bbox: parts, limit, year });

    res.json({ success: true, data: {
      historical: true,
      coverage: "2012-2020, 37 states",
      count: features.length,
      capped: features.length >= limit,
      features,
    } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


/**
 * GET /api/us-election/stats
 *
 * Corpus size, for the splash screen. Counted live rather than written into
 * the UI as constants: a number baked into a splash is a claim that quietly
 * stops being true the next time an ingest runs, and nobody notices because
 * nothing fails.
 */
exports.getStats = async (req, res) => {
  try {
    const data = await repo.stats();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
