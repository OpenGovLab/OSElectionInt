/**
 * Shared MapLibre configuration for the US election map.
 *
 * Deliberately framework-free so the Expo client can import the same layer
 * definitions and paint expressions. If the two clients ever disagree about
 * what a division looks like, it will be because something was added here and
 * not consumed — not because the definitions drifted.
 */

export const SOURCE_ID = "us-divisions";

/** Fallback if the manifest cannot be read — the unversioned build. */
export const TILES_FALLBACK = "/tiles/us-divisions.pmtiles";
export const TILES_MANIFEST = "/tiles/tiles.json";

/**
 * Resolve which archive to load.
 *
 * Archives are published under a content-hashed name so a URL's bytes never
 * change — a PMTiles archive is read in byte ranges across a whole session,
 * and bytes shifting under a stable URL corrupts an in-flight read rather than
 * just serving something stale. The manifest is the only uncached hop.
 */
export async function resolveTilesUrl(): Promise<string> {
  try {
    const r = await fetch(TILES_MANIFEST, { cache: "no-store" });
    if (r.ok) {
      const j = (await r.json()) as { archive?: string };
      if (j?.archive) return `pmtiles://${j.archive}`;
    }
  } catch {
    /* fall through */
  }
  return `pmtiles://${TILES_FALLBACK}`;
}

/** Free, key-less vector basemaps. */
export const BASEMAP = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;



export type DivisionLevel = "state" | "cd" | "county" | "sldu" | "sldl";

/**
 * Zoom bands must match how the archive was built (see build_tiles.sh) —
 * asking for a layer outside its band renders nothing, silently.
 */
export const LEVELS: {
  id: DivisionLevel;
  label: string;
  short: string;
  minzoom: number;
  maxzoom: number;
}[] = [
  { id: "state",  label: "States",            short: "State",  minzoom: 0, maxzoom: 6 },
  { id: "cd",     label: "Congressional",     short: "House",  minzoom: 3, maxzoom: 10 },
  { id: "county", label: "Counties",          short: "County", minzoom: 4, maxzoom: 12 },
  { id: "sldu",   label: "State Senate",      short: "Senate", minzoom: 5, maxzoom: 12 },
  { id: "sldl",   label: "State House",       short: "House",  minzoom: 5, maxzoom: 12 },
];

/**
 * Diverging D<->R scale, reserved for when us_margins lands (phase 2).
 *
 * Margin is signed: negative = Democratic, positive = Republican, so the
 * neutral midpoint sits at a genuine tie rather than at an arbitrary colour.
 * Competitiveness is what the map is FOR, so the saturated ends are the
 * blowouts and the pale middle is where a race is actually in play.
 */
export const MARGIN_STOPS: [number, string][] = [
  [-40, "#1e40af"],
  [-20, "#60a5fa"],
  [-5,  "#bfdbfe"],
  [0,   "#f1f5f9"],
  [5,   "#fecaca"],
  [20,  "#f87171"],
  [40,  "#b91c1c"],
];

/**
 * Fill opacity is low on purpose.
 *
 * The choropleth sits UNDER the basemap's label layers (see the beforeId used
 * when the layers are added), so city and state names stay legible. Keeping
 * the fill translucent as well means the terrain and roads underneath still
 * read, which is what makes it feel like a map rather than a chart with a
 * coastline. Saturation carries the signal; the outline carries the boundary.
 */
export const FILL_OPACITY = {
  data: 0.62,
  hover: 0.82,
  selected: 0.9,
  none: 0.1,
} as const;

export const OFFICES = [
  { id: "president", label: "President", levels: ["state", "county"] },
  { id: "us_senate", label: "U.S. Senate", levels: ["state", "county"] },
  { id: "us_house", label: "U.S. House", levels: ["cd", "county"] },
  { id: "governor", label: "Governor", levels: ["state", "county"] },
] as const;

export type OfficeId = (typeof OFFICES)[number]["id"];

/**
 * Fill colour driven by feature-state `margin`.
 *
 * Features with no margin keep the neutral identity fill rather than being
 * painted at the midpoint — an unknown result and a genuine tie must not look
 * the same. The source sets promoteId to ocd_id so feature state can be keyed
 * by division rather than by tile-local numeric ids.
 */
// `["has", k, ["feature-state"]]` is NOT valid — feature-state requires a key
// argument, and MapLibre rejects the whole layer at load time. Comparing the
// looked-up value to null is the documented way to test for presence.
const HAS_MARGIN = ["!=", ["feature-state", "margin"], null];

export function marginFill(neutral: string): unknown[] {
  return [
    "case",
    HAS_MARGIN,
    ["interpolate", ["linear"], ["to-number", ["feature-state", "margin"], 0],
      ...MARGIN_STOPS.flat()],
    neutral,
  ];
}

export function marginOpacity(): unknown[] {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false], FILL_OPACITY.selected,
    ["boolean", ["feature-state", "hover"], false], FILL_OPACITY.hover,
    HAS_MARGIN, FILL_OPACITY.data,
    FILL_OPACITY.none,
  ];
}

/**
 * Boundary width: thicker when hovered or selected so the edge reads clearly.
 *
 * `zoom` must be the top-level input to interpolate — MapLibre rejects a zoom
 * expression nested inside `case` ("may only be used as input to a top-level
 * step or interpolate") and drops the whole layer, so the outlines silently
 * disappear. Hence interpolate on the outside, case per stop.
 */
export function boundaryWidth(): unknown[] {
  const perState = (base: number, hov: number, sel: number) => [
    "case",
    ["boolean", ["feature-state", "selected"], false], sel,
    ["boolean", ["feature-state", "hover"], false], hov,
    base,
  ];
  return [
    "interpolate", ["linear"], ["zoom"],
    2, perState(0.4, 1.4, 1.8),
    8, perState(1.1, 2.4, 3.0),
  ];
}

/** Human label for a signed margin. */
export function marginLabel(m: number | null | undefined): string {
  if (m === null || m === undefined) return "no data";
  const a = Math.abs(m);
  if (a < 0.05) return "EVEN";
  return `${m > 0 ? "R" : "D"}+${a.toFixed(1)}`;
}

/**
 * Fill for divisions with no result.
 *
 * Deliberately neutral grey rather than a hue: once most of the map is painted
 * on the red/blue scale, any coloured "no data" fill reads as a third party.
 * Grey is the only choice that cannot be mistaken for a position on the scale.
 */
export const NEUTRAL = {
  light: { fill: "#cbd5e1", line: "#94a3b8", hover: "#f59e0b", select: "#b45309" },
  dark:  { fill: "#475569", line: "#64748b", hover: "#fbbf24", select: "#f59e0b" },
} as const;


/**
 * Race circles.
 *
 * One circle per contested race, drawn at its division's centroid — NOT one
 * per candidate. Every candidate for a seat shares that seat's geography, so
 * per-candidate points would land on the identical coordinate, and scattering
 * them would invent a position the data does not have. A Senate race covers a
 * whole state. The circle claims "a contested race is somewhere in here",
 * which is true; a pin would claim a person is at a point, which is not.
 *
 * Radius encodes money raised on a sqrt scale so AREA tracks the total —
 * a linear radius makes a $100M race look 100x a $1M one instead of 10x.
 */
export const RACE_SOURCE = "us-races";
/** Centroid points used purely for labelling — see the tile-repeat note. */
export const LABEL_SOURCE = "us-division-labels";

export const PARTY_COLOR: Record<string, string> = {
  DEM: "#2563eb",
  REP: "#dc2626",
  OTH: "#64748b",
};

/**
 * `scale` multiplies the radius stops rather than the returned expression.
 *
 * MapLibre allows a `zoom` expression ONLY as the top-level input to
 * interpolate/step. Wrapping this in ["*", 0.42, raceRadius()] nests zoom
 * inside a multiply, which invalidates the layer and makes the circles vanish
 * with no visible error — the same trap that silently removed the boundary
 * outlines. Scale the numbers, never the expression.
 */
export function raceRadius(scale = 1): unknown[] {
  const k = (n: number) => n * scale;
  return [
    "interpolate", ["linear"], ["zoom"],
    3, ["interpolate", ["linear"], ["sqrt", ["get", "total_raised"]],
      0, k(3), 3000, k(9), 12000, k(22)],
    8, ["interpolate", ["linear"], ["sqrt", ["get", "total_raised"]],
      0, k(6), 3000, k(20), 12000, k(46)],
  ];
}

export function raceColor(): unknown[] {
  return [
    "match", ["get", "lead_party"],
    "DEM", PARTY_COLOR.DEM,
    "REP", PARTY_COLOR.REP,
    PARTY_COLOR.OTH,
  ];
}


/**
 * Election news.
 *
 * Rings, not filled circles, and a single amber hue rather than a diverging
 * scale — and deliberately NOT coloured by coverage lean. Every tilt in this
 * corpus is slightly negative (SC -0.02, TX -0.16, ME -0.26), which is a
 * property of our own source mix, not a finding about those districts. A lean
 * ramp would paint a near-monochrome map that reads as a discovery. Lean is a
 * labelled number in the readout, where it cannot be mistaken for a vote. The map already carries red/blue twice — the margin choropleth and
 * the race circles — and a third political colour ramp would be read as a
 * third party rather than as a different measure. Volume is encoded in size;
 * coverage lean is a number in the readout, where it can be labelled and
 * therefore cannot be misread as a vote.
 */
export const NEWS_SOURCE = "us-election-news";

export function newsRadius(): unknown[] {
  return [
    "interpolate", ["linear"], ["zoom"],
    3, ["interpolate", ["linear"], ["sqrt", ["get", "articles"]], 1, 6, 6, 18],
    8, ["interpolate", ["linear"], ["sqrt", ["get", "articles"]], 1, 12, 6, 40],
  ];
}

/** -1 entirely left-rated .. +1 entirely right-rated; null when unrated. */
export function tiltLabel(t: number | null | undefined): string {
  if (t === null || t === undefined) return "coverage lean unrated";
  const a = Math.abs(t);
  if (a < 0.05) return "coverage evenly rated";
  const side = t < 0 ? "left" : "right";
  const strength = a < 0.15 ? "slightly" : a < 0.35 ? "moderately" : "heavily";
  return `coverage ${strength} ${side}-rated`;
}


/**
 * Candidate home towns.
 *
 * The only layer on this map drawn at a REAL coordinate. Everything else —
 * margins, race circles, news rings — is a polygon or its centroid, and says
 * "somewhere inside this shape". A home dot says "this town", which is a
 * different and stronger claim, so it gets a different visual language:
 * a small solid dot over a soft halo rather than a big translucent circle.
 *
 * One dot per city, never per candidate. Four people filing from Austin share
 * one coordinate exactly; four stacked dots would be a rendering artifact
 * dressed up as density, and jittering them would invent positions the data
 * does not have. The dot carries the count instead.
 *
 * Hue is teal and nothing else. The map already spends red and blue twice
 * (the margin choropleth and the race circles) and amber once (news); a
 * fourth ramp in a political colour would be read as a fourth party. Party
 * mix is a labelled number in the readout, where it cannot be misread.
 */
export const HOME_SOURCE = "us-candidate-homes";

export const HOME_COLOR = {
  dot: "#0d9488",
  glow: "#14b8a6",
  stroke: "#ffffff",
} as const;

/**
 * Radius by candidate count, on a sqrt scale so AREA tracks the count.
 *
 * `scale` multiplies the stop VALUES, never the returned expression — zoom is
 * only legal as the top-level input to interpolate, and wrapping this in a
 * multiply invalidates the layer and the dots vanish with no error. Same trap
 * as raceRadius and the boundary outlines.
 */
export function homeRadius(scale = 1): unknown[] {
  const k = (n: number) => n * scale;
  return [
    "interpolate", ["linear"], ["zoom"],
    3, ["interpolate", ["linear"], ["sqrt", ["get", "candidates"]],
      1, k(2.5), 3, k(5), 8, k(9)],
    10, ["interpolate", ["linear"], ["sqrt", ["get", "candidates"]],
      1, k(5), 3, k(11), 8, k(20)],
  ];
}

/** "3 Democrats, 1 Republican" — party mix as words, not as a colour ramp. */
export function partyMixLabel(dem: number, rep: number, other: number): string {
  const bits: string[] = [];
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  if (dem) bits.push(plural(dem, "Democrat", "Democrats"));
  if (rep) bits.push(plural(rep, "Republican", "Republicans"));
  if (other) bits.push(plural(other, "other", "others"));
  return bits.join(", ") || "no party recorded";
}

/** Compact money for a tooltip: $4.2M, $310K, $0. */
export function moneyLabel(n: number | null | undefined): string {
  const v = Number(n || 0);
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}


/**
 * Historical polling places.
 *
 * Only drawn from POLLS_MIN_ZOOM up. These are individual buildings: at state
 * zoom 216,822 of them are a solid sheet of ink that hides the choropleth
 * underneath, and the layer would be answering a question nobody asked at that
 * scale. The viewport fetch is bounded for the same reason.
 */
export const POLLS_SOURCE = "us-polling-places";
export const POLLS_MIN_ZOOM = 9;

/** Amber, distinct from the party-coloured margins and the news layer. */
export const POLLS_COLOR = "#b45309";

export function pollsRadius(): unknown[] {
  return ["interpolate", ["linear"], ["zoom"], 9, 2, 12, 3.5, 16, 6];
}


/**
 * Where people will ACTUALLY vote in 2026.
 *
 * A separate source and a separate colour from POLLS_SOURCE on purpose. That
 * layer is 2012-2020 — where booths stood — and reading it as current advice
 * sends someone to a building that may have closed two elections ago. This
 * one comes from the states' own VIP feeds and is the live answer.
 *
 * Violet, because every other hue on this map is already spoken for: amber is
 * the historical booths and the news rings, teal is candidate home towns,
 * blue and red are the parties, and cyan is interface chrome. A layer about
 * voting must not borrow a colour that already means something else.
 */
export const VOTE26_SOURCE = "us-vote-2026";

/**
 * Deliberately lower than POLLS_MIN_ZOOM (9).
 *
 * That floor exists because 216,822 historical rows blanket the choropleth at
 * country zoom. This dataset is currently EIGHT rows nationally — only
 * Virginia's feed has published — so the same floor would hide the layer
 * entirely unless a reader happened to zoom into Richmond. Raise this as
 * feeds come online and the count climbs.
 */
export const VOTE26_MIN_ZOOM = 5;

/**
 * The three kinds are three different acts and must not read as one.
 * Dropping a mail ballot into a box is not voting in person, and a reader
 * who conflates them can turn up somewhere that cannot take their vote.
 */
export const VOTE26_COLORS = {
  pollingLocations: "#a855f7",
  earlyVoteSites: "#c084fc",
  dropOffLocations: "#7c3aed",
} as const;

export const VOTE26_KIND_LABEL: Record<string, string> = {
  pollingLocations: "Vote here on election day",
  earlyVoteSites: "Early voting site",
  dropOffLocations: "Ballot drop-off — not in-person voting",
};

/** Colour by kind, so the act is legible before anything is clicked. */
export function vote26Color(): unknown[] {
  return [
    "match", ["get", "kind"],
    "pollingLocations", VOTE26_COLORS.pollingLocations,
    "earlyVoteSites", VOTE26_COLORS.earlyVoteSites,
    "dropOffLocations", VOTE26_COLORS.dropOffLocations,
    "#a855f7",
  ];
}

/**
 * Election-day sites are drawn largest. Among the three this is the one with
 * a deadline attached, so it should be the one the eye lands on.
 */
export function vote26Radius(scale = 1): unknown[] {
  const r = (n: number) => n * scale;
  return [
    "interpolate", ["linear"], ["zoom"],
    5, ["match", ["get", "kind"], "pollingLocations", r(4), r(3)],
    9, ["match", ["get", "kind"], "pollingLocations", r(7), r(5)],
    14, ["match", ["get", "kind"], "pollingLocations", r(11), r(8)],
  ];
}

/**
 * Drop-off boxes are drawn hollow: a ring rather than a filled dot. The
 * colour difference alone is too subtle to carry "you cannot vote here", and
 * that is the one distinction on this layer with a real-world cost.
 */
export function vote26FillOpacity(): unknown[] {
  return ["match", ["get", "kind"], "dropOffLocations", 0.15, 0.9];
}
