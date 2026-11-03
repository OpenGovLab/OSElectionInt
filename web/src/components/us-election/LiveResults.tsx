import { useCallback, useEffect, useRef, useState } from "react";

import {
  clockLabel, dayLabel, fetchLiveCut, fetchLiveTimeline, reportingLabel,
  type LiveContest, type LiveCut, type LiveTimeline,
} from "@/lib/liveResults";

/**
 * Election night, scrubbed by the clock.
 *
 * Replaces the cycle scrubber while 2026 is selected. Everything here is
 * written on the assumption that a reader will screenshot one frame of it
 * and post that frame without the surrounding page, so each claim carries
 * its own qualification rather than relying on a caption elsewhere.
 */

const STEP_MS = 1100;

/** Emerald — not the margin ramp, not the stance ramp, not the booth amber. */
const ACCENT = "text-emerald-700 dark:text-emerald-300";

function PollsOpenNotice({ states }: { states: string[] }) {
  return (
    <div className="pointer-events-auto absolute bottom-9 left-1/2 z-20 hidden w-[min(36rem,calc(100%-24rem))] -translate-x-1/2 items-start gap-3 rounded-xl border border-emerald-600/30 bg-white/95 px-3.5 py-2.5 shadow-lg backdrop-blur md:flex dark:border-emerald-400/25 dark:bg-slate-900/95">
      <span className="mt-0.5 flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
      <div className="min-w-0">
        <div className={`font-mono text-[10px] uppercase tracking-[0.16em] ${ACCENT}`}>
          Live results · 2026
        </div>
        {/* The honest empty state. A scrubber with nothing in it reads as
            broken; a 0% reads as a result. Neither is what is true, which is
            simply that counting has not started. */}
        <p className="mt-1 text-[11px] leading-snug text-slate-600 dark:text-slate-300">
          No returns yet — results begin after polls close, from 7pm ET.
          {states.length > 0 && (
            <> Feeds connected: <span className="font-medium">{states.join(", ")}</span>.</>
          )}
        </p>
      </div>
    </div>
  );
}

export default function LiveResults({
  office, level, onCut,
}: {
  office: string;
  level: string;
  /** Hands the active cut up so the map and this control cannot disagree. */
  onCut?: (cut: LiveCut | null) => void;
}) {
  const [tl, setTl] = useState<LiveTimeline | null>(null);
  const [idx, setIdx] = useState(0);
  const [cut, setCut] = useState<LiveCut | null>(null);
  const [playing, setPlaying] = useState(false);
  const [live, setLive] = useState(true);
  const raf = useRef<number | null>(null);
  const last = useRef(0);

  // The window, re-checked periodically: tonight it goes from empty to
  // populated without anyone reloading the page.
  useEffect(() => {
    let alive = true;
    const load = () => { fetchLiveTimeline().then((t) => { if (alive) setTl(t); }); };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const buckets = tl?.buckets ?? [];

  // Land on the newest report whenever the window grows, unless the reader
  // has scrubbed back — in which case leave them where they put themselves.
  useEffect(() => {
    if (live && buckets.length) setIdx(buckets.length - 1);
  }, [buckets.length, live]);

  const loadCut = useCallback((i: number, atLive: boolean) => {
    const at = buckets[i]?.at ?? null;
    // The present carries candidate detail; a past moment cannot.
    fetchLiveCut(atLive ? null : at, office, level).then((c) => {
      setCut(c);
      onCut?.(c);
    });
  }, [buckets, office, level, onCut]);

  useEffect(() => {
    if (!buckets.length) { setCut(null); onCut?.(null); return; }
    loadCut(idx, live && idx === buckets.length - 1);
  }, [idx, live, buckets.length, loadCut, onCut]);

  const stop = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (playing || buckets.length < 2) return;
    setLive(false);
    setPlaying(true);
    let i = idx >= buckets.length - 1 ? -1 : idx;
    last.current = 0;
    const tick = (ts: number) => {
      if (!last.current) last.current = ts;
      if (ts - last.current >= STEP_MS) {
        last.current = ts;
        i += 1;
        if (i >= buckets.length) { stop(); return; }
        setIdx(i);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [playing, buckets.length, idx, stop]);

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  if (!tl) return null;
  if (!buckets.length || !tl.playable) {
    return <PollsOpenNotice states={tl.states ?? []} />;
  }

  const at = buckets[idx]?.at ?? null;
  const atLive = live && idx === buckets.length - 1;
  const totalVotes = (cut?.rows ?? []).reduce((a, r) => a + (r.total_votes || 0), 0);

  return (
    <div className="pointer-events-auto absolute bottom-9 left-1/2 z-20 hidden w-[min(38rem,calc(100%-24rem))] -translate-x-1/2 flex-col gap-1.5 rounded-xl border border-emerald-600/30 bg-white/95 px-3.5 py-2.5 shadow-lg backdrop-blur md:flex dark:border-emerald-400/25 dark:bg-slate-900/95">
      <div className="flex items-center gap-3">
        <button
          onClick={() => (playing ? stop() : play())}
          title={playing ? "Pause" : "Replay tonight's count"}
          className="shrink-0 rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white dark:bg-emerald-400 dark:text-slate-900"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={buckets.length - 1}
          step={1}
          value={idx}
          onChange={(e) => {
            stop();
            const v = Number(e.target.value);
            setLive(v === buckets.length - 1);
            setIdx(v);
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-emerald-700 dark:accent-emerald-400"
        />
        <span className="w-[8.5rem] shrink-0 text-right">
          <span className="block text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-100">
            {clockLabel(at)}
          </span>
          <span className="block font-mono text-[9px] uppercase tracking-wide text-slate-400">
            {atLive ? "live" : dayLabel(at)}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
        {/* Naming the clock matters: a replay implies its axis is real, so
            it has to be the source's reporting time and say so. */}
        <span className="font-mono uppercase tracking-wide">
          source reporting time
        </span>
        <span>·</span>
        <span className="tabular-nums">
          {(cut?.count ?? 0).toLocaleString()} contests
        </span>
        <span>·</span>
        <span className="tabular-nums">{totalVotes.toLocaleString()} votes counted</span>
        {!atLive && (
          // Replaying a past moment, where the log holds totals and the
          // leader and no candidate split at all.
          <>
            <span>·</span>
            <span className="italic">totals only at this moment</span>
          </>
        )}
      </div>

      <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
        Unofficial returns. No winner is called here — a lead is a count at a
        moment, not a result.
      </p>
    </div>
  );
}

/**
 * One contest, for the panel. Separated so the scrubber stays a scrubber.
 */
export function LiveContestRow({ c }: { c: LiveContest }) {
  const reporting = reportingLabel(c);
  const sorted = [...(c.candidates ?? [])].sort((a, b) => b.votes - a.votes);
  return (
    <div className="border-t border-black/5 px-3 py-2 dark:border-white/5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-slate-900 dark:text-white">
          {c.state} {c.office === "us_senate" ? "Senate"
            : c.office === "us_house" ? `House ${c.district ?? ""}` : c.office}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-500">
          {c.total_votes.toLocaleString()} votes
        </span>
      </div>

      {sorted.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {sorted.map((cand) => (
            <div key={cand.name} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  cand.party === "DEM" ? "bg-blue-500"
                    : cand.party === "REP" ? "bg-red-500" : "bg-slate-400"}`} />
                <span className="truncate text-slate-700 dark:text-slate-200">{cand.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {cand.votes.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      ) : c.leader ? (
        // A replayed moment: the log kept who led and nothing finer.
        <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
          Ahead at this point: <span className="font-medium">{c.leader}</span>
        </div>
      ) : null}

      {/* Completeness, or an explicit statement that it is unknowable. */}
      <div className="mt-1 text-[10px] text-slate-400">
        {reporting ?? "no precinct count published"}
      </div>

      {/* Only ever someone else's call, and attributed as such. */}
      {c.source_call && (
        <div className="mt-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
          {c.source ?? "The source"} reports this race called for {c.source_call}.
          We do not call races.
        </div>
      )}
    </div>
  );
}
