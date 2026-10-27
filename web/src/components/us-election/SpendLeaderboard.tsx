import { useEffect, useState } from "react";

import { moneyLabel } from "@/config/usElectionMap";
import { spendTop, type SpendRow } from "@/lib/adSpend";

/**
 * Who outside groups are spending hardest against.
 *
 * Two orderings, and they answer different questions. By AMOUNT is where the
 * money is — the marquee Senate races. By RATIO is where the spending is
 * most lopsided, which surfaces smaller races in which one side is being
 * overwhelmingly outspent and which the amount ordering buries entirely.
 *
 * The ratio view is gated server-side on both sides carrying real money,
 * because a candidate with $2.5m against and $1,050 for scores 2,381x and
 * would otherwise head the table while measuring nothing but the size of its
 * own denominator.
 */

type Sort = "oppose" | "ratio";

const OFFICES: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "us_senate", label: "Senate" },
  { id: "us_house", label: "House" },
];

export default function SpendLeaderboard({ onBack, onOpen }: {
  onBack: () => void;
  onOpen?: (fecId: string, name: string) => void;
}) {
  const [sort, setSort] = useState<Sort>("oppose");
  const [office, setOffice] = useState("");
  const [rows, setRows] = useState<SpendRow[] | null>(null);
  const [caveat, setCaveat] = useState("");

  useEffect(() => {
    let alive = true;
    setRows(null);
    spendTop({ sort, office: office || undefined, limit: 30 }).then((r) => {
      if (!alive) return;
      setRows(r.rows);
      setCaveat(r.caveat);
    });
    return () => { alive = false; };
  }, [sort, office]);

  const max = rows?.reduce((m, r) => Math.max(m, r.oppose_total ?? 0), 0) || 1;

  const chip = (on: boolean) =>
    `rounded-[3px] border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors ${
      on ? "border-orange-400/60 bg-orange-400/15 text-orange-300"
        : "border-white/10 bg-slate-900/70 text-slate-400 hover:text-slate-200"}`;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <button onClick={onBack}
          className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
          ←
        </button>
        <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
          Outside spending
        </span>
      </div>

      <div className="shrink-0 space-y-1.5 px-3 pt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={chip(sort === "oppose")} onClick={() => setSort("oppose")}>
            Most against
          </button>
          <button className={chip(sort === "ratio")} onClick={() => setSort("ratio")}>
            Most lopsided
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {OFFICES.map((o) => (
            <button key={o.id} className={chip(office === o.id)}
              onClick={() => setOffice(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="pt-0.5 text-[10px] leading-relaxed text-slate-400">
          {sort === "ratio"
            ? "Ranked by how lopsided the spending is. Only races with real money on both sides — a ratio against a near-zero total measures nothing."
            : "Ranked by total spent to defeat the candidate."}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {!rows && <p className="px-2 py-6 text-center text-xs text-slate-500">Loading…</p>}
        {rows?.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-slate-500">Nothing reported.</p>
        )}
        {rows?.map((r, i) => {
          const against = r.oppose_total ?? 0;
          const support = r.support_total ?? 0;
          return (
            <button
              key={r.candidate_id}
              onClick={() => r.candidate_id && onOpen?.(r.candidate_id, r.name)}
              className="mb-1 flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-slate-900 dark:text-white">
                  <span className="mr-1.5 tabular-nums text-slate-400">{i + 1}</span>
                  {r.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums font-semibold text-orange-600 dark:text-orange-400">
                  {moneyLabel(against)}
                </span>
              </div>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <span className="bg-orange-500" style={{ width: `${(against / max) * 100}%` }} />
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[9px] tabular-nums text-slate-500">
                <span>
                  {r.state}{r.office === "us_house" && r.district ? `-${r.district}` : ""}
                  {" · "}{moneyLabel(support)} supporting
                </span>
                {r.ratio_against_for != null && (
                  <span className="text-slate-400">{r.ratio_against_for.toFixed(1)}×</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {caveat && (
        <p className="shrink-0 border-t border-black/5 px-3 py-2 text-[10px] leading-relaxed text-slate-500 dark:border-white/5 dark:text-slate-400">
          {caveat}
        </p>
      )}
    </div>
  );
}
