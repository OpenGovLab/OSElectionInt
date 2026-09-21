import { useEffect, useMemo, useState } from "react";

import IssueIcon from "@/components/us-election/IssueIcon";
import { stanceHex, stanceWording } from "@/config/usElectionStance";
import {
  fetchStanceClusters, fetchStanceFilter, OFFICE_LABEL, PARTY_TEXT, ROLE_SHORT,
  type StanceAxis, type StanceCluster, type StancePerson,
} from "@/lib/stance";

/**
 * Who stands where on one issue, as a filter over the map.
 *
 * The list and the map are driven by the SAME rows — whatever this panel is
 * showing is exactly what is painted. Fetching them separately would let the
 * two drift under a filter, and a map that disagrees with the list beside it
 * is worse than either alone.
 *
 * Three things are stated rather than implied, each because leaving them
 * implicit would assert something false:
 *
 *   Evidence count, always. A median over two quotes and a median over
 *   eighteen are not the same claim, and coverage is roughly five to one in
 *   favour of people who already hold office.
 *
 *   Conflict, never averaged away. Cuellar's +0.40 on guns spans −0.80 and
 *   +0.80 twelve years apart; rendering him mid-ramp would invent a
 *   moderation he has never expressed.
 *
 *   Age. A position last stated in 2007 is not a current position, and the
 *   date range sits next to the number rather than behind a click.
 */

const PARTIES = [
  { id: "", label: "All" },
  { id: "DEM", label: "Dem" },
  { id: "REP", label: "Rep" },
];

const ROLES = [
  { id: "", label: "Everyone" },
  { id: "challenger", label: "Challengers" },
  { id: "officeholder", label: "In office" },
];

/** −1..+1 as a percentage along the axis, for bar positioning. */
const pct = (v: number) => ((v + 1) / 2) * 100;

function PersonRow({ r, axis }: { r: StancePerson; axis: StanceAxis | null }) {
  const [open, setOpen] = useState(false);
  const quotes = r.quotes ?? [];

  return (
    <div
      className={`mb-1.5 rounded-lg border px-2.5 py-2 ${
        r.conflicted
          ? "border-amber-500/40 bg-amber-500/[0.04]"
          : "border-black/5 bg-white/60 dark:border-white/5 dark:bg-slate-800/40"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-semibold text-slate-900 dark:text-white">
          {r.name}
        </span>
        <span className={`shrink-0 font-mono text-[10px] font-bold ${PARTY_TEXT(r.party)}`}>
          {r.party}
        </span>
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-400">
        <span>{ROLE_SHORT[r.role] ?? r.role}</span>
        <span>{OFFICE_LABEL[r.office] ?? r.office}{r.state ? ` · ${r.state}` : ""}</span>
      </div>

      {/* Position on the axis. The dot is the median; the bar behind it is
          the full span of what they have said, so a wide bar reads as a wide
          range of statements rather than a confident middle. */}
      <div className="relative mt-2 h-4">
        <div className="absolute inset-x-0 top-1.5 h-1 rounded-full bg-slate-200 dark:bg-slate-700" />
        {r.spread > 0 && (
          <div
            className="absolute top-1.5 h-1 rounded-full bg-slate-400/50 dark:bg-slate-500/50"
            style={{
              left: `${pct(Math.max(-1, r.median - r.spread))}%`,
              right: `${100 - pct(Math.min(1, r.median + r.spread))}%`,
            }}
          />
        )}
        <span
          className="absolute top-0 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-white shadow dark:border-slate-900"
          style={{ left: `${pct(r.median)}%`, background: stanceHex(r.median) }}
        />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-[10px] font-bold tabular-nums"
              style={{ color: stanceHex(r.median) }}>
          {r.median > 0 ? "+" : ""}{r.median.toFixed(2)}
        </span>
        <span className="text-[10px] text-slate-600 dark:text-slate-300">
          {stanceWording(r.median, axis)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          title={`${r.n_classified} of this person's quotes on this issue were classified. Coverage is far deeper for people who have held office.`}
          className="rounded-[2px] border border-cyan-500/30 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300"
        >
          {r.n_classified} quote{r.n_classified === 1 ? "" : "s"}
        </span>
        {(r.earliest || r.latest) && (
          <span className="font-mono text-[9px] text-slate-400">
            {r.earliest}{r.latest && r.latest !== r.earliest ? ` – ${r.latest}` : ""}
          </span>
        )}
        {r.conflicted && (
          <span
            title="This person's quotes disagree with each other. The median is not a position they have stated — open the quotes to see the range."
            className="rounded-[2px] border border-amber-500/40 bg-amber-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300"
          >
            mixed record
          </span>
        )}
      </div>

      {quotes.length > 0 && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-1 font-mono text-[9px] uppercase tracking-wider text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            {open ? "hide what they said" : `what they said (${quotes.length})`}
          </button>
          {open && (
            <ul className="mt-1 space-y-1 border-t border-black/5 pt-1 dark:border-white/5">
              {quotes.map((q, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
                  <span
                    className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: stanceHex(q.stance) }}
                    title={q.stance == null ? "no position on this axis"
                      : `${q.stance > 0 ? "+" : ""}${q.stance.toFixed(2)} · ${q.confidence} confidence`}
                  />
                  <span className="min-w-0">
                    {/* Verbatim. This is the evidence for the number above. */}
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
        </>
      )}
    </div>
  );
}

function Clusters({ rows, axis }: { rows: StanceCluster[]; axis: StanceAxis | null }) {
  const divided = rows.filter((r) => r.divided);
  const sorted = [...rows].sort((a, b) => a.median - b.median);
  const ends = [...sorted.slice(0, 3), ...sorted.slice(-3).reverse()];

  return (
    <div className="mb-2 rounded-lg border border-black/5 bg-white/50 px-2.5 py-2 dark:border-white/5 dark:bg-slate-800/30">
      <div className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
        Across the country
      </div>
      <div className="space-y-0.5">
        {ends.map((r) => (
          <div key={r.state} className="flex items-center gap-2">
            <span className="w-6 shrink-0 font-mono text-[10px] font-bold text-slate-600 dark:text-slate-300">
              {r.state}
            </span>
            <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-slate-200 dark:bg-slate-700">
              <span
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${pct(r.median)}%`, background: stanceHex(r.median) }}
              />
            </span>
            <span className="w-16 shrink-0 text-right font-mono text-[9px] tabular-nums text-slate-400">
              {r.neg}/{r.pos} of {r.people}
            </span>
          </div>
        ))}
      </div>
      {divided.length > 0 && (
        <p className="mt-2 border-t border-black/5 pt-1.5 text-[10px] leading-relaxed text-slate-600 dark:border-white/5 dark:text-slate-300">
          <span className="font-semibold text-amber-700 dark:text-amber-400">
            {divided.length} states are split
          </span>{" "}
          — their delegations sit on both sides of this issue:{" "}
          {divided.map((d) => `${d.state} (${d.neg}/${d.pos})`).join(", ")}.
        </p>
      )}
      {axis && (
        <p className="mt-1 font-mono text-[8px] uppercase tracking-wider text-slate-400">
          left {axis.neg} · right {axis.pos}
        </p>
      )}
    </div>
  );
}

export default function StanceView({
  category, icon, state, stateName, onRows,
}: {
  category: string;
  icon?: string | null;
  state?: string | null;
  stateName?: string | null;
  /** Hand the displayed rows up so the map paints exactly this list. */
  onRows: (rows: StancePerson[], axis: StanceAxis | null) => void;
}) {
  const [rows, setRows] = useState<StancePerson[]>([]);
  const [clusters, setClusters] = useState<StanceCluster[]>([]);
  const [axis, setAxis] = useState<StanceAxis | null>(null);
  const [caveat, setCaveat] = useState("");
  const [loading, setLoading] = useState(false);

  const [min, setMin] = useState(-1);
  const [max, setMax] = useState(1);
  const [party, setParty] = useState("");
  const [role, setRole] = useState("");
  const [scoped, setScoped] = useState(false);

  useEffect(() => { setScoped(false); setMin(-1); setMax(1); }, [category]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchStanceFilter(category, {
      min, max, party: party || undefined, role: role || undefined,
      state: scoped && state ? state : undefined,
      limit: 600,
    })
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setAxis(r.axis);
        setCaveat(r.caveat);
        onRows(r.rows, r.axis);
      })
      .catch(() => { if (alive) { setRows([]); onRows([], null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, min, max, party, role, scoped, state]);

  useEffect(() => {
    let alive = true;
    fetchStanceClusters(category)
      .then((r) => { if (alive) setClusters(r.rows); })
      .catch(() => { if (alive) setClusters([]); });
    return () => { alive = false; };
  }, [category]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.median - b.median), [rows]);
  const conflicted = useMemo(
    () => rows.filter((r) => r.conflicted).length, [rows]);

  const chip = (on: boolean) =>
    `rounded-[3px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors ${
      on
        ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-700 dark:text-cyan-300"
        : "border-black/10 text-slate-500 hover:text-slate-700 dark:border-white/10 dark:text-slate-400 dark:hover:text-slate-200"
    }`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
      {/* The axis, in the server's own words. Never "left" and "right". */}
      {axis && (
        <div className="mb-2 rounded-lg border border-black/5 bg-white/50 px-2.5 py-2 dark:border-white/5 dark:bg-slate-800/30">
          <div className="mb-1 flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
            <IssueIcon name={icon} />
            <span className="font-mono text-[9px] uppercase tracking-[0.16em]">
              the axis
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 text-right text-[10px] leading-tight text-slate-600 dark:text-slate-300">
              {axis.neg}
            </span>
            <span
              className="h-2 w-16 shrink-0 rounded-full"
              style={{
                background: `linear-gradient(to right, ${stanceHex(-1)}, ${stanceHex(0)}, ${stanceHex(1)})`,
              }}
            />
            <span className="min-w-0 flex-1 text-[10px] leading-tight text-slate-600 dark:text-slate-300">
              {axis.pos}
            </span>
          </div>
        </div>
      )}

      {/* Range. Two handles along the axis, labelled by the poles. */}
      <div className="mb-2 px-0.5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400">
            showing
          </span>
          <span className="font-mono text-[9px] tabular-nums text-slate-500">
            {min.toFixed(1)} → {max.toFixed(1)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="range" min={-1} max={1} step={0.1} value={min}
            aria-label={`Minimum, toward ${axis?.neg ?? "one pole"}`}
            onChange={(e) => setMin(Math.min(Number(e.target.value), max))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-cyan-500"
          />
          <input
            type="range" min={-1} max={1} step={0.1} value={max}
            aria-label={`Maximum, toward ${axis?.pos ?? "the other pole"}`}
            onChange={(e) => setMax(Math.max(Number(e.target.value), min))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-pink-500"
          />
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1">
        {PARTIES.map((p) => (
          <button key={p.id} onClick={() => setParty(p.id)} className={chip(party === p.id)}>
            {p.label}
          </button>
        ))}
        <span className="mx-0.5 h-3 w-px bg-black/10 dark:bg-white/10" />
        {ROLES.map((r) => (
          <button key={r.id} onClick={() => setRole(r.id)} className={chip(role === r.id)}>
            {r.label}
          </button>
        ))}
        {state && (
          <>
            <span className="mx-0.5 h-3 w-px bg-black/10 dark:bg-white/10" />
            <button onClick={() => setScoped((s) => !s)} className={chip(scoped)}>
              {scoped ? (stateName ?? state) : "Nationwide"}
            </button>
          </>
        )}
      </div>

      {clusters.length > 0 && !scoped && <Clusters rows={clusters} axis={axis} />}

      <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-cyan-500/20 pb-1">
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
          {sorted.length} people
        </span>
        {conflicted > 0 && (
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
            {conflicted} mixed
          </span>
        )}
      </div>

      {loading && (
        <p className="px-1 py-6 text-center text-xs text-slate-500">Loading positions…</p>
      )}
      {!loading && sorted.length === 0 && (
        <p className="px-1 py-6 text-center text-xs text-slate-500">
          Nobody on record in this range.
        </p>
      )}
      {sorted.map((r) => (
        <PersonRow key={`${r.bioguide ?? r.fec_id ?? r.name}`} r={r} axis={axis} />
      ))}

      {caveat && (
        <p className="mt-1 rounded bg-slate-50 px-2 py-1.5 text-[9px] leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          {caveat}
        </p>
      )}
    </div>
  );
}
