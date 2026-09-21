import { apiService } from "@/lib/api";

/**
 * Issue positions, fetched once per scope and shared.
 *
 * The API answers two questions well — "what categories exist" and "who has
 * said something about ONE category" — and does not answer "what has THIS
 * person said", which is what the detail panels need. `?ocd_id=` exists but
 * returns nothing: the stored `ref` is a pointer object rather than a
 * division string, so the query can never match. Reported upstream; until
 * there is a per-person endpoint this module works around it by fetching
 * every category once for a scope and indexing the result client-side.
 *
 * That is a burst of ~13 requests, so it happens once per state, is cached
 * for the session, and is only triggered when a reader actually opens a
 * positions section. It is not done on mount.
 */

export interface Quote {
  text: string;
  dated: string | null;
  topic: string;
}

export interface PositionRow {
  name: string;
  state: string | null;
  party: string;
  office: string;
  role: string;
  bioguide: string | null;
  fec_id: string | null;
  quote_count: number;
  total_quotes: number;
  source_topics: string[];
  positions: Quote[];
  source_url: string | null;
  match_confidence: number;
}

export interface IssueCategory {
  category: string;
  people: number;
  quotes: number;
  challengers: number;
  /** Poles of this issue's policy axis, in the server's own wording. */
  axis?: { neg: string; pos: string };
  icon?: string;
  with_stance?: number;
  quotes_classified?: number;
  conflicted?: number;
  challengers_with_stance?: number;
  /**
   * Whether stance can be answered for this category at all. Honoured rather
   * than assumed: the corpus predates the current technology debate, so an AI
   * or data-centre filter would return an empty room that reads as a finding.
   */
  filterable?: boolean;
}

/** What a person has said, grouped by the product category it belongs to. */
export interface PersonPositions {
  name: string;
  total_quotes: number;
  source_url: string | null;
  byCategory: { category: string; quotes: Quote[] }[];
}

let categoriesCache: Promise<IssueCategory[]> | null = null;

export function fetchCategories(): Promise<IssueCategory[]> {
  if (!categoriesCache) {
    categoriesCache = apiService({ method: "get", url: "/us-election/issues" })
      .then((r) => (r?.data?.data?.rows ?? []) as IssueCategory[])
      .catch(() => {
        // Do not poison the cache: a failed load should be retryable.
        categoriesCache = null;
        return [];
      });
  }
  return categoriesCache;
}

export interface ScopeQuery { state?: string | null; office?: string | null }

const scopeKey = (s: ScopeQuery) =>
  `${s.state ?? "*"}|${s.office ?? "*"}`;

/** One category, one scope. */
export async function fetchCategory(
  category: string, scope: ScopeQuery = {}, limit = 200,
): Promise<{ rows: PositionRow[]; caveat: string }> {
  const p = new URLSearchParams({ category, limit: String(limit) });
  if (scope.state) p.set("state", scope.state);
  if (scope.office) p.set("office", scope.office);
  const r = await apiService({
    method: "get", url: `/us-election/positions?${p.toString()}`,
  });
  const d = r?.data?.data ?? {};
  return { rows: (d.rows ?? []) as PositionRow[], caveat: String(d.caveat ?? "") };
}

const everythingCache = new Map<string, Promise<Map<string, PersonPositions>>>();

/** A stable key for a person across the two feeds that name them differently. */
function personKey(p: { fec_id?: string | null; bioguide?: string | null; name?: string }) {
  if (p.bioguide) return `b:${p.bioguide}`;
  if (p.fec_id) return `f:${p.fec_id}`;
  return `n:${String(p.name ?? "").toLowerCase().replace(/[^a-z]/g, "")}`;
}

/**
 * Everything said within one scope, indexed per person.
 *
 * Indexed under every identifier the row carries, so a caller holding only an
 * FEC id can find a person the positions feed matched by bioguide. Names are
 * the last resort and are normalised, because the FEC writes "John Sen
 * Cornyn" where other feeds write "John Cornyn".
 */
export function fetchScopeIndex(
  scope: ScopeQuery,
): Promise<Map<string, PersonPositions>> {
  const key = scopeKey(scope);
  const hit = everythingCache.get(key);
  if (hit) return hit;

  const job = (async () => {
    const cats = await fetchCategories();
    const results = await Promise.all(
      cats.map((c) => fetchCategory(c.category, scope)
        .then((r) => ({ category: c.category, rows: r.rows }))
        .catch(() => ({ category: c.category, rows: [] as PositionRow[] }))),
    );
    const index = new Map<string, PersonPositions>();
    for (const { category, rows } of results) {
      for (const row of rows) {
        const keys = [
          row.bioguide ? `b:${row.bioguide}` : null,
          row.fec_id ? `f:${row.fec_id}` : null,
          `n:${row.name.toLowerCase().replace(/[^a-z]/g, "")}`,
        ].filter(Boolean) as string[];
        let entry = keys.map((k) => index.get(k)).find(Boolean);
        if (!entry) {
          entry = {
            name: row.name,
            total_quotes: row.total_quotes,
            source_url: row.source_url,
            byCategory: [],
          };
        }
        if (row.positions.length) {
          entry.byCategory.push({ category, quotes: row.positions });
        }
        for (const k of keys) index.set(k, entry);
      }
    }
    for (const entry of new Set(index.values())) {
      entry.byCategory.sort((a, b) => b.quotes.length - a.quotes.length);
    }
    return index;
  })().catch((e) => {
    everythingCache.delete(key);
    throw e;
  });

  everythingCache.set(key, job);
  return job;
}

export function lookupPerson(
  index: Map<string, PersonPositions>,
  p: { fec_id?: string | null; bioguide?: string | null; name?: string },
): PersonPositions | null {
  const direct = index.get(personKey(p));
  if (direct) return direct;
  if (p.bioguide && index.has(`b:${p.bioguide}`)) return index.get(`b:${p.bioguide}`)!;
  if (p.fec_id && index.has(`f:${p.fec_id}`)) return index.get(`f:${p.fec_id}`)!;
  const n = String(p.name ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return n ? index.get(`n:${n}`) ?? null : null;
}

/** Roles, in the order a reader should meet them. Challengers first. */
export const ROLE_ORDER = ["challenger", "open seat", "incumbent", "officeholder"];

export const ROLE_LABEL: Record<string, string> = {
  challenger: "Challengers",
  "open seat": "Open-seat candidates",
  incumbent: "Incumbents running",
  officeholder: "Currently in office",
};
