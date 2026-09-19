const { getModelForLanguage } = require("./db");

/**
 * US election map data.
 *
 * Reads the collections built by python/us_election/: `us_divisions` (identity
 * and hierarchy — geometry lives in the PMTiles archive, never here) and
 * `us_margins` (party totals and a signed margin per geography per contest).
 *
 * Everything routes through getModelForLanguage so the US tenant reads the
 * en_usa database. The Bangladesh election controller does NOT do this — it is
 * bound to the default connection — which is exactly why these live in a
 * separate controller rather than being bolted onto it.
 */

// Margin is signed: negative = Democratic, positive = Republican.
const OFFICES = ["president", "us_senate", "us_house", "governor"];
const LEVELS = ["state", "cd", "county", "sldu", "sldl"];

const marginsModel = (req) =>
  getModelForLanguage("us_margins", req.query.lang, req.query.country);
const divisionsModel = (req) =>
  getModelForLanguage("us_divisions", req.query.lang, req.query.country);

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

    const Margins = marginsModel(req);
    const q = { level, office, election_type };
    let year = parseInt(req.query.year, 10);
    if (!Number.isFinite(year)) {
      // default to the most recent year that actually has data for this cut
      const latest = await Margins.find(q).sort({ year: -1 }).limit(1).lean();
      if (!latest.length) return res.json({ success: true, data: { year: null, rows: [] } });
      year = latest[0].year;
    }
    q.year = year;
    if (minShare > 0) q.major_share = { $gte: minShare };

    const rows = await Margins.find(q, {
      _id: 0, ocd_id: 1, margin: 1, winner_party: 1, votes: 1, total: 1, major_share: 1,
    }).lean();

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
    const Margins = marginsModel(req);
    const rows = await Margins.aggregate([
      { $match: { level, election_type } },
      { $group: { _id: { year: "$year", office: "$office" }, n: { $sum: 1 } } },
      { $sort: { "_id.year": -1 } },
    ]);
    const byOffice = {};
    for (const r of rows) {
      (byOffice[r._id.office] ||= []).push({ year: r._id.year, count: r.n });
    }
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
    const q = {};
    if (office) {
      if (!OFFICES.includes(office)) {
        return res.status(400).json({ success: false, message: `office must be one of ${OFFICES}` });
      }
      q.office = office;
    }
    if (state) q.state = String(state).toUpperCase();
    if (upBy) q.next_election = { $lte: String(upBy) };

    const rows = await getModelForLanguage(
      "us_officeholders", req.query.lang, req.query.country,
    ).find(q, {
      _id: 0, ocd_id: 1, office: 1, state: 1, district: 1, name: 1,
      party: 1, next_election: 1, term_end: 1, senate_class: 1, url: 1,
      photo: 1, bioguide: 1,
    }).lean();

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
    const [division, history, holders, candidates, pastCandidates] = await Promise.all([
      // .collection bypasses Mongoose casting: these documents use the OCD id
      // as their _id, and the dynamically-built model assumes ObjectId.
      divisionsModel(req).collection.findOne(
        { _id: ocdId }, { projection: { centroid: 0, aliases: 0 } },
      ),
      marginsModel(req)
        .find({ ocd_id: ocdId }, { _id: 0, year: 1, office: 1, district: 1,
          election_type: 1, margin: 1, winner_party: 1, votes: 1, total: 1, major_share: 1 })
        .sort({ year: -1, office: 1 }).limit(limit).lean(),
      getModelForLanguage("us_officeholders", req.query.lang, req.query.country)
        .find({ ocd_id: ocdId }, { _id: 0, name: 1, party: 1, office: 1,
          next_election: 1, term_end: 1, term_start: 1, senate_class: 1,
          url: 1, bioguide: 1, ideology: 1, committees: 1, finance: 1,
          photo: 1 })
        .lean(),
      // Everyone who has FILED for this seat this cycle — incumbents and
      // challengers. Ordered by money raised, which is the only comparable
      // signal of seriousness the bulk data carries; a third of filers have
      // raised nothing at all.
      getModelForLanguage("us_candidates", req.query.lang, req.query.country)
        .find({ ocd_id: ocdId }, { _id: 0, name: 1, party: 1, status: 1,
          office: 1, cycle: 1, receipts: 1, cash_on_hand: 1,
          individual_contrib: 1, pac_contrib: 1, ballot_status: 1,
          coverage_end: 1, photo: 1, bioguide: 1, fec_id: 1 })
        .sort({ cycle: -1, receipts: -1 }).limit(40).lean(),
      // Who actually appeared on past ballots here. us_margins only knows how
      // a place voted by party; this is who they were voting for.
      getModelForLanguage("us_race_candidates", req.query.lang, req.query.country)
        .find({ ocd_id: ocdId, election_type: "general" },
          { _id: 0, year: 1, office: 1, district: 1, name: 1, party: 1,
            votes: 1, vote_share: 1, led_in_data: 1, photo: 1, bioguide: 1 })
        .sort({ year: -1, votes: -1 }).limit(80).lean(),
    ]);
    if (!division) return res.status(404).json({ success: false, message: "unknown division" });

    // Who holds this seat right now, flagged on both candidate lists so the
    // UI can lead with them instead of re-deriving incumbency three times.
    //
    // The join is on bioguide, not on the name. Name matching is what put the
    // wrong Begich and the wrong Paul on the page during the portrait link,
    // and it is the same risk here; a bioguide is the person. Candidates with
    // no bioguide simply are not flagged, which is the correct answer for a
    // challenger who has never held federal office.
    const sitting = new Set(holders.map((h) => h.bioguide).filter(Boolean));
    const flag = (r) => (r.bioguide && sitting.has(r.bioguide) ? { ...r, sitting: true } : r);

    res.json({ success: true, data: {
      division, history, holders,
      candidates: candidates.map(flag),
      pastCandidates: pastCandidates.map(flag),
    } });
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

/** Loose name key so "Henry R. Cuellar" and "Cuellar, Henry" collapse. */
const nameKey = (n) =>
  String(n || "").toLowerCase().replace(/[^a-z\s]/g, " ")
    .split(/\s+/).filter((w) => w.length > 2).sort().join(" ");

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
    const Cand = getModelForLanguage("us_candidates", req.query.lang, req.query.country);
    const q = fecId ? { fec_id: String(fecId) } : { name: String(name) };
    if (!fecId && ocdId) q.ocd_id = String(ocdId);
    const candidate = await Cand.findOne(q, { _id: 0 }).lean();
    if (!candidate) {
      return res.status(404).json({ success: false, message: "candidate not found" });
    }

    // A sitting member's record lives in us_officeholders. Join on bioguide
    // where the candidate carries one, and on a loose name key only where it
    // does not, because the two feeds spell the same person differently:
    // "Eli Crane" against "Elijah Crane", "Jim Himes" against "James A.
    // Himes", Sanchez against Sánchez, and the FEC's own "Neal Patrick Md,
    // Facs Dunn". 88 sitting members lost their record to those spellings and
    // were rendered as challengers with no voting history, which is not a
    // missing field but a false statement about an incumbent.
    //
    // The asymmetry matters: every officeholder carries a bioguide, so a
    // candidate that HAS one and matches none of them is definitively not a
    // sitting member. Falling back to the name there would reintroduce exactly
    // the wrong-person merge this removes — the Begich and Paul problem, where
    // two people of one name run in one state.
    const Holders = getModelForLanguage(
      "us_officeholders", req.query.lang, req.query.country,
    );
    const HOLDER_FIELDS = {
      _id: 0, name: 1, party: 1, office: 1, district: 1, ocd_id: 1,
      term_start: 1, term_end: 1, next_election: 1, senate_class: 1, url: 1,
      ideology: 1, committees: 1, finance: 1, bioguide: 1, photo: 1,
    };
    let record = null;
    if (candidate.bioguide) {
      record = await Holders.findOne({ bioguide: candidate.bioguide }, HOLDER_FIELDS).lean();
    } else {
      const holders = await Holders.find({ state: candidate.state }, HOLDER_FIELDS).lean();
      const key = nameKey(candidate.name);
      record = holders.find((h) => nameKey(h.name) === key) || null;
    }

    // Everyone else filed for the same seat this cycle.
    const opponents = await Cand.find(
      { ocd_id: candidate.ocd_id, cycle: candidate.cycle,
        fec_id: { $ne: candidate.fec_id } },
      { _id: 0, name: 1, party: 1, status: 1, receipts: 1, fec_id: 1, photo: 1 },
    ).sort({ receipts: -1 }).limit(12).lean();

    // How this seat has voted before, for context on the race.
    const history = await getModelForLanguage(
      "us_margins", req.query.lang, req.query.country,
    ).find({ ocd_id: candidate.ocd_id, election_type: "general" },
      { _id: 0, year: 1, office: 1, margin: 1, winner_party: 1, total: 1 })
      .sort({ year: -1 }).limit(6).lean();

    res.json({ success: true, data: { candidate, record, opponents, history } });
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
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const [cands, holders] = await Promise.all([
      getModelForLanguage("us_candidates", req.query.lang, req.query.country)
        .find({ name: re }, { _id: 0, name: 1, party: 1, status: 1, office: 1,
          state: 1, district: 1, ocd_id: 1, cycle: 1, receipts: 1, fec_id: 1,
          photo: 1, bioguide: 1 })
        .sort({ receipts: -1 }).limit(15).lean(),
      getModelForLanguage("us_officeholders", req.query.lang, req.query.country)
        .find({ name: re }, { _id: 0, name: 1, party: 1, office: 1, state: 1,
          district: 1, ocd_id: 1, next_election: 1, photo: 1, bioguide: 1 })
        .limit(10).lean(),
    ]);

    // De-duplicate: a sitting member usually appears in both feeds. Bioguide
    // first, since the two feeds spell people differently and a name-only
    // check leaves an incumbent listed twice; the name key still catches the
    // candidate rows that carry no bioguide.
    const seenBio = new Set(cands.map((c) => c.bioguide).filter(Boolean));
    const seenName = new Set(cands.map((c) => nameKey(c.name)));
    const rows = [
      ...cands.map((c) => ({ ...c, kind: "candidate" })),
      ...holders
        .filter((h) => !(h.bioguide && seenBio.has(h.bioguide))
                    && !seenName.has(nameKey(h.name)))
        .map((h) => ({ ...h, kind: "officeholder" })),
    ];
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
    const match = { cycle };
    if (req.query.office) {
      if (!OFFICES.includes(req.query.office)) {
        return res.status(400).json({ success: false, message: `office must be one of ${OFFICES}` });
      }
      match.office = req.query.office;
    }
    if (minReceipts > 0) match.receipts = { $gte: minReceipts };

    const Cand = getModelForLanguage("us_candidates", req.query.lang, req.query.country);
    const grouped = await Cand.aggregate([
      { $match: match },
      { $sort: { receipts: -1 } },
      { $group: {
        _id: { ocd_id: "$ocd_id", office: "$office" },
        state: { $first: "$state" },
        district: { $first: "$district" },
        candidates: { $sum: 1 },
        total_raised: { $sum: "$receipts" },
        top: { $push: { name: "$name", party: "$party", status: "$status", receipts: "$receipts" } },
      } },
      { $project: { candidates: 1, total_raised: 1, state: 1, district: 1,
        top: { $slice: ["$top", 4] } } },
    ]);
    if (!grouped.length) return res.json({ success: true, data: { cycle, features: [] } });

    // Centroids live on us_divisions; geometry itself is in the PMTiles archive.
    const ids = [...new Set(grouped.map((g) => g._id.ocd_id))];
    const divs = await divisionsModel(req).collection.find(
      { _id: { $in: ids } }, { projection: { _id: 1, name: 1, centroid: 1, level: 1 } },
    ).toArray();
    const byId = new Map(divs.map((d) => [d._id, d]));

    const features = [];
    for (const g of grouped) {
      const d = byId.get(g._id.ocd_id);
      if (!d?.centroid?.coordinates) continue;
      // Which party has raised most here — the only funding signal the bulk
      // filings support. Explicitly NOT a prediction of the outcome.
      const byParty = {};
      for (const c of g.top) byParty[c.party] = (byParty[c.party] || 0) + c.receipts;
      const leadParty = Object.entries(byParty).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "OTH";
      // Census names a district "Congressional District 4" with no state in
      // it, so 435 of them read identically on a national map. Readers say
      // "TX-28"; that is what the label should say.
      const label = g._id.office === "us_house" && g.state && g.district
        ? `${g.state}-${g.district}`
        : d.name;
      features.push({
        type: "Feature",
        geometry: d.centroid,
        properties: {
          ocd_id: g._id.ocd_id,
          office: g._id.office,
          name: d.name,
          label,
          level: d.level,
          state: g.state,
          district: g.district,
          candidates: g.candidates,
          total_raised: Math.round(g.total_raised),
          lead_party: leadParty,
          top: g.top.map((c) => `${c.name}|${c.party}|${Math.round(c.receipts)}`).join(";"),
        },
      });
    }
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
    const rows = await divisionsModel(req).collection.find(
      { level }, { projection: { _id: 1, name: 1, state: 1, centroid: 1, level: 1 } },
    ).toArray();
    const features = rows
      .filter((d) => d?.centroid?.coordinates)
      .map((d) => ({
        type: "Feature",
        geometry: d.centroid,
        properties: {
          ocd_id: d._id,
          // Census calls every district "Congressional District 4"; on a
          // national map 435 of those read identically.
          label: level === "cd" && d.state
            ? `${d.state}-${String(d.name).replace(/\D+/g, "") || "AL"}`
            : d.name,
          state: d.state,
        },
      }));
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
    const has = async (name) => {
      try {
        const n = await getModelForLanguage(name, req.query.lang, req.query.country)
          .estimatedDocumentCount();
        return n > 0;
      } catch {
        return false;
      }
    };
    // Home points are a FIELD on us_candidates, not a collection, so the
    // presence check has to count documents that actually carry one. Checking
    // the collection would report the overlay available the moment candidates
    // land and leave an empty layer toggled on until the places ingest runs.
    const hasHomes = async () => {
      try {
        return (await getModelForLanguage("us_candidates", req.query.lang, req.query.country)
          .countDocuments({ "home.lat": { $exists: true } }, { limit: 1 })) > 0;
      } catch {
        return false;
      }
    };
    // Only counts rows that actually carry coordinates: the collection is
    // populated long before the geocoder runs, and an overlay offered against
    // unplaced rows toggles on to an empty map.
    const hasPolls = async () => {
      try {
        return (await getModelForLanguage("us_polling_places", req.query.lang, req.query.country)
          .countDocuments({ loc: { $exists: true } }, { limit: 1 })) > 0;
      } catch {
        return false;
      }
    };
    const [races, news, margins, officeholders, homes, polls] = await Promise.all([
      has("us_candidates"), has("us_election_news"),
      has("us_margins"), has("us_officeholders"), hasHomes(), hasPolls(),
    ]);
    res.json({
      success: true,
      data: { races, electionNews: news, margins, officeholders,
              candidateHomes: homes, pollingPlaces: polls },
    });
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
exports.getNewsPoints = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 400, 1, 2000);
    const News = getModelForLanguage("us_election_news", req.query.lang, req.query.country);
    const grouped = await News.aggregate([
      { $group: {
        _id: "$ocd_id",
        articles: { $sum: 1 },
        people: { $addToSet: "$person" },
        left: { $sum: { $ifNull: ["$spectrum.left", 0] } },
        center: { $sum: { $ifNull: ["$spectrum.center", 0] } },
        right: { $sum: { $ifNull: ["$spectrum.right", 0] } },
        // Weighted lean per article, averaged across the division's coverage.
        // rated counts only articles whose outlet carries an AllSides rating.
        tiltSum: { $sum: { $multiply: [
          { $ifNull: ["$spectrum.tilt", 0] }, { $ifNull: ["$spectrum.rated", 0] } ] } },
        rated: { $sum: { $ifNull: ["$spectrum.rated", 0] } },
        unrated: { $sum: { $ifNull: ["$spectrum.unrated", 0] } },
        latest: { $max: "$published_at" },
        headline: { $first: "$title" },
      } },
      { $sort: { articles: -1 } },
      { $limit: limit },
    ]);
    if (!grouped.length) return res.json({ success: true, data: { features: [] } });

    const ids = grouped.map((g) => g._id);
    const divs = await divisionsModel(req).collection.find(
      { _id: { $in: ids } }, { projection: { _id: 1, name: 1, centroid: 1, state: 1 } },
    ).toArray();
    const byId = new Map(divs.map((d) => [d._id, d]));

    const features = [];
    for (const g of grouped) {
      const d = byId.get(g._id);
      if (!d?.centroid?.coordinates) continue;
      // -1 entirely left-rated .. +1 entirely right-rated. Null when nothing
      // carried a rating, rather than defaulting to centre — "unknown" and
      // "balanced" are different claims and must not render the same.
      const tilt = g.rated > 0 ? g.tiltSum / g.rated : null;
      features.push({
        type: "Feature",
        geometry: d.centroid,
        properties: {
          ocd_id: g._id,
          name: d.name,
          state: d.state,
          articles: g.articles,
          people: (g.people || []).slice(0, 4).join(", "),
          people_count: (g.people || []).length,
          tilt: tilt === null ? null : Math.round(tilt * 1000) / 1000,
          rated: g.rated,
          unrated: g.unrated,
          left: g.left, center: g.center, right: g.right,
          headline: String(g.headline || "").slice(0, 140),
          latest: g.latest || null,
        },
      });
    }
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
    const Cand = getModelForLanguage("us_candidates", req.query.lang, req.query.country);

    const rows = await Cand.aggregate([
      { $match: { cycle, "home.lat": { $exists: true } } },
      { $sort: { receipts: -1 } },
      { $group: {
        _id: { city: "$home.city", state: "$home.state" },
        lat: { $first: "$home.lat" },
        lng: { $first: "$home.lng" },
        candidates: { $sum: 1 },
        // NOT a plain $sum of receipts. 88 candidates in the 2026 cycle hold
        // two FEC candidate IDs sharing one principal campaign committee — a
        // House member who filed for Senate keeps both — and weball reports
        // that committee's totals under BOTH ids, so summing naively
        // double-counts $177M nationally. $addToSet on {name, receipts}
        // collapses the pair; two different people in one town with byte-equal
        // receipts is not a case that occurs.
        moneyRows: { $addToSet: { n: "$name", r: { $ifNull: ["$receipts", 0] } } },
        po_box: { $sum: { $cond: [{ $eq: ["$home.po_box", true] }, 1, 0] } },
        // Already sorted by receipts, so $push preserves that order and the
        // first few are the candidates worth naming in a tooltip.
        who: { $push: {
          name: "$name", party: "$party", office: "$office",
          district: "$district", ocd_id: "$ocd_id",
          fec_id: "$fec_id", receipts: "$receipts",
          pcc: "$pcc", bioguide: "$bioguide",
        } },
      } },
      // Sum the de-duplicated set, not the rows. This has to happen inside the
      // pipeline rather than in JS because the sort and limit below depend on
      // it — ranking on a field computed after $limit would rank the wrong
      // cities and quietly drop the biggest ones.
      { $addFields: { raised: {
        $sum: { $map: { input: "$moneyRows", as: "m", in: "$$m.r" } } } } },
      { $sort: { raised: -1, candidates: -1 } },
      { $limit: limit },
    ]);

    const features = rows.map((r) => {
      // Same duplication seen from the other side: the pair would otherwise
      // list one person twice. Keep the richer row, which is the filing the
      // money actually belongs to.
      //
      // Identity is the principal campaign committee where there is one. That
      // is not a heuristic — a committee belongs to one candidate, which is
      // exactly how the double-counted filings were found, and it holds for
      // the pair that spells the name two different ways. Bioguide is the next
      // best key, and the name is the last resort for the 84% of filings that
      // carry neither.
      const identity = (w) => (w.pcc && `pcc:${w.pcc}`)
        || (w.bioguide && `bio:${w.bioguide}`)
        || `name:${w.name}`;
      const byPerson = new Map();
      for (const w of r.who || []) {
        const k = identity(w);
        const prev = byPerson.get(k);
        if (!prev || (w.receipts || 0) > (prev.receipts || 0)) byPerson.set(k, w);
      }
      const who = [...byPerson.values()];
      // Party counts come from the de-duplicated list too, or dem + rep can
      // exceed the candidate count and the readout contradicts itself.
      const dem = who.filter((w) => w.party === "DEM").length;
      const rep = who.filter((w) => w.party === "REP").length;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lng, r.lat] },
        properties: {
          city: r._id.city,
          state: r._id.state,
          place: `${r._id.city}, ${r._id.state}`,
          candidates: who.length,
          raised: Math.round(r.raised || 0),
          dem,
          rep,
          other: who.length - dem - rep,
          po_box: r.po_box,
          names: who.slice(0, 5).map((w) => w.name).join(", "),
          // Full rows for the detail panel; the tooltip only reads `names`.
          who: JSON.stringify(who.slice(0, 12)),
        },
      };
    });
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
exports.getVoterInfo = async (req, res) => {
  try {
    const state = String(req.query.state || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ success: false, message: "state must be a 2-letter code" });
    }
    const office = await getModelForLanguage(
      "us_voter_info", req.query.lang, req.query.country,
    ).collection.findOne({ _id: state });

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
    const [w, s2, e, n] = parts;
    const limit = clampInt(req.query.limit, 800, 1, 3000);
    const q = {
      loc: { $geoWithin: { $box: [[w, s2], [e, n]] } },
    };
    const year = Number(req.query.year);
    if (Number.isFinite(year) && year > 0) q.year = year;

    const rows = await getModelForLanguage(
      "us_polling_places", req.query.lang, req.query.country,
    ).find(q, {
      _id: 0, name: 1, address: 1, loc: 1, year: 1, location_type: 1,
      county_name: 1, state: 1, geo_match: 1, county_source: 1,
    }).limit(limit).lean();

    res.json({ success: true, data: {
      historical: true,
      coverage: "2012-2020, 37 states",
      count: rows.length,
      capped: rows.length >= limit,
      features: rows.map((r) => ({
        type: "Feature",
        geometry: r.loc,
        properties: {
          name: r.name, address: r.address, year: r.year,
          location_type: r.location_type, county: r.county_name, state: r.state,
          // Half the geocodes are interpolated along a street segment rather
          // than a rooftop hit; a reader zoomed in on a building deserves to
          // know which kind of pin they are looking at.
          geo_match: r.geo_match, county_source: r.county_source,
        },
      })),
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
    const count = async (name, filter = {}) => {
      try {
        return await getModelForLanguage(name, req.query.lang, req.query.country)
          .estimatedDocumentCount ? await getModelForLanguage(
            name, req.query.lang, req.query.country).countDocuments(filter) : 0;
      } catch {
        return 0;
      }
    };
    const [contests, divisions, candidates, places] = await Promise.all([
      count("us_margins"),
      count("us_divisions", { level: "county" }),
      count("us_race_candidates"),
      count("us_polling_places", { loc: { $exists: true } }),
    ]);
    res.json({ success: true, data: { contests, divisions, candidates, places } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
