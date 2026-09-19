/**
 * Grounded Q&A for the election map.
 *
 * NOTE ON LOCATION: this sits in server/services/ rather than server/src/
 * because controller.js was flattened when it was copied from the parent app
 * — there it lives at src/controllers/, so its `require("../services/...")`
 * landed in src/services/; here the controller is at src/, so the same
 * require resolves one level higher. The path is left alone rather than
 * "corrected" so the controller can still be diffed against its origin.
 */
const { getModelForLanguage } = require("../src/db");

/**
 * Grounded Q&A over the US election data.
 *
 * Retrieval here is STRUCTURED, not vector-based. The corpus is not prose — it
 * is divisions, officeholders, filed candidates and certified margins. Chunking
 * those into text and embedding them would throw away exactly the structure
 * that makes an answer checkable, and would happily retrieve a 2016 margin for
 * a question about 2026. Resolving the entities in the question and fetching
 * the matching records is both more accurate and auditable — every answer can
 * return the rows it was built from.
 *
 * The model's only job is to phrase what the records already say. It is told
 * to refuse rather than fill gaps, because a confident wrong answer about who
 * is on someone's ballot is worse than no answer.
 */

// clawpy runs on the host; pods reach it through the clawpy Service, which has
// manual Endpoints pointing at the host IP (same pattern as claude-api).
const LLM_URL = process.env.CLAWPY_URL
  || "http://clawpy.drishtikon.svc.cluster.local:4040/v1/chat/completions";
// NOTE: clawpy's /v1/models list is stale — the ids it advertises 404 upstream.
// Verify a model with a real completion before changing this.
const LLM_MODEL = process.env.CLAWPY_MODEL || "claude-sonnet-5";

const STATES = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy", "district of columbia": "dc",
};
const ABBREVS = new Set(Object.values(STATES));

const OFFICE_WORDS = [
  [/\bpresident|potus|white house\b/i, "president"],
  [/\bsenat/i, "us_senate"],
  [/\bhouse|congress(ional)?|representative|rep\b/i, "us_house"],
  [/\bgovernor|gubernatorial\b/i, "governor"],
];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pull states, districts, offices, years and names out of the question. */
function parseQuestion(q) {
  const text = String(q || "");
  const lower = text.toLowerCase();

  const states = new Set();
  for (const [name, ab] of Object.entries(STATES)) {
    if (new RegExp(`\\b${esc(name)}\\b`, "i").test(lower)) states.add(ab);
  }
  // "TX-28" / "TX 28" and bare uppercase abbreviations
  for (const m of text.matchAll(/\b([A-Z]{2})[-\s]?(\d{1,2})\b/g)) {
    if (ABBREVS.has(m[1].toLowerCase())) states.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (ABBREVS.has(m[1].toLowerCase())) states.add(m[1].toLowerCase());
  }

  const districts = new Set();
  for (const m of text.matchAll(/\b[A-Z]{2}[-\s]?(\d{1,2})\b/g)) districts.add(Number(m[1]));
  for (const m of lower.matchAll(/\bdistrict\s*(\d{1,2})\b/g)) districts.add(Number(m[1]));
  for (const m of lower.matchAll(/\bcd[-\s]?(\d{1,2})\b/g)) districts.add(Number(m[1]));

  const offices = OFFICE_WORDS.filter(([re]) => re.test(lower)).map(([, o]) => o);
  const years = [...lower.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));

  // Capitalised word pairs that are not state names — candidate/member names.
  // A leading question word means the pair is grammar, not a person —
  // "What Senate seats..." must not become a name lookup.
  const LEAD = /^(What|Which|Who|When|Where|How|Why|Is|Are|Does|Do|Can|Tell|Show|List)\b/;
  const stop = new Set(["United States", "U.S", "New York", "New Jersey"]);
  const names = [...text.matchAll(/\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b/g)]
    .map((m) => m[0])
    .filter((n) => !stop.has(n) && !STATES[n.toLowerCase()] && !LEAD.test(n));

  return {
    states: [...states], districts: [...districts], offices,
    years: [...new Set(years)], names: [...new Set(names)],
  };
}

async function retrieve(req, parsed, ocdId) {
  const M = (c) => getModelForLanguage(c, req.query.lang, req.query.country);
  const out = { officeholders: [], candidates: [], margins: [], divisions: [] };

  const ocdFilter = [];
  if (ocdId) ocdFilter.push(ocdId);
  for (const st of parsed.states) {
    const base = `ocd-division/country:us/state:${st}`;
    if (parsed.districts.length) {
      for (const d of parsed.districts) ocdFilter.push(`${base}/cd:${d}`);
    }
    ocdFilter.push(base);
  }

  const nameRe = parsed.names.length
    ? new RegExp(parsed.names.map(esc).join("|"), "i") : null;

  // people — by place, or by name when the question names someone
  const hq = { $or: [] };
  if (ocdFilter.length) hq.$or.push({ ocd_id: { $in: ocdFilter } });
  if (nameRe) hq.$or.push({ name: nameRe });
  if (hq.$or.length) {
    out.officeholders = await M("us_officeholders").find(hq, {
      _id: 0, name: 1, party: 1, office: 1, state: 1, district: 1,
      term_start: 1, term_end: 1, next_election: 1, senate_class: 1,
      ocd_id: 1, ideology: 1, finance: 1, committees: 1,
    }).limit(12).lean();

    out.candidates = await M("us_candidates").find(hq, {
      _id: 0, name: 1, party: 1, status: 1, office: 1, state: 1, district: 1,
      cycle: 1, receipts: 1, cash_on_hand: 1, individual_contrib: 1,
      pac_contrib: 1, ballot_status: 1, ocd_id: 1,
    }).sort({ receipts: -1 }).limit(25).lean();
  }

  if (ocdFilter.length) {
    const mq = { ocd_id: { $in: ocdFilter } };
    if (parsed.offices.length) mq.office = { $in: parsed.offices };
    if (parsed.years.length) mq.year = { $in: parsed.years };
    out.margins = await M("us_margins").find(mq, {
      _id: 0, ocd_id: 1, year: 1, office: 1, district: 1, election_type: 1,
      margin: 1, winner_party: 1, votes: 1, total: 1, major_share: 1,
    }).sort({ year: -1 }).limit(25).lean();

    out.divisions = await M("us_divisions").collection.find(
      { _id: { $in: ocdFilter } }, { projection: { centroid: 0, aliases: 0, bbox: 0 } },
    ).limit(8).toArray();
  }
  return out;
}

/** Compact, labelled context. Field names are kept so the model can cite them. */
function renderContext(r) {
  const L = [];
  const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`);

  if (r.divisions.length) {
    L.push("## Places");
    for (const d of r.divisions) L.push(`- ${d.name} (${d.level}) ${d._id}`);
  }
  if (r.officeholders.length) {
    L.push("\n## Current officeholders");
    for (const h of r.officeholders) {
      const bits = [`${h.name} — ${h.party}, ${h.office}`,
        h.state && `state ${h.state}`, h.district && `district ${h.district}`,
        h.term_start && `serving since ${h.term_start}`,
        h.term_end && `term ends ${h.term_end}`,
        h.next_election && `next on the ballot ${h.next_election}`,
        h.ideology?.nominate_dim1 != null
          && `DW-NOMINATE ${h.ideology.nominate_dim1.toFixed(2)} (-1 liberal .. +1 conservative, from ${h.ideology.votes_analysed} roll-call votes)`,
        h.finance && `raised ${money(h.finance.receipts)}, cash ${money(h.finance.cash_on_hand)} (${h.finance.cycle} cycle)`,
        h.committees?.length && `${h.committees.length} committee assignments: ${h.committees.slice(0, 4).map((c) => c.name).join("; ")}`,
      ].filter(Boolean);
      L.push(`- ${bits.join(" | ")}`);
    }
  }
  if (r.candidates.length) {
    L.push("\n## Filed candidates (FEC, this cycle)");
    for (const c of r.candidates) {
      L.push(`- ${c.name} — ${c.party}, ${c.status ?? "filed"}, ${c.office}`
        + `${c.district ? ` district ${c.district}` : ""}${c.state ? `, ${c.state}` : ""}`
        + ` | raised ${money(c.receipts)} | cash ${money(c.cash_on_hand)}`
        + ` | ballot_status=${c.ballot_status}`);
    }
  }
  if (r.margins.length) {
    L.push("\n## Certified past results");
    for (const m of r.margins) {
      const who = m.margin == null ? "n/a"
        : `${m.margin > 0 ? "R" : "D"}+${Math.abs(m.margin).toFixed(1)}`;
      L.push(`- ${m.year} ${m.office}${m.district ? ` d${m.district}` : ""} (${m.election_type})`
        + ` in ${m.ocd_id.replace("ocd-division/country:us/", "")}: margin ${who},`
        + ` DEM ${m.votes.DEM.toLocaleString()} / REP ${m.votes.REP.toLocaleString()}`
        + ` / other ${m.votes.OTH.toLocaleString()}, total ${m.total.toLocaleString()}`);
    }
  }
  return L.join("\n");
}

const SYSTEM = `You answer questions about US elections for a public awareness tool.

Rules, in order of importance:
1. Use ONLY the records provided. If they do not contain the answer, say plainly
   what is missing and what the reader could look at instead. Never guess a name,
   a number, a date or an outcome.
2. Never predict or imply who will win. You may state margins, money raised and
   who has filed, because those are recorded facts.
3. A candidate "filed" with the FEC is registered, NOT confirmed on the ballot.
   Say "filed" and never "on the ballot" unless a record says otherwise.
4. DW-NOMINATE summarises how someone voted on roll calls. It is not a statement
   of their positions on issues, and must never be described as one.
5. Vote totals for some state-years are known to be inflated by duplicate source
   filings; margins are reliable because they are ratios. Prefer margins, and
   flag a total if you cite one.
6. Be brief and concrete — two or three short paragraphs at most, plain prose,
   no preamble. Quote the numbers you used.`;

async function ask(req, question, ocdId) {
  const parsed = parseQuestion(question);
  const records = await retrieve(req, parsed, ocdId);
  const context = renderContext(records);
  const found = records.officeholders.length + records.candidates.length
    + records.margins.length;

  if (!found) {
    return {
      answer: "I could not find any records matching that. Try naming a state, "
        + "a district like TX-28, an office (Senate, House, governor, president), "
        + "or a sitting member of Congress.",
      grounded: false, parsed, sources: records,
    };
  }

  const body = {
    model: LLM_MODEL,
    max_tokens: 700,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Question: ${question}\n\nRecords:\n${context}` },
    ],
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  let answer;
  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    const j = await res.json();
    answer = j?.choices?.[0]?.message?.content?.trim();
  } finally {
    clearTimeout(timer);
  }
  if (!answer) throw new Error("empty response from language model");

  return { answer, grounded: true, parsed, sources: records };
}

module.exports = { ask, parseQuestion, renderContext };
