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

/**
 * The race happening NOW, for every division at once.
 *
 * The hover had only ever been able to answer "how did this place vote in
 * 2024". Ten days out from an election that is the less useful half; a
 * reader wants to know whether this seat is on the ballot, who is defending
 * it, and who is coming for it. This is the bulk cut that makes that cost
 * nothing per mouse-move, keyed the same way margins and topCandidates are.
 *
 * ── A Senate state holds TWO seats at one ocd_id ─────────────────────────
 * Texas carries Cornyn (class 2, up 2026) and Cruz (class 1, up 2030) under
 * ocd-division/country:us/state:tx. "One row per division" therefore cannot
 * mean "one seat": collapsing them would either hide Cruz or put him in a
 * race he is not running. So a row describes the DIVISION and carries a
 * `seats` array describing each seat under it — one entry for a House
 * district, two for a Senate state — and the top-level fields summarise the
 * seat that is actually up this cycle.
 *
 * ── "running" is three-valued on purpose ─────────────────────────────────
 * true  — the incumbent appears among this cycle's filings (bioguide first,
 *         FEC id as fallback; 641 of 668 incumbent filings carry a bioguide
 *         and 537 of 539 holders carry fec_ids, so the pair covers nearly
 *         everyone).
 * false — ONLY when the roster explicitly says retiring / withdrew / lost
 *         primary. That is a positive statement that they are out.
 * null  — anything else. An incumbent missing from our candidate table is
 *         not evidence of retirement, it is evidence of a gap in our table,
 *         and rendering that as "not running" would invent a retirement.
 */
async function race2026({ office, level }) {
  const CYCLE = 2026;
  const holderQ = office ? { office } : {};
  const candQ = { cycle: CYCLE };
  if (office) candQ.office = office;

  const [holders, cands, rosters] = await Promise.all([
    M(TABLES.officeholders).find(holderQ, {
      _id: 0, ocd_id: 1, office: 1, state: 1, district: 1, name: 1, party: 1,
      next_election: 1, senate_class: 1, photo: 1, bioguide: 1, fec_ids: 1,
    }).lean(),
    M(TABLES.candidates).find(candQ, {
      _id: 0, ocd_id: 1, office: 1, state: 1, district: 1, name: 1, party: 1,
      status: 1, receipts: 1, photo: 1, bioguide: 1, fec_id: 1,
      election_yr: 1,
    }).lean(),
    M(TABLES.raceRoster).find({ cycle: CYCLE }).lean().catch(() => []),
  ]);

  // election_yr is certified and is the only thing that knows Cruz's 2026
  // committee is raising for 2030. Absent means "no reason to exclude".
  const live = cands.filter((c) => c.election_yr == null || c.election_yr === CYCLE);

  const byDivision = new Map();
  for (const c of live) {
    if (!c.ocd_id) continue;
    if (!byDivision.has(c.ocd_id)) byDivision.set(c.ocd_id, []);
    byDivision.get(c.ocd_id).push(c);
  }

  // Roster flags, keyed per state. Only the Senate roster exists (34 states),
  // so a House row simply finds nothing here — which is absence of a claim,
  // not a claim of absence.
  const rosterByState = new Map();
  for (const r of rosters) if (r.state) rosterByState.set(r.state, r);
  const OUT_FLAGS = new Set(["retiring", "withdrew", "lost primary"]);
  const nameKey = (n) => String(n || "").toLowerCase().replace(/[^a-z]/g, "");
  const flagsFor = (roster, name) => {
    if (!roster) return null;
    const want = nameKey(name);
    for (const r of roster.candidates ?? []) {
      if (nameKey(r.name) === want) return r.status_flags ?? [];
    }
    // Surname fallback, used only when it resolves to exactly one entry —
    // the FEC writes "John Sen Cornyn" where the roster writes "John Cornyn".
    const sur = String(name || "").trim().split(/\s+/).pop()?.toLowerCase();
    if (!sur) return null;
    const hits = (roster.candidates ?? [])
      .filter((r) => nameKey(r.name).endsWith(sur));
    return hits.length === 1 ? hits[0].status_flags ?? [] : null;
  };

  const holdersByDivision = new Map();
  for (const h of holders) {
    if (!h.ocd_id) continue;
    if (!holdersByDivision.has(h.ocd_id)) holdersByDivision.set(h.ocd_id, []);
    holdersByDivision.get(h.ocd_id).push(h);
  }

  const rows = [];
  const divisions = new Set([...holdersByDivision.keys(), ...byDivision.keys()]);
  for (const ocdId of divisions) {
    if (level === "cd" && !ocdId.includes("/cd:")) continue;
    if (level === "state" && ocdId.includes("/cd:")) continue;

    const divHolders = holdersByDivision.get(ocdId) ?? [];
    const divCands = byDivision.get(ocdId) ?? [];
    const state = divHolders[0]?.state ?? divCands[0]?.state ?? null;
    const roster = state ? rosterByState.get(state) : null;

    const fecOf = new Set(divCands.map((c) => c.fec_id).filter(Boolean));
    const bioOf = new Set(divCands.map((c) => c.bioguide).filter(Boolean));

    const seats = divHolders.map((h) => {
      const up = String(h.next_election || "").startsWith(String(CYCLE));
      const flags = flagsFor(roster, h.name);
      const matched = (h.bioguide && bioOf.has(h.bioguide))
        || (h.fec_ids ?? []).some((f) => fecOf.has(f));
      const isOut = Array.isArray(flags) && flags.some((f) => OUT_FLAGS.has(f));
      // An explicit "retiring" outranks a filing match, not the other way
      // round. A departing member keeps a committee open to wind it down and
      // transfer funds, so filings persist long after they stop being a
      // candidate: McConnell, Durbin, Tuberville and Ernst all still match on
      // FEC id while the roster says they are retiring. Letting the match win
      // reported four of the cycle's genuinely open Senate races as incumbent
      // defences, which is the opposite of the truth.
      const running = isOut ? false : matched ? true : null;
      return {
        senate_class: h.senate_class ?? null,
        next_election: h.next_election ?? null,
        seat_up: up,
        incumbent: {
          name: h.name, party: h.party, photo: h.photo ?? null,
          bioguide: h.bioguide ?? null,
          running,
          roster_status: Array.isArray(flags) && flags.length ? flags : null,
        },
      };
    });

    // The seat actually being contested this cycle leads the row.
    const upSeat = seats.find((s) => s.seat_up) ?? null;
    const challengers = divCands.filter((c) => c.status !== "incumbent");
    const top = challengers
      .slice()
      .sort((a, b) => (b.receipts ?? 0) - (a.receipts ?? 0))[0] ?? null;

    // Two independent positive signals that nobody is defending this seat.
    // The roster saying "retiring" is one. The other is the FEC's own
    // classification: where it has filings here and marks every one of them
    // "open seat" with no incumbent among them, that is the FEC stating the
    // race has no incumbent — sparse (2 House districts carry it) but a
    // claim rather than a silence. A division we simply hold no holder for
    // stays unknown, because absence of a record is not an open seat.
    const incumbentFilings = divCands.filter((c) => c.status === "incumbent");
    const fecSaysOpen = divCands.length > 0
      && incumbentFilings.length === 0
      && divCands.some((c) => c.status === "open seat");

    rows.push({
      ocd_id: ocdId,
      office: office ?? divHolders[0]?.office ?? divCands[0]?.office ?? null,
      state,
      district: divHolders[0]?.district ?? divCands[0]?.district ?? null,
      seat_up: seats.some((s) => s.seat_up) || (!seats.length && !!divCands.length),
      open_seat: (!!upSeat && upSeat.incumbent.running === false) || fecSaysOpen,
      open_seat_source: (!!upSeat && upSeat.incumbent.running === false)
        ? "roster" : fecSaysOpen ? "fec" : null,
      incumbent: upSeat ? upSeat.incumbent : null,
      challengers: challengers.length,
      top_challenger: top
        ? {
          name: top.name, party: top.party, photo: top.photo ?? null,
          receipts: top.receipts ?? 0, fec_id: top.fec_id ?? null,
          roster_status: (() => {
            const f = flagsFor(roster, top.name);
            return Array.isArray(f) && f.length ? f : null;
          })(),
        }
        : null,
      seats,
      roster_source: roster?.source ?? null,
    });
  }
  return rows;
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
/**
 * The issue taxonomy, with the coverage actually behind each category.
 *
 * Coverage is reported rather than assumed because it is deeply uneven and
 * the UI must not offer an issue that will return an empty room. Six of the
 * nineteen product categories have no source topic at all — OnTheIssues has
 * nothing on Veterans Affairs, Agriculture, Infrastructure, Media & Free
 * Speech or International Development, and "Principles & Values" was
 * deliberately NOT forced into Constitutional Issues, because religion and
 * political philosophy are not court appointments.
 */
async function issueCategories() {
  const rows = await M(TABLES.issuePositions).aggregate([
    { $project: { cats: { $objectToArray: "$categories" }, role: 1 } },
    { $unwind: "$cats" },
    { $group: {
      _id: "$cats.k",
      people: { $sum: 1 },
      quotes: { $sum: "$cats.v.quote_count" },
      challengers: { $sum: { $cond: [{ $eq: ["$role", "challenger"] }, 1, 0] } },
    } },
    { $sort: { people: -1 } },
  ]);
  return rows.map((r) => ({
    category: r._id, people: r.people, quotes: r.quotes,
    challengers: r.challengers,
  }));
}

/**
 * Everyone in one division, with what they have said, by category.
 *
 * `total_quotes` travels with every person on purpose. Documentation here is
 * heavily incumbency-biased — the median officeholder carries 51 recorded
 * positions against a challenger's 11 — so a thin record must be legible as
 * "little is written down", never as "this person believes nothing".
 */
async function positionsForDivision({ ocdId }) {
  // `ref` is a POINTER, not an ocd id — {collection, id} where id is
  // "<ocd>|<office>|<bioguide>" for a member and "<cycle>|<fec_id>" for a
  // filer. Matching it against an ocd id string returned nothing at all, so
  // resolve the division's people first and look them up by their own keys.
  const [holders, cands] = await Promise.all([
    M(TABLES.officeholders).find({ ocd_id: ocdId }, { _id: 0, bioguide: 1 }).lean(),
    M(TABLES.candidates).find({ ocd_id: ocdId }, { _id: 0, fec_id: 1 }).lean(),
  ]);
  const bios = holders.map((h) => h.bioguide).filter(Boolean);
  const fecs = cands.map((c) => c.fec_id).filter(Boolean);
  if (!bios.length && !fecs.length) return [];
  const rows = await M(TABLES.issuePositions)
    .find({ $or: [
      ...(bios.length ? [{ bioguide: { $in: bios } }] : []),
      ...(fecs.length ? [{ fec_id: { $in: fecs } }] : []),
    ] }, { _id: 0, topics: 0 })
    .sort({ total_quotes: -1 }).limit(60).lean();
  return rows;
}

/** One person's positions, by whichever id the caller holds. */
async function positionsForPerson({ fecId, bioguide, name, state }) {
  const q = fecId ? { fec_id: String(fecId) }
    : bioguide ? { bioguide: String(bioguide) }
      : { name: String(name || "") };
  if (!fecId && !bioguide && state) q.state = String(state).toUpperCase();
  return M(TABLES.issuePositions).findOne(q, { _id: 0 }).lean();
}

/**
 * Pick an issue, see who stands where.
 *
 * Returns people who have SAID something in this category, with the quotes
 * themselves and their dates. Sorted by how much is on record, which is a
 * statement about documentation and not about conviction — the caller is
 * given the counts so it can say so.
 */
async function positionsByIssue({ category, ocdId, state, office, limit }) {
  const q = { [`categories.${category}`]: { $exists: true } };
  if (ocdId) q.ref = ocdId;
  if (state) q.state = String(state).toUpperCase();
  if (office) q.office = office;
  const rows = await M(TABLES.issuePositions)
    .find(q, { _id: 0, name: 1, state: 1, party: 1, office: 1, role: 1,
      bioguide: 1, fec_id: 1, ref: 1, total_quotes: 1, source_url: 1,
      match_confidence: 1, categories: 1, topics: 1 })
    .limit(limit).lean();

  // Flatten to just this category's evidence, keeping the source topics so a
  // reader can see WHICH OnTheIssues topic a product category was built from.
  return rows.map((r) => {
    const cat = r.categories?.[category] ?? {};
    const srcTopics = cat.topics ?? [];
    const positions = [];
    for (const t of srcTopics) {
      for (const p of (r.topics?.[t]?.positions ?? [])) {
        positions.push({ ...p, topic: t });
      }
    }
    positions.sort((a, b) => String(b.dated).localeCompare(String(a.dated)));
    return {
      name: r.name, state: r.state, party: r.party, office: r.office,
      role: r.role, bioguide: r.bioguide, fec_id: r.fec_id, ocd_id: r.ref,
      quote_count: cat.quote_count ?? positions.length,
      total_quotes: r.total_quotes,
      source_topics: srcTopics,
      positions,
      source_url: r.source_url,
      match_confidence: r.match_confidence,
    };
  }).sort((a, b) => b.quote_count - a.quote_count);
}

/**
 * Stance rows for a map layer — one point per person.
 *
 * `centroid` is the division's centre, not the person's: everyone in a
 * district shares a point. That is honest for what this shows (a seat's
 * representative takes a position) but means co-located people must be
 * spread or clustered by the client rather than drawn on top of each other.
 *
 * Anyone without a centroid is DROPPED, never emitted at 0,0 — a person
 * silently placed in the Gulf of Guinea is worse than a person missing.
 */
async function stanceMap({ category, office, role, minN }) {
  const K = `category_stance.${category}`;
  const q = {
    [`${K}.n_classified`]: { $gte: minN },
    centroid: { $exists: true, $ne: null },
  };
  if (office) q.office = office;
  if (role) q.role = role;
  const rows = await M(TABLES.issuePositions)
    .find(q, { _id: 0, name: 1, party: 1, role: 1, ocd_id: 1, state: 1,
      office: 1, centroid: 1, bioguide: 1, fec_id: 1, total_quotes: 1,
      division_name: 1, division_level: 1, source_url: 1,
      [K]: 1 })
    .lean();
  return rows.map((r) => {
    const st = r.category_stance?.[category] ?? {};
    const [lng, lat] = r.centroid?.coordinates ?? [];
    return {
      name: r.name, party: r.party, role: r.role, ocd_id: r.ocd_id,
      state: r.state, office: r.office, lng, lat,
      division_name: r.division_name ?? null,
      division_level: r.division_level ?? null,
      // median first and mean beside it, never instead of it — see the
      // note on stanceFilter for why the mean cannot be the sort key.
      median: st.median ?? null, mean: st.mean ?? null,
      spread: st.spread ?? null, conflicted: !!st.conflicted,
      label: st.label ?? null, confidence: st.confidence ?? null,
      n_classified: st.n_classified ?? 0, n_unclear: st.n_unclear ?? 0,
      earliest: st.earliest ?? null, latest: st.latest ?? null,
      fec_id: r.fec_id ?? null, bioguide: r.bioguide ?? null,
      total_quotes: r.total_quotes ?? null,
      source_url: r.source_url ?? null,
    };
  });
}

/**
 * The candidate filter: everyone whose position on one issue falls in a band.
 *
 * Ordered and filtered on MEDIAN, deliberately. The mean is not safe as a key
 * here: Ocasio-Cortez's climate mean is -0.44 against a median of -0.80,
 * because a single quote about where the Green New Deal idea came from was
 * read as opposition to it. One stray classification moves a mean; it barely
 * moves a median. The mean is still returned so a caller can show both and a
 * reader can see the disagreement.
 *
 * Supporting quotes ride along so the filter can always show its evidence —
 * a stance with no quote behind it is an assertion, not a finding.
 */
async function stanceFilter({
  category, min, max, label, party, state, office, role, minN, limit,
}) {
  const K = `category_stance.${category}`;
  const q = { [`${K}.n_classified`]: { $gte: minN } };
  const band = {};
  if (Number.isFinite(min)) band.$gte = min;
  if (Number.isFinite(max)) band.$lte = max;
  if (Object.keys(band).length) q[`${K}.median`] = band;
  else q[`${K}.median`] = { $ne: null };
  if (label) q[`${K}.label`] = label;
  if (party) q.party = String(party).toUpperCase();
  if (state) q.state = String(state).toUpperCase();
  if (office) q.office = office;
  if (role) q.role = role;

  const rows = await M(TABLES.issuePositions)
    .find(q, { _id: 0, name: 1, party: 1, role: 1, ocd_id: 1, state: 1,
      office: 1, centroid: 1, bioguide: 1, fec_id: 1, total_quotes: 1,
      division_name: 1, source_url: 1, categories: 1, topics: 1, [K]: 1 })
    .sort({ [`${K}.median`]: 1 })
    .limit(limit)
    .lean();

  return rows.map((r) => {
    const st = r.category_stance?.[category] ?? {};
    const [lng, lat] = r.centroid?.coordinates ?? [];
    // The strongest evidence, by |stance|, so the quotes shown are the ones
    // actually driving the position rather than the most recent aside.
    const srcTopics = r.categories?.[category]?.topics ?? [];
    const quotes = [];
    for (const t of srcTopics) {
      for (const p of (r.topics?.[t]?.positions ?? [])) {
        if (p?.stance?.value == null) continue;
        quotes.push({
          text: p.text, dated: p.dated, topic: t,
          stance: p.stance.value, label: p.stance.label,
          confidence: p.stance.confidence,
        });
      }
    }
    quotes.sort((a, b) => Math.abs(b.stance) - Math.abs(a.stance));
    return {
      name: r.name, party: r.party, role: r.role, ocd_id: r.ocd_id,
      state: r.state, office: r.office,
      lng: lng ?? null, lat: lat ?? null,
      division_name: r.division_name ?? null,
      median: st.median ?? null, mean: st.mean ?? null,
      spread: st.spread ?? null, conflicted: !!st.conflicted,
      label: st.label ?? null, confidence: st.confidence ?? null,
      n_classified: st.n_classified ?? 0, n_unclear: st.n_unclear ?? 0,
      earliest: st.earliest ?? null, latest: st.latest ?? null,
      fec_id: r.fec_id ?? null, bioguide: r.bioguide ?? null,
      total_quotes: r.total_quotes ?? null,
      source_url: r.source_url ?? null,
      quotes: quotes.slice(0, 3),
    };
  });
}

/**
 * Per-state aggregate, for seeing the national pattern at a glance.
 *
 * Reports the SPLIT either side of zero alongside the central value, because
 * a state whose delegation is evenly divided and a state whose delegation is
 * uniformly moderate both average near zero and are not remotely the same
 * thing. Without the split a swing state and a consensus state paint
 * identically.
 */
async function stanceClusters({ category, minN }) {
  const K = `category_stance.${category}`;
  const rows = await M(TABLES.issuePositions).aggregate([
    { $match: { [`${K}.n_classified`]: { $gte: minN },
      state: { $nin: [null, ""] } } },
    { $group: {
      _id: "$state",
      medians: { $push: `$${K}.median` },
      people: { $sum: 1 },
      neg: { $sum: { $cond: [{ $lt: [`$${K}.median`, 0] }, 1, 0] } },
      pos: { $sum: { $cond: [{ $gt: [`$${K}.median`, 0] }, 1, 0] } },
      zero: { $sum: { $cond: [{ $eq: [`$${K}.median`, 0] }, 1, 0] } },
      conflicted: { $sum: { $cond: [`$${K}.conflicted`, 1, 0] } },
    } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => {
    const xs = (r.medians ?? []).filter((n) => typeof n === "number")
      .sort((a, b) => a - b);
    const mid = xs.length
      ? (xs.length % 2
        ? xs[(xs.length - 1) / 2]
        : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
      : null;
    return {
      state: r._id,
      median: mid === null ? null : Math.round(mid * 1000) / 1000,
      people: r.people, neg: r.neg, pos: r.pos, zero: r.zero,
      conflicted: r.conflicted,
      // A delegation split near-evenly is a different fact from one that
      // agrees on a middling position; both can share a median.
      divided: r.people > 1 && Math.min(r.neg, r.pos) / r.people >= 0.3,
    };
  });
}

/** How many people have a CLASSIFIED stance per category, not merely quotes. */
async function stanceCoverage() {
  const rows = await M(TABLES.issuePositions).aggregate([
    { $project: { cs: { $objectToArray: "$category_stance" }, role: 1 } },
    { $unwind: "$cs" },
    { $match: { "cs.v.median": { $ne: null } } },
    { $group: {
      _id: "$cs.k",
      with_stance: { $sum: 1 },
      classified: { $sum: "$cs.v.n_classified" },
      conflicted: { $sum: { $cond: ["$cs.v.conflicted", 1, 0] } },
      challengers_with_stance: {
        $sum: { $cond: [{ $eq: ["$role", "challenger"] }, 1, 0] } },
    } },
  ]);
  return new Map(rows.map((r) => [r._id, {
    with_stance: r.with_stance, classified: r.classified,
    conflicted: r.conflicted,
    challengers_with_stance: r.challengers_with_stance,
  }]));
}

/**
 * Where people will actually vote in 2026.
 *
 * A DIFFERENT collection from pollingPoints(), and the distinction is the
 * whole point: that one is 2012-2020, where booths STOOD, and is explicitly
 * not guidance. This one is current, from the state's own VIP feed.
 *
 * Coverage is one sampled address per state, so it proves a feed is live and
 * is emphatically not a survey. Only Virginia has published so far. A state
 * with no rows here has NOT published yet — it does not lack polling places,
 * and the caller is handed `coverage` so it can say so rather than implying
 * absence.
 */
async function pollingPoints2026({ bbox, kinds, limit }) {
  const q = {};
  if (Array.isArray(bbox) && bbox.length === 4) {
    const [w, s, e, n] = bbox;
    q.geometry = { $geoWithin: { $box: [[w, s], [e, n]] } };
  }
  if (kinds?.length) q.kind = { $in: kinds };
  const rows = await M(TABLES.polling2026).find(q).limit(limit).lean();
  return rows.map((r) => ({
    type: "Feature",
    geometry: r.geometry,
    properties: {
      name: r.name, address: r.address, hours: r.hours ?? null,
      kind: r.kind, state: r.state, notes: r.notes ?? null,
      start_date: r.start_date ?? null, end_date: r.end_date ?? null,
      source: r.source ?? null, sampled_from: r.sampled_from ?? null,
    },
  }));
}

async function voterInfo(state) {
  return M(TABLES.voterInfo).collection.findOne({ _id: state });
}

/**
 * Outside spending for and against one candidate.
 *
 * SPENDING, not advertising creative. The FEC reports an amount, a payer, a
 * payee and a free-text purpose; it never reports what the message said. A
 * caller must not present this as "the ads" — we cannot show a single one.
 *
 * Totals come from the rollup rather than re-summing line items, because the
 * ingest already removed two things a naive sum would put back: 3,113 rows
 * belonging to 600 superseded amendments ($186.2m — an amended FEC report
 * REPLACES a filing rather than patching it, and the bulk file ships both),
 * and 16 quarantined junk filings worth $38.5bn. The line items returned
 * here are for display only and exclude supersessions for the same reason.
 */
async function adSpend({ fecId, limit }) {
  const rollup = await M(TABLES.ieRollup)
    .findOne({ candidate_id: String(fecId) }, { _id: 0 }).lean();
  if (!rollup) return null;

  const items = await M(TABLES.ieLineItems)
    .find({ candidate_id: String(fecId), amendment: { $ne: "A" } },
      { _id: 0, amount: 1, spender_name: 1, spender_id: 1, payee: 1,
        purpose: 1, medium: 1, is_ad: 1, support_oppose: 1,
        expenditure_date: 1, dissemination_date: 1, election_type: 1 })
    .sort({ amount: -1 }).limit(limit).lean();

  return { ...rollup, line_items: items };
}

/**
 * Leaderboards — who is being spent against hardest.
 *
 * `ratio` sorting demands a support total to divide by, so rows with none are
 * excluded from THAT sort only; a candidate with $5m against and nothing for
 * has an undefined ratio, not an infinite one.
 */
async function adSpendTop({
  office, state, sort, minTotal, minSupport, limit,
}) {
  const q = {};
  if (office) q.office = office;
  if (state) q.state = String(state).toUpperCase();

  const key = sort === "support" ? "support_total"
    : sort === "ratio" ? "ratio_against_for"
      : "oppose_total";
  // A ratio needs a real denominator as well as a real numerator. Gating only
  // the opposed side still floated $2.5m-against/$1,050-for to the top at
  // 2,381x, which measures the smallness of the denominator and nothing else.
  if (sort === "ratio") {
    q.ratio_against_for = { $ne: null };
    q.support_total = { $gte: minSupport };
  }
  // minTotal always gates on DOLLARS opposed, never on the sort key. Gating a
  // ratio sort by ratio is what made the leaderboard useless: a candidate with
  // $2.5m against and $1,050 for scores 2,381x and outranks a $207m race. The
  // ratio is only meaningful once the denominator is real, so the floor has to
  // be an absolute amount.
  if (Number.isFinite(minTotal)) q.oppose_total = { $gte: minTotal };

  return M(TABLES.ieRollup)
    .find(q, { _id: 0, line_items: 0 })
    .sort({ [key]: -1 }).limit(limit).lean();
}

/**
 * Per-division totals, so a map can shade by how much outside money a seat
 * has attracted.
 *
 * The join is candidate_id -> us_candidates.fec_id, which is the same key on
 * both sides. 73 of 819 candidates carrying outside spending are absent from
 * us_candidates entirely — Troy Jackson of Maine has $62.8m spent against him
 * and no candidate record at all — so dropping the unmatched would silently
 * erase the single largest unreported race. Where the candidate table cannot
 * supply an ocd id, one is derived from state and office and marked as such,
 * and a row that can be placed neither way is still returned without one.
 */
async function adSpendMap({ office, cycle }) {
  const q = { cycle };
  if (office) q.office = office;
  const rows = await M(TABLES.ieRollup)
    .find(q, { _id: 0, candidate_id: 1, name: 1, party: 1, state: 1,
      office: 1, district: 1, support_total: 1, oppose_total: 1,
      ratio_against_for: 1, first_date: 1, last_date: 1 })
    .lean();
  if (!rows.length) return [];

  const ids = rows.map((r) => r.candidate_id);
  const cands = await M(TABLES.candidates)
    .find({ fec_id: { $in: ids } }, { _id: 0, fec_id: 1, ocd_id: 1, photo: 1 })
    .lean();
  const byFec = new Map(cands.map((c) => [c.fec_id, c]));

  // A House district is "00" for statewide offices and a zero-padded number
  // otherwise; the OCD form drops the padding.
  const derive = (r) => {
    const st = String(r.state || "").toLowerCase();
    if (!/^[a-z]{2}$/.test(st)) return null;
    const base = `ocd-division/country:us/state:${st}`;
    if (r.office === "us_senate" || r.office === "president") return base;
    if (r.office === "us_house") {
      const d = parseInt(r.district, 10);
      if (!Number.isFinite(d)) return null;
      return `${base}/cd:${d === 0 ? "1" : d}`;
    }
    return null;
  };

  return rows.map((r) => {
    const hit = byFec.get(r.candidate_id);
    const derived = hit?.ocd_id ? null : derive(r);
    return {
      candidate_id: r.candidate_id, name: r.name, party: r.party,
      state: r.state, office: r.office, district: r.district,
      support_total: r.support_total ?? 0,
      oppose_total: r.oppose_total ?? 0,
      ratio_against_for: r.ratio_against_for ?? null,
      first_date: r.first_date ?? null, last_date: r.last_date ?? null,
      photo: hit?.photo ?? null,
      ocd_id: hit?.ocd_id ?? derived ?? null,
      ocd_source: hit?.ocd_id ? "candidates" : derived ? "derived" : null,
      in_candidate_table: !!hit,
    };
  });
}

/** Load/rollup provenance, so the client can state the window and the source. */
async function adSpendMeta() {
  const rows = await M(TABLES.ieMeta).find({}).lean().catch(() => []);
  const byId = Object.fromEntries((rows || []).map((r) => [r._id, r]));
  return { load: byId["load-2026"] ?? null, rollup: byId["rollup-2026"] ?? null };
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
  race2026,
  division,
  divisionPoints,
  candidateByFec,
  searchPeople,
  racePoints,
  candidatePlaces,
  newsPoints,
  newsArticles,
  pollingPoints,
  pollingPoints2026,
  voterInfo,
  issueCategories,
  positionsForDivision,
  positionsByIssue,
  positionsForPerson,
  stanceMap,
  stanceFilter,
  stanceClusters,
  stanceCoverage,
  adSpend,
  adSpendTop,
  adSpendMap,
  adSpendMeta,
  capabilities,
  stats,
};
