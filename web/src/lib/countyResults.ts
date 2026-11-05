import { apiService } from "@/lib/api";

/**
 * Unofficial returns for one division, from /results-county.
 *
 * This module exists because the same count is rendered in two places — the
 * map hover and the panel a click opens — and they drifted. The results block
 * was added to the hover alone, so clicking a county two days after the
 * election still led with "register by 30 days before Election Day". Sharing
 * the type, the fetch and the wording is what stops the two surfaces
 * disagreeing about the same division again.
 *
 * A division holds SEVERAL contests. A county votes in its own House district
 * and in the statewide Senate race, so Wake County returns four: the Senate
 * contest plus the three House districts it is split across. Anything
 * rendering these must handle a list, never assume one.
 */

export interface CountyCandidate {
  name: string;
  party: string | null;
  votes: number;
  percent: number | null;
  by_mode?: Record<string, number> | null;
}

export interface CountyContest {
  ocd_id: string;
  county_name: string | null;
  state: string;
  office: string;
  district: number | null;
  contest_ocd_id?: string;
  tier: "county" | "contest";
  /** True when the whole division voted in it — what a reader leads with. */
  statewide: boolean;
  candidates: CountyCandidate[];
  total_votes: number;
  /** Leader of the count we hold. NOT a winner; nothing here calls a race. */
  leader: CountyCandidate | null;
  margin_votes: number | null;
  margin_pct: number | null;
  /** Null for North Carolina: the state publishes no reporting denominator. */
  precincts_reporting: number | null;
  precincts_reporting_available: boolean;
  precincts_total: number | null;
  precincts_with_votes: number | null;
  source_call?: string | null;
  reported_at: string | null;
  source: string | null;
  source_url?: string | null;
}

/**
 * The single caveat both surfaces print.
 *
 * Kept here rather than written twice. "Leading", never "won": North Carolina
 * publishes no precincts-reporting total, so how much of the count is left is
 * genuinely unknown and may not be implied.
 */
export const COUNT_CAVEAT =
  "Leading in the count we hold. Not a called race — this state publishes no "
  + "precincts-reporting total, so how much is left is unknown. Unofficial; "
  + "certified results will differ.";

/** Shown where we hold nothing, which is every state except North Carolina. */
export const NO_COUNT_NOTE =
  "No count here yet. We read returns directly from each state's own feed and "
  + "only have them for some states so far — this means we hold no figures, "
  + "not that no votes were cast.";

export function officeLabel(office: string, district: number | null): string {
  if (office === "us_senate") return "U.S. Senate";
  if (office === "us_house") return `U.S. House ${district ?? ""}`.trim();
  if (office === "governor") return "Governor";
  return office;
}

/** Party dot colour. Blue/red here genuinely are parties, not a ramp. */
export function partyDot(party: string | null | undefined): string {
  if (party === "DEM") return "bg-blue-500";
  if (party === "REP") return "bg-red-500";
  return "bg-slate-400";
}

/** "2026-11-05T13:55:43+00:00" -> "11-05 13:55", as the hover prints it. */
export function reportedLabel(iso: string | null | undefined): string {
  return iso ? iso.slice(5, 16).replace("T", " ") : "—";
}

/**
 * The precinct fraction, or just the count when the pair is incoherent.
 *
 * Measured on the current NC rollup: 76 of 215 county rows report MORE
 * precincts with votes than precincts in total — Avery County reads 21/19.
 * The denominator appears to exclude the pseudo-precincts that absentee and
 * provisional ballots are filed under while the numerator counts them.
 *
 * That is a server-side rollup bug, not something to paper over here, but
 * printing "21/19" is strictly worse than printing "21": a ratio above one
 * is visibly broken and invites a reader to distrust figures that are
 * otherwise exact. So where the pair cannot both be true, only the
 * observation survives — never the implied completeness.
 */
export function precinctLabel(c: {
  precincts_with_votes: number | null;
  precincts_total: number | null;
}): string | null {
  const { precincts_with_votes: w, precincts_total: t } = c;
  if (w == null) return null;
  if (t == null || w > t) return `${w.toLocaleString()} precincts with votes`;
  return `${w.toLocaleString()}/${t.toLocaleString()} precincts with votes`;
}

/**
 * Sort as the server does — statewide first, then by district — so a hover
 * and a panel never disagree about which contest leads.
 */
export function sortContests(rows: CountyContest[]): CountyContest[] {
  return [...rows].sort(
    (a, b) => Number(b.statewide) - Number(a.statewide)
      || (a.district ?? -1) - (b.district ?? -1),
  );
}

export async function fetchCountyResults(
  ocdId: string,
): Promise<CountyContest[]> {
  try {
    const r = await apiService({
      method: "get",
      url: `/us-election/results-county?ocd_id=${encodeURIComponent(ocdId)}`,
    });
    const rows = (r as { data?: { data?: { rows?: CountyContest[] } } })
      ?.data?.data?.rows ?? [];
    return sortContests(rows);
  } catch {
    return [];
  }
}

/**
 * Election day 2026. Mirrors the constant in Chrome.tsx.
 *
 * Used to decide whether voter guidance is live instruction or historical
 * reference. Derived from the clock rather than hardcoded as a boolean, so it
 * flips by itself and cannot ship stale.
 */
export const ELECTION_DAY_2026 = new Date("2026-11-03T00:00:00-05:00");

export function electionHasPassed(now: Date = new Date()): boolean {
  return now.getTime() > ELECTION_DAY_2026.getTime();
}
