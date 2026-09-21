import { useEffect, useState } from "react";

import { marginLabel, moneyLabel } from "@/config/usElectionMap";
import { apiService } from "@/lib/api";

import PersonLinks, { type Social } from "./PersonLinks";
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
  social?: Social | null;
  wikipedia?: string | null;
  ballotpedia?: string | null;
  opensecrets?: string | null;
  ideology?: { nominate_dim1: number | null; votes_analysed: number; congress: number };
  committees?: { name: string; parent?: string | null; rank: string | null }[];
  finance?: {
    cycle: number; status: string | null; receipts: number; disbursements: number;
    cash_on_hand: number; individual_contrib: number; pac_contrib: number;
    debts: number; coverage_end: string | null;
  };
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
  social?: Social | null;
  wikipedia?: string | null;
  ballotpedia?: string | null;
  opensecrets?: string | null;
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


/* ── head-to-head ──────────────────────────────────────────────────────────
 *
 * The top two finishers of the most recent general, as a fight card.
 *
 * Names and faces come from us_candidates; the NUMBERS come from the
 * certified history row instead. That split is not fussiness — at state
 * level the same person is fragmented across county-level spellings
 * ("Donald J. Trump" and "Donald J. Trump/jd Vance" are two rows summing to
 * one candidate), so a card built on raw per-candidate shares showed TX 2024
 * president as a 5-point race when the certified margin was R+13.88. The
 * aggregate is the honest number; the candidate rows are only the best
 * available label for who the number belongs to.
 */

interface Fighter {
  name: string;
  party: string;
  photo?: string | null;
  bioguide?: string;
  sitting?: boolean;
  votes: number;
  /** percent of all votes cast in the contest */
  share: number;
}

interface Matchup {
  year: number;
  office: string;
  left: Fighter;
  right: Fighter | null;
  otherShare: number;
  margin: number | null;
  total: number;
  /** false when shares are per-candidate rows rather than the aggregate */
  fromAggregate: boolean;
}

function pickMatchup(
  generals: HistoryRow[], past: PastCandidate[],
): Matchup | null {
  const head = generals[0];
  if (!head) return null;
  const pool = past.filter((c) => c.year === head.year && c.office === head.office);
  if (pool.length === 0) return null;

  // The biggest row for a party is the best label for that party's total,
  // even when other rows for the same person exist under different spellings.
  const bestOf = (p: string) =>
    pool.filter((c) => c.party === p).sort((a, b) => b.votes - a.votes)[0] ?? null;
  const dem = bestOf("DEM");
  const rep = bestOf("REP");
  const face = (c: PastCandidate) => ({
    name: c.name, party: c.party, photo: c.photo,
    bioguide: c.bioguide, sitting: c.sitting,
  });

  if (dem && rep) {
    const t = Math.max(head.total, 1);
    const d = (head.votes.DEM / t) * 100;
    const r = (head.votes.REP / t) * 100;
    return {
      year: head.year, office: head.office,
      left: { ...face(dem), votes: head.votes.DEM, share: d },
      right: { ...face(rep), votes: head.votes.REP, share: r },
      otherShare: Math.max(0, 100 - d - r),
      margin: head.margin, total: head.total, fromAggregate: true,
    };
  }

  // One-sided ballot, or a same-party runoff. The aggregate's D/R split says
  // nothing useful about these two, so fall back to their own shares.
  const top = [...pool].sort((a, b) => b.votes - a.votes).slice(0, 2);
  if (top.length === 0) return null;
  const mk = (c: PastCandidate): Fighter => ({
    ...face(c), votes: c.votes, share: c.vote_share,
  });
  return {
    year: head.year, office: head.office,
    left: mk(top[0]),
    right: top[1] ? mk(top[1]) : null,
    otherShare: 0,
    margin: head.margin, total: head.total, fromAggregate: false,
  };
}

const PARTY_HEX: Record<string, string> = {
  DEM: "#2563eb", REP: "#dc2626",
};
const partyFill = (p: string) => PARTY_HEX[p] ?? "#64748b";

/** One corner of the card: face, name, party, incumbency. */
function Corner({
  f, lead, align, onOpen,
}: {
  f: Fighter; lead: boolean; align: "left" | "right"; onOpen?: () => void;
}) {
  const right = align === "right";
  return (
    <button
      onClick={onOpen}
      disabled={!onOpen}
      className={`flex min-w-0 flex-col gap-1.5 ${
        right ? "items-end text-right" : "items-start text-left"
      } ${onOpen ? "cursor-pointer" : "cursor-default"}`}
    >
      <span
        className="rounded-full"
        style={lead
          ? { boxShadow: `0 0 0 2px ${partyFill(f.party)}, 0 0 16px -2px ${partyFill(f.party)}` }
          : undefined}
      >
        <Portrait src={f.photo} name={f.name} party={f.party} size={64} />
      </span>
      <span className="min-w-0 max-w-full">
        <span className="block truncate text-[11px] font-semibold leading-tight text-slate-900 dark:text-white">
          {f.name}
        </span>
        <span className={`mt-0.5 flex items-center gap-1 ${right ? "justify-end" : ""}`}>
          <span className={`font-mono text-[9px] font-bold tracking-wider ${partyText(f.party)}`}>
            {f.party}
          </span>
          {f.sitting && (
            <span
              title="holds this seat today"
              className="rounded-[2px] bg-slate-900 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-white dark:bg-white dark:text-slate-900"
            >
              ★ Incumbent
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function MatchupCard({
  m, holders, cands, onSelectPerson, onSelectCandidate,
}: {
  m: Matchup;
  holders: Holder[];
  cands: Candidate[];
  onSelectPerson?: (h: Holder) => void;
  onSelectCandidate?: (c: { fecId?: string; name: string }) => void;
}) {
  // Grow the bar from nothing on mount so a result reads as landing rather
  // than as having always been there. Keyed on the contest so reopening the
  // panel on a different district replays it.
  const key = `${m.year}-${m.office}-${m.left.name}`;
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    setGrown(false);
    const id = window.setTimeout(() => setGrown(true), 60);
    return () => window.clearTimeout(id);
  }, [key]);

  const leadLeft = m.right ? m.left.votes >= m.right.votes : true;
  const bar = (pct: number) => ({
    width: grown ? `${Math.max(0, Math.min(100, pct))}%` : "0%",
    transition: "width 700ms cubic-bezier(0.22,1,0.36,1)",
  });

  // Who each fighter is beyond this one contest.
  const holderFor = (f: Fighter) => holders.find(
    (h) => (f.bioguide && h.bioguide === f.bioguide) || h.name === f.name) ?? null;
  const candFor = (f: Fighter) => cands.find((c) => c.name === f.name) ?? null;

  const open = (f: Fighter) => {
    const h = holderFor(f);
    if (h && onSelectPerson) return () => onSelectPerson(h);
    const c = candFor(f);
    if (c && onSelectCandidate) return () => onSelectCandidate({ fecId: c.fec_id, name: c.name });
    if (onSelectCandidate) return () => onSelectCandidate({ name: f.name });
    return undefined;
  };

  return (
    <section className="mb-4">
      <div className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-slate-900/70">
        {/* contest */}
        <div className="border-b border-black/5 bg-slate-50 px-3 py-1.5 text-center font-mono text-[9px] uppercase tracking-[0.22em] text-slate-500 dark:border-white/5 dark:bg-slate-950/60 dark:text-slate-400">
          {m.year} · {OFFICE_LABEL[m.office] ?? m.office}
        </div>

        {/* corners */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 px-3 pt-3">
          <Corner f={m.left} lead={leadLeft} align="left" onOpen={open(m.left)} />
          {m.right ? (
            <div className="flex select-none flex-col items-center gap-1 pt-5">
              <span className="h-3 w-px bg-gradient-to-b from-transparent to-cyan-400/40" />
              <span
                className="font-mono text-[11px] font-bold tracking-[0.15em] text-cyan-500 dark:text-cyan-300"
                style={{ textShadow: "0 0 10px rgba(34,211,238,0.55)" }}
              >
                VS
              </span>
              <span className="h-3 w-px bg-gradient-to-t from-transparent to-cyan-400/40" />
            </div>
          ) : <span />}
          {m.right
            ? <Corner f={m.right} lead={!leadLeft} align="right" onOpen={open(m.right)} />
            : <span />}
        </div>

        {/* tug of war */}
        <div className="px-3 pb-3 pt-3">
          <div className="flex items-baseline justify-between font-mono text-[11px] font-bold tabular-nums">
            <span style={{ color: partyFill(m.left.party) }}>
              {m.left.share.toFixed(1)}%
            </span>
            {m.right && (
              <span style={{ color: partyFill(m.right.party) }}>
                {m.right.share.toFixed(1)}%
              </span>
            )}
          </div>

          <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <span style={{ ...bar(m.left.share), background: partyFill(m.left.party) }} />
            <span
              className="bg-slate-300 dark:bg-slate-600"
              style={bar(m.otherShare)}
            />
            {m.right && (
              <span
                className="ml-auto"
                style={{ ...bar(m.right.share), background: partyFill(m.right.party) }}
              />
            )}
          </div>

          <div className="mt-1 flex items-baseline justify-between text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
            <span>{m.left.votes.toLocaleString()}</span>
            {m.right && <span>{m.right.votes.toLocaleString()}</span>}
          </div>

          <div className="mt-2 flex justify-center">
            <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider ${
              m.margin == null
                ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                : m.margin > 0
                  ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            }`}>
              {marginLabel(m.margin)} MARGIN
            </span>
          </div>

          {!m.fromAggregate && (
            <p className="mt-1.5 text-center text-[9px] leading-relaxed text-slate-400">
              Shares are each candidate&rsquo;s own rows, not a two-party total.
            </p>
          )}
        </div>
      </div>

      {/* the record behind each name */}
      {[m.left, m.right].filter(Boolean).map((f) => {
        const ff = f as Fighter;
        const h = holderFor(ff);
        const c = candFor(ff);
        const fin = h?.finance ?? null;
        const receipts = fin?.receipts ?? c?.receipts ?? null;
        const cash = fin?.cash_on_hand ?? c?.cash_on_hand ?? null;
        const ind = fin?.individual_contrib ?? c?.individual_contrib ?? null;
        const pac = fin?.pac_contrib ?? c?.pac_contrib ?? null;
        const dw = h?.ideology?.nominate_dim1;
        const comms = h?.committees ?? [];
        if (!h && !c) return null;
        return (
          <div
            key={`rec-${ff.name}`}
            className="mt-1.5 rounded-lg border border-black/5 px-2.5 py-2 dark:border-white/5"
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full`}
                style={{ background: partyFill(ff.party) }} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-800 dark:text-slate-100">
                {ff.name}
              </span>
              {h?.url && (
                <a
                  href={h.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-cyan-600 hover:underline dark:text-cyan-400"
                >
                  official ↗
                </a>
              )}
            </div>

            {h?.term_start && (
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                In office since {h.term_start.slice(0, 4)}
                {h.term_end ? ` · term ends ${h.term_end.slice(0, 4)}` : ""}
                {h.next_election ? ` · up ${h.next_election.slice(0, 4)}` : ""}
              </p>
            )}

            {/* DW-NOMINATE: a real voting record, computed from roll calls. */}
            {typeof dw === "number" && (
              <div className="mt-1.5">
                <div className="flex items-baseline justify-between font-mono text-[9px] uppercase tracking-wider text-slate-400">
                  <span>Voting record</span>
                  <span className="tabular-nums text-slate-500 dark:text-slate-300">
                    {dw > 0 ? "+" : ""}{dw.toFixed(2)}
                  </span>
                </div>
                <div className="relative mt-1 h-1.5 w-full rounded-full bg-gradient-to-r from-blue-500/50 via-slate-300 to-red-500/50 dark:via-slate-600">
                  <span
                    className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900 dark:bg-white"
                    style={{ left: `${Math.max(0, Math.min(100, (dw + 1) * 50))}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[9px] text-slate-400">
                  DW-NOMINATE
                  {h?.ideology?.votes_analysed
                    ? ` · ${h.ideology.votes_analysed.toLocaleString()} roll calls`
                    : ""}
                </p>
              </div>
            )}

            {receipts != null && receipts > 0 && (
              <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                <span className="text-slate-400">Raised</span>
                <span className="text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {moneyLabel(receipts)}
                </span>
                {cash != null && (
                  <>
                    <span className="text-slate-400">Cash on hand</span>
                    <span className="text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {moneyLabel(cash)}
                    </span>
                  </>
                )}
                {ind != null && pac != null && (ind > 0 || pac > 0) && (
                  <>
                    <span className="text-slate-400">Individual · PAC</span>
                    <span className="text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {moneyLabel(ind)} · {moneyLabel(pac)}
                    </span>
                  </>
                )}
              </div>
            )}

            {comms.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-wider text-slate-400">
                  {comms.length} committee{comms.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {comms.slice(0, 8).map((cm) => (
                    <li key={cm.name} className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                      {cm.parent ? <span className="text-slate-400">↳ </span> : null}
                      {cm.name}
                      {cm.rank && (
                        <span className="ml-1 font-medium text-slate-600 dark:text-slate-300">
                          · {cm.rank}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}

/* ── who's running ─────────────────────────────────────────────────────────
 *
 * The next election, placed above the last one.
 *
 * A panel that opens on whoever already holds the seat quietly tells the
 * reader that the job is taken. The undecided part is the people trying to
 * take it, so they lead and the sitting member becomes context underneath.
 *
 * Money raised orders the list and scales the bars because it is the only
 * comparable number the bulk FEC filings carry for every filer. It is money,
 * not votes and not polling — a long bar is a war chest and nothing else, and
 * the caption under the list says so. Filing is registration with the FEC,
 * which is not the same as a certified place on the ballot.
 */

const isSeatHolder = (c: Candidate) => c.sitting === true || c.status === "incumbent";

const statusTag = (c: Candidate) =>
  c.status === "open seat" ? "Open seat"
    : c.status === "challenger" ? "Challenger"
      : c.status ?? "Filed";

/** Last name, ignoring generational suffixes — "Paxton Jr." is a Paxton. */
const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function surname(name: string): string {
  const parts = name.toLowerCase().replace(/[.,]/g, "").trim().split(/\s+/)
    .filter((t) => !SUFFIX.has(t));
  return parts[parts.length - 1] ?? "";
}

interface OfficeField {
  office: string;
  cycle: number;
  challengers: Candidate[];
  seated: Candidate[];
  /** Holders of this seat with no filing this cycle — still context. */
  otherHolders: Holder[];
  max: number;
  filed: number;
  challengerMoney: number;
  seatedMoney: number;
}

/**
 * Split the filer list into one race per office.
 *
 * The API returns every filing for a division rather than one office's, so a
 * state can carry a Senate race and a governor's race in the same array. They
 * are separate contests and must not share a money scale — a $68m Senate haul
 * would flatten every governor's bar to a sliver of a race it has nothing to
 * do with.
 */
function buildFields(cands: Candidate[], holders: Holder[]): OfficeField[] {
  const cycle = cands.length ? Math.max(...cands.map((c) => c.cycle)) : null;
  const live = cycle == null ? [] : cands.filter((c) => c.cycle === cycle);

  const offices = [...new Set([
    ...live.map((c) => c.office),
    ...holders.map((h) => h.office),
  ])];

  // bioguide first, the same join the API uses. Where a filing carries no
  // bioguide the exact name is not enough either: the FEC files Ted Cruz as
  // "Rafael Edward Ted Cruz" and John Cornyn as "John Sen Cornyn", so a
  // strict match listed both men twice — once as a filer, once as a holder
  // with "no filing this cycle" beside a seat they had in fact filed for.
  // Party plus surname closes that, and a collision there would only merge
  // two same-party candidates sharing a surname, which loses a row rather
  // than inventing one.
  const filedAlready = (h: Holder, pool: Candidate[]) => pool.some((c) => {
    if (h.bioguide && c.bioguide) return c.bioguide === h.bioguide;
    if (c.name === h.name) return true;
    return c.party === h.party && surname(c.name) === surname(h.name);
  });

  return offices
    .map((office) => {
      const pool = live.filter((c) => c.office === office);
      const seated = pool.filter(isSeatHolder)
        .sort((a, b) => b.receipts - a.receipts);
      const challengers = pool.filter((c) => !isSeatHolder(c))
        .sort((a, b) => b.receipts - a.receipts);
      return {
        office,
        cycle: cycle ?? 0,
        challengers,
        seated,
        otherHolders: holders.filter(
          (h) => h.office === office && !filedAlready(h, pool)),
        max: Math.max(...pool.map((c) => c.receipts), 1),
        filed: pool.length,
        challengerMoney: challengers.reduce((t, c) => t + c.receipts, 0),
        seatedMoney: seated.reduce((t, c) => t + c.receipts, 0),
      };
    })
    .filter((f) => f.challengers.length || f.seated.length || f.otherHolders.length)
    .sort((a, b) => b.filed - a.filed);
}

function MoneyBar({ value, max, party, muted }: {
  value: number; max: number; party: string; muted?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className={`mt-1 block w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700 ${
      muted ? "h-[3px]" : "h-1.5"
    }`}>
      <span
        className="block h-full rounded-full"
        style={{
          width: `${pct}%`,
          background: partyFill(party),
          opacity: muted ? 0.5 : 1,
          transition: "width 600ms cubic-bezier(0.22,1,0.36,1)",
        }}
      />
    </span>
  );
}

/** A challenger, at full weight. */
function ChallengerRow({ c, max, onOpen }: {
  c: Candidate; max: number; onOpen?: () => void;
}) {
  const links = (
    <PersonLinks
      social={c.social}
      wikipedia={c.wikipedia}
      ballotpedia={c.ballotpedia}
      opensecrets={c.opensecrets}
    />
  );
  return (
    /* The card is a button and the handles are links. An anchor nested in a
       button is invalid HTML and one of the two clicks gets eaten, so the
       link bar is a sibling laid over the same card. */
    <div className="mb-1.5 rounded-lg border border-black/5 hover:bg-slate-50 dark:border-white/5 dark:hover:bg-slate-800">
    <button
      onClick={onOpen}
      disabled={!onOpen}
      className="block w-full rounded-lg px-2.5 pb-1 pt-2 text-left disabled:cursor-default"
    >
      <div className="flex items-center gap-2.5">
        <Portrait src={c.photo} name={c.name} party={c.party} size={40} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-semibold text-slate-900 dark:text-white">
              {c.name}
            </span>
            <span className={`shrink-0 font-mono text-[10px] font-bold ${partyText(c.party)}`}>
              {c.party}
            </span>
          </span>
          <span className="mt-0.5 flex items-baseline justify-between gap-2">
            <span className="shrink-0 rounded-[2px] border border-cyan-500/30 bg-cyan-500/10 px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
              {statusTag(c)}
            </span>
            <span className="shrink-0 text-[10px] font-medium tabular-nums text-slate-600 dark:text-slate-300">
              {c.receipts > 0 ? moneyLabel(c.receipts) : "nothing reported"}
            </span>
          </span>
          <MoneyBar value={c.receipts} max={max} party={c.party} />
        </span>
      </div>
    </button>
      {/* Indented to clear the 40px portrait, so the handles line up with
          the name they belong to rather than the card edge. */}
      <div className="flex justify-end px-2.5 pb-1.5 pl-[3.6rem] empty:hidden">
        {links}
      </div>
    </div>
  );
}

/**
 * A member's position on the roll-call axis, as a tick on a line.
 *
 * Only the FIRST DW-NOMINATE dimension is ever drawn. The second separates
 * the parties barely better than chance and would put Ocasio-Cortez and Chip
 * Roy on the same side of a "social" axis — a compass built from it would
 * look rigorous and be wrong. No label is attached to the position either.
 */
function IdeologyTick({ dim1, party }: { dim1: number; party: string }) {
  const pct = Math.min(97, Math.max(3, ((dim1 + 1) / 2) * 100));
  const dot = party === "DEM" ? "bg-blue-600" : party === "REP" ? "bg-red-600" : "bg-slate-600";
  return (
    <span
      className="mt-1 block"
      title={`DW-NOMINATE ${dim1.toFixed(2)} on the economic axis (-1 liberal to +1 conservative), from roll-call votes in the 119th Congress. Source: Voteview.`}
    >
      <span className="relative block h-1 w-full rounded-full"
        style={{ background: "linear-gradient(to right,#1d4ed8,#e2e8f0,#b91c1c)" }}>
        <span className={`absolute -top-[3px] h-[7px] w-[7px] rounded-full border border-white shadow-sm ${dot}`}
          style={{ left: `calc(${pct}% - 3.5px)` }} />
      </span>
    </span>
  );
}

/** A sitting member, deliberately quieter. */
function SeatHolderRow({
  name, party, photo, sub, receipts, max, onOpen, holder,
}: {
  name: string; party: string; photo?: string | null; sub: string;
  receipts: number | null; max: number; onOpen?: () => void;
  /** Supplies the voting-record tick and the outbound links, when known. */
  holder?: Holder;
}) {
  const dim1 = holder?.ideology?.nominate_dim1;
  const links = (
    <PersonLinks
      social={holder?.social}
      wikipedia={holder?.wikipedia}
      ballotpedia={holder?.ballotpedia}
      opensecrets={holder?.opensecrets}
    />
  );
  return (
    <div className="mb-1 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60">
    <button
      onClick={onOpen}
      disabled={!onOpen}
      className="block w-full rounded-lg px-2 pb-0.5 pt-1.5 text-left disabled:cursor-default"
    >
      <div className="flex items-center gap-2">
        <Portrait src={photo} name={name} party={party} size={28} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] font-medium text-slate-600 dark:text-slate-300">
              {name}
              <span className={`ml-1 font-mono text-[9px] font-bold ${partyText(party)}`}>
                {party}
              </span>
            </span>
            {receipts != null && receipts > 0 && (
              <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
                {moneyLabel(receipts)}
              </span>
            )}
          </span>
          <span className="block truncate text-[9px] text-slate-400">{sub}</span>
          {receipts != null && receipts > 0 && (
            <MoneyBar value={receipts} max={max} party={party} muted />
          )}
          {/* Absent for anyone who has not cast roll-call votes. Nothing is
              drawn in that case — an empty axis or a centred tick would
              read as "this person is a centrist", which is a claim. */}
          {dim1 != null && <IdeologyTick dim1={dim1} party={party} />}
        </span>
      </div>
    </button>
      <div className="flex justify-end px-2 pb-1 pl-10 empty:hidden">{links}</div>
    </div>
  );
}

function OfficeRace({
  f, holders, onSelectPerson, onSelectCandidate,
}: {
  f: OfficeField;
  holders: Holder[];
  onSelectPerson?: (h: Holder) => void;
  onSelectCandidate?: (c: { fecId?: string; name: string }) => void;
}) {
  const TOP = 5;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? f.challengers : f.challengers.slice(0, TOP);
  const hidden = f.challengers.length - shown.length;

  const holderFor = (c: Candidate) => holders.find(
    (h) => (c.bioguide && h.bioguide === c.bioguide) || h.name === c.name) ?? null;

  // A sitting member routes into their own record where we have one; a
  // challenger has no officeholder page to route to.
  const openSeated = (c: Candidate) => {
    const h = holderFor(c);
    if (h && onSelectPerson) return () => onSelectPerson(h);
    if (onSelectCandidate) return () => onSelectCandidate({ fecId: c.fec_id, name: c.name });
    return undefined;
  };
  const openChallenger = (c: Candidate) => (onSelectCandidate
    ? () => onSelectCandidate({ fecId: c.fec_id, name: c.name })
    : undefined);

  const ratio = f.seatedMoney > 0 ? f.challengerMoney / f.seatedMoney : null;

  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-cyan-500/20 pb-1">
        <span className="truncate font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
          {f.cycle} · {OFFICE_LABEL[f.office] ?? f.office}
        </span>
        {f.filed > 0 && (
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-slate-400">
            {f.filed} filed
          </span>
        )}
      </div>

      {shown.map((c) => (
        <ChallengerRow
          key={c.fec_id || c.name}
          c={c}
          max={f.max}
          onOpen={openChallenger(c)}
        />
      ))}

      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="mb-1.5 w-full rounded-lg border border-dashed border-black/10 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-slate-400 hover:text-slate-600 dark:border-white/10 dark:hover:text-slate-300"
        >
          +{hidden} more filed
        </button>
      )}
      {expanded && f.challengers.length > TOP && (
        <button
          onClick={() => setExpanded(false)}
          className="mb-1.5 w-full rounded-lg px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          show fewer
        </button>
      )}

      {/* Both sides of the money, stated as money. */}
      {f.challengerMoney > 0 && f.seatedMoney > 0 && (
        <p className="mb-1.5 rounded bg-slate-50 px-2 py-1 text-[9px] leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          Challengers have raised{" "}
          <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
            {moneyLabel(f.challengerMoney)}
          </span>{" "}
          to the sitting {f.seated.length === 1 ? "member" : "members"}&rsquo;{" "}
          <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
            {moneyLabel(f.seatedMoney)}
          </span>
          {ratio && ratio >= 1.5 ? ` — ${ratio.toFixed(1)}× as much.` : "."}
        </p>
      )}

      {(f.seated.length > 0 || f.otherHolders.length > 0) && (
        <>
          <p className="mb-1 mt-2 border-t border-black/5 pt-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400 dark:border-white/5">
            Currently holding this seat
          </p>
          {f.seated.map((c) => {
            const h = holderFor(c);
            return (
              <SeatHolderRow
                key={c.fec_id || c.name}
                name={c.name}
                party={c.party}
                photo={c.photo ?? h?.photo}
                sub={[
                  h?.term_start ? `since ${h.term_start.slice(0, 4)}` : "incumbent",
                  h?.next_election ? `up ${h.next_election.slice(0, 4)}` : null,
                  "running again",
                ].filter(Boolean).join(" · ")}
                receipts={c.receipts}
                max={f.max}
                holder={h}
                onOpen={openSeated(c)}
              />
            );
          })}
          {f.otherHolders.map((h) => (
            <SeatHolderRow
              key={h.bioguide || h.name}
              name={h.name}
              party={h.party}
              photo={h.photo}
              sub={[
                h.term_start ? `since ${h.term_start.slice(0, 4)}` : "in office",
                h.next_election ? `up ${h.next_election.slice(0, 4)}` : null,
                h.senate_class ? `class ${h.senate_class}` : null,
                "no filing this cycle",
              ].filter(Boolean).join(" · ")}
              receipts={null}
              max={f.max}
              holder={h}
              onOpen={onSelectPerson ? () => onSelectPerson(h) : undefined}
            />
          ))}
        </>
      )}
    </div>
  );
}

function WhosRunning({
  fields, holders, coverageEnd, onSelectPerson, onSelectCandidate,
}: {
  fields: OfficeField[];
  holders: Holder[];
  coverageEnd: string | null;
  onSelectPerson?: (h: Holder) => void;
  onSelectCandidate?: (c: { fecId?: string; name: string }) => void;
}) {
  if (fields.length === 0) return null;
  const anyFiled = fields.some((f) => f.filed > 0);
  return (
    <section className="mb-4">
      <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-700 dark:text-slate-200">
        Who&rsquo;s running
      </h3>
      {fields.map((f) => (
        <OfficeRace
          key={f.office}
          f={f}
          holders={holders}
          onSelectPerson={onSelectPerson}
          onSelectCandidate={onSelectCandidate}
        />
      ))}
      {anyFiled && (
        <p className="text-[9px] leading-relaxed text-slate-400">
          Bars are money raised — not votes, and not a poll. Filed with the FEC
          {coverageEnd ? `, through ${coverageEnd}` : ""}; filing is
          registration, not a certified place on the ballot.
        </p>
      )}
    </section>
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

  // Challengers lead. Whoever already holds the seat is context underneath —
  // see buildFields. The reader opens a division to find out what could
  // change, and the incumbent is the part that already happened.
  const fields = buildFields(cands, holders);
  const matchup = pickMatchup(generals, past);
  const coverageEnd = cands[0]?.coverage_end ?? null;

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
            <WhosRunning
              fields={fields}
              holders={holders}
              coverageEnd={coverageEnd}
              onSelectPerson={onSelectPerson}
              onSelectCandidate={onSelectCandidate}
            />

            {matchup && (
              <MatchupCard
                m={matchup}
                holders={holders}
                cands={cands}
                onSelectPerson={onSelectPerson}
                onSelectCandidate={onSelectCandidate}
              />
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
