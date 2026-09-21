import { useEffect, useState } from "react";

import { apiService } from "@/lib/api";
import PersonLinks, { type Social } from "./PersonLinks";
import Portrait from "./Portrait";

/**
 * One candidate — incumbent or challenger.
 *
 * Money exists for everyone who filed; a voting record and committees exist
 * only for people who have actually served. A challenger having no record is
 * information, not a gap, so this says so explicitly rather than rendering an
 * empty section that looks broken.
 */

interface Cand {
  name: string; party: string; status: string | null; office: string;
  state: string | null; district: number | null; cycle: number;
  receipts: number; cash_on_hand: number; individual_contrib: number;
  pac_contrib: number; debts: number; ballot_status: string;
  coverage_end: string | null; fec_id: string; ocd_id: string;
  photo?: string | null; bioguide?: string;
  social?: Social | null; wikipedia?: string | null;
  ballotpedia?: string | null; opensecrets?: string | null;
}
interface Record_ {
  name: string; party: string; office: string; term_start?: string;
  term_end?: string; next_election?: string | null; url?: string;
  ideology?: { nominate_dim1: number | null; votes_analysed: number };
  committees?: { name: string; parent?: string | null; rank: string | null }[];
  social?: Social | null; wikipedia?: string | null;
  ballotpedia?: string | null; opensecrets?: string | null;
}
interface Opp {
  name: string; party: string; status: string | null; receipts: number;
  fec_id: string; photo?: string | null;
  social?: Social | null; wikipedia?: string | null;
}
interface Hist { year: number; office: string; margin: number | null; winner_party: string }

const OFFICE: Record<string, string> = {
  president: "President", us_senate: "U.S. Senate",
  us_house: "U.S. House", governor: "Governor",
};
const partyText = (p: string) =>
  p === "DEM" ? "text-blue-600 dark:text-blue-400"
    : p === "REP" ? "text-red-600 dark:text-red-400" : "text-slate-500";
const partyBg = (p: string) =>
  p === "DEM" ? "bg-blue-600" : p === "REP" ? "bg-red-600" : "bg-slate-400";
const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n.toFixed(0)}`;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-[11px] text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-[11px] font-medium tabular-nums text-slate-800 dark:text-slate-100">{value}</span>
    </div>
  );
}

export default function CandidateDetail({
  fecId, name, ocdId, onBack, onOpen,
}: {
  fecId?: string; name?: string; ocdId?: string;
  onBack: () => void; onOpen?: (fecId: string) => void;
}) {
  const [d, setD] = useState<{ candidate: Cand; record: Record_ | null; opponents: Opp[]; history: Hist[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setD(null); setErr(null);
    const qs = fecId
      ? `fec_id=${encodeURIComponent(fecId)}`
      : `name=${encodeURIComponent(name || "")}${ocdId ? `&ocd_id=${encodeURIComponent(ocdId)}` : ""}`;
    apiService({ method: "get", url: `/us-election/candidate?${qs}` })
      .then((r) => { if (alive) setD((r as { data?: { data?: never } })?.data?.data ?? null); })
      .catch(() => { if (alive) setErr("Could not load this candidate."); });
    return () => { alive = false; };
  }, [fecId, name, ocdId]);

  if (err) return <div className="p-4 text-xs text-red-600">{err}</div>;
  if (!d) return <div className="p-6 text-center text-xs text-slate-500">Loading…</div>;

  const { candidate: c, record: rec, opponents, history } = d;
  const grass = c.individual_contrib;
  const pac = c.pac_contrib;
  const dim1 = rec?.ideology?.nominate_dim1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-black/5 px-3 py-2.5 dark:border-white/5">
        <button onClick={onBack} aria-label="Back"
          className="mt-0.5 rounded-md px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">←</button>
        <Portrait src={c.photo} name={c.name} party={c.party} size={40} className="mt-0.5" />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{c.name}</h2>
          <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            <span className={partyText(c.party)}>{c.party}</span>
            {" · "}{c.status ?? "filed"}{" · "}{OFFICE[c.office] ?? c.office}
            {c.district ? ` ${c.state}-${c.district}` : c.state ? ` ${c.state}` : ""}
          </p>
          <PersonLinks
            className="mt-1"
            social={rec?.social ?? c.social}
            wikipedia={rec?.wikipedia ?? c.wikipedia}
            ballotpedia={rec?.ballotpedia ?? c.ballotpedia}
            opensecrets={rec?.opensecrets ?? c.opensecrets}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 pt-3">
        <section>
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Campaign finance · {c.cycle}
          </h3>
          <Row label="Raised" value={money(c.receipts)} />
          <Row label="Cash on hand" value={money(c.cash_on_hand)} />
          {c.debts > 0 && <Row label="Debts" value={money(c.debts)} />}
          {(grass > 0 || pac > 0) && (
            <>
              <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <span className="bg-emerald-600" style={{ width: `${(grass / Math.max(grass + pac, 1)) * 100}%` }} />
                <span className="bg-violet-600" style={{ width: `${(pac / Math.max(grass + pac, 1)) * 100}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[9px]">
                <span className="text-emerald-700 dark:text-emerald-500">individuals {money(grass)}</span>
                <span className="text-violet-700 dark:text-violet-400">PACs {money(pac)}</span>
              </div>
            </>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            FEC filings{c.coverage_end ? `, through ${c.coverage_end}` : ""}.
            Registered with the FEC — that is not the same as being certified
            onto the ballot.
          </p>
        </section>

        <section>
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Voting record
          </h3>
          {dim1 != null ? (
            <>
              <div className="mt-1.5 relative h-1.5 w-full rounded-full"
                style={{ background: "linear-gradient(to right,#1d4ed8,#e2e8f0,#b91c1c)" }}>
                <span className={`absolute -top-1 h-3.5 w-3.5 rounded-full border-2 border-white shadow ${partyBg(c.party)}`}
                  style={{ left: `calc(${Math.min(98, Math.max(2, ((dim1 + 1) / 2) * 100))}% - 7px)` }} />
              </div>
              <div className="mt-1 flex justify-between text-[9px] text-slate-400">
                <span>more liberal</span><span>more conservative</span>
              </div>
              <Row label="Score (DW-NOMINATE)" value={dim1.toFixed(2)} />
              {rec?.ideology && (
                <Row label="Roll-call votes" value={rec.ideology.votes_analysed.toLocaleString()} />
              )}
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                Derived from every roll-call vote cast. Summarises how they
                voted — not their stated positions.
                Source: DW-NOMINATE, Voteview, 119th Congress.
              </p>
            </>
          ) : (
            <p className="py-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              No voting record — {c.name.split(" ").slice(-1)[0]} has not served in
              Congress. Records exist only for people who have held the seat.
            </p>
          )}
        </section>

        {rec?.committees?.length ? (
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Committees ({rec.committees.length})
            </h3>
            {rec.committees.map((x) => (
              <div key={`${x.parent ?? ""}${x.name}`}
                className={`flex items-baseline justify-between gap-2 py-0.5 ${x.parent ? "pl-3" : ""}`}>
                <span className={`min-w-0 flex-1 text-[11px] ${x.parent
                  ? "text-slate-500 dark:text-slate-400"
                  : "font-medium text-slate-700 dark:text-slate-200"}`}>
                  {x.parent && <span className="mr-1 text-slate-300">↳</span>}{x.name}
                </span>
                {x.rank && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {x.rank}
                  </span>
                )}
              </div>
            ))}
          </section>
        ) : null}

        {opponents.length > 0 && (
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Also running ({opponents.length})
            </h3>
            {/* The row is a button and the handles are links, so they are
                siblings rather than nested — an anchor inside a button is
                invalid and swallows one of the two clicks. */}
            {opponents.map((o) => (
              <div key={o.fec_id}
                className="mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                <button onClick={() => onOpen?.(o.fec_id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Portrait src={o.photo} name={o.name} party={o.party} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-slate-800 dark:text-slate-100">{o.name}</span>
                    <span className={`block text-[10px] ${partyText(o.party)}`}>{o.party} · {o.status ?? "filed"}</span>
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{money(o.receipts)}</span>
                </button>
                <PersonLinks social={o.social} wikipedia={o.wikipedia} />
              </div>
            ))}
          </section>
        )}

        {history.length > 0 && (
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              How this seat has voted
            </h3>
            {history.map((h) => (
              <div key={`${h.year}-${h.office}`} className="flex justify-between py-0.5 text-[11px]">
                <span className="text-slate-600 dark:text-slate-300">{h.year} {OFFICE[h.office] ?? h.office}</span>
                <span className={`font-semibold ${partyText(h.winner_party)}`}>
                  {h.margin == null ? "—" : `${h.margin > 0 ? "R" : "D"}+${Math.abs(h.margin).toFixed(1)}`}
                </span>
              </div>
            ))}
          </section>
        )}

        {rec?.url && (
          <a href={rec.url} target="_blank" rel="noopener noreferrer"
            className="block rounded-lg border border-black/10 px-3 py-2 text-center text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-slate-800">
            Official site ↗
          </a>
        )}
      </div>
    </div>
  );
}
