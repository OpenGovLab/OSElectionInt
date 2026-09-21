const { getModelForLanguage } = require("../db");
const { TABLES, LEVEL_OCD_PATTERN } = require("./contract");

/**
 * MongoDB implementation of the ElectionRepo contract.
 *
 * Every query here was LIFTED from controller.js rather than rewritten. The
 * pipelines encode corrections that cost real debugging — the per-party
 * collapse in topCandidates, the $addToSet de-duplication in candidatePlaces
 * that stops $177M being double-counted, the bioguide-not-name join that put
 * the wrong Begich on the page once already. Moving them must not reword them.
 *
 * db.js takes only a collection name; the lang/country arguments the
 * controller used to pass were always ignored (OSElectionInt is single
 * tenant), so they are simply not passed on.
 */

const M = (name) => getModelForLanguage(name);

/** Loose name key so "Henry R. Cuellar" and "Cuellar, Henry" collapse. */
const nameKey = (n) =>
  String(n || "").toLowerCase().replace(/[^a-z\s]/g, " ")
    .split(/\s+/).filter((w) => w.length > 2).sort().join(" ");

const HOLDER_FIELDS = {
  _id: 0, name: 1, party: 1, office: 1, district: 1, ocd_id: 1,
  term_start: 1, term_end: 1, next_election: 1, senate_class: 1, url: 1,
  ideology: 1, committees: 1, finance: 1, bioguide: 1, photo: 1,
  social: 1, wikipedia: 1, wikidata: 1, ballotpedia: 1, opensecrets: 1,
};

async function latestYear({ level, office, electionType }) {
  const rows = await M(TABLES.margins)
    .find({ level, office, election_type: electionType })
    .sort({ year: -1 }).limit(1).lean();
  return rows.length ? rows[0].year : null;
}

async function margins({ level, office, electionType, year, minMajorShare }) {
  const q = { level, office, election_type: electionType, year };
  if (minMajorShare > 0) q.major_share = { $gte: minMajorShare };
  return M(TABLES.margins).find(q, {
    _id: 0, ocd_id: 1, margin: 1, winner_party: 1, votes: 1, total: 1,
    major_share: 1,
  }).lean();
}

async function years({ level, electionType }) {
  const rows = await M(TABLES.margins).aggregate([
    { $match: { level, election_type: electionType } },
    { $group: { _id: { year: "$year", office: "$office" }, n: { $sum: 1 } } },
    { $sort: { "_id.year": -1 } },
  ]);
  const byOffice = {};
  for (const r of rows) {
    (byOffice[r._id.office] ||= []).push({ year: r._id.year, count: r.n });
  }
  return byOffice;
}

/** Most recent year that holds candidate rows for this cut, or null. */
async function latestCandidateYear({ level, office, electionType }) {
  const rows = await M(TABLES.raceCandidates)
    .find({ office, election_type: electionType,
      ocd_id: { $regex: LEVEL_OCD_PATTERN[level] } })
    .sort({ year: -1 }).limit(1).lean();
  return rows.length ? rows[0].year : null;
}

async function topCandidates({ level, office, electionType, year }) {
  const q = {
    office, election_type: electionType, year,
    ocd_id: { $regex: LEVEL_OCD_PATTERN[level] },
  };

  const [grouped, holders] = await Promise.all([
    M(TABLES.raceCandidates).aggregate([
      { $match: q },
      // Collapse the spelling variants: group to one entry per party and
      // keep the best-voted spelling as the display name. Votes are summed
      // only to ORDER the parties — the figure is never returned.
      { $sort: { ocd_id: 1, votes: -1 } },
      { $group: {
        _id: { ocd_id: "$ocd_id", party: "$party" },
        votes: { $sum: "$votes" },
        name: { $first: "$name" },
        photo: { $first: "$photo" },
        bioguide: { $first: "$bioguide" },
      } },
      { $sort: { "_id.ocd_id": 1, votes: -1 } },
      { $group: {
        _id: "$_id.ocd_id",
        top: { $push: {
          name: "$name", party: "$_id.party",
          photo: "$photo", bioguide: "$bioguide",
        } },
      } },
      { $project: { _id: 0, ocd_id: "$_id", top: { $slice: ["$top", 2] } } },
    ]),
    // Same bioguide join getDivision uses, for the same reason: a name match
    // put the wrong Begich on the page once already. A candidate with no
    // bioguide is simply never flagged, which is the right answer for a
    // challenger who has never held federal office.
    M(TABLES.officeholders).find({ office }, { _id: 0, bioguide: 1 }).lean(),
  ]);

  const sitting = new Set(holders.map((h) => h.bioguide).filter(Boolean));
  return grouped.map((r) => ({
    ocd_id: r.ocd_id,
    top: r.top.map((c) => (c.bioguide && sitting.has(c.bioguide)
      ? { ...c, sitting: true } : c)),
  }));
}

async function officeholders({ office, state, upBy }) {
  const q = {};
  if (office) q.office = office;
  if (state) q.state = String(state).toUpperCase();
  if (upBy) q.next_election = { $lte: String(upBy) };

  return M(TABLES.officeholders).find(q, {
    _id: 0, ocd_id: 1, office: 1, state: 1, district: 1, name: 1,
    party: 1, next_election: 1, term_end: 1, senate_class: 1, url: 1,
    photo: 1, bioguide: 1,
  }).lean();
}

async function division(ocdId, limit) {
  const [div, history, holders, candidates, pastCandidates] = await Promise.all([
    // .collection bypasses Mongoose casting: these documents use the OCD id
    // as their _id, and the dynamically-built model assumes ObjectId.
    M(TABLES.divisions).collection.findOne(
      { _id: ocdId }, { projection: { centroid: 0, aliases: 0 } },
    ),
    M(TABLES.margins)
      .find({ ocd_id: ocdId }, { _id: 0, year: 1, office: 1, district: 1,
        election_type: 1, margin: 1, winner_party: 1, votes: 1, total: 1,
        major_share: 1 })
      .sort({ year: -1, office: 1 }).limit(limit).lean(),
    M(TABLES.officeholders)
      .find({ ocd_id: ocdId }, { _id: 0, name: 1, party: 1, office: 1,
        next_election: 1, term_end: 1, term_start: 1, senate_class: 1,
        url: 1, bioguide: 1, ideology: 1, committees: 1, finance: 1,
        photo: 1, social: 1, wikipedia: 1, ballotpedia: 1, opensecrets: 1,
        caucuses: 1 })
      .lean(),
    // Everyone who has FILED for this seat this cycle — incumbents and
    // challengers. Ordered by money raised, which is the only comparable
    // signal of seriousness the bulk data carries; a third of filers have
    // raised nothing at all.
    M(TABLES.candidates)
      .find({ ocd_id: ocdId }, { _id: 0, name: 1, party: 1, status: 1,
        office: 1, cycle: 1, receipts: 1, cash_on_hand: 1,
        individual_contrib: 1, pac_contrib: 1, ballot_status: 1,
        coverage_end: 1, photo: 1, bioguide: 1, fec_id: 1,
        social: 1, wikipedia: 1, ballotpedia: 1, election_yr: 1 })
      .sort({ cycle: -1, receipts: -1 }).limit(40).lean(),
    // Who actually appeared on past ballots here. us_margins only knows how
    // a place voted by party; this is who they were voting for.
    M(TABLES.raceCandidates)
      .find({ ocd_id: ocdId, election_type: "general" },
        { _id: 0, year: 1, office: 1, district: 1, name: 1, party: 1,
          votes: 1, vote_share: 1, led_in_data: 1, photo: 1, bioguide: 1 })
      .sort({ year: -1, votes: -1 }).limit(80).lean(),
  ]);
  if (!div) return null;

  // Who holds this seat right now, flagged on both candidate lists so the
  // UI can lead with them instead of re-deriving incumbency three times.
  //
  // The join is on bioguide, not on the name. Name matching is what put the
  // wrong Begich and the wrong Paul on the page during the portrait link,
  // and it is the same risk here; a bioguide is the person. Candidates with
  // no bioguide simply are not flagged, which is the correct answer for a
  // challenger who has never held federal office.
  const sitting = new Set(holders.map((h) => h.bioguide).filter(Boolean));
  const flag = (r) => (r.bioguide && sitting.has(r.bioguide)
    ? { ...r, sitting: true } : r);

  /**
   * Who is still actually in this race.
   *
   * Two separate things make a raw filing list wrong, and both are visible
   * in Texas. First, the FEC files a candidate under the cycle their
   * committee is active in, not the year they are on the ballot: Ted Cruz's
   * 2026 row carries election_yr 2030, because his class-1 seat is not up.
   * Showing him as a 2026 incumbent puts a man in a race he is not running.
   * election_yr is certified, so it is a hard filter.
   *
   * Second, the FEC records that someone filed and never records that they
   * lost. Of six Texas Senate filers, two lost their primary and one
   * withdrew. Only the roster knows that — and the roster is OnTheIssues'
   * editorial compilation, not a certified return, so it is attached as an
   * ANNOTATION and never deletes a filing. The reader is told who says so.
   */
  const roster = div.state
    ? await M(TABLES.raceRoster)
      .findOne({ state: div.state, cycle: 2026 }).lean().catch(() => null)
    : null;
  const rosterStatus = new Map();
  for (const r of roster?.candidates ?? []) {
    const key = String(r.name || "").toLowerCase().replace(/[^a-z]/g, "");
    if (key) rosterStatus.set(key, r.status_flags ?? []);
  }
  const annotate = (r) => {
    const key = String(r.name || "").toLowerCase().replace(/[^a-z]/g, "");
    const flags = rosterStatus.get(key);
    // Surname fallback: the FEC writes "John Sen Cornyn", the roster "John
    // Cornyn". Only used when it resolves to exactly one roster entry.
    let hit = flags;
    if (!hit) {
      const sur = String(r.name || "").trim().split(/\s+/).pop()?.toLowerCase();
      const cands = [...rosterStatus].filter(([k]) => sur && k.endsWith(sur));
      if (cands.length === 1) hit = cands[0][1];
    }
    return hit && hit.length
      ? { ...r, roster_status: hit, roster_source: roster?.source ?? null }
      : r;
  };

  // election_yr is often absent on older rows; absent means "no reason to
  // exclude", so only an explicit mismatch drops a candidate.
  const onThisBallot = (r) => r.election_yr == null || r.election_yr === 2026;

  return {
    division: div,
    history,
    holders,
    candidates: candidates.filter(onThisBallot).map(flag).map(annotate),
    pastCandidates: pastCandidates.map(flag),
    roster: roster
      ? { source: roster.source, source_url: roster.source_url,
          retrieved_at: roster.retrieved_at, caveat: roster.caveat }
      : null,
  };
}

async function divisionPoints({ level }) {
  const rows = await M(TABLES.divisions).collection.find(
    { level }, { projection: { _id: 1, name: 1, state: 1, centroid: 1, level: 1 } },
  ).toArray();
  return rows
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
}

/**
 * One candidate plus the context the panel shows beside them.
 *
 * `history` is part of this composition even though the contract's typedef
 * omits it — the endpoint has always returned it and dropping it would change
 * the response.
 */
async function candidateByFec({ fecId, name, ocdId }) {
  const Cand = M(TABLES.candidates);
  const q = fecId ? { fec_id: String(fecId) } : { name: String(name) };
  if (!fecId && ocdId) q.ocd_id = String(ocdId);
  const candidate = await Cand.findOne(q, { _id: 0 }).lean();
  if (!candidate) return null;

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
  const Holders = M(TABLES.officeholders);
  let record = null;
  if (candidate.bioguide) {
    record = await Holders.findOne(
      { bioguide: candidate.bioguide }, HOLDER_FIELDS).lean();
  } else {
    const holders = await Holders.find(
      { state: candidate.state }, HOLDER_FIELDS).lean();
    const key = nameKey(candidate.name);
    record = holders.find((h) => nameKey(h.name) === key) || null;
  }

  // Everyone else filed for the same seat this cycle.
  const opponents = await Cand.find(
    { ocd_id: candidate.ocd_id, cycle: candidate.cycle,
      fec_id: { $ne: candidate.fec_id } },
    { _id: 0, name: 1, party: 1, status: 1, receipts: 1, fec_id: 1, photo: 1,
      social: 1, wikipedia: 1 },
  ).sort({ receipts: -1 }).limit(12).lean();

  // How this seat has voted before, for context on the race.
  const history = await M(TABLES.margins)
    .find({ ocd_id: candidate.ocd_id, election_type: "general" },
      { _id: 0, year: 1, office: 1, margin: 1, winner_party: 1, total: 1 })
    .sort({ year: -1 }).limit(6).lean();

  return { candidate, record, opponents, history };
}

async function searchPeople(q) {
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const [cands, holders] = await Promise.all([
    M(TABLES.candidates)
      .find({ name: re }, { _id: 0, name: 1, party: 1, status: 1, office: 1,
        state: 1, district: 1, ocd_id: 1, cycle: 1, receipts: 1, fec_id: 1,
        photo: 1, bioguide: 1 })
      .sort({ receipts: -1 }).limit(15).lean(),
    M(TABLES.officeholders)
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
  return [
    ...cands.map((c) => ({ ...c, kind: "candidate" })),
    ...holders
      .filter((h) => !(h.bioguide && seenBio.has(h.bioguide))
                  && !seenName.has(nameKey(h.name)))
      .map((h) => ({ ...h, kind: "officeholder" })),
  ];
}

async function racePoints({ cycle, office, minReceipts }) {
  const match = { cycle };
  if (office) match.office = office;
  if (minReceipts > 0) match.receipts = { $gte: minReceipts };

  const grouped = await M(TABLES.candidates).aggregate([
    { $match: match },
    { $sort: { receipts: -1 } },
    { $group: {
      _id: { ocd_id: "$ocd_id", office: "$office" },
      state: { $first: "$state" },
      district: { $first: "$district" },
      candidates: { $sum: 1 },
      total_raised: { $sum: "$receipts" },
      top: { $push: { name: "$name", party: "$party", status: "$status",
        receipts: "$receipts" } },
    } },
    { $project: { candidates: 1, total_raised: 1, state: 1, district: 1,
      top: { $slice: ["$top", 4] } } },
  ]);
  if (!grouped.length) return [];

  // Centroids live on us_divisions; geometry itself is in the PMTiles archive.
  const ids = [...new Set(grouped.map((g) => g._id.ocd_id))];
  const divs = await M(TABLES.divisions).collection.find(
    { _id: { $in: ids } },
    { projection: { _id: 1, name: 1, centroid: 1, level: 1 } },
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
    const leadParty = Object.entries(byParty)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "OTH";
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
        top: g.top.map((c) =>
          `${c.name}|${c.party}|${Math.round(c.receipts)}`).join(";"),
      },
    });
  }
  return features;
}

async function candidatePlaces({ cycle, limit }) {
  const rows = await M(TABLES.candidates).aggregate([
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

  return rows.map((r) => {
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
}

/**
 * Individual articles, newest first, for the card rail under the map.
 *
 * Sorted on `matched_at`, NOT `published_at`. `published_at` in this
 * collection is the relative string Google News rendered at scrape time —
 * "2 hours ago", "9 hours ago" — so it sorts alphabetically into nonsense and
 * ages silently once stored. It is still what the UI displays, because it is
 * what the source said; `matched_at` is the real ISO timestamp and the only
 * thing worth ordering by.
 *
 * Division names are joined in a second query rather than a $lookup: the
 * result set is one page of cards, so the id list is short and a lookup
 * across the whole collection would cost more than it saves.
 */
async function newsArticles({ ocdId, limit }) {
  const q = ocdId ? { ocd_id: ocdId } : {};
  const rows = await M(TABLES.news)
    .find(q, {
      _id: 0, ocd_id: 1, title: 1, url: 1, image: 1, source: 1,
      published_at: 1, matched_at: 1, person: 1, party: 1, office: 1,
      total_sources: 1, spectrum: 1,
    })
    .sort({ matched_at: -1 })
    .limit(limit)
    .lean();
  if (!rows.length) return [];

  const ids = [...new Set(rows.map((r) => r.ocd_id).filter(Boolean))];
  const divs = await M(TABLES.divisions).collection
    .find({ _id: { $in: ids } }, { projection: { name: 1, state: 1 } })
    .toArray();
  const byId = new Map(divs.map((d) => [d._id, d]));

  return rows.map((r) => {
    const sp = r.spectrum || {};
    const d = byId.get(r.ocd_id) || {};
    return {
      ocd_id: r.ocd_id,
      name: d.name || null,
      state: d.state || null,
      title: r.title,
      url: r.url,
      image: r.image || null,
      source: r.source || null,
      // Verbatim from the source. Not a date — see above.
      published_at: r.published_at || null,
      person: r.person || null,
      party: r.party || null,
      office: r.office || null,
      tilt: sp.tilt === undefined ? null : sp.tilt,
      left: sp.left ?? 0,
      center: sp.center ?? 0,
      right: sp.right ?? 0,
      total_sources: r.total_sources ?? null,
    };
  });
}

async function newsPoints({ limit }) {
  const grouped = await M(TABLES.news).aggregate([
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
        { $ifNull: ["$spectrum.tilt", 0] },
        { $ifNull: ["$spectrum.rated", 0] } ] } },
      rated: { $sum: { $ifNull: ["$spectrum.rated", 0] } },
      unrated: { $sum: { $ifNull: ["$spectrum.unrated", 0] } },
      latest: { $max: "$published_at" },
      headline: { $first: "$title" },
    } },
    { $sort: { articles: -1 } },
    { $limit: limit },
  ]);
  if (!grouped.length) return [];

  const ids = grouped.map((g) => g._id);
  const divs = await M(TABLES.divisions).collection.find(
    { _id: { $in: ids } },
    { projection: { _id: 1, name: 1, centroid: 1, state: 1 } },
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
  return features;
}

async function pollingPoints({ bbox, limit, year }) {
  const [w, s, e, n] = bbox;
  const q = { loc: { $geoWithin: { $box: [[w, s], [e, n]] } } };
  if (Number.isFinite(year) && year > 0) q.year = year;

  const rows = await M(TABLES.pollingPlaces).find(q, {
    _id: 0, name: 1, address: 1, loc: 1, year: 1, location_type: 1,
    county_name: 1, state: 1, geo_match: 1, county_source: 1,
  }).limit(limit).lean();

  return rows.map((r) => ({
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
  }));
}

/** The state election office row. The Civic API lookup stays in the
 *  controller — it is an outbound HTTP call, not data access. */
async function voterInfo(state) {
  return M(TABLES.voterInfo).collection.findOne({ _id: state });
}

async function capabilities() {
  const has = async (name) => {
    try {
      return (await M(name).estimatedDocumentCount()) > 0;
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
      return (await M(TABLES.candidates)
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
      return (await M(TABLES.pollingPlaces)
        .countDocuments({ loc: { $exists: true } }, { limit: 1 })) > 0;
    } catch {
      return false;
    }
  };
  const [races, news, marginsOk, officeholdersOk, homes, polls] =
    await Promise.all([
      has(TABLES.candidates), has(TABLES.news),
      has(TABLES.margins), has(TABLES.officeholders), hasHomes(), hasPolls(),
    ]);
  return {
    races, electionNews: news, margins: marginsOk,
    officeholders: officeholdersOk, candidateHomes: homes,
    pollingPlaces: polls,
  };
}

async function stats() {
  const count = async (name, filter = {}) => {
    try {
      return await M(name).countDocuments(filter);
    } catch {
      return 0;
    }
  };
  const [contests, divisions, candidates, places] = await Promise.all([
    count(TABLES.margins),
    count(TABLES.divisions, { level: "county" }),
    count(TABLES.raceCandidates),
    count(TABLES.pollingPlaces, { loc: { $exists: true } }),
  ]);
  return { contests, divisions, candidates, places };
}

module.exports = {
  backend: "mongo",
  latestYear,
  margins,
  years,
  latestCandidateYear,
  topCandidates,
  officeholders,
  division,
  divisionPoints,
  candidateByFec,
  searchPeople,
  racePoints,
  candidatePlaces,
  newsPoints,
  newsArticles,
  pollingPoints,
  voterInfo,
  capabilities,
  stats,
};
