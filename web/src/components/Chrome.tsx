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
          ELECTION<span className="text-cyan-300">INT</span>OS
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
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-emerald-300">ARCHIVE</span>
        </span>
        <span>
          <span className="tabular-nums text-slate-300">{n(stats?.contests)}</span> CONTESTS
        </span>
        <span>
          <span className="tabular-nums text-slate-300">{n(stats?.candidates)}</span> CANDIDATES
        </span>
        <span>
          <span className="tabular-nums text-slate-300">{n(stats?.places)}</span> BOOTHS
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
