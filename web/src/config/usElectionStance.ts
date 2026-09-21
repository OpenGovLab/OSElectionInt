/**
 * Where people stand on an issue, as a map layer.
 *
 * ── Why this ramp is not the party ramp ──────────────────────────────────
 *
 * Stance is not party, and the data says so loudly. On gun policy Sanford
 * Bishop (DEM) sits at +0.50 and Mitch McConnell (REP) sits at +0.50 — the
 * same point on the axis. Painting that point red would silently relabel a
 * Democrat as a Republican, which is a factual claim we would be making by
 * accident through colour alone.
 *
 * So the diverging ramp here is green to magenta, and every other hue on this
 * map is already spoken for: blue and red are the parties, amber is the
 * historical booths and the news rings, teal is candidate home towns, violet
 * is the 2026 voting locations, and cyan is interface chrome. Grey sits at
 * the midpoint because a balanced position should read as unremarkable.
 *
 * ── Why the poles are never named after a tribe ──────────────────────────
 *
 * Each category carries its own axis from the server — "more restriction on
 * firearms" against "fewer restrictions on firearms". Those are directions of
 * policy, not identities, and the UI must use the server's own wording rather
 * than substituting "pro-gun", "progressive" or any other label. A person is
 * placed by what they said about a policy; nothing here is entitled to say
 * what they are.
 */

/** Diverging ramp along the axis. −1 = the `neg` pole, +1 = the `pos` pole. */
export const STANCE_STOPS: [number, string][] = [
  [-1.0, "#15803d"],
  [-0.5, "#4ade80"],
  [-0.15, "#a7f3d0"],
  [0, "#94a3b8"],
  [0.15, "#f9a8d4"],
  [0.5, "#ec4899"],
  [1.0, "#9d174d"],
];

export const STANCE_SOURCE = "us-stance";

/**
 * Drawn from country zoom. Unlike the polling layers this is never more than
 * a few hundred points nationally — one per person with a classified
 * position — so there is no density reason to hold it back, and the national
 * pattern is the entire point of the layer.
 */
export const STANCE_MIN_ZOOM = 0;

/** Colour by the person's median, interpolated across the ramp. */
export function stanceColor(): unknown[] {
  return [
    "interpolate", ["linear"], ["get", "median"],
    ...STANCE_STOPS.flatMap(([v, c]) => [v, c]),
  ];
}

/**
 * Sized by how much evidence sits behind the position, not by how strong the
 * position is.
 *
 * Coverage runs about five to one in favour of people who already hold
 * office, so a median drawn from two quotes and one drawn from eighteen are
 * not the same claim. Size is the honest channel for that: a reader should be
 * able to see at a glance which dots are thinly sourced without reading a
 * number. Capped so a 400-quote veteran does not swamp the map.
 */
export function stanceRadius(scale = 1): unknown[] {
  const n = (v: number) => v * scale;
  return [
    "interpolate", ["linear"], ["zoom"],
    2, ["interpolate", ["linear"], ["get", "n_classified"], 1, n(2.4), 20, n(5)],
    5, ["interpolate", ["linear"], ["get", "n_classified"], 1, n(3.4), 20, n(7.5)],
    9, ["interpolate", ["linear"], ["get", "n_classified"], 1, n(5.5), 20, n(12)],
  ];
}

/**
 * Conflicted people get a dashed-looking halo rather than just a tint.
 *
 * Henry Cuellar's gun-policy median is +0.40, but it spans "Require
 * background check for every firearm sale" at −0.80 and "Ban gun
 * registration & trigger lock law in DC" at +0.80, twelve years apart.
 * Drawing him as a mid-ramp moderate would assert a position he has never
 * held. Fifty people carry the flag on gun policy alone, so this is not an
 * edge case, and colour alone is too weak to carry "this average is hiding
 * an argument".
 */
export function stanceStrokeColor(): unknown[] {
  return [
    "case",
    ["boolean", ["get", "conflicted"], false], "#fbbf24",
    "#0f172a",
  ];
}

export function stanceStrokeWidth(): unknown[] {
  return [
    "case",
    ["boolean", ["get", "conflicted"], false], 2.2,
    1,
  ];
}

/** Hex for a stance value, for legends and list rows outside the GPU. */
export function stanceHex(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "#64748b";
  const s = STANCE_STOPS;
  if (v <= s[0][0]) return s[0][1];
  if (v >= s[s.length - 1][0]) return s[s.length - 1][1];
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (let i = 0; i < s.length - 1; i++) {
    const [a, ca] = s[i];
    const [b, cb] = s[i + 1];
    if (v >= a && v <= b) {
      const t = b === a ? 0 : (v - a) / (b - a);
      const A = hex(ca);
      const B = hex(cb);
      return `rgb(${A.map((x, k) => Math.round(x + (B[k] - x) * t)).join(",")})`;
    }
  }
  return "#64748b";
}

/**
 * How far apart to fan people who share a centroid, in degrees, by the level
 * of the division they were placed on.
 *
 * The server places a person at their DIVISION's centre, not their own — it
 * has no home address for an officeholder. So every senator and statewide
 * candidate for a state lands on one pixel and hides the rest. State
 * divisions are large enough to absorb a wide fan; a congressional district
 * is not, and pushing a point outside its own district would be worse than
 * overlapping.
 */
const FAN_DEGREES: Record<string, number> = {
  state: 1.15,
  cd: 0.22,
  county: 0.12,
  sldu: 0.12,
  sldl: 0.08,
};

/**
 * Fan co-located people around their shared centroid.
 *
 * A hash-based random jitter was the obvious approach and is worse: random
 * offsets collide, so with eight people on one point some still overlap. A
 * golden-angle spiral places n points with guaranteed separation, and because
 * position is derived from the index within a sorted group it is stable
 * between renders rather than jumping every time the list refetches.
 *
 * Latitude is compressed by cos(lat) so the fan stays visually circular
 * rather than stretching east-west as it moves north.
 */
export function fanOut<T extends {
  ocd_id: string; lng: number; lat: number; division_level?: string | null;
}>(rows: T[]): (T & { lng: number; lat: number })[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.ocd_id ?? `${r.lng},${r.lat}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const out: (T & { lng: number; lat: number })[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0] as T & { lng: number; lat: number }); continue; }
    const spread = FAN_DEGREES[group[0].division_level ?? "state"] ?? 0.5;
    const n = group.length;
    group.forEach((r, i) => {
      // sqrt keeps the points area-uniform instead of clustering at the centre
      const radius = spread * Math.sqrt((i + 0.5) / n);
      const theta = i * GOLDEN;
      const cos = Math.max(0.2, Math.cos((r.lat * Math.PI) / 180));
      out.push({
        ...r,
        lng: r.lng + (radius * Math.cos(theta)) / cos,
        lat: r.lat + radius * Math.sin(theta),
      });
    });
  }
  return out;
}

/** Turn API rows into a FeatureCollection, fanned so nobody is hidden. */
export function stanceFeatures(rows: {
  ocd_id: string; lng: number; lat: number; division_level?: string | null;
  median: number; [k: string]: unknown;
}[]) {
  return {
    type: "FeatureCollection" as const,
    features: fanOut(rows)
      .filter((r) => Number.isFinite(r.lng) && Number.isFinite(r.lat))
      .map((r) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [r.lng, r.lat] },
        properties: { ...r },
      })),
  };
}

/**
 * Label for a stance value, phrased along the axis rather than as a tribe.
 * The caller passes the category's own poles so this never invents wording.
 */
export function stanceWording(
  v: number | null | undefined, axis: { neg: string; pos: string } | null,
): string {
  if (v == null) return "no classified position";
  if (!axis) return v.toFixed(2);
  const pole = v < 0 ? axis.neg : axis.pos;
  const m = Math.abs(v);
  if (m < 0.15) return "balanced between both";
  if (m < 0.5) return `leans toward ${pole}`;
  return `toward ${pole}`;
}
