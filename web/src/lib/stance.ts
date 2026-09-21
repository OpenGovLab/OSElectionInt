import { apiService } from "@/lib/api";

/**
 * Stance: where people sit on an issue's own policy axis.
 *
 * Three questions, three endpoints. Where everyone stands (`map`), who sits
 * in a given range (`filter`), and what the national pattern looks like
 * (`clusters`).
 *
 * MEDIAN IS THE KEY EVERYWHERE, never mean, and that is not a stylistic
 * preference. Ocasio-Cortez on climate has a mean of −0.44 against a median
 * of −0.80, because one quote — "OpEd: Green New Deal idea borrowed from
 * Green Party" — was read as +0.30 when it is a remark about where an idea
 * came from, not opposition to climate action. One misread line drags a mean;
 * it barely moves a median. Both are carried so a reader can see the gap, but
 * sorting, filtering and colouring all run off the median.
 */

export interface StanceAxis { neg: string; pos: string }

export interface StanceQuote {
  text: string;
  dated: string | null;
  topic: string;
  stance: number | null;
  label: string;
  confidence: string;
}

export interface StancePerson {
  name: string;
  party: string;
  role: string;
  ocd_id: string;
  state: string | null;
  office: string;
  lng: number;
  lat: number;
  division_name: string | null;
  division_level?: string | null;
  median: number;
  mean: number;
  spread: number;
  /** Their quotes disagree with each other — see the note in the config. */
  conflicted: boolean;
  label: string;
  confidence: string;
  n_classified: number;
  n_unclear: number;
  earliest: string | null;
  latest: string | null;
  fec_id: string | null;
  bioguide: string | null;
  total_quotes: number;
  source_url: string | null;
  quotes?: StanceQuote[];
}

export interface StanceCluster {
  state: string;
  median: number;
  people: number;
  neg: number;
  pos: number;
  zero: number;
  conflicted: number;
  /** The delegation is split roughly evenly — the most interesting states. */
  divided: boolean;
}

interface Envelope {
  axis: StanceAxis;
  icon: string;
  caveat: string;
  count: number;
}

export interface StanceMapResult extends Envelope { rows: StancePerson[] }
export interface StanceClusterResult extends Envelope { rows: StanceCluster[] }

const get = async (url: string) => {
  const r = await apiService({ method: "get", url });
  return (r as { data?: { data?: Record<string, unknown> } })?.data?.data ?? {};
};

const envelope = (d: Record<string, unknown>): Envelope => ({
  axis: (d.axis as StanceAxis) ?? { neg: "", pos: "" },
  icon: String(d.icon ?? ""),
  caveat: String(d.caveat ?? ""),
  count: Number(d.count ?? 0),
});

/** Everyone with a classified position, placed for the map. */
export async function fetchStanceMap(
  category: string, opts: { office?: string; minN?: number } = {},
): Promise<StanceMapResult> {
  const p = new URLSearchParams({ category });
  if (opts.office) p.set("office", opts.office);
  if (opts.minN) p.set("min_n", String(opts.minN));
  const d = await get(`/us-election/stance/map?${p.toString()}`);
  return { ...envelope(d), rows: (d.rows as StancePerson[]) ?? [] };
}

export interface StanceFilterQuery {
  min?: number;
  max?: number;
  label?: string;
  party?: string;
  state?: string;
  office?: string;
  role?: string;
  limit?: number;
}

/** Who sits in a range on this axis. */
export async function fetchStanceFilter(
  category: string, q: StanceFilterQuery = {},
): Promise<StanceMapResult> {
  const p = new URLSearchParams({ category });
  if (q.min != null) p.set("min", String(q.min));
  if (q.max != null) p.set("max", String(q.max));
  if (q.label) p.set("label", q.label);
  if (q.party) p.set("party", q.party);
  if (q.state) p.set("state", q.state);
  if (q.office) p.set("office", q.office);
  if (q.role) p.set("role", q.role);
  p.set("limit", String(q.limit ?? 150));
  const d = await get(`/us-election/stance/filter?${p.toString()}`);
  return { ...envelope(d), rows: (d.rows as StancePerson[]) ?? [] };
}

/** The national pattern, one row per state. */
export async function fetchStanceClusters(
  category: string,
): Promise<StanceClusterResult> {
  const p = new URLSearchParams({ category, level: "state" });
  const d = await get(`/us-election/stance/clusters?${p.toString()}`);
  return { ...envelope(d), rows: (d.rows as StanceCluster[]) ?? [] };
}

/**
 * Categories the stance feature can actually answer.
 *
 * `filterable` is the server's own judgement and is honoured rather than
 * second-guessed. It matters: the corpus predates the current technology
 * debate almost entirely — across all 531 people "artificial intelligence"
 * appears zero times, "data center" zero, "semiconductor" zero — so an AI or
 * data-centre filter would be answering from nothing. Offering a category the
 * data cannot support is worse than not offering it, because the empty answer
 * looks like a finding.
 */
export interface StanceCategory {
  category: string;
  people: number;
  quotes: number;
  challengers: number;
  axis?: StanceAxis;
  icon?: string;
  with_stance?: number;
  quotes_classified?: number;
  conflicted?: number;
  challengers_with_stance?: number;
  filterable?: boolean;
}

export const PARTY_TEXT = (p: string) =>
  p === "DEM" ? "text-blue-600 dark:text-blue-400"
    : p === "REP" ? "text-red-600 dark:text-red-400"
      : "text-slate-500 dark:text-slate-400";

export const OFFICE_LABEL: Record<string, string> = {
  president: "President", us_senate: "U.S. Senate",
  us_house: "U.S. House", governor: "Governor",
};

export const ROLE_SHORT: Record<string, string> = {
  challenger: "Challenger",
  "open seat": "Open seat",
  incumbent: "Incumbent",
  officeholder: "In office",
};
