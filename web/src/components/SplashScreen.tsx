import { useEffect, useMemo, useRef, useState } from "react";

import { apiService } from "@/lib/api";
import { MARGIN_STOPS } from "@/config/usElectionMap";

/**
 * Boot screen for OSElectionInt.
 *
 * The structure is borrowed from OSIRIS — a full-bleed overlay that holds for
 * a couple of seconds and fades — but nothing else is. OSIRIS opens on a
 * targeting reticle because it is a surveillance console; an election archive
 * opening on a crosshair would be saying something untrue about itself.
 *
 * So this paints the actual 2024 presidential result onto a tile-grid
 * cartogram, one state at a time, EAST TO WEST. That is the order returns
 * genuinely arrive in on election night, as poll closings roll across the time
 * zones, and it is the reason the animation reads as an election rather than
 * as a loading bar: anyone who has watched a results night recognises the
 * shape of it before they read a word.
 *
 * The colours are not decoration. They come from the same marginFill ramp the
 * map uses, fed by real margins fetched from the API, so the splash cannot
 * drift away from what the dashboard shows. If the fetch fails the cells stay
 * neutral and the splash still plays — a boot screen must never be the thing
 * that stops an app opening.
 */

/**
 * The standard 11x8 US tile grid. Each state is one cell at (col,row),
 * arranged so the country is recognisable while every state gets equal area —
 * which is the honest way to show a per-state quantity, since a geographic map
 * gives Wyoming more ink than New Jersey for a fortieth of the voters.
 */
const GRID: [string, number, number][] = [
  ["AK",0,0],["ME",10,0],
  ["VT",9,1],["NH",10,1],
  ["WA",0,2],["ID",1,2],["MT",2,2],["ND",3,2],["MN",4,2],["IL",5,2],["WI",6,2],["MI",7,2],["NY",8,2],["RI",9,2],["MA",10,2],
  ["OR",0,3],["NV",1,3],["WY",2,3],["SD",3,3],["IA",4,3],["IN",5,3],["OH",6,3],["PA",7,3],["NJ",8,3],["CT",9,3],
  ["CA",0,4],["UT",1,4],["CO",2,4],["NE",3,4],["MO",4,4],["KY",5,4],["WV",6,4],["VA",7,4],["MD",8,4],["DE",9,4],
  ["AZ",1,5],["NM",2,5],["KS",3,5],["AR",4,5],["TN",5,5],["NC",6,5],["SC",7,5],["DC",8,5],
  ["OK",3,6],["LA",4,6],["MS",5,6],["AL",6,6],["GA",7,6],
  ["HI",0,7],["TX",3,7],["FL",8,7],
];

const COLS = 11;
const ROWS = 8;

interface Stats { contests: number; divisions: number; candidates: number; places: number }

/**
 * Margin -> hex, interpolated across the SAME stops the choropleth paints
 * with. marginFill() itself cannot be reused here: it returns a MapLibre
 * expression for the GPU to evaluate, not a colour. Sharing the stops rather
 * than copying the hexes is what stops the splash drifting away from the map
 * it is a curtain for.
 */
function marginColour(margin: number): string {
  const stops = MARGIN_STOPS;
  if (margin <= stops[0][0]) return stops[0][1];
  if (margin >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (margin >= a && margin <= b) {
      const t = b === a ? 0 : (margin - a) / (b - a);
      const A = hex(ca), B = hex(cb);
      const mix = A.map((v, k) => Math.round(v + (B[k] - v) * t));
      return `rgb(${mix.join(",")})`;
    }
  }
  return stops[3][1];
}

/** Count up to a target, easing out so it decelerates like a tally settling. */
function useCountUp(target: number, run: boolean, ms = 1700) {
  const [n, setN] = useState(0);
  const raf = useRef<number>();
  useEffect(() => {
    if (!run || !target) return;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target, run, ms]);
  return n;
}

export default function SplashScreen({ onDone }: { onDone: () => void }) {
  const [margins, setMargins] = useState<Record<string, number>>({});
  const [stats, setStats] = useState<Stats | null>(null);
  const [leaving, setLeaving] = useState(false);

  // Real 2024 result per state, keyed by postal code.
  useEffect(() => {
    let alive = true;
    apiService({ method: "get", url: "/us-election/margins?level=state&office=president&year=2024" })
      .then((r) => {
        if (!alive) return;
        const rows = (r?.data?.data?.rows ?? []) as { ocd_id: string; margin: number | null }[];
        const out: Record<string, number> = {};
        for (const row of rows) {
          const m = /\/state:([a-z]{2})$/.exec(row.ocd_id);
          if (m && row.margin != null) out[m[1].toUpperCase()] = row.margin;
        }
        setMargins(out);
      })
      .catch(() => { /* neutral cells; the splash still plays */ });
    apiService({ method: "get", url: "/us-election/stats" })
      .then((r) => { if (alive) setStats(r?.data?.data ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /**
   * Hold, then fade. The map keeps initialising underneath the whole time, so
   * this is a curtain rather than a delay.
   *
   * The timing is set by when the SLOWEST element finishes, not by taste. The
   * first version began fading at 2.7s while the counters were still climbing
   * (they settle at ~3.4s) and the returns bar was still filling (~2.9s), so
   * the two things carrying the actual numbers were never seen finished. Now
   * Now the last element settles at ~3.9s and the screen holds fully still
   * until 5.2s, which is roughly the time it takes to read two figures and a
   * subtitle without hurrying.
   */
  useEffect(() => {
    const hold = setTimeout(() => setLeaving(true), 5200);
    const gone = setTimeout(onDone, 6100);
    return () => { clearTimeout(hold); clearTimeout(gone); };
  }, [onDone]);

  // Anyone who has seen it once can leave early. A splash that cannot be
  // dismissed stops being an introduction and becomes a toll.
  useEffect(() => {
    // Ignore modified keys. ⌘K is the command panel: without this it both
    // dismissed the splash and opened the panel, so the app's first frame was
    // a dialog over a half-faded boot screen.
    const skip = (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.metaKey || k.ctrlKey || k.altKey) return;
      setLeaving(true);
      setTimeout(onDone, 400);
    };
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
    };
  }, [onDone]);

  const cells = useMemo(() => GRID.map(([code, col, row]) => {
    const margin = margins[code];
    // East first: the rightmost column starts at zero delay and each column
    // westward waits another beat, which is poll closings crossing the
    // time zones.
    const delay = (COLS - 1 - col) * 0.1 + row * 0.014;
    return { code, col, row, margin, delay };
  }), [margins]);

  const counted = useCountUp(stats?.contests ?? 0, !!stats);
  const places = useCountUp(stats?.places ?? 0, !!stats);

  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-[999] flex cursor-pointer flex-col items-center justify-center overflow-hidden transition-opacity duration-[900ms] ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{ background: "radial-gradient(ellipse at 50% 40%, #0d1220 0%, #05070e 70%)" }}
    >
      {/* Faint ruled paper — a nod to a tally sheet, not a CRT. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(148,163,184,0.045) 3px, rgba(148,163,184,0.045) 4px)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center px-6">
        {/* ── the country, filling in ── */}
        <div
          className="mb-9 grid gap-[5px]"
          style={{
            gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
            width: "min(78vw, 30rem)",
            aspectRatio: `${COLS} / ${ROWS}`,
          }}
        >
          {cells.map(({ code, col, row, margin, delay }) => (
            <div
              key={code}
              className="osei-cell flex items-center justify-center rounded-[3px] font-mono text-[9px] font-semibold"
              style={{
                gridColumn: col + 1,
                gridRow: row + 1,
                animationDelay: `${delay}s`,
                // marginFill is the map's own ramp, so a state reads the same
                // colour here as it does once the dashboard opens.
                ["--fill" as string]: margin == null ? "#1e293b" : marginColour(margin),
                ["--ink" as string]:
                  margin == null ? "rgba(148,163,184,0.45)" : "rgba(255,255,255,0.92)",
              }}
            >
              {code}
            </div>
          ))}
        </div>

        {/* ── wordmark ── */}
        <div className="flex items-baseline">
          {"OSElectionInt".split("").map((ch, i) => (
            <span
              key={i}
              className="osei-letter text-3xl font-semibold tracking-tight text-slate-100 md:text-4xl"
              style={{ animationDelay: `${1.15 + i * 0.05}s` }}
            >
              {ch}
            </span>
          ))}
        </div>

        <p className="osei-sub mt-3 font-mono text-[10px] uppercase tracking-[0.42em] text-sky-300/70"
           style={{ animationDelay: "1.95s" }}>
          Open Election Data
        </p>

        {/* ── what is actually in the archive ── */}
        <div className="mt-8 flex items-center gap-7 font-mono text-[10px] tracking-wider text-slate-400">
          <span className="osei-sub" style={{ animationDelay: "2.05s" }}>
            <b className="block text-center text-base font-semibold tabular-nums text-slate-100">
              {counted.toLocaleString()}
            </b>
            contests
          </span>
          <span className="h-7 w-px bg-slate-700" />
          <span className="osei-sub" style={{ animationDelay: "2.15s" }}>
            <b className="block text-center text-base font-semibold tabular-nums text-slate-100">
              {places.toLocaleString()}
            </b>
            polling places
          </span>
        </div>

        {/* ── returns bar ── */}
        <div className="mt-8 h-[2px] w-60 overflow-hidden rounded-full bg-slate-800 md:w-72">
          <div className="osei-bar h-full rounded-full"
               style={{ background: "linear-gradient(90deg,#2563eb,#e2e8f0,#dc2626)" }} />
        </div>
        <p className="mt-3 font-mono text-[9px] tracking-[0.3em] text-slate-500">
          RESULTS · CANDIDATES · MONEY · COVERAGE
        </p>
      </div>

      <p className="osei-sub absolute bottom-12 left-0 right-0 text-center font-mono text-[9px] tracking-[0.3em] text-slate-600"
         style={{ animationDelay: "4.0s" }}>
        PRESS ANY KEY TO ENTER
      </p>
      <p className="absolute bottom-5 left-0 right-0 text-center font-mono text-[9px] tracking-[0.2em] text-slate-600">
        OPENELECTIONS · MIT ELECTION LAB · FEC · US CENSUS
      </p>
    </div>
  );
}
