import { useEffect, useState } from "react";

import {
  fetchScopeIndex, lookupPerson, type PersonPositions as PP,
} from "@/lib/positions";

/**
 * What one person has said, by issue.
 *
 * Loaded lazily and only when a reader opens it: there is no per-person
 * endpoint, so this warms a per-state index that costs one burst of requests
 * (see lib/positions.ts). Mounting it eagerly on every panel would fire that
 * burst for anyone who merely clicked a district.
 *
 * Absence is the normal case here and must not read as a verdict. A
 * challenger with nothing recorded is under-documented, not empty-headed:
 * the median sitting member carries roughly five times the coverage of
 * someone running against them. So "nothing recorded" is the wording, the
 * asymmetry is stated once, and no score or summary is derived.
 */
export default function PersonPositions({
  name, state, fecId, bioguide,
}: {
  name: string;
  /** Postal code; the index is built per state. */
  state?: string | null;
  fecId?: string | null;
  bioguide?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PP | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || data || loading) return;
    let alive = true;
    setLoading(true);
    setFailed(false);
    fetchScopeIndex({ state: state ?? null })
      .then((idx) => {
        if (!alive) return;
        setData(lookupPerson(idx, { name, fec_id: fecId, bioguide }));
      })
      .catch(() => { if (alive) setFailed(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, data, loading, name, state, fecId, bioguide]);

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-1.5 flex w-full items-baseline justify-between gap-2 border-b border-cyan-500/20 pb-1 text-left"
      >
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
          Where they stand
        </span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-slate-400">
          {open ? "hide" : "show"}
        </span>
      </button>

      {open && (
        <>
          {loading && (
            <p className="px-1 py-3 text-center text-[10px] text-slate-500">
              Loading positions…
            </p>
          )}
          {failed && (
            <p className="px-1 py-2 text-[10px] text-slate-500">
              Could not load positions.
            </p>
          )}
          {!loading && !failed && !data && (
            <p className="px-1 py-2 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
              Nothing recorded for {name}. Coverage is far thinner for people
              who have not held office — this means no statements have been
              compiled, not that they hold no positions.
            </p>
          )}
          {data && (
            <>
              <p className="mb-1.5 text-[9px] text-slate-400">
                {data.total_quotes} positions on record across{" "}
                {data.byCategory.length}{" "}
                {data.byCategory.length === 1 ? "issue" : "issues"}
              </p>
              {data.byCategory.map((c) => (
                <div key={c.category} className="mb-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[10px] font-semibold text-slate-700 dark:text-slate-200">
                      {c.category}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] tabular-nums text-slate-400">
                      {c.quotes.length}
                    </span>
                  </div>
                  <ul className="mt-0.5 space-y-0.5">
                    {/* Two most recent per issue; the explorer has the rest. */}
                    {c.quotes.slice(0, 2).map((q, i) => (
                      <li
                        key={i}
                        className="flex gap-1.5 text-[10px] leading-snug text-slate-600 dark:text-slate-300"
                      >
                        <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-cyan-500/50" />
                        <span className="min-w-0">
                          {q.text}
                          {q.dated && (
                            <span className="ml-1 whitespace-nowrap font-mono text-[9px] text-slate-400">
                              {q.dated}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {data.source_url && (
                <a
                  href={data.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[9px] uppercase tracking-wider text-cyan-700 hover:underline dark:text-cyan-400"
                >
                  positions via OnTheIssues
                </a>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
