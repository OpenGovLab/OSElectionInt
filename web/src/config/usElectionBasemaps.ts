import type { SkySpecification, StyleSpecification } from "maplibre-gl";

/**
 * Base maps the election map can sit on.
 *
 * Two of these are vector styles from OpenFreeMap; the third is Esri's World
 * Imagery raster service, the same source OSIRIS uses for its satellite view.
 * All three are keyless.
 *
 * Imagery earns its place at district and county zoom: a margin means more
 * when you can see the farmland, the freeway and the city block under it.
 * A globe projection is the other half of the OSIRIS look, and maplibre-gl v5
 * gives it to us. It ships as a MODE rather than the default: a sphere
 * distorts area, which is the exact channel a choropleth reads through, so
 * 2D stays the analytical view and 3D is the one you reach for to place the
 * country in the world. That is also why entering the globe pulls the camera
 * back — a globe cropped to the lower 48 is a worse mercator, not a globe.
 */

/** Alias kept because both spellings are in use across the page. */
export type BasemapId = BasemapKey;
export type BasemapKey = "light" | "dark" | "satellite";

/** OpenFreeMap ships exactly three faces; our label layers depend on them. */
export const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const ESRI_IMAGERY =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/**
 * A raster-only style has no `glyphs` entry, and MapLibre then refuses to
 * render ANY symbol layer — every division and race label would silently
 * vanish on satellite. Borrowing OpenFreeMap's glyph endpoint keeps them.
 */
export const satelliteStyle: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    "esri-imagery": {
      type: "raster",
      tiles: [ESRI_IMAGERY],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [
    { id: "esri-imagery", type: "raster", source: "esri-imagery" },
  ],
};

export interface BasemapDef {
  id: BasemapKey;
  label: string;
  style: string | StyleSpecification;
  /** Imagery is dark, so overlay ink has to flip with it, not with the theme. */
  darkInk: boolean;
}

export const BASEMAPS: BasemapDef[] = [
  { id: "light", label: "Map", style: "https://tiles.openfreemap.org/styles/positron", darkInk: false },
  { id: "dark", label: "Dark", style: "https://tiles.openfreemap.org/styles/dark", darkInk: true },
  { id: "satellite", label: "Satellite", style: satelliteStyle, darkInk: true },
];

export const basemapFor = (k: BasemapKey) =>
  BASEMAPS.find((b) => b.id === k) ?? BASEMAPS[0];

/**
 * 2D or 3D. MapLibre's globe carries its own adaptive transition — past
 * roughly z12 it renders as mercator anyway — so a county stays undistorted
 * when you are close enough for that to matter.
 */
export type ProjectionKey = "mercator" | "globe";

/**
 * Outside the sphere, MapLibre paints sky, not background colour. Without a
 * sky the globe sits in a flat slab of the basemap's background and reads as
 * a circle rather than a planet, so each basemap gets its own horizon.
 */
export const skyFor = (darkInk: boolean): SkySpecification =>
  darkInk
    ? {
        "sky-color": "#05070f",
        "sky-horizon-blend": 0.5,
        "horizon-color": "#0b1226",
        "horizon-fog-blend": 0.35,
        "fog-color": "#05070f",
        "fog-ground-blend": 0.85,
      }
    : {
        "sky-color": "#bfd8f2",
        "sky-horizon-blend": 0.6,
        "horizon-color": "#e6eef8",
        "horizon-fog-blend": 0.4,
        "fog-color": "#eef3f9",
        "fog-ground-blend": 0.9,
      };

/**
 * Zoom floors differ by projection. Mercator is clamped at 2 because below it
 * the lower 48 is a smear; the globe needs to go further out or you never see
 * that it is a globe.
 */
export const MIN_ZOOM: Record<ProjectionKey, number> = { mercator: 2, globe: 0.8 };

/** Where the camera sits when you switch to 3D: the US on a whole earth. */
export const GLOBE_HOME = { center: [-96, 38] as [number, number], zoom: 2.2 };
