import { useEffect, useState } from "react";

import { moneyLabel } from "@/config/usElectionMap";
import {
  MEDIUM_LABEL, PLACED_MEDIA, spendFor, type SpendRow,
} from "@/lib/adSpend";

/**
 * Outside spending for and against a candidate.
 *
 * On colour: for/against is a third axis on a map that already spends its
 * palette. Blue and red are parties, green-to-magenta is issue stance, and
 * emerald/violet is individual-versus-PAC money inside this very panel. So
 * this uses ORANGE for money spent against and NEUTRAL GREY for money spent
 * supporting. The asymmetry is deliberate rather than decorative: opposition
 * is the finding, and a grey/orange pair cannot be mistaken for a party
 * reading — which matters, because outside money is not a party quantity.
 *
 * On wording: never "ads". The FEC reports amounts, payers, payees and a
 * purpose string, never creative, so a reader cannot see a single
 * advertisement here and the UI must not imply otherwise.
 */

const AGAINST = "bg-orange-500";
const FOR = "bg-slate-400 dark:bg-slate-500";

function Bar({ against, support }: { against: number; support: number }) {
  const total = Math.max(against + support, 1);
  return (
    <div className="mt-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <span className={FOR} style={{ width: `${(support / total) * 100}%` }} />
        <span className={`ml-auto ${AGAINST}`} style={{ width: `${(against / total) * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[9px] tabular-nums">
        <span className="text-slate-500 dark:text-slate-400">
          {moneyLabel(support)} supporting
        </span>
        <span className="font-semibold text-orange-600 dark:text-orange-400">
          {moneyLabel(against)} against
        </span>
      </div>
    </div>
  );
}

/** One line, for a row inside a list of candidates. */
export function AdSpendInline({ fecId }: { fecId?: string | null }) {
  const [row, setRow] = useState<SpendRow | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!fecId) { setRow(null); return; }
    spendFor(fecId).then((r) => { if (alive) setRow(r); });
    return () => { alive = false; };
  }, [fecId]);

  if (row === undefined || !row) return null;
  const against = row.oppose_total ?? 0;
  const support = row.support_total ?? 0;
  if (!against && !support) return null;

  return (
    <div className="mt-1" title="Independent expenditures by outside groups — not this candidate's own spending, and not their opponent's">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <span className={FOR} style={{ width: `${(support / Math.max(against + support, 1)) * 100}%` }} />
        <span className={`ml-auto ${AGAINST}`} style={{ width: `${(against / Math.max(against + support, 1)) * 100}%` }} />
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[9px] tabular-nums text-slate-500">
        <span className="uppercase tracking-wide text-slate-400">outside</span>
        <span className="font-semibold text-orange-600 dark:text-orange-400">
          {moneyLabel(against)} against
        </span>
        {support > 0 && <span>· {moneyLabel(support)} for</span>}
      </div>
    </div>
  );
}

/** The full picture, for a candidate's own panel. */
export default function AdSpend({ fecId }: { fecId?: string | null }) {
  const [row, setRow] = useState<SpendRow | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!fecId) { setRow(null); return; }
    setRow(undefined);
    spendFor(fecId).then((r) => { if (alive) setRow(r); });
    return () => { alive = false; };
  }, [fecId]);

  if (row === undefined) {
    return (
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Outside spending
        </h3>
        <p className="mt-1 text-[11px] text-slate-400">Loading…</p>
      </section>
    );
  }

  if (!row) {
    return (
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Outside spending
        </h3>
        {/* 73 candidates with real outside spending are absent from our
            candidate table, so "we have no record" must never be rendered as
            "no money was spent". */}
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
          No independent-expenditure record found for this candidate. That
          means none was matched here — not that no outside money was spent.
        </p>
      </section>
    );
  }

  const against = row.oppose_total ?? 0;
  const support = row.support_total ?? 0;
  const media = Object.entries(row.by_medium ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const placed = media.filter(([k]) => PLACED_MEDIA.has(k));
  const other = media.filter(([k]) => !PLACED_MEDIA.has(k));
  const mediaTotal = media.reduce((s, [, v]) => s + v, 0);

  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Outside spending · {row.office === "us_senate" ? "Senate"
          : row.office === "us_house" ? "House" : row.office}
      </h3>

      <Bar against={against} support={support} />

      {row.ratio_against_for != null && row.ratio_against_for >= 1.5 && (
        <p className="mt-1.5 font-mono text-[10px] text-orange-600 dark:text-orange-400">
          {row.ratio_against_for.toFixed(1)}× more spent against than for
        </p>
      )}

      {row.first_date && row.last_date && (
        <p className="mt-1 text-[10px] tabular-nums text-slate-400">
          {row.first_date} – {row.last_date}
          {" · "}
          {(row.oppose_count ?? 0) + (row.support_count ?? 0)} reported expenditures
        </p>
      )}

      {row.top_spenders_against?.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
            Groups spending against
          </p>
          {row.top_spenders_against.slice(0, 5).map((s) => (
            <div key={s.committee_id} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="min-w-0 truncate text-[11px] text-slate-700 dark:text-slate-200">
                {s.name}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                {moneyLabel(s.total)}
              </span>
            </div>
          ))}
        </div>
      )}

      {row.top_spenders_for?.length > 0 && (
        <div className="mt-2">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            Groups spending in support
          </p>
          {row.top_spenders_for.slice(0, 4).map((s) => (
            <div key={s.committee_id} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="min-w-0 truncate text-[11px] text-slate-700 dark:text-slate-200">
                {s.name}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                {moneyLabel(s.total)}
              </span>
            </div>
          ))}
        </div>
      )}

      {mediaTotal > 0 && (
        <div className="mt-2.5">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            Where it went
          </p>
          {placed.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="text-[11px] text-slate-700 dark:text-slate-200">
                {MEDIUM_LABEL[k] ?? k}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                {moneyLabel(v)}
              </span>
            </div>
          ))}
          {other.length > 0 && (
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              Plus {other.map(([k, v]) => `${(MEDIUM_LABEL[k] ?? k).toLowerCase()} ${moneyLabel(v)}`).join(", ")}
              {" "}— production, canvassing and overhead rather than a message
              placed in front of voters.
            </p>
          )}
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
        Independent expenditures reported to the FEC. These are outside groups
        acting without coordination with any campaign — money spent against a
        candidate is <b>not</b> their opponent's spending. The FEC reports
        amounts and payees, never the content of an advertisement, so nothing
        here shows what any message said. Spending is not support and not a
        prediction of the result.
      </p>
    </section>
  );
}
