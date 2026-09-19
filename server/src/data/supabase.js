/**
 * Supabase (Postgres) implementation of the ElectionRepo contract.
 *
 * Reads through supabase-js: `.from()` for straightforward selects, `.rpc()`
 * for the aggregates PostgREST cannot express (see supabase/migrations).
 *
 * Two things about this transport shape the code more than anything else:
 *
 * 1. PostgREST caps a response at `max_rows` (1000 by default, and that is
 *    what the cloud project serves). A county-level margins cut is 3,013 rows
 *    and every division-points call is thousands more, so any select that can
 *    exceed a page MUST be paged — a silent truncation here is a map that
 *    renders two thirds of the country and reports no error.
 *
 * 2. PostGIS columns serialise as hex EWKB, not GeoJSON. Selecting `centroid`
 *    hands back "0101000020E6100000…" and the layer renders nothing. Anything
 *    needing coordinates goes through the `us_divisions_geo` view or the
 *    polling-points RPC, both of which project st_x/st_y as plain numbers.
 *
 * The three point-layer aggregations (races, candidate homes, news) are done
 * in JS rather than SQL. That is deliberate: each carries correctness logic
 * that was expensive to get right — de-duplicating the 88 candidates who hold
 * two FEC ids under one committee, averaging coverage tilt only over rated
 * outlets — and re-deriving it in SQL would be a second place for it to drift.
 * The inputs are a few thousand rows, so the cost is small and the risk of
 * the two backends disagreeing is what actually matters.
 */

const path = require("node:path");
const { TABLES } = require("./contract");

const PAGE = 1000;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase backend selected but not configured. Set SUPABASE_URL and "
      + "SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in server/.env, "
      + "or set DATA_BACKEND=mongo.",
    );
  }
  const { createClient } = require("@supabase/supabase-js");
  const opts = { auth: { persistSession: false } };
  // supabase-js builds a Realtime client inside createClient whether or not
  // it is used, and that needs a global WebSocket — which Node ships only
  // from 22. On 20 this throws before the first query, so supply `ws`.
  // Nothing here subscribes; this exists purely to let the client construct.
  if (typeof globalThis.WebSocket === "undefined") {
    try {
      opts.realtime = { transport: require("ws") };
    } catch {
      /* Node >= 22, or ws absent and WebSocket native — let it try. */
    }
  }
  return createClient(url, key, opts);
}

/**
 * Read every row of a query, a page at a time.
 *
 * `build` is called per page so each gets a fresh PostgREST query object —
 * they are single-use, and reusing one silently returns the first page again.
 */
async function all(build, cap = 100000) {
  const out = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const feat = (lng, lat, properties) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties,
});

/** Strip the synthetic primary key the Postgres mirror adds. */
const noId = (r) => { const { id, ...rest } = r; return rest; };

/**
 * Built at require time, not lazily, and exported as a plain object so this
 * module has the SAME SHAPE as ./mongo — which exports an instance, not a
 * factory. data/index.js assigns whichever it required straight to its own
 * export, so a factory here would hand the controller a function and every
 * call would fail at the first `.stats()`.
 *
 * Constructing eagerly also means a missing SUPABASE_URL kills the process at
 * startup with the message index.js wraps, rather than turning every request
 * into a 500 an hour later.
 */
function buildRepo() {
  const sb = client();

  const rpc = async (fn, args = {}) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  /** ocd_id -> {name, state, level, lng, lat} for the ids given. */
  async function geoFor(ids) {
    const byId = new Map();
    // 50, not 200. PostgREST puts `in.(...)` in the QUERY STRING, and an OCD
    // id is ~48 characters, so 200 of them is a ~9.6 KB URI — past the 8 KB
    // the gateway accepts. It failed as a flat "URI too long" on /races, the
    // one endpoint whose division count is large enough to reach the second
    // chunk, so the map lost its whole race overlay on Supabase while every
    // smaller endpoint looked fine.
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data, error } = await sb.from("us_divisions_geo")
        .select("ocd_id,name,state,level,lng,lat").in("ocd_id", chunk);
      if (error) throw new Error(error.message);
      for (const d of data || []) byId.set(d.ocd_id, d);
    }
    return byId;
  }

  return {
    backend: "supabase",

    async latestYear({ level, office, electionType }) {
      return (await rpc("election_latest_year", {
        p_level: level, p_office: office,
        p_election_type: electionType, p_table: "margins",
      })) ?? null;
    },

    async margins({ level, office, electionType, year, minMajorShare }) {
      const rows = await all(() => {
        let q = sb.from(TABLES.margins)
          .select("ocd_id,margin,winner_party,votes,total,major_share")
          .eq("level", level).eq("office", office)
          .eq("election_type", electionType).eq("year", year);
        if (minMajorShare > 0) q = q.gte("major_share", minMajorShare);
        return q;
      });
      return rows;
    },

    years({ level, electionType = "general" }) {
      return rpc("election_years", { p_level: level, p_election_type: electionType });
    },

    /**
     * Most recent cycle holding CANDIDATE rows for this cut.
     *
     * Distinct from latestYear, which reads us_margins: the two feeds do not
     * cover the same cycles, so asking margins for the candidate year opens
     * the panel on a cycle with no names in it. The RPC takes p_table for
     * exactly this reason.
     */
    async latestCandidateYear({ level, office, electionType }) {
      return (await rpc("election_latest_year", {
        p_level: level, p_office: office,
        p_election_type: electionType, p_table: "candidates",
      })) ?? null;
    },

    async topCandidates({ level, office, electionType, year }) {
      return (await rpc("election_top_candidates", {
        p_level: level, p_office: office,
        p_election_type: electionType, p_year: year ?? null,
      })) ?? [];
    },

    async division(ocdId, limit = 40) {
      const one = async (t, sel, tweak) => {
        let q = sb.from(t).select(sel).eq("ocd_id", ocdId);
        if (tweak) q = tweak(q);
        const { data, error } = await q;
        if (error) throw new Error(`${t}: ${error.message}`);
        return data || [];
      };

      const [divRows, history, holders, candidates, pastCandidates] = await Promise.all([
        (async () => {
          const { data, error } = await sb.from(TABLES.divisions)
            .select("ocd_id,level,name,state,geoid,match_key,parent_ocd,bbox")
            .eq("ocd_id", ocdId).limit(1);
          if (error) throw new Error(error.message);
          return data || [];
        })(),
        one(TABLES.margins,
          "year,office,district,election_type,margin,winner_party,votes,total,major_share",
          (q) => q.order("year", { ascending: false })
                  .order("office", { ascending: true }).limit(limit)),
        one(TABLES.officeholders,
          "name,party,office,next_election,term_end,term_start,senate_class,url,bioguide,ideology,committees,finance,photo"),
        one(TABLES.candidates,
          "name,party,status,office,cycle,receipts,cash_on_hand,individual_contrib,pac_contrib,ballot_status,coverage_end,photo,bioguide,fec_id",
          (q) => q.order("cycle", { ascending: false })
                  .order("receipts", { ascending: false, nullsFirst: false }).limit(40)),
        one(TABLES.raceCandidates,
          "year,office,district,name,party,votes,vote_share,led_in_data,photo,bioguide",
          (q) => q.eq("election_type", "general")
                  .order("year", { ascending: false })
                  .order("votes", { ascending: false, nullsFirst: false }).limit(80)),
      ]);

      // The division document keeps Mongo's `_id` name for the id so the
      // client's existing reads keep working across both backends.
      const division = divRows.length
        ? (() => { const { ocd_id, ...rest } = divRows[0]; return { _id: ocd_id, ...rest }; })()
        : null;

      // Bioguide, never the name: a name match put the wrong Begich on the
      // page once already. A candidate with no bioguide is simply not
      // flagged, which is correct for someone who has never held office.
      const sitting = new Set(holders.map((h) => h.bioguide).filter(Boolean));
      const flag = (r) => (r.bioguide && sitting.has(r.bioguide) ? { ...r, sitting: true } : r);

      return {
        division, history, holders,
        candidates: candidates.map(flag),
        pastCandidates: pastCandidates.map(flag),
      };
    },

    async divisionPoints({ level }) {
      const rows = await all(() => sb.from("us_divisions_geo")
        .select("ocd_id,name,state,lng,lat").eq("level", level));
      // A bare array, matching ./mongo — the controller wraps it with the
      // level and count. Returning a {level,count,features} object here
      // nested a FeatureCollection inside data.features and every layer
      // silently drew nothing.
      return rows.map((d) => feat(d.lng, d.lat, {
          ocd_id: d.ocd_id,
          // Census calls every district "Congressional District 4"; on a
          // national map 435 of those read identically.
          label: level === "cd" && d.state
            ? `${d.state}-${String(d.name).replace(/\D+/g, "") || "AL"}`
            : d.name,
          state: d.state,
        }));
    },

    async officeholders({ office, state, upBy }) {
      const rows = await all(() => {
        let q = sb.from(TABLES.officeholders)
          .select("ocd_id,office,state,district,name,party,next_election,term_end,senate_class,url,photo,bioguide");
        if (office) q = q.eq("office", office);
        if (state) q = q.eq("state", String(state).toUpperCase());
        if (upBy) q = q.lte("next_election", String(upBy));
        return q;
      });
      return rows;
    },

    // Destructured, matching mongo.js. The positional form this used to
    // take made `candidateByFec({fecId})` bind the whole object to
    // `fecId`, so the query filtered on the string "[object Object]",
    // matched nothing, and returned an empty panel — a wrong answer with
    // no error, on the Supabase deployment only.
    async candidateByFec({ fecId, name, ocdId } = {}) {
      let q = sb.from(TABLES.candidates).select("*");
      q = fecId ? q.eq("fec_id", String(fecId)) : q.eq("name", String(name));
      if (!fecId && ocdId) q = q.eq("ocd_id", String(ocdId));
      const { data, error } = await q.limit(1);
      if (error) throw new Error(error.message);
      const candidate = data && data.length ? noId(data[0]) : null;
      if (!candidate) return { candidate: null, record: null, opponents: [], history: [] };

      const HOLDER = "name,party,office,district,ocd_id,term_start,term_end,next_election,senate_class,url,ideology,committees,finance,bioguide,photo";
      let record = null;
      if (candidate.bioguide) {
        const r = await sb.from(TABLES.officeholders).select(HOLDER)
          .eq("bioguide", candidate.bioguide).limit(1);
        if (r.error) throw new Error(r.error.message);
        record = r.data && r.data.length ? r.data[0] : null;
      } else if (candidate.state) {
        // No bioguide: fall back to a loose name key within the state. The
        // asymmetry is deliberate — a candidate that HAS a bioguide and
        // matches none is definitively not a sitting member, and matching on
        // name there would reintroduce the wrong-person merge.
        const r = await sb.from(TABLES.officeholders).select(HOLDER)
          .eq("state", candidate.state);
        if (r.error) throw new Error(r.error.message);
        const key = nameKey(candidate.name);
        record = (r.data || []).find((h) => nameKey(h.name) === key) || null;
      }

      const opp = await sb.from(TABLES.candidates)
        .select("name,party,status,receipts,fec_id,photo")
        .eq("ocd_id", candidate.ocd_id).eq("cycle", candidate.cycle)
        .neq("fec_id", candidate.fec_id)
        .order("receipts", { ascending: false, nullsFirst: false }).limit(12);
      if (opp.error) throw new Error(opp.error.message);

      const hist = await sb.from(TABLES.margins)
        .select("year,office,margin,winner_party,total")
        .eq("ocd_id", candidate.ocd_id).eq("election_type", "general")
        .order("year", { ascending: false }).limit(6);
      if (hist.error) throw new Error(hist.error.message);

      return {
        candidate, record,
        opponents: opp.data || [],
        history: hist.data || [],
      };
    },

    async searchPeople(q) {
      const term = String(q || "").trim();
      if (term.length < 2) return [];
      // ilike, not a regex: PostgREST has no regex operator, and the trigram
      // index on name serves a contains-match.
      const pattern = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;

      const [c, h] = await Promise.all([
        sb.from(TABLES.candidates)
          .select("name,party,status,office,state,district,ocd_id,cycle,receipts,fec_id,photo,bioguide")
          .ilike("name", pattern)
          .order("receipts", { ascending: false, nullsFirst: false }).limit(15),
        sb.from(TABLES.officeholders)
          .select("name,party,office,state,district,ocd_id,next_election,photo,bioguide")
          .ilike("name", pattern).limit(10),
      ]);
      if (c.error) throw new Error(c.error.message);
      if (h.error) throw new Error(h.error.message);

      const cands = c.data || [];
      const seenBio = new Set(cands.map((x) => x.bioguide).filter(Boolean));
      const seenName = new Set(cands.map((x) => nameKey(x.name)));
      return [
        ...cands.map((x) => ({ ...x, kind: "candidate" })),
        ...(h.data || [])
          .filter((x) => !(x.bioguide && seenBio.has(x.bioguide))
                      && !seenName.has(nameKey(x.name)))
          .map((x) => ({ ...x, kind: "officeholder" })),
      ];
    },

    async racePoints({ cycle, office, minReceipts = 5000 }) {
      const rows = await all(() => {
        let q = sb.from(TABLES.candidates)
          .select("ocd_id,office,state,district,name,party,status,receipts")
          .eq("cycle", cycle);
        if (office) q = q.eq("office", office);
        if (minReceipts > 0) q = q.gte("receipts", minReceipts);
        return q;
      });
      if (!rows.length) return [];

      const groups = new Map();
      for (const r of rows) {
        const k = `${r.ocd_id}|${r.office}`;
        if (!groups.has(k)) {
          groups.set(k, {
            ocd_id: r.ocd_id, office: r.office, state: r.state,
            district: r.district, candidates: 0, total_raised: 0, who: [],
          });
        }
        const g = groups.get(k);
        g.candidates += 1;
        g.total_raised += r.receipts || 0;
        g.who.push(r);
      }

      const geo = await geoFor([...new Set(rows.map((r) => r.ocd_id))]);
      const features = [];
      for (const g of groups.values()) {
        const d = geo.get(g.ocd_id);
        if (!d) continue;
        g.who.sort((a, b) => (b.receipts || 0) - (a.receipts || 0));
        const top = g.who.slice(0, 4);
        // Which party has raised most here — the only funding signal the bulk
        // filings support, and explicitly NOT a prediction of the outcome.
        const byParty = {};
        for (const c of top) byParty[c.party] = (byParty[c.party] || 0) + (c.receipts || 0);
        const lead = Object.entries(byParty).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "OTH";
        features.push(feat(d.lng, d.lat, {
          ocd_id: g.ocd_id, office: g.office, name: d.name,
          label: g.office === "us_house" && g.state && g.district
            ? `${g.state}-${g.district}` : d.name,
          level: d.level, state: g.state, district: g.district,
          candidates: g.candidates,
          total_raised: Math.round(g.total_raised),
          lead_party: lead,
          top: top.map((c) => `${c.name}|${c.party}|${Math.round(c.receipts || 0)}`).join(";"),
        }));
      }
      return features;
    },

    async candidatePlaces({ cycle, limit = 600 }) {
      const rows = await all(() => sb.from(TABLES.candidates)
        .select("name,party,office,district,ocd_id,fec_id,receipts,pcc,bioguide,home")
        .eq("cycle", cycle).not("home->>lat", "is", null));

      const groups = new Map();
      for (const r of rows) {
        const h = r.home || {};
        if (h.lat === undefined || h.lat === null) continue;
        const k = `${h.city}|${h.state}`;
        if (!groups.has(k)) {
          groups.set(k, {
            city: h.city, state: h.state,
            lat: Number(h.lat), lng: Number(h.lng),
            po_box: 0, who: [],
          });
        }
        const g = groups.get(k);
        if (h.po_box === true) g.po_box += 1;
        g.who.push(r);
      }

      const out = [];
      for (const g of groups.values()) {
        // 88 candidates in the 2026 cycle hold two FEC ids sharing one
        // principal campaign committee — a House member who filed for Senate
        // keeps both — and the bulk file reports that committee's totals
        // under BOTH ids. Summing rows double-counts $177M nationally.
        // Identity is the committee where there is one: a committee belongs
        // to one candidate, which is how the duplication was found.
        const identity = (w) => (w.pcc && `pcc:${w.pcc}`)
          || (w.bioguide && `bio:${w.bioguide}`)
          || `name:${w.name}`;
        const byPerson = new Map();
        for (const w of g.who) {
          const k = identity(w);
          const prev = byPerson.get(k);
          if (!prev || (w.receipts || 0) > (prev.receipts || 0)) byPerson.set(k, w);
        }
        const who = [...byPerson.values()]
          .sort((a, b) => (b.receipts || 0) - (a.receipts || 0));
        const raised = who.reduce((s, w) => s + (w.receipts || 0), 0);
        // Party counts come off the de-duplicated list too, or dem + rep can
        // exceed the candidate count and the readout contradicts itself.
        const dem = who.filter((w) => w.party === "DEM").length;
        const rep = who.filter((w) => w.party === "REP").length;
        out.push({ g, who, raised, dem, rep });
      }

      out.sort((a, b) => b.raised - a.raised || b.who.length - a.who.length);
      const features = out.slice(0, limit).map(({ g, who, raised, dem, rep }) =>
        feat(g.lng, g.lat, {
          city: g.city, state: g.state, place: `${g.city}, ${g.state}`,
          candidates: who.length, raised: Math.round(raised),
          dem, rep, other: who.length - dem - rep, po_box: g.po_box,
          names: who.slice(0, 5).map((w) => w.name).join(", "),
          who: JSON.stringify(who.slice(0, 12).map((w) => ({
            name: w.name, party: w.party, office: w.office,
            district: w.district, ocd_id: w.ocd_id, fec_id: w.fec_id,
            receipts: w.receipts, pcc: w.pcc, bioguide: w.bioguide,
          }))),
        }));
      return features;
    },

    async newsPoints({ limit = 400 }) {
      const rows = await all(() => sb.from(TABLES.news)
        .select("ocd_id,person,title,published_at,spectrum"));

      const groups = new Map();
      for (const r of rows) {
        if (!groups.has(r.ocd_id)) {
          groups.set(r.ocd_id, {
            ocd_id: r.ocd_id, articles: 0, people: new Set(),
            left: 0, center: 0, right: 0, tiltSum: 0, rated: 0, unrated: 0,
            latest: null, headline: null,
          });
        }
        const g = groups.get(r.ocd_id);
        const s = r.spectrum || {};
        g.articles += 1;
        if (r.person) g.people.add(r.person);
        g.left += s.left || 0;
        g.center += s.center || 0;
        g.right += s.right || 0;
        g.tiltSum += (s.tilt || 0) * (s.rated || 0);
        g.rated += s.rated || 0;
        g.unrated += s.unrated || 0;
        if (g.headline === null) g.headline = r.title;
        if (r.published_at && (!g.latest || r.published_at > g.latest)) {
          g.latest = r.published_at;
        }
      }

      const ranked = [...groups.values()]
        .sort((a, b) => b.articles - a.articles).slice(0, limit);
      const geo = await geoFor(ranked.map((g) => g.ocd_id));

      const features = [];
      for (const g of ranked) {
        const d = geo.get(g.ocd_id);
        if (!d) continue;
        // Null when nothing carried a rating, rather than defaulting to
        // centre: "unknown" and "balanced" are different claims and must not
        // render the same.
        const tilt = g.rated > 0 ? g.tiltSum / g.rated : null;
        const people = [...g.people];
        features.push(feat(d.lng, d.lat, {
          ocd_id: g.ocd_id, name: d.name, state: d.state,
          articles: g.articles,
          people: people.slice(0, 4).join(", "),
          people_count: people.length,
          tilt: tilt === null ? null : Math.round(tilt * 1000) / 1000,
          rated: g.rated, unrated: g.unrated,
          left: g.left, center: g.center, right: g.right,
          headline: String(g.headline || "").slice(0, 140),
          latest: g.latest || null,
        }));
      }
      return features;
    },

    /**
     * Individual stories for the card rail, newest first.
     *
     * Ordered by `matched_at`, never `published_at`: the latter is the
     * relative string the source rendered ("2 hours ago"), which is fine to
     * show and impossible to sort. The spectrum blob is flattened here so the
     * client reads the same flat fields from either backend.
     */
    async newsArticles({ ocdId, limit = 60 } = {}) {
      let q = sb.from(TABLES.news)
        .select("ocd_id,title,url,image,source,published_at,matched_at,person,party,office,total_sources,spectrum");
      if (ocdId) q = q.eq("ocd_id", ocdId);
      const { data, error } = await q
        .order("matched_at", { ascending: false, nullsFirst: false })
        .limit(Math.max(1, Math.min(limit, 500)));
      if (error) throw new Error(`newsArticles: ${error.message}`);

      const rows = data || [];
      const geo = await geoFor([...new Set(rows.map((r) => r.ocd_id))]);
      return rows.map((r) => {
        const sp = r.spectrum || {};
        const d = geo.get(r.ocd_id);
        return {
          ocd_id: r.ocd_id,
          name: d ? d.name : null,
          state: d ? d.state : null,
          title: r.title,
          url: r.url,
          image: r.image,
          source: r.source,
          published_at: r.published_at,
          person: r.person,
          party: r.party,
          office: r.office,
          // Null rather than 0 when nothing carried a rating: "unknown" and
          // "balanced" are different claims and must not render the same.
          tilt: sp.rated > 0 && sp.tilt !== undefined && sp.tilt !== null
            ? sp.tilt : null,
          left: sp.left || 0,
          center: sp.center || 0,
          right: sp.right || 0,
          total_sources: r.total_sources ?? null,
        };
      });
    },

    async pollingPoints({ bbox, limit = 800, year }) {
      const [w, s, e, n] = bbox;
      const rows = await rpc("election_polling_points", {
        p_west: w, p_south: s, p_east: e, p_north: n,
        p_limit: limit, p_year: Number.isFinite(year) && year > 0 ? year : null,
      }) || [];
      return rows.map((r) => feat(r.lng, r.lat, {
          name: r.name, address: r.address, year: r.year,
          location_type: r.location_type, county: r.county_name,
          state: r.state, geo_match: r.geo_match,
          county_source: r.county_source,
        }));
    },

    async voterInfo(state) {
      const { data, error } = await sb.from(TABLES.voterInfo)
        .select("*").eq("state", String(state).toUpperCase()).limit(1);
      if (error) throw new Error(error.message);
      if (!data || !data.length) return null;
      // Keyed by `_id` on the Mongo side; keep that so callers need no branch.
      const { state: st, ...rest } = data[0];
      return { _id: st, ...rest };
    },

    capabilities: () => rpc("election_capabilities"),
    stats: () => rpc("election_stats"),

    async close() { /* supabase-js holds no pool to drain */ },
  };
}

module.exports = buildRepo();

/**
 * Loose name key for the one join that cannot use a bioguide.
 *
 * The two feeds spell the same person differently — "Eli Crane" against
 * "Elijah Crane", "Jim Himes" against "James A. Himes", Sanchez against
 * Sánchez, and the FEC's own "Neal Patrick Md, Facs Dunn". Kept byte-identical
 * to the Mongo path's helper so the two backends never disagree about who is
 * an incumbent.
 */
function nameKey(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z\s]/g, " ")
    .split(/\s+/).filter(Boolean).sort().join(" ");
}
