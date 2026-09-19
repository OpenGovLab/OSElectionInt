import { useEffect, useState } from "react";

import { marginLabel } from "@/config/usElectionMap";
import { apiService } from "@/lib/api";

import Portrait from "./Portrait";
import VoterInfo from "./VoterInfo";

/**
 * What is on the ballot in one place, and what has happened there before.
 *
 * Opens over the viewport list when a division is selected — the AllTrails
 * pattern, where picking a trail replaces the list with its detail and a back
 * arrow returns you. Same component serves the desktop side panel and the
 * mobile bottom sheet.
 */

export interface Holder {
  name: string;
  party: string;
  office: string;
  next_election: string | null;
  senate_class?: number;
  url?: string;
  photo?: string | null;
  bioguide?: string;
  term_start?: string | null;
  term_end?: string | null;
}

export interface Candidate {
  name: string;
  party: string;
  status: string | null;
  office: string;
  cycle: number;
  receipts: number;
  cash_on_hand: number;
  individual_contrib: number;
  pac_contrib: number;
  ballot_status: string;
  coverage_end: string | null;
  fec_id?: string;
  photo?: string | null;
  bioguide?: string;
  /** Set by the API when this filer already holds the seat. */
  sitting?: boolean;
}

export interface PastCandidate {
  year: number; office: string; district: number | null;
  name: string; party: string; votes: number; vote_share: number; led_in_data: boolean;
  photo?: string | null;
  bioguide?: string;
  sitting?: boolean;
}

interface HistoryRow {
  year: number;
  office: string;
  district: number | null;
  election_type: string;
  margin: number | null;
  winner_party: string;
  votes: { DEM: number; REP: number; OTH: number };
  total: number;
  major_share: number;
}

const OFFICE_LABEL: Record<string, string> = {
  president: "President",
  us_senate: "U.S. Senate",
  us_house: "U.S. House",
  governor: "Governor",
};

const partyText = (p: string) =>
  p === "DEM" ? "text-blue-600 dark:text-blue-400"
    : p === "REP" ? "text-red-600 dark:text-red-400"
      : "text-slate-500 dark:text-slate-400";

const partyBg = (p: string) =>
  p === "DEM" ? "bg-blue-600" : p === "REP" ? "bg-red-600" : "bg-slate-400";

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
    : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n.toFixed(0)}`;

function fmtDate(iso: string | null) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** Bar showing the two-party split; width is each side's share of the vote. */
function VoteBar({ row }: { row: HistoryRow }) {
  const t = Math.max(row.total, 1);
  const d = (row.votes.DEM / t) * 100;
  const r = (row.votes.REP / t) * 100;
  const o = Math.max(0, 100 - d - r);
  return (
    <span className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
      <span className="bg-blue-600" style={{ width: `${d}%` }} />
      <span className="bg-slate-300 dark:bg-slate-600" style={{ width: `${o}%` }} />
      <span className="bg-red-600" style={{ width: `${r}%` }} />
    </span>
  );
}

export default function DivisionDetail({
  ocdId, name, onBack, onSelectPerson, onSelectCandidate,
}: {
  ocdId: string;
  name: string;
  onBack: () => void;
  onSelectPerson?: (h: Holder) => void;
  onSelectCandidate?: (c: { fecId?: string; name: string }) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [past, setPast] = useState<PastCandidate[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    apiService({
      method: "get",
      url: `/us-election/division?ocd_id=${encodeURIComponent(ocdId)}`,
    })
      .then((r) => {
        if (!alive) return;
        const d = r?.data?.data;
        if (!d) { setErr("not found"); return; }
        setHolders(d.holders || []);
        setHistory(d.history || []);
        setCands(d.candidates || []);
        setPast(d.pastCandidates || []);
      })
      .catch(() => { if (alive) setErr("could not load"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ocdId]);

  // Generals are the headline; primaries are kept but shown as a separate,
  // quieter group so a 60-point primary margin never reads as a landslide.
  const generals = history.filter((h) => h.election_type === "general");
  const others = history.filter((h) => h.election_type !== "general");

  const upcoming = holders
    .filter((h) => h.next_election)
    .sort((a, b) => (a.next_election! < b.next_election! ? -1 : 1));
  const nextDay = upcoming[0]?.next_election ?? null;

  // Whoever holds the seat leads the filer list. The API already ordered it by
  // money raised, which is a real signal but not the one a reader opens a
  // district to find — they want to know who has the job before they read who
  // is trying to take it. Stable within each group, so money still orders the
  // challengers.
  const running = [...cands].sort((a, b) => Number(!!b.sitting) - Number(!!a.sitting));
  const maxReceipts = Math.max(...cands.map((x) => x.receipts), 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 px-3 pt-3">
        <button
          onClick={onBack}
          aria-label="Back to list"
          className="mt-0.5 rounded-md px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          ←
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{name}</h2>
          <p className="truncate font-mono text-[10px] text-slate-400 dark:text-slate-500">
            {ocdId.replace("ocd-division/country:us/", "")}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
        {loading && <p className="py-6 text-center text-xs text-slate-500">Loading…</p>}
        {err && <p className="py-6 text-center text-xs text-red-600">{err}</p>}

        {!loading && !err && (
          <>
            {holders.length > 0 && (
              <section className="mb-3">
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {holders.length > 1 ? "Currently represented by" : "Currently held by"}
                </h3>
                {holders.map((h) => (
                  <button
                    key={h.bioguide || h.name}
                    onClick={() => onSelectPerson?.(h)}
                    className="mb-1.5 flex w-full items-center gap-2.5 rounded-xl border border-black/10 bg-white px-2.5 py-2.5 text-left shadow-sm hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:hover:bg-slate-800"
                  >
                    <Portrait src={h.photo} name={h.name} party={h.party} size={48} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900 dark:text-white">
                        {h.name}
                      </span>
                      <span className={`block truncate text-[11px] font-medium ${partyText(h.party)}`}>
                        {h.party} · {OFFICE_LABEL[h.office] ?? h.office}
                        {h.senate_class ? ` · class ${h.senate_class}` : ""}
                      </span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {h.term_start ? `since ${h.term_start.slice(0, 4)}` : "in office"}
                        {h.next_election ? ` · up in ${h.next_election.slice(0, 4)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-slate-300">›</span>
                  </button>
                ))}
              </section>
            )}

            <VoterInfo ocdId={ocdId} />

            {nextDay && (
              <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">
                  Next election here
                </p>
                <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                  {fmtDate(nextDay)}
                </p>
              </div>
            )}

            {cands.length > 0 && (
              <section className="mb-4">
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Running in {cands[0].cycle} ({cands.length})
                </h3>
                {running.map((c) => (
                  <button key={c.fec_id || c.name}
                    onClick={() => onSelectCandidate?.({ fecId: c.fec_id, name: c.name })}
                    className={`mb-1.5 block w-full rounded-lg border px-2.5 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      c.sitting
                        ? "border-slate-900/25 bg-slate-50/60 dark:border-white/25 dark:bg-slate-800/40"
                        : "border-black/5 dark:border-white/5"
                    }`}>
                    <div className="flex items-center gap-2">
                      <Portrait src={c.photo} name={c.name} party={c.party} size={34} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-xs font-medium text-slate-900 dark:text-white">
                            {c.name}
                          </span>
                          <span className={`shrink-0 text-[10px] font-semibold ${partyText(c.party)}`}>
                            {c.party}
                          </span>
                        </span>
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                            {c.sitting && (
                              <span className="mr-1 rounded bg-slate-900 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-white dark:bg-white dark:text-slate-900">
                                Incumbent
                              </span>
                            )}
                            {c.status ?? "filed"}
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-slate-600 dark:text-slate-300">
                            {c.receipts > 0 ? money(c.receipts) : "no funds reported"}
                          </span>
                        </span>
                      </span>
                    </div>
                    {/* Money raised is the only comparable signal of
                        seriousness the bulk filings carry. */}
                    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                      <span className={`block h-full ${partyBg(c.party)}`}
                        style={{ width: `${(c.receipts / maxReceipts) * 100}%` }} />
                    </span>
                  </button>
                ))}
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                  Filed with the FEC{cands[0].coverage_end ? `, through ${cands[0].coverage_end}` : ""}.
                  Filing is registration, not a place on the ballot — that needs
                  state certification.
                </p>
              </section>
            )}

            {past.length > 0 && (
              <section className="mb-4">
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Who ran here before
                </h3>
                <p className="mb-1.5 text-[10px] leading-relaxed text-slate-400">
                  Shares are of the votes present in our data, which is
                  volunteer-contributed and uneven. Where counties are missing
                  the leader shown can differ from the certified winner, so no
                  winner is declared here.
                </p>
                {Object.entries(
                  past.reduce<Record<string, PastCandidate[]>>((acc, c) => {
                    const k = `${c.year} ${OFFICE_LABEL[c.office] ?? c.office}`;
                    (acc[k] ||= []).push(c);
                    return acc;
                  }, {}),
                ).slice(0, 6).map(([label, people]) => (
                  <details key={label} className="mb-1 rounded-lg border border-black/5 px-2.5 py-1.5 dark:border-white/5">
                    <summary className="cursor-pointer text-[11px] font-medium text-slate-700 dark:text-slate-200">
                      {label}
                      <span className="ml-1 text-slate-400">· {people.length} on the ballot</span>
                    </summary>
                    {people.slice(0, 12).map((c) => (
                      <div key={`${c.bioguide || c.name}`} className="flex items-center gap-2 py-1">
                        <Portrait src={c.photo} name={c.name} party={c.party} size={24} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600 dark:text-slate-300">
                              {c.led_in_data && (
                                <span className="mr-1 text-slate-400" title="led the votes present in our data — not a called result">▲</span>
                              )}
                              {c.name}
                              <span className={`ml-1 ${partyText(c.party)}`}>{c.party}</span>
                              {c.sitting && (
                                <span className="ml-1 text-slate-400" title="holds this seat today">· holds it now</span>
                              )}
                            </span>
                            <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                              {c.vote_share.toFixed(1)}%
                            </span>
                          </span>
                          {/* The share as a bar, so a ballot reads at a glance
                              instead of as a column of numbers. */}
                          <span className="mt-0.5 block h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                            <span className={`block h-full ${partyBg(c.party)}`}
                              style={{ width: `${Math.min(100, c.vote_share)}%` }} />
                          </span>
                        </span>
                      </div>
                    ))}
                  </details>
                ))}
              </section>
            )}

            <section>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Past results {generals.length ? `(${generals.length})` : ""}
              </h3>
              {generals.length === 0 && (
                <p className="py-3 text-xs text-slate-500">
                  No certified general-election results here yet. Coverage is
                  uneven — OpenElections is volunteer-contributed.
                </p>
              )}
              {generals.map((h) => (
                <div key={`${h.year}-${h.office}-${h.district}`}
                  className="mb-2 rounded-lg border border-black/5 px-2.5 py-2 dark:border-white/5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">
                      {h.year} {OFFICE_LABEL[h.office] ?? h.office}
                      {h.district ? ` · district ${h.district}` : ""}
                    </span>
                    <span className={`shrink-0 text-[11px] font-semibold ${partyText(h.winner_party)}`}>
                      {marginLabel(h.margin)}
                    </span>
                  </div>
                  <VoteBar row={h} />
                  <div className="mt-1 flex justify-between text-[10px] text-slate-400">
                    <span>{h.total.toLocaleString()} votes</span>
                    {h.major_share < 0.9 && (
                      <span title="share of votes carrying a usable party label">
                        {Math.round(h.major_share * 100)}% two-party
                      </span>
                    )}
                  </div>
                </div>
              ))}

              {others.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] text-slate-500">
                    {others.length} primary / special contests
                  </summary>
                  {others.map((h) => (
                    <div key={`${h.year}-${h.office}-${h.election_type}-${h.district}`}
                      className="mt-1 flex justify-between text-[11px] text-slate-500">
                      <span className="truncate">
                        {h.year} {OFFICE_LABEL[h.office] ?? h.office} · {h.election_type}
                      </span>
                      <span className="shrink-0">{marginLabel(h.margin)}</span>
                    </div>
                  ))}
                </details>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
