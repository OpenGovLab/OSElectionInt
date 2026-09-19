import { useEffect, useState } from "react";

import { apiService } from "@/lib/api";

/**
 * The frame around the map.
 *
 * A map on its own reads as a document. What makes a console feel like a
 * console is the furniture: a wordmark, a line of live telemetry, and a
 * status bar that keeps moving. OSIRIS does this well and the structure here
 * follows it — header strip, corner rails, footer ticker.
 *
 * Everything in the strip is REAL. The clock is the clock, the counts come
 * from the corpus, and the sources are the sources. Inventing a "SIGNAL:
 * NOMINAL" readout would be set dressing, and set dressing on a data tool
 * teaches a reader to distrust the numbers next to it.
 */

interface Stats { contests: number; divisions: number; candidates: number; places: number }

interface Holder { party: string; next_election?: string | null }
interface Chamber { dem: number; rep: number; oth: number; total: number }

/**
 * Election day 2026. Declared once, as a date rather than a countdown, so the
 * number on screen is derived from the clock and cannot go stale in a build
 * that ships the day before.
 */
const ELECTION_DAY = new Date("2026-11-03T00:00:00-05:00");

function useCountdown() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const ms = ELECTION_DAY.getTime() - now;
  const days = Math.ceil(ms / 86_400_000);
  return { days, past: ms < 0 };
}

/**
 * Seats held, by chamber.
 *
 * Counted from the officeholder feed rather than hardcoded, because a
 * hardcoded balance is wrong the first time someone resigns — and a number
 * this prominent being quietly wrong is worse than not showing it.
 */
function useChamber(office: string): Chamber | null {
  const [c, setC] = useState<Chamber | null>(null);
  useEffect(() => {
    let alive = true;
    apiService({ method: "get", url: `/us-election/officeholders?office=${office}` })
      .then((r) => {
        if (!alive) return;
        const rows: Holder[] = r?.data?.data?.rows ?? [];
        if (!rows.length) return;
        const out = { dem: 0, rep: 0, oth: 0, total: rows.length };
        for (const h of rows) {
          if (h.party === "DEM") out.dem += 1;
          else if (h.party === "REP") out.rep += 1;
          else out.oth += 1;
        }
        setC(out);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [office]);
  return c;
}

/** A seat bar: blue left, red right, independents as a slate sliver between. */
function SeatBar({ label, c }: { label: string; c: Chamber | null }) {
  if (!c) return null;
  const pct = (n: number) => `${(n / c.total) * 100}%`;
  return (
    <span className="flex items-center gap-1.5" title={
      `${label}: ${c.dem} Democrat, ${c.rep} Republican` +
      (c.oth ? `, ${c.oth} other` : "") + ` of ${c.total} seats`
    }>
      <span className="text-slate-500">{label}</span>
      <span className="tabular-nums text-blue-300">{c.dem}</span>
      <span className="flex h-[7px] w-16 overflow-hidden rounded-[2px] bg-slate-800">
        <span style={{ width: pct(c.dem) }} className="bg-blue-500" />
        <span style={{ width: pct(c.oth) }} className="bg-slate-500" />
        <span style={{ width: pct(c.rep) }} className="ml-auto bg-red-500" />
      </span>
      <span className="tabular-nums text-red-300">{c.rep}</span>
    </span>
  );
}

function useClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return t.toISOString().slice(11, 19);
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString();

export function ChromeHeader() {
  const [stats, setStats] = useState<Stats | null>(null);
  const zulu = useClock();
  const { days, past } = useCountdown();
  const senate = useChamber("us_senate");
  const house = useChamber("us_house");

  useEffect(() => {
    let alive = true;
    apiService({ method: "get", url: "/us-election/stats" })
      .then((r) => { if (alive) setStats(r?.data?.data ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between px-4 pt-3">
      {/* wordmark */}
      <div className="pointer-events-auto flex items-baseline gap-3">
        <span className="font-mono text-[15px] font-semibold tracking-[0.36em] text-slate-100">
          <span className="text-cyan-300">OS</span>ELECTION<span className="text-cyan-300">INT</span>
        </span>
        <span className="hidden font-mono text-[9px] uppercase tracking-[0.3em] text-slate-500 md:inline">
          Open Election Data
        </span>
      </div>

      {/* live strip */}
      <div className="hidden items-center gap-5 font-mono text-[10px] tracking-[0.14em] text-slate-500 lg:flex">
        <span>
          ZULU <span className="tabular-nums text-slate-300">{zulu}</span>
        </span>
        {/* The archive is the point, but a reader arriving in an election year
            needs to know where they are standing in it. Derived from the
            clock, so it cannot ship stale. */}
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${
            past ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`} />
          <span className={past ? "text-emerald-300" : "text-amber-300"}>
            {past ? "ARCHIVE" : `T−${days} DAY${days === 1 ? "" : "S"}`}
          </span>
        </span>
        <span>
          <span className="tabular-nums text-slate-300">{n(stats?.contests)}</span> CONTESTS
        </span>
        <span>
          <span className="tabular-nums text-slate-300">{n(stats?.candidates)}</span> CANDIDATES
        </span>
        <span className="hidden 2xl:inline">
          <span className="tabular-nums text-slate-300">{n(stats?.places)}</span> BOOTHS
        </span>
        <span className="hidden items-center gap-4 xl:flex">
          <SeatBar label="HOUSE" c={house} />
          <SeatBar label="SENATE" c={senate} />
        </span>
      </div>
    </header>
  );
}

/**
 * Footer telemetry. `cursor` and `zoom` are handed down from the map because
 * only it knows them; the rest is static provenance that belongs on screen
 * rather than buried in an about page.
 */
export function ChromeFooter({
  cursor, zoom, level, year, inView,
}: {
  cursor: { lng: number; lat: number } | null;
  zoom: number;
  level: string;
  year: number | null;
  inView: number;
}) {
  const deg = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;

  return (
    <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-30 hidden items-center justify-between border-t border-white/5 bg-slate-950/70 px-4 py-1.5 font-mono text-[9px] tracking-[0.14em] text-slate-500 backdrop-blur md:flex">
      <div className="flex items-center gap-5">
        <span>
          CURSOR{" "}
          <span className="tabular-nums text-slate-300">
            {cursor ? `${deg(cursor.lat, "N", "S")}  ${deg(cursor.lng, "E", "W")}` : "—"}
          </span>
        </span>
        <span>
          ZOOM <span className="tabular-nums text-slate-300">{zoom.toFixed(2)}</span>
        </span>
        <span>
          LEVEL <span className="text-slate-300">{level.toUpperCase()}</span>
        </span>
        {year && (
          <span>
            CYCLE <span className="tabular-nums text-slate-300">{year}</span>
          </span>
        )}
        <span>
          IN VIEW <span className="tabular-nums text-slate-300">{inView}</span>
        </span>
      </div>
      <div className="hidden lg:block">
        OPENELECTIONS · MIT ELECTION LAB · FEC · US CENSUS · WIKIDATA
      </div>
    </footer>
  );
}
