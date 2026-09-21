import { useEffect, useMemo, useState } from "react";

import IssueIcon from "@/components/us-election/IssueIcon";
import StanceView from "@/components/us-election/StanceView";
import {
  fetchCategories, fetchCategory, ROLE_LABEL, ROLE_ORDER,
  type IssueCategory, type PositionRow,
} from "@/lib/positions";
import type { StanceAxis, StancePerson } from "@/lib/stance";

/**
 * Pick an issue, see who stands where.
 *
 * The design problem this solves is not layout, it is bias. Coverage of what
 * people have said runs about five to one in favour of those already holding
 * office — Texas gun policy carries 25 officeholders against 2 challengers —
 * so a single list sorted by how much someone has on record puts every
 * challenger below the fold and quietly turns a tool about change into a tool
 * about incumbency.
 *
 * So people are grouped by ROLE and challengers are shown first, regardless
 * of how thin their record is. Within a group the ordering is by volume,
 * which is honest as long as the counts are visible — which is why the count
 * is a chip a reader can see rather than a hidden sort key.
 *
 * Nothing here is scored, rated or summarised. The quotes are reproduced
 * verbatim with their dates and linked back to the source, and a person with
 * no recorded position is described as having nothing recorded, never as
 * holding no position.
 */

const partyText = (p: string) =>
  p === "DEM" ? "text-blue-600 dark:text-blue-400"
    : p === "REP" ? "text-red-600 dark:text-red-400"
      : "text-slate-500 dark:text-slate-400";

const OFFICE_LABEL: Record<string, string> = {
  president: "President", us_senate: "U.S. Senate",
  us_house: "U.S. House", governor: "Governor",
};

function PersonBlock({ r }: { r: PositionRow }) {
  const [open, setOpen] = useState(false);
  const TOP = 3;
  const shown = open ? r.positions : r.positions.slice(0, TOP);
  const more = r.positions.length - shown.length;

  return (
    <div className="mb-2 rounded-lg border border-black/5 bg-white/60 px-2.5 py-2 dark:border-white/5 dark:bg-slate-800/40">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-semibold text-slate-900 dark:text-white">
          {r.name}
        </span>
        <span className={`shrink-0 font-mono text-[10px] font-bold ${partyText(r.party)}`}>
          {r.party}
        </span>
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400">
          {OFFICE_LABEL[r.office] ?? r.office}{r.state ? ` · ${r.state}` : ""}
        </span>
        {/* The count is stated, not implied by position in a list. A reader
            must be able to see that two quotes is two quotes. */}
        <span
          title={`${r.quote_count} recorded on this issue, ${r.total_quotes} recorded in total. Coverage is far deeper for people who have held office.`}
          className="shrink-0 rounded-[2px] border border-cyan-500/30 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300"
        >
          {r.quote_count} on record
        </span>
        <span className="font-mono text-[9px] text-slate-400">
          of {r.total_quotes} total
        </span>
      </div>

      {r.positions.length === 0 ? (
        <p className="mt-1.5 text-[10px] italic text-slate-400">
          nothing recorded on this issue
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {shown.map((q, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-cyan-500/60" />
              <span className="min-w-0">
                {/* Verbatim. Never paraphrased. */}
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
      )}

      <div className="mt-1 flex items-center justify-between gap-2">
        {more > 0 ? (
          <button
            onClick={() => setOpen(true)}
            className="font-mono text-[9px] uppercase tracking-wider text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            +{more} more
          </button>
        ) : open && r.positions.length > TOP ? (
          <button
            onClick={() => setOpen(false)}
            className="font-mono text-[9px] uppercase tracking-wider text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            show fewer
          </button>
        ) : <span />}
        {r.source_url && (
          <a
            href={r.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[9px] uppercase tracking-wider text-cyan-700 hover:underline dark:text-cyan-400"
          >
            source
          </a>
        )}
      </div>
    </div>
  );
}

export default function IssueExplorer({
  state, stateName, onBack, onStanceRows,
}: {
  /** Postal code the map is currently looking at, or null for nationwide. */
  state?: string | null;
  stateName?: string | null;
  onBack: () => void;
  /**
   * Rows currently on screen in stance mode, handed up so the map can paint
   * exactly what the list shows. Called with an empty array to clear.
   */
  onStanceRows?: (rows: StancePerson[], axis: StanceAxis | null) => void;
}) {
  const [cats, setCats] = useState<IssueCategory[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [caveat, setCaveat] = useState("");
  const [loading, setLoading] = useState(false);
  // Scoped to what the map is showing by default; a reader can widen it.
  const [scoped, setScoped] = useState(Boolean(state));
  // "said" lists the quotes; "stance" places people on the issue's axis.
  const [mode, setMode] = useState<"said" | "stance">("stance");

  const meta = useMemo(
    () => cats.find((c) => c.category === category) ?? null, [cats, category]);

  useEffect(() => { fetchCategories().then(setCats).catch(() => setCats([])); }, []);
  useEffect(() => { setScoped(Boolean(state)); }, [state]);

  // Leaving the panel, or the category, must not leave stale pins behind.
  useEffect(() => {
    if (!category || mode !== "stance") onStanceRows?.([], null);
  }, [category, mode, onStanceRows]);
  useEffect(() => () => { onStanceRows?.([], null); }, [onStanceRows]);

  useEffect(() => {
    if (!category || mode !== "said") { setRows([]); return; }
    let alive = true;
    setLoading(true);
    fetchCategory(category, scoped && state ? { state } : {})
      .then((r) => { if (alive) { setRows(r.rows); setCaveat(r.caveat); } })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [category, scoped, state, mode]);

  // Challengers first — see the note at the top of this file.
  const grouped = useMemo(() => {
    const byRole = new Map<string, PositionRow[]>();
    for (const r of rows) {
      const k = r.role || "officeholder";
      byRole.set(k, [...(byRole.get(k) ?? []), r]);
    }
    return ROLE_ORDER
      .filter((role) => byRole.has(role))
      .map((role) => ({
        role,
        rows: (byRole.get(role) ?? []).sort((a, b) => b.quote_count - a.quote_count),
      }))
      .concat(
        [...byRole.keys()]
          .filter((k) => !ROLE_ORDER.includes(k))
          .map((role) => ({ role, rows: byRole.get(role) ?? [] })),
      );
  }, [rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/5 px-3 py-2 dark:border-white/5">
        <button
          onClick={category ? () => setCategory(null) : onBack}
          aria-label="Back"
          className="rounded-md px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          ←
        </button>
        {category && <IssueIcon name={meta?.icon} className="h-3.5 w-3.5 shrink-0 text-cyan-600 dark:text-cyan-300" />}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">
          {category ?? "Issues"}
        </span>
        {category && (
          /* Two questions about the same people: where they sit on the axis,
             and what they actually said. The quotes are the evidence for the
             position, so both must stay one click apart. */
          <div className="flex shrink-0 overflow-hidden rounded-[3px] border border-black/10 dark:border-white/10">
            {(["stance", "said"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={m === "stance"
                  ? "Place everyone on this issue's axis, on the map"
                  : "Read what people said, quoted and dated"}
                className={`px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors ${
                  mode === m
                    ? "bg-cyan-400/15 text-cyan-700 dark:text-cyan-300"
                    : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {m === "stance" ? "Stance" : "Said"}
              </button>
            ))}
          </div>
        )}
        {state && mode === "said" && (
          <button
            onClick={() => setScoped((s) => !s)}
            title={scoped ? "Showing this state only" : "Showing everyone on record"}
            className={`shrink-0 rounded-[3px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors ${
              scoped
                ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-700 dark:text-cyan-300"
                : "border-black/10 text-slate-500 dark:border-white/10 dark:text-slate-400"
            }`}
          >
            {scoped ? (stateName ?? state) : "Nationwide"}
          </button>
        )}
      </div>

      {!category ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          <p className="mb-2 px-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
            Pick an issue to see what people have actually said about it, quoted
            and dated. The counts below say how much is on record — not how
            strongly anyone holds a view.
          </p>
          {cats.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-slate-500">Loading issues…</p>
          )}
          {cats.map((c) => (
            <button
              key={c.category}
              onClick={() => setCategory(c.category)}
              className="mb-1 flex w-full items-center gap-2 rounded-lg border border-black/5 px-2.5 py-2 text-left hover:bg-slate-50 dark:border-white/5 dark:hover:bg-slate-800"
            >
              <span className="shrink-0 text-slate-400 dark:text-slate-500">
                <IssueIcon name={c.icon} className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800 dark:text-slate-100">
                {c.category}
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-[9px] tabular-nums text-slate-500 dark:text-slate-400">
                  {c.people} people
                </span>
                {/* Challenger coverage shown up front, because it is the
                    number most likely to be thin and most likely to matter. */}
                <span className="block font-mono text-[9px] tabular-nums text-cyan-700 dark:text-cyan-400">
                  {c.challengers} challengers
                </span>
              </span>
            </button>
          ))}
          <p className="mt-2 px-0.5 text-[9px] leading-relaxed text-slate-400">
            Six further categories — infrastructure, veterans, agriculture,
            media, international development and constitutional questions — have
            no source coverage and are not listed rather than shown empty.
          </p>
        </div>
      ) : mode === "stance" ? (
        meta && meta.filterable === false ? (
          <p className="px-3 py-6 text-center text-xs leading-relaxed text-slate-500">
            Nobody has a classified position on this issue, so there is nothing
            to place on the axis. The quotes are still under “Said”.
          </p>
        ) : (
          <StanceView
            category={category}
            icon={meta?.icon}
            state={state}
            stateName={stateName}
            onRows={onStanceRows ?? (() => {})}
          />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {loading && (
            <p className="px-1 py-6 text-center text-xs text-slate-500">Loading positions…</p>
          )}
          {!loading && rows.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-slate-500">
              Nothing recorded on this issue{scoped && state ? ` in ${stateName ?? state}` : ""}.
            </p>
          )}
          {grouped.map((g) => (
            <div key={g.role} className="mb-3">
              <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-cyan-500/20 pb-1">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
                  {ROLE_LABEL[g.role] ?? g.role}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-slate-400">
                  {g.rows.length}
                </span>
              </div>
              {g.rows.map((r) => (
                <PersonBlock key={`${r.bioguide ?? r.fec_id ?? r.name}`} r={r} />
              ))}
            </div>
          ))}
          {rows.length > 0 && caveat && (
            <p className="mt-1 rounded bg-slate-50 px-2 py-1.5 text-[9px] leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              {caveat}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Small entry point used by the person panels. */
export function IssueBadge({ count }: { count: number }) {
  return (
    <span className="shrink-0 rounded-[2px] border border-cyan-500/30 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
      {count} positions
    </span>
  );
}
