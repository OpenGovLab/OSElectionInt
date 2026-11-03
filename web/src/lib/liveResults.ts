import { apiService } from "@/lib/api";

/**
 * Election-night results: the clock-based replay, as distinct from the
 * cycle-based one the margin scrubber drives.
 *
 * The two are different animals and are deliberately kept apart. The margin
 * scrubber steps across certified history, where every cut is complete and
 * final. This steps across a single evening of partial, unofficial counting
 * that will be revised for weeks. Sharing one control would invite a reader
 * to read tonight's 4%-counted lead with the same confidence as a 2016
 * result, which is the single worst misreading this dashboard could offer.
 */

export interface LiveBucket {
  at: string;
  changes: number;
  contests: number;
}

export interface LiveTimeline {
  buckets: LiveBucket[];
  first: string | null;
  last: string | null;
  states: string[];
  /** False on a single report: one timestamp is a starting gun, not a race. */
  playable: boolean;
  cycle: number;
  detail_available: boolean;
  caveat: string;
}

export interface LiveCandidate {
  name: string;
  party: string;
  votes: number;
  percent: number | null;
}

/**
 * A contest at a moment.
 *
 * `candidates` is present only in the live cut. A past moment carries the
 * total and who led and genuinely nothing more — the change log never stored
 * a per-candidate split, so there is none to recover. Anything that renders
 * these rows must handle `candidates` being absent rather than assume it.
 */
export interface LiveContest {
  contest_id: string;
  ocd_id: string;
  office: string;
  district: number | null;
  state: string;
  total_votes: number;
  leader?: string | null;
  kind?: string | null;
  reported_at: string | null;
  candidates?: LiveCandidate[];
  precincts_reporting?: number | null;
  precincts_reporting_available?: boolean;
  precincts_total?: number | null;
  precincts_with_votes?: number | null;
  is_estimate?: boolean;
  /** Only ever another organisation's call, attributed. Never computed here. */
  source_call?: string | null;
  source?: string | null;
  source_url?: string | null;
}

export interface LiveCut {
  count: number;
  rows: LiveContest[];
  as_of: string | null;
  cycle: number;
  detail_available: boolean;
  clock: string;
  caveat: string;
}

const base = "/us-election/results-live";

export async function fetchLiveTimeline(): Promise<LiveTimeline | null> {
  try {
    const r = await apiService({ method: "get", url: `${base}/timeline` });
    return (r?.data?.data as LiveTimeline) ?? null;
  } catch {
    return null;
  }
}

/** Omit `asOf` for the present, which is the only cut with candidate detail. */
export async function fetchLiveCut(
  asOf: string | null, office?: string, level?: string,
): Promise<LiveCut | null> {
  const q = new URLSearchParams();
  if (asOf) q.set("as_of", asOf);
  if (office) q.set("office", office);
  if (level) q.set("level", level);
  const url = asOf
    ? `${base}?${q.toString()}`
    : `${base}/latest${q.toString() ? `?${q}` : ""}`;
  try {
    const r = await apiService({ method: "get", url });
    return (r?.data?.data as LiveCut) ?? null;
  } catch {
    return null;
  }
}

/** Source reporting time, in the reader's zone, with the zone named. */
export function clockLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], {
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

export function dayLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * How much of the count is in — or, far more often, that we cannot say.
 *
 * Returning null is the common and correct case. Most states publish no
 * reporting denominator, and `precincts_with_votes` is NOT a substitute: a
 * precinct can return a legitimate zero for one contest while having fully
 * reported, so counting non-zero precincts understates reporting and dressing
 * it up as a percentage invents a completeness nobody published.
 */
export function reportingLabel(c: LiveContest): string | null {
  if (c.precincts_reporting_available && c.precincts_reporting != null
      && c.precincts_total) {
    const pct = (c.precincts_reporting / c.precincts_total) * 100;
    return `${c.precincts_reporting.toLocaleString()} of `
      + `${c.precincts_total.toLocaleString()} precincts (${pct.toFixed(0)}%)`;
  }
  if (c.precincts_total) {
    return `${c.precincts_total.toLocaleString()} precincts — this state `
      + "publishes no reporting count";
  }
  return null;
}
