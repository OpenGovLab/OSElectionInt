import PersonLinks, { type Social } from "./PersonLinks";
import Portrait from "./Portrait";

/**
 * One officeholder: how they vote, what they sit on, and who funds them.
 *
 * Everything here is bulk open data, and each panel says where it came from —
 * a reader deciding how to vote should be able to check the source, and a
 * number with no provenance is worth less than no number.
 *
 * Deliberately NOT shown: stated positions on issues. There is no open,
 * structured, non-partisan dataset of those, and inferring them from a voting
 * score would be presenting our guess as their platform.
 */

export interface Person {
  name: string;
  party: string;
  office: string;
  next_election: string | null;
  term_start?: string;
  term_end?: string;
  senate_class?: number;
  url?: string;
  bioguide?: string;
  photo?: string | null;
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

const OFFICE_LABEL: Record<string, string> = {
  president: "President", us_senate: "U.S. Senate",
  us_house: "U.S. House", governor: "Governor",
};

const partyName = (p: string) =>
  p === "DEM" ? "Democrat" : p === "REP" ? "Republican" : p === "IND" ? "Independent" : p;

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n.toFixed(0)}`;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-[11px] text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-[11px] font-medium text-slate-800 dark:text-slate-100">{value}</span>
    </div>
  );
}

/**
 * Where this member sits on the roll-call axis, drawn as a position on a line.
 *
 * ONE axis, deliberately. DW-NOMINATE's first dimension separates the parties
 * almost completely (it classifies party 99.8% of the time); the second
 * separates them barely better than a coin toss (59.7%) and is close to
 * residual variation in the modern era. Plotting dim1 against dim2 as an
 * economic/social compass reads as rigour and is not: it puts Ocasio-Cortez
 * (dim2 -0.94) and Chip Roy (dim2 -0.60) on the same side.
 *
 * No word is attached to a position either. The marker and the number are
 * shown; calling a living person "moderate" or "far-right" is our judgement
 * dressed as their data.
 */
function IdeologyScale({ dim1, party }: { dim1: number; party: string }) {
  const pct = ((dim1 + 1) / 2) * 100;           // -1..+1 -> 0..100
  const dot = party === "DEM" ? "bg-blue-600" : party === "REP" ? "bg-red-600" : "bg-slate-600";
  return (
    <div className="mt-1.5"
      title="DW-NOMINATE first dimension, from roll-call votes in the 119th Congress (Voteview). Summarises how they voted, not what they say.">

      <div className="relative h-1.5 w-full rounded-full"
        style={{ background: "linear-gradient(to right,#1d4ed8,#e2e8f0,#b91c1c)" }}>
        <span
          className={`absolute -top-1 h-3.5 w-3.5 rounded-full border-2 border-white shadow ${dot}`}
          style={{ left: `calc(${Math.min(98, Math.max(2, pct))}% - 7px)` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-slate-400">
        <span>more liberal</span><span>more conservative</span>
      </div>
    </div>
  );
}

export default function PersonDetail({ person, onBack }: { person: Person; onBack: () => void }) {
  const p = person;
  const f = p.finance;
  const outside = f ? f.pac_contrib : 0;
  const grass = f ? f.individual_contrib : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 px-3 pt-3">
        <button onClick={onBack} aria-label="Back"
          className="mt-0.5 rounded-md px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">←</button>
        <Portrait src={p.photo} name={p.name} party={p.party} size={44} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{p.name}</h2>
          <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {partyName(p.party)} · {OFFICE_LABEL[p.office] ?? p.office}
            {p.senate_class ? ` · class ${p.senate_class}` : ""}
          </p>
          <PersonLinks
            className="mt-1"
            social={p.social}
            wikipedia={p.wikipedia}
            ballotpedia={p.ballotpedia}
            opensecrets={p.opensecrets}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 pt-3">
        <section>
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Term</h3>
          {p.term_start && <Row label="Serving since" value={p.term_start} />}
          {p.term_end && <Row label="Term ends" value={p.term_end} />}
          {p.next_election && <Row label="Next on the ballot" value={p.next_election} />}
        </section>

        {p.ideology?.nominate_dim1 != null && (
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Voting record
            </h3>
            <IdeologyScale dim1={p.ideology.nominate_dim1} party={p.party} />
            <Row label="Score (DW-NOMINATE)" value={p.ideology.nominate_dim1.toFixed(2)} />
            <Row label="Roll-call votes analysed" value={p.ideology.votes_analysed.toLocaleString()} />
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              Position derived from every roll-call vote cast this Congress.
              It summarises how they voted — not their stated positions.
              Source: DW-NOMINATE, Voteview, 119th Congress.
            </p>
          </section>
        )}

        {f && (
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Campaign finance · {f.cycle} cycle
            </h3>
            <Row label="Raised" value={money(f.receipts)} />
            <Row label="Spent" value={money(f.disbursements)} />
            <Row label="Cash on hand" value={money(f.cash_on_hand)} />
            {f.debts > 0 && <Row label="Debts" value={money(f.debts)} />}
            {f.status && <Row label="Status" value={f.status} />}
            {(grass > 0 || outside > 0) && (
              <>
                <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <span className="bg-emerald-600" style={{ width: `${(grass / Math.max(grass + outside, 1)) * 100}%` }} />
                  <span className="bg-violet-600" style={{ width: `${(outside / Math.max(grass + outside, 1)) * 100}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[9px]">
                  <span className="text-emerald-700 dark:text-emerald-500">individuals {money(grass)}</span>
                  <span className="text-violet-700 dark:text-violet-400">PACs {money(outside)}</span>
                </div>
              </>
            )}
            <p className="mt-1 text-[10px] text-slate-400">
              FEC bulk filings{f.coverage_end ? `, through ${f.coverage_end}` : ""}.
            </p>
          </section>
        )}

        {p.committees?.length ? (
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Committees ({p.committees.length})
            </h3>
            {/* Subcommittees are indented under their parent rather than
                shown as "Parent — Sub", which truncates to identical rows in
                a narrow panel and looks like duplicate entries. */}
            {p.committees.map((c) => (
              <div key={`${c.parent ?? ""}${c.name}`}
                className={`flex items-baseline justify-between gap-2 py-0.5 ${c.parent ? "pl-3" : ""}`}>
                <span className={`min-w-0 flex-1 text-[11px] ${
                  c.parent
                    ? "text-slate-500 dark:text-slate-400"
                    : "font-medium text-slate-700 dark:text-slate-200"}`}>
                  {c.parent && <span className="mr-1 text-slate-300">↳</span>}
                  {c.name}
                </span>
                {c.rank && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {c.rank}
                  </span>
                )}
              </div>
            ))}
          </section>
        ) : null}

        {p.url && (
          <a href={p.url} target="_blank" rel="noopener noreferrer"
            className="block rounded-lg border border-black/10 px-3 py-2 text-center text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-slate-800">
            Official site ↗
          </a>
        )}

        <p className="text-[10px] leading-relaxed text-slate-400">
          Stated positions on issues are not shown: no open, structured,
          non-partisan dataset of them exists, and inferring them from a voting
          score would present our guess as their platform.
        </p>
      </div>
    </div>
  );
}
