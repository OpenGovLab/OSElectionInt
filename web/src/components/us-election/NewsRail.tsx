import { useState } from "react";

/**
 * The coverage layer, as journalism rather than as circles.
 *
 * Toggling "news" used to draw amber rings and stop there — the reader could
 * see THAT a district was covered but never what was said about it. The rail
 * puts the stories themselves on screen: headline, outlet, and the L/C/R
 * split of the sources covering that event.
 *
 * That split is the reason this layer exists at all. Two races with identical
 * results can be covered very differently, and a results choropleth cannot
 * show that asymmetry. So the lean bar is not decoration — it is the payload.
 *
 * It describes the COVERAGE, never the candidate. A story about a Republican
 * carried mostly by left-rated outlets is a fact about who chose to write it,
 * and the label says so in those words.
 */

export interface NewsArticle {
  ocd_id: string;
  name: string;
  state: string;
  title: string;
  url: string;
  image?: string | null;
  source?: string;
  /** A RELATIVE STRING from the feed ("2 hours ago"). Never parse it. */
  published_at?: string;
  person?: string;
  party?: string;
  office?: string;
  tilt?: number | null;
  left?: number;
  center?: number;
  right?: number;
  total_sources?: number;
}

/**
 * Lean bar. Counts are of RATED sources only, so a bar with nothing in it
 * means the outlets covering this story carry no rating — which is different
 * from balanced coverage, and is rendered as absence rather than as centre.
 */
function LeanBar({ left = 0, center = 0, right = 0 }: {
  left?: number; center?: number; right?: number;
}) {
  const total = left + center + right;
  if (!total) return null;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className="mt-1.5"
      title={`Coverage lean: ${left} left-rated, ${center} centre, ${right} right-rated of ${total} rated sources. This describes the outlets covering the story, not the candidate.`}
    >
      <div className="flex h-[3px] overflow-hidden rounded-full bg-slate-700/60">
        <span style={{ width: pct(left) }} className="bg-blue-400/80" />
        <span style={{ width: pct(center) }} className="bg-slate-400/70" />
        <span style={{ width: pct(right) }} className="bg-red-400/80" />
      </div>
      <p className="mt-1 font-mono text-[8px] uppercase tracking-[0.14em] text-slate-500">
        coverage lean · {total} rated
      </p>
    </div>
  );
}

function Card({ a, onOpen, onHover }: {
  a: NewsArticle;
  onOpen: (a: NewsArticle) => void;
  onHover: (ocdId: string | null) => void;
}) {
  // Google News attachment URLs expire, so a card must look deliberate with
  // no image rather than showing a broken frame.
  const [broken, setBroken] = useState(false);
  return (
    <div
      onMouseEnter={() => onHover(a.ocd_id)}
      onMouseLeave={() => onHover(null)}
      className="group flex w-[210px] shrink-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-slate-900/90 transition-colors hover:border-amber-400/40"
    >
      <button
        onClick={() => onOpen(a)}
        title={`${a.title}\n\nOpen ${a.name} on the map`}
        className="block text-left"
      >
        {a.image && !broken ? (
          <img
            src={a.image}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-20 w-full bg-slate-800 object-cover"
          />
        ) : (
          <div className="flex h-20 w-full items-center justify-center bg-slate-800/70">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
              {a.state || "news"}
            </span>
          </div>
        )}
        <div className="px-2.5 pb-1 pt-2">
          <span className="inline-block max-w-full truncate rounded-[3px] border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-[1px] font-mono text-[8px] uppercase tracking-[0.12em] text-cyan-300">
            {a.name}
          </span>
          <p className="mt-1.5 line-clamp-3 text-[11px] font-medium leading-snug text-slate-100">
            {a.title}
          </p>
        </div>
      </button>

      <div className="mt-auto px-2.5 pb-2">
        <div className="flex items-baseline justify-between gap-2">
          {a.url ? (
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={`Read at ${a.source || "source"} (opens in a new tab)`}
              className="truncate text-[9px] text-amber-400/90 hover:underline"
            >
              {a.source || "source"}
            </a>
          ) : (
            <span className="truncate text-[9px] text-slate-500">{a.source}</span>
          )}
          {/* Verbatim: the feed stores this as prose, not a timestamp. */}
          <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.1em] text-slate-500">
            {a.published_at}
          </span>
        </div>
        <LeanBar left={a.left} center={a.center} right={a.right} />
      </div>
    </div>
  );
}

export default function NewsRail({
  rows, open, onOpen, onHover,
}: {
  rows: NewsArticle[];
  open: boolean;
  onOpen: (a: NewsArticle) => void;
  onHover: (ocdId: string | null) => void;
}) {
  // Kept mounted while closed so the slide has something to animate, but
  // inert — a hidden rail must not eat pointer events over the map.
  const idle = !open || rows.length === 0;
  return (
    <div
      aria-hidden={idle}
      className={`absolute bottom-[5.5rem] left-3 z-20 hidden max-w-[calc(100%-24.5rem)] xl:block ${
        idle
          ? "pointer-events-none translate-y-6 opacity-0"
          : "pointer-events-auto translate-y-0 opacity-100"
      } transition-all duration-300 ease-out`}
    >
      <div className="mb-1 flex items-baseline gap-2 pl-0.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-amber-400/90">
          Coverage
        </span>
        <span className="font-mono text-[9px] tracking-[0.12em] text-slate-500">
          {rows.length} {rows.length === 1 ? "story" : "stories"} · newest first
        </span>
      </div>
      <div className="eios-rail flex gap-2 overflow-x-auto pb-1">
        {rows.map((a, i) => (
          <Card key={`${a.ocd_id}-${a.url || i}`} a={a} onOpen={onOpen} onHover={onHover} />
        ))}
      </div>
    </div>
  );
}
