#!/usr/bin/env node
/**
 * Copy the election corpus from MongoDB into Supabase (Postgres).
 *
 * The Mongo side is authoritative: python/us_election writes it, and this
 * schema is a reloadable derivative. So every table is upserted on its
 * primary key — running this twice is a no-op, and re-running after a fresh
 * ingest updates in place rather than duplicating.
 *
 * Uses `pg` over a direct connection rather than supabase-js. This is a bulk
 * load of ~480k rows; PostgREST is a request-per-batch REST API and the wrong
 * tool for it. The direct connection also runs as the service role, which is
 * what lets it write through the read-only RLS policies.
 *
 * Usage:
 *   node scripts/mongo_to_supabase.js --dry-run
 *   node scripts/mongo_to_supabase.js --only us_margins --limit 5000
 *   node scripts/mongo_to_supabase.js            # everything
 *
 * Env: MONGODB_URL (server/.env), SUPABASE_DB_URL
 */

const path = require("node:path");
const SERVER = path.join(__dirname, "..", "server");
require(path.join(SERVER, "node_modules", "dotenv"))
  .config({ path: path.join(SERVER, ".env") });
const { MongoClient } = require(path.join(SERVER, "node_modules", "mongodb"));
const { Client } = require(path.join(SERVER, "node_modules", "pg"));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = has("--dry-run");
const PRUNE = has("--prune");
const ONLY = val("--only", null);
const LIMIT = Number(val("--limit", 0)) || 0;
const BATCH = 1000;

const MONGO = process.env.MONGODB_URL;
const PG = process.env.SUPABASE_DB_URL;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Transport. `pg` is the right tool for a full load and is preferred whenever
 * a database password is available. But a project linked with an access token
 * has no password to hand — that is the normal state of a freshly linked
 * cloud project — so PostgREST is the fallback rather than a hard stop. It is
 * slower (a request per batch) and cannot report table sizes, which is why it
 * is second choice and not the default.
 */
const TRANSPORT = val("--transport", PG ? "pg" : "rest");
if (!MONGO) fail("MONGODB_URL is not set (expected in server/.env)");
if (!DRY && TRANSPORT === "pg" && !PG) {
  fail("SUPABASE_DB_URL is not set.\n"
    + "  Local: supabase start, then use the DB URL it prints\n"
    + "         (postgresql://postgres:postgres@127.0.0.1:54322/postgres)\n"
    + "  Cloud: Project Settings → Database → Connection string\n"
    + "  Or:    --transport rest (uses SUPABASE_URL + SERVICE_ROLE_KEY)");
}
if (!DRY && TRANSPORT === "rest" && !(SB_URL && SB_KEY)) {
  fail("--transport rest needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
}
function fail(m) { console.error(m); process.exit(1); }

/** GeoJSON Point → a PostGIS geography literal, or null. */
const point = (g) => {
  const c = g && g.coordinates;
  return Array.isArray(c) && c.length === 2 && Number.isFinite(c[0])
    ? `SRID=4326;POINT(${c[0]} ${c[1]})` : null;
};
const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== ""
  ? Math.trunc(Number(v)) : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== ""
  ? Number(v) : null);
const arr = (v) => (Array.isArray(v) ? v.map(String) : null);

/**
 * A BSON date arrives as a JS Date. Handing that straight to a TEXT column
 * lets pg format it in the session's timezone, so "2026-09-17T22:12:17.803Z"
 * was stored as "2026-09-18T00:12:17.803+02:00" — the same instant, rendered
 * differently, which made the Postgres backend disagree with Mongo on a field
 * the client prints verbatim. Normalise to ISO-8601 Z.
 */
const txt = (v) => {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

/**
 * Each table: the Mongo collection, the Postgres columns, and a row mapper.
 * `geo` names columns that must be cast to geography on insert — they arrive
 * as EWKT strings and Postgres needs to be told, since a text parameter will
 * not implicitly become a geography.
 */
const SPECS = [
  {
    table: "us_divisions",
    cols: ["ocd_id", "level", "name", "state", "geoid", "match_key",
      "parent_ocd", "aliases", "bbox", "centroid"],
    geo: ["centroid"],
    key: "ocd_id",
    map: (d) => [d._id, d.level, d.name, d.state ?? null, d.geoid ?? null,
      d.match_key ?? null, d.parent_ocd ?? null, arr(d.aliases),
      j(d.bbox), point(d.centroid)],
  },
  {
    table: "us_margins",
    cols: ["id", "ocd_id", "level", "office", "year", "election_type",
      "district", "margin", "winner_party", "votes", "total", "major_share",
      "source", "source_files"],
    key: "id",
    map: (d) => [d._id, d.ocd_id, d.level, d.office, int(d.year),
      d.election_type, int(d.district), num(d.margin), d.winner_party ?? null,
      j(d.votes), int(d.total), num(d.major_share), d.source ?? null,
      int(d.source_files)],
  },
  {
    table: "us_race_candidates",
    cols: ["id", "ocd_id", "office", "year", "election_type", "district",
      "name", "party", "votes", "vote_share", "led_in_data", "bioguide",
      "photo", "photo_source"],
    key: "id",
    map: (d) => [d._id, d.ocd_id, d.office, int(d.year), d.election_type,
      int(d.district), d.name, d.party ?? null, int(d.votes),
      num(d.vote_share), d.led_in_data ?? null, d.bioguide ?? null,
      d.photo ?? null, d.photo_source ?? null],
  },
  {
    table: "us_candidates",
    cols: ["id", "fec_id", "ocd_id", "name", "party", "party_raw", "office",
      "level", "state", "district", "cycle", "election_yr", "status",
      "ballot_status", "receipts", "cash_on_hand", "individual_contrib",
      "pac_contrib", "disbursements", "debts", "pcc", "coverage_end",
      "bioguide", "photo", "photo_source", "wikidata", "home"],
    key: "id",
    map: (d) => [d._id, d.fec_id, d.ocd_id, d.name, d.party ?? null,
      d.party_raw ?? null, d.office ?? null, d.level ?? null, d.state ?? null,
      int(d.district), int(d.cycle), int(d.election_yr), d.status ?? null,
      d.ballot_status ?? null, num(d.receipts), num(d.cash_on_hand),
      num(d.individual_contrib), num(d.pac_contrib), num(d.disbursements),
      num(d.debts), d.pcc ?? null, txt(d.coverage_end), d.bioguide ?? null,
      d.photo ?? null, d.photo_source ?? null, d.wikidata ?? null, j(d.home)],
  },
  {
    table: "us_officeholders",
    cols: ["id", "ocd_id", "bioguide", "name", "party", "party_raw", "office",
      "level", "state", "district", "senate_class", "term_start", "term_end",
      "next_election", "up_next_cycle", "url", "photo", "photo_source",
      "fec_ids", "committees", "finance", "ideology", "updated_at"],
    key: "id",
    map: (d) => [d._id, d.ocd_id, d.bioguide ?? null, d.name, d.party ?? null,
      d.party_raw ?? null, d.office ?? null, d.level ?? null, d.state ?? null,
      int(d.district), int(d.senate_class), txt(d.term_start),
      txt(d.term_end), txt(d.next_election), d.up_next_cycle ?? null,
      d.url ?? null, d.photo ?? null, d.photo_source ?? null, arr(d.fec_ids),
      j(d.committees), j(d.finance), j(d.ideology), txt(d.updated_at)],
  },
  {
    table: "us_polling_places",
    filter: { loc: { $exists: true } },
    cols: ["id", "ocd_id", "name", "address", "precinct_name", "location_type",
      "county_name", "county_source", "state", "year", "election_date",
      "geo_match", "source", "source_date", "loc"],
    geo: ["loc"],
    key: "id",
    map: (d) => [d._id, d.ocd_id ?? null, d.name ?? null, d.address ?? null,
      d.precinct_name ?? null, d.location_type ?? null, d.county_name ?? null,
      d.county_source ?? null, d.state ?? null, int(d.year),
      txt(d.election_date), d.geo_match ?? null, d.source ?? null,
      txt(d.source_date), point(d.loc)],
  },
  {
    table: "us_election_news",
    cols: ["id", "event_id", "ocd_id", "person", "person_kind", "office",
      "party", "state", "district", "title", "url", "image", "source",
      "total_sources", "published_at", "matched_at", "spectrum"],
    key: "id",
    map: (d) => [d._id, d.event_id ?? null, d.ocd_id, d.person ?? null,
      d.person_kind ?? null, d.office ?? null, d.party ?? null,
      d.state ?? null, int(d.district), d.title ?? null, d.url ?? null,
      d.image ?? null, d.source ?? null, int(d.total_sources),
      txt(d.published_at), txt(d.matched_at), j(d.spectrum)],
  },
  {
    table: "us_voter_info",
    cols: ["state", "name", "election_office_url", "source", "source_url",
      "http_status", "is_state", "url_corrected", "checked_at"],
    key: "state",
    map: (d) => [d._id, d.name ?? null, d.election_office_url ?? null,
      d.source ?? null, d.source_url ?? null,
      d.http_status === null || d.http_status === undefined
        ? null : String(d.http_status),
      d.is_state ?? null, d.url_corrected ?? null, txt(d.checked_at)],
  },
];

/** INSERT ... ON CONFLICT DO UPDATE for one batch. */
function statement(spec, rows) {
  const { cols, geo = [], key } = spec;
  const params = [];
  const tuples = rows.map((row) => {
    const ph = row.map((v, i) => {
      params.push(v);
      const p = `$${params.length}`;
      return geo.includes(cols[i]) ? `${p}::geography` : p;
    });
    return `(${ph.join(",")})`;
  });
  const updates = cols.filter((c) => c !== key)
    .map((c) => `${c} = excluded.${c}`).join(", ");
  return {
    text: `insert into ${spec.table} (${cols.join(",")}) values ${tuples.join(",")}`
      + ` on conflict (${key}) do update set ${updates}`,
    values: params,
  };
}

/**
 * Writers. Both upsert on the primary key, so either is safe to re-run.
 *
 * The specs describe a row positionally (cols + map -> array) because that is
 * what a parameterised multi-row INSERT wants. PostgREST wants objects, so the
 * REST writer zips the two back together rather than the specs carrying two
 * shapes.
 */
async function makeWriter() {
  if (TRANSPORT === "pg") {
    const pg = new Client({
      connectionString: PG,
      // Supabase terminates TLS with its own CA. Verifying it would mean
      // shipping the bundle alongside; this is a one-way load of data that is
      // already public.
      ssl: /localhost|127\.0\.0\.1/.test(PG) ? false : { rejectUnauthorized: false },
    });
    await pg.connect();
    return {
      kind: "pg",
      async write(spec, rows) {
        const { text, values } = statement(spec, rows);
        await pg.query(text, values);
      },
      count: async (t) =>
        Number((await pg.query(`select count(*)::bigint n from ${t}`)).rows[0].n),
      async keys(t, key) {
        return (await pg.query(`select ${key} k from ${t}`)).rows.map((r) => r.k);
      },
      async remove(t, key, ids) {
        for (let i = 0; i < ids.length; i += 500) {
          await pg.query(`delete from ${t} where ${key} = any($1)`,
                         [ids.slice(i, i + 500)]);
        }
      },
      async sizes() {
        const db = await pg.query(
          "select pg_size_pretty(pg_database_size(current_database())) s,"
          + " pg_database_size(current_database()) b");
        const t = await pg.query(`
          select relname, pg_size_pretty(pg_total_relation_size(c.oid)) size,
                 pg_total_relation_size(c.oid) bytes
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
          order by pg_total_relation_size(c.oid) desc`);
        return { database: db.rows[0].s, bytes: Number(db.rows[0].b), tables: t.rows };
      },
      close: () => pg.end(),
    };
  }

  const { createClient } = require(path.join(SERVER, "node_modules", "@supabase/supabase-js"));
  // supabase-js constructs a Realtime client inside createClient whether or
  // not you use it, and that wants a global WebSocket — which Node only ships
  // from 22. On 20 it throws before a row moves, so hand it `ws`. Nothing
  // here subscribes; this only lets the REST client be built.
  const sb = createClient(SB_URL, SB_KEY, {
    auth: { persistSession: false },
    realtime: { transport: require(path.join(SERVER, "node_modules", "ws")) },
  });
  return {
    kind: "rest",
    async write(spec, rows) {
      const objs = rows.map((r) =>
        Object.fromEntries(spec.cols.map((c, i) => [c, r[i]])));
      const { error } = await sb.from(spec.table).upsert(objs, { onConflict: spec.key });
      if (error) throw new Error(`${spec.table}: ${error.message}`);
    },
    async count(t) {
      const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
      if (error) throw new Error(`${t}: ${error.message}`);
      return count ?? 0;
    },
    async keys(t, key) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(t).select(key).range(from, from + 999);
        if (error) throw new Error(`${t}: ${error.message}`);
        if (!data || !data.length) break;
        out.push(...data.map((r) => r[key]));
        if (data.length < 1000) break;
      }
      return out;
    },
    async remove(t, key, ids) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await sb.from(t).delete().in(key, ids.slice(i, i + 200));
        if (error) throw new Error(`${t}: ${error.message}`);
      }
    },
    // Table sizes need catalogue SQL, which PostgREST does not expose.
    sizes: async () => null,
    close: async () => {},
  };
}

(async () => {
  const specs = ONLY ? SPECS.filter((s) => s.table === ONLY) : SPECS;
  if (!specs.length) fail(`--only ${ONLY}: not a known table`);

  const mongo = new MongoClient(MONGO);
  await mongo.connect();
  const mdb = mongo.db();

  const writer = DRY ? null : await makeWriter();
  if (writer) console.log(`transport=${writer.kind}`);

  console.log(DRY ? "DRY RUN — nothing will be written\n" : "");
  const report = [];

  for (const spec of specs) {
    const col = mdb.collection(spec.table);
    const src = spec.filter
      ? await col.countDocuments(spec.filter)
      : await col.estimatedDocumentCount();
    if (!src) {
      console.log(`${spec.table}: source empty or absent — skipped`);
      report.push({ table: spec.table, mongo: 0, pg: null, skipped: true });
      continue;
    }

    const want = LIMIT ? Math.min(LIMIT, src) : src;
    process.stdout.write(`${spec.table}: ${want.toLocaleString()} rows `);

    // Unplaced rows cannot be drawn and are a quarter of the collection;
    // copying them would spend a free tier's storage on invisible data.
    const filter = spec.filter || {};
    let cursor = col.find(filter);
    if (LIMIT) cursor = cursor.limit(LIMIT);

    let done = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      if (!DRY) await writer.write(spec, batch);
      done += batch.length;
      batch = [];
      process.stdout.write(".");
    };

    for await (const doc of cursor) {
      batch.push(spec.map(doc));
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    /**
     * Upserting alone cannot converge.
     *
     * Several of these collections have keys that encode their CONTENT — a
     * news row's id carries the event, the division and the person — so when
     * the matcher re-assigns an article to a different district it writes a
     * NEW key and abandons the old one. The old row is not updated by the
     * upsert; it is simply never mentioned again, and it lingers in Postgres
     * forever. Measured: after a clean re-sync, Postgres held 127 news rows
     * against Mongo's 125, and the two extra divisions surfaced as phantom
     * map points that Mongo did not draw.
     *
     * So --prune deletes what Mongo no longer has. It is off by default
     * because it is destructive, and refused under --limit, where "absent
     * from this run" means "not fetched" rather than "deleted upstream".
     */
    if (PRUNE && !DRY) {
      if (LIMIT) {
        console.log("\n  --prune ignored under --limit (a partial read cannot"
                    + " distinguish deleted from not-fetched)");
      } else {
        const live = new Set();
        for await (const d of col.find(filter, { projection: { _id: 1 } })) {
          live.add(String(d._id));
        }
        const have = await writer.keys(spec.table, spec.key);
        const stale = have.filter((k) => !live.has(String(k)));
        if (stale.length) {
          await writer.remove(spec.table, spec.key, stale);
          console.log(`\n  pruned ${stale.length} row(s) absent from Mongo`);
        }
      }
    }

    let dst = null;
    if (!DRY) {
      dst = await writer.count(spec.table);
    }
    console.log(` ${done.toLocaleString()} written`
      + (dst === null ? "" : `, table now ${dst.toLocaleString()}`));
    report.push({ table: spec.table, mongo: src, written: done, pg: dst });
  }

  console.log("\n── row counts ─────────────────────────────────");
  for (const r of report) {
    if (r.skipped) { console.log(`  ${r.table.padEnd(20)} skipped`); continue; }
    // Under --limit the two are EXPECTED to differ; only a full run is a
    // like-for-like comparison, so only that one gets a verdict.
    const verdict = DRY ? "" : (LIMIT ? "  (partial)"
      : (r.pg === r.mongo ? "  ✓" : `  ✗ expected ${r.mongo.toLocaleString()}`));
    console.log(`  ${r.table.padEnd(20)} mongo ${String(r.mongo).padStart(7)}`
      + `   pg ${String(r.pg ?? "-").padStart(7)}${verdict}`);
  }

  // Real occupied size, so a full-load decision is made on a measurement
  // rather than an estimate. Only the direct connection can read this.
  if (writer) {
    const sz = await writer.sizes();
    if (sz) {
      console.log(`\n── size ───────────────────────────────────────`);
      console.log(`  database ${sz.database}`);
      for (const t of sz.tables) {
        console.log(`  ${t.relname.padEnd(22)} ${String(t.size).padStart(9)}`);
      }
    }
  }

  await mongo.close();
  if (writer) await writer.close();
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
