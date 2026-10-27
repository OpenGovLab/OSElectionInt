import { apiService } from "@/lib/api";

/**
 * Outside spending — FEC independent expenditures for and against a candidate.
 *
 * SPENDING, NOT ADVERTISING. The FEC reports an amount, who paid, who was
 * paid, and a free-text purpose. It never reports what the advertisement
 * said, so nothing here can show a reader a message, a script or an image.
 * The word "ads" is avoided throughout for that reason.
 *
 * Fetches are cached per key for the session: a division panel asks for one
 * candidate at a time and a reader opening five candidates in a race should
 * not re-fetch the leaderboard behind each one.
 */

export interface Spender {
  committee_id: string;
  name: string;
  total: number;
}

export interface LineItem {
  amount: number;
  spender_name: string;
  spender_id: string;
  payee: string | null;
  purpose: string | null;
  medium: string;
  is_ad: boolean;
  support_oppose: "S" | "O";
  expenditure_date: string | null;
  dissemination_date: string | null;
  election_type: string | null;
}

export interface SpendRow {
  candidate_id: string;
  name: string;
  party: string | null;
  state: string | null;
  office: string | null;
  district: string | null;
  support_total: number;
  oppose_total: number;
  support_count: number;
  oppose_count: number;
  ratio_against_for: number | null;
  top_spenders_against: Spender[];
  top_spenders_for: Spender[];
  by_medium: Record<string, number>;
  ad_total?: number;
  non_ad_total?: number;
  first_date: string | null;
  last_date: string | null;
  line_items?: LineItem[];
}

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, run());
  return cache.get(key) as Promise<T>;
}

/** One candidate. `null` means no FEC record — which is NOT the same as zero. */
export function spendFor(fecId: string): Promise<SpendRow | null> {
  return cached(`one:${fecId}`, async () => {
    try {
      const r = await apiService({
        method: "get",
        url: `/us-election/ad-spend?fec_id=${encodeURIComponent(fecId)}&limit=8`,
      });
      return (r?.data?.data?.row ?? null) as SpendRow | null;
    } catch {
      return null;
    }
  });
}

export interface TopResult {
  rows: SpendRow[];
  caveat: string;
  source: string;
  source_url: string | null;
}

/**
 * Leaderboard. `sort=ratio` is gated server-side on both sides having real
 * money, because a ratio against a near-zero denominator measures the
 * denominator and nothing else.
 */
export function spendTop(
  opts: { office?: string; state?: string; sort?: "oppose" | "support" | "ratio"; limit?: number } = {},
): Promise<TopResult> {
  const q = new URLSearchParams();
  if (opts.office) q.set("office", opts.office);
  if (opts.state) q.set("state", opts.state);
  q.set("sort", opts.sort ?? "oppose");
  q.set("limit", String(opts.limit ?? 25));
  const key = `top:${q.toString()}`;
  return cached(key, async () => {
    try {
      const r = await apiService({
        method: "get", url: `/us-election/ad-spend/top?${q.toString()}`,
      });
      const d = r?.data?.data ?? {};
      return {
        rows: (d.rows ?? []) as SpendRow[],
        caveat: String(d.caveat ?? ""),
        source: String(d.source ?? ""),
        source_url: d.source_url ?? null,
      };
    } catch {
      return { rows: [], caveat: "", source: "", source_url: null };
    }
  });
}

/** Human label for the free-text medium buckets the ingest assigned. */
export const MEDIUM_LABEL: Record<string, string> = {
  tv: "TV",
  digital: "Digital",
  mail: "Mail",
  radio: "Radio",
  print: "Print",
  media_unspecified: "Media, type not stated",
  canvassing: "Canvassing",
  production: "Production",
  overhead: "Overhead",
  unclassified: "Not classified",
};

/**
 * Media buckets that are a message placed in front of voters, as opposed to
 * the cost of making one or of knocking on doors. Kept separate so a
 * "spent on advertising" figure cannot quietly include staff and overhead.
 */
export const PLACED_MEDIA = new Set([
  "tv", "digital", "mail", "radio", "print", "media_unspecified",
]);
