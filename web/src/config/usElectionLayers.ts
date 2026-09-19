/**
 * Overlay registry.
 *
 * Pattern borrowed from OSIRIS (MIT), whose map carries 95 layers and stays
 * manageable because layers are DATA, not code: each declares its id, label
 * and the capability it needs, and one loop drives visibility for all of them.
 *
 * The distinction that matters here, and that OSIRIS does not need to make:
 * office, level and year are QUERY PARAMETERS — they change what the
 * choropleth asks for, and are mutually exclusive. Races and news are
 * OVERLAYS — independent things drawn on top, each on or off. Putting both
 * in one registry would force every parameter into a boolean and lose the
 * "exactly one of" constraint that makes the level chips correct.
 *
 * So: parameters stay as their own controls, overlays live here. Adding the
 * news layer becomes one entry plus a data effect, not another ad-hoc piece
 * of state and another setLayoutProperty call site.
 */

export type OverlayId = "races" | "news" | "homes" | "polls";

export interface OverlayDef {
  id: OverlayId;
  label: string;
  /** Tooltip — says what the layer shows, not what it is called. */
  hint: string;
  /** Every MapLibre layer id this overlay owns; visibility is driven as a set. */
  layerIds: string[];
  /**
   * Server capability this overlay needs. An overlay whose data is not
   * configured stays hidden rather than rendering an empty toggle that looks
   * broken — the same idea as OSIRIS's `requires`.
   */
  requires?: string;
  defaultOn: boolean;
  /**
   * Default on a narrow viewport, when it differs. Screen area is the scarce
   * resource on a phone, not information: an overlay that reads as useful
   * density on a 1400px desktop can bury the choropleth on a 390px one.
   * Falls back to `defaultOn` when not given.
   */
  defaultOnNarrow?: boolean;
}

export const OVERLAYS: OverlayDef[] = [
  {
    id: "races",
    label: "2026 races",
    hint: "Contested races, sized by money raised",
    layerIds: ["race-glow", "race-dot", "race-label"],
    defaultOn: true,
    // Off on a phone. At state zoom this is a few thousand circles over the
    // whole country; on a desktop that reads as "where the contests are", on
    // a 390px screen it is a blanket and the margins underneath stop being
    // legible at all. Still one tap away under Layers.
    defaultOnNarrow: false,
  },
  {
    id: "news",
    label: "Election news",
    hint: "Coverage mentioning candidates, placed on their district",
    layerIds: ["news-glow", "news-dot"],
    requires: "electionNews",
    defaultOn: false,
  },
  {
    id: "homes",
    label: "Home towns",
    // Says what it shows and what it does not: the filing address, which is
    // usually home. Overclaiming here would be the easiest thing on the map
    // to get quietly wrong.
    hint: "Where candidates file from, grouped by city",
    layerIds: ["home-glow", "home-dot"],
    // Gated on the `home` field existing, not on us_candidates existing —
    // see getCapabilities. Until the places ingest runs this stays hidden
    // rather than offering a toggle that turns on an empty layer.
    requires: "candidateHomes",
    defaultOn: false,
  },
  {
    id: "polls",
    label: "Polling places",
    // The hint carries the years because the label cannot. This layer is
    // where booths WERE, 2012-2020; read as current it sends someone to a
    // building that may have closed two elections ago.
    hint: "Where booths stood, 2012–2020 (37 states) — not current locations",
    layerIds: ["polls-glow", "polls-dot"],
    requires: "pollingPlaces",
    defaultOn: false,
  },
];

/** Which overlays start on. Evaluated once at mount, never re-applied — a
 *  rotation must not silently undo what the reader has toggled since. */
export function defaultOverlays(narrow: boolean): Record<OverlayId, boolean> {
  return OVERLAYS.reduce(
    (acc, o) => ({
      ...acc,
      [o.id]: narrow && o.defaultOnNarrow !== undefined
        ? o.defaultOnNarrow
        : o.defaultOn,
    }),
    {} as Record<OverlayId, boolean>,
  );
}

/** Overlays the server can actually serve, in declaration order. */
export function availableOverlays(
  capabilities: Record<string, boolean> = {},
): OverlayDef[] {
  return OVERLAYS.filter((o) => !o.requires || capabilities[o.requires]);
}
