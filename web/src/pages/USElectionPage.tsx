import maplibregl, { type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BASEMAP,
  type DivisionLevel,
  LEVELS,
  marginFill,
  marginLabel,
  marginOpacity,
  boundaryWidth,
  raceColor,
  raceRadius,
  LABEL_SOURCE,
  NEWS_SOURCE,
  POLLS_SOURCE,
  POLLS_MIN_ZOOM,
  POLLS_COLOR,
  pollsRadius,
  newsRadius,
  HOME_SOURCE,
  HOME_COLOR,
  homeRadius,
  partyMixLabel,
  moneyLabel,
  RACE_SOURCE,
  tiltLabel,
  MARGIN_STOPS,
  NEUTRAL,
  OFFICES,
  type OfficeId,
  resolveTilesUrl,
  SOURCE_ID,
} from "@/config/usElectionMap";
import DivisionDetail, { type Holder as DetailHolder }
  from "@/components/us-election/DivisionDetail";
import CandidateDetail from "@/components/us-election/CandidateDetail";
import ElectionChat from "@/components/us-election/ElectionChat";
import PersonDetail from "@/components/us-election/PersonDetail";
import Portrait from "@/components/us-election/Portrait";
import {
  availableOverlays,
  defaultOverlays,
  type OverlayId,
} from "@/config/usElectionLayers";
import {
  basemapFor,
  BASEMAPS,
  type BasemapKey,
  GLOBE_HOME,
  MIN_ZOOM,
  type ProjectionKey,
  skyFor,
} from "@/config/usElectionBasemaps";
import { useIsDark } from "@/lib/theme";
import { apiService } from "@/lib/api";
import { ChromeFooter, ChromeHeader } from "@/components/Chrome";
import type { IntroPhase } from "@/App";

interface PageProps {
  introPhase?: IntroPhase;
  onIntroDone?: () => void;
}

interface Row {
  ocd_id: string;
  name: string;
  state: string;
  margin?: number | null;
  winner?: string;
  holders?: Holder[];
}

interface Holder {
  ocd_id: string;
  office: string;
  name: string;
  party: string;
  next_election: string | null;
  senate_class?: number;
  photo?: string | null;
  bioguide?: string;
}

interface MarginRow {
  ocd_id: string;
  margin: number | null;
  winner_party: string;
  total: number;
  major_share: number;
  /** Certified party totals — what a candidate's displayed share is built from. */
  votes?: Record<string, number | undefined>;
}

/**
 * A leading finisher, as /top-candidates reports them: who, not how many.
 *
 * There is deliberately no vote count here. That endpoint reads a collection
 * keyed on the raw name string from each county's source file, where one
 * ticket is spelled half a dozen ways, so its totals do not reconcile with
 * the certified figures in us_margins. The share rendered beside these names
 * is therefore derived from the margin row for the SAME division — the same
 * record the choropleth is painted from — joined on `party`. That is why the
 * server returns at most one candidate per party: it keeps the join exact,
 * and a share can never contradict the margin pill sitting next to it.
 */
interface TopCandidate {
  name: string;
  party: string;
  photo?: string | null;
  bioguide?: string | null;
  sitting?: boolean;
}

interface TopRow {
  ocd_id: string;
  top: TopCandidate[];
}

const US_BOUNDS: [number, number, number, number] = [-125, 24.4, -66.5, 49.4];

/** Tailwind's md breakpoint, readable from JS. SSR counts as wide. */
function isNarrow() {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

function fitPadding() {
  const wide = !isNarrow();
  // Narrow: the office chips wrap to two rows above the map and the sheet
  // covers the bottom, so the country has to be fitted into what is left. A
  // symmetric fit puts half the map under the chrome.
  return wide
    ? { top: 28, bottom: 28, left: 28, right: 392 }
    : { top: 104, bottom: 150, left: 20, right: 20 };
}

/**
 * Rough centre of a tile feature, for a bounds test.
 *
 * Tile geometry is clipped at tile edges, so a big state split across tiles
 * yields one of these per piece and none of them is the true centroid. That is
 * fine for deciding "is this roughly on screen" — and the caller dedupes by
 * OCD id afterwards, so a state counted from three tiles still lands once.
 */
function roughCentre(f: maplibregl.GeoJSONFeature): [number, number] | null {
  let sx = 0, sy = 0, n = 0;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      sx += c[0] as number; sy += c[1] as number; n += 1;
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk((f.geometry as { coordinates?: unknown })?.coordinates);
  return n ? [sx / n, sy / n] : null;
}

/**
 * The divisions currently on screen, under either projection.
 *
 * Mercator uses queryRenderedFeatures, which is exactly right: it reports what
 * the GPU actually drew inside the viewport box.
 *
 * The globe cannot use it. MapLibre's box query degenerates once the rectangle
 * reaches past the limb — the corners of the screen are empty space, not map —
 * and it fails silently rather than partially. Measured against this archive at
 * 390px wide: at z3.4 a full-viewport query returns 0 features while the same
 * query inset by 25% returns all 64; at z2.2 even the inset returns 1. The
 * threshold moves with zoom, so no fixed inset is safe.
 *
 * So on the globe we read the source rather than the screen and filter by the
 * camera bounds. It is coarser — a globe shows most of a hemisphere, so the
 * bounds are wide — but it is stable at every zoom, and a list of every state
 * is a far better answer than the empty list this used to produce.
 */
function viewportFeatures(
  map: maplibregl.Map, lvl: DivisionLevel,
): maplibregl.GeoJSONFeature[] {
  const onGlobe = map.getProjection?.()?.type === "globe";
  if (!onGlobe) {
    try {
      return map.queryRenderedFeatures({ layers: [`${lvl}-fill`] });
    } catch {
      return [];
    }
  }
  try {
    const b = map.getBounds();
    return map
      .querySourceFeatures(SOURCE_ID, { sourceLayer: lvl })
      .filter((f) => {
        const c = roughCentre(f);
        return c ? b.contains(c) : false;
      });
  } catch {
    return [];
  }
}

/**
 * Put the map into 2D or 3D.
 *
 * Three things move together, and all three are style state that setStyle()
 * throws away: the projection, the sky the globe needs to read as a planet
 * rather than a flat disc, and the zoom floor. So this is called twice — once
 * when the reader flips the toggle, and again after every basemap swap.
 *
 * `camera` separates those two callers. Flipping the toggle should move the
 * camera (a globe cropped to the lower 48 is just a worse mercator); a style
 * swap must not, because the reader is already somewhere and a jump there
 * reads as a bug.
 */
function applyProjection(
  map: maplibregl.Map,
  p: ProjectionKey,
  darkInk: boolean,
  opts: { camera?: boolean } = {},
) {
  try {
    map.setProjection({ type: p });
  } catch (e) {
    // A projection the runtime will not take must degrade the map, not the page.
    console.warn("[election] projection unavailable", e);
    return;
  }
  // setMinZoom clamps the current zoom for us when 3D → 2D leaves us below 2.
  map.setMinZoom(MIN_ZOOM[p]);

  if (p === "globe") {
    try {
      map.setSky(skyFor(darkInk));
    } catch {
      /* style not ready for a sky yet — the reinstall path sets it again */
    }
    if (opts.camera) {
      map.easeTo({
        center: GLOBE_HOME.center,
        zoom: GLOBE_HOME.zoom,
        pitch: 0,
        duration: 900,
      });
    }
    return;
  }

  // Back to flat. Zeroing the atmosphere is what stops mercator inheriting
  // the globe's halo the moment anything tilts the camera.
  try {
    map.setSky({ "atmosphere-blend": 0 });
  } catch {
    /* nothing to clear */
  }
  if (opts.camera) {
    map.fitBounds(US_BOUNDS, { padding: fitPadding(), duration: 900 });
  }
}

export default function USElectionPage({
  introPhase = "done",
  onIntroDone,
}: PageProps) {
  const isDark = useIsDark();
  const palette = NEUTRAL[isDark ? "dark" : "light"];

  const containerRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoverRef = useRef<string | null>(null);
  const stateKeysRef = useRef<Set<string>>(new Set());
  // setStyle() discards every source and layer the app added, so the installer
  // is kept on a ref and replayed once the new style has loaded.
  // Overlay ink follows the BASEMAP, not the site theme: satellite imagery is
  // dark whichever theme the reader has chosen.
  const darkInkRef = useRef(false);
  // Which basemap is actually applied. Without this the effect re-runs
  // setStyle on mount — re-swapping the style the map is still loading and
  // throwing "Style is not done loading" out of an effect, which takes the
  // whole React tree down.
  const appliedBasemapRef = useRef<BasemapKey | null>(null);
  const installRef = useRef<(() => void) | null>(null);
  // The pmtiles Protocol instance, kept so a basemap swap can replace it.
  const protocolRef = useRef<Protocol | null>(null);

  const [office, setOffice] = useState<OfficeId>("president");
  const [level, setLevel] = useState<DivisionLevel>("state");
  // Zoom drives the level unless the reader picks one — the map should reveal
  // districts and counties as you go in, not make you find a control first.
  const [autoLevel, setAutoLevel] = useState(true);
  const [year, setYear] = useState<number | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [yearCounts, setYearCounts] = useState<Map<number, number>>(new Map());
  const [margins, setMargins] = useState<Map<string, MarginRow>>(new Map());
  const [holders, setHolders] = useState<Map<string, Holder[]>>(new Map());
  // Who ran, per division, for the cut on screen. Names only — the numbers
  // beside them come from `margins`; see TopCandidate.
  const [topCandidates, setTopCandidates] =
    useState<Map<string, TopCandidate[]>>(new Map());
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const [person, setPerson] = useState<DetailHolder | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // Overlay visibility, keyed by the registry rather than one boolean per
  // layer. Adding the news layer is a registry entry plus a data effect.
  const [overlays, setOverlays] = useState<Record<OverlayId, boolean>>(
    () => defaultOverlays(isNarrow()),
  );
  // Capabilities the server reports; an overlay whose feed is not configured
  // never renders a toggle.
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  // ElectionIntOS opens dark and on the globe. The parent app defaults to a
  // flat light map because it is a reading surface inside a news site; this is
  // a console, and the first thing it should say is "this is planetary data".
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  // 2D is the analytical default; the globe is a mode. setStyle() drops the
  // projection and the sky along with everything else, so the current choice
  // has to survive in a ref and be re-applied after every basemap swap.
  const [projection, setProjection] = useState<ProjectionKey>("globe");
  // Seeded with what the map is actually built as, NOT with the default
  // above. The effect below only acts when these differ, so seeding it
  // "globe" to match the state would skip the one call that makes it a globe.
  const projectionRef = useRef<ProjectionKey>("mercator");
  // On a 390px phone the control chips wrap to five rows and cover 175px of a
  // 564px map — a third of the surface the page exists to show. Everything
  // except the office axis and the year therefore collapses behind one chip.
  // Desktop has the width and keeps them all open.
  const [toolsOpen, setToolsOpen] = useState(false);
  // Bumped after a basemap swap. setStyle() discards sources, layers AND all
  // feature-state, so the margin paint has to be pushed in again — the data
  // effects key off this so they re-run without duplicating their logic here.
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [cand, setCand] = useState<{ fecId?: string; name: string } | null>(null);
  const [people, setPeople] = useState<{
    name: string; party: string; office?: string; state?: string;
    district?: number | null; kind: string; fec_id?: string;
  }[]>([]);
  const [zoom, setZoom] = useState(3.4);
  // Where the pointer is, in degrees. Pure chrome — it tells a reader the map
  // is live and gives them something to quote when reporting what they saw.
  const [cursor, setCursor] = useState<{ lng: number; lat: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const spinRef = useRef<number | null>(null);
  const introPhaseRef = useRef(introPhase);
  useEffect(() => { introPhaseRef.current = introPhase; }, [introPhase]);
  const [sheetOpen, setSheetOpen] = useState(() => !isNarrow());
  const [query, setQuery] = useState("");
  // Hover readout. Kept in state rather than a MapLibre Popup so it can show
  // the same margin pill and incumbent the list uses, and so it never steals
  // the pointer from the layer underneath it.
  // Height is measured, not assumed. `100dvh - 3.5rem` guessed at the chrome
  // above the map, but the header and the dismissible beta strip are taller
  // than that, so the map overflowed the viewport by ~74px and everything
  // anchored to its bottom — the legend, the timeline scrubber — sat below
  // the fold. Measuring the shell's own top is correct whatever is above it.
  const [shellH, setShellH] = useState<number | null>(null);
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      setShellH(Math.max(420, Math.round(window.innerHeight - top)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const [playing, setPlaying] = useState(false);
  const [prefetching, setPrefetching] = useState(false);
  const playRef = useRef<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<
    { x: number; y: number; row: Row; total?: number; majorShare?: number;
      top?: TopCandidate[] } | null>(null);
  const [newsTip, setNewsTip] = useState<{
    x: number; y: number; name: string; articles: number;
    people: string; tilt: number | null; headline: string;
  } | null>(null);
  const [pollTip, setPollTip] = useState<{
    x: number; y: number; name: string; address: string; year: number;
    kind: string; county: string; exact: boolean; lat: number; lng: number;
  } | null>(null);
  const [homeTip, setHomeTip] = useState<{
    x: number; y: number; place: string; candidates: number;
    dem: number; rep: number; other: number;
    raised: number; po_box: number; names: string;
  } | null>(null);
  // A clicked city, held open in the sheet so its candidates can be opened one
  // at a time and come back to the list.
  const [homePlace, setHomePlace] = useState<{
    place: string; po_box: number;
    who: { name: string; party: string; office: string;
      district: number | null; fec_id: string; receipts: number }[];
  } | null>(null);

  const officeMeta = useMemo(() => OFFICES.find((o) => o.id === office)!, [office]);
  const allowedLevels = useMemo(
    () => LEVELS.filter((l) => (officeMeta.levels as readonly string[]).includes(l.id)),
    [officeMeta],
  );
  const levelMeta = useMemo(() => LEVELS.find((l) => l.id === level)!, [level]);
  const outOfBand = zoom < levelMeta.minzoom || zoom > levelMeta.maxzoom;

  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);
  const marginsRef = useRef(margins);
  useEffect(() => { marginsRef.current = margins; }, [margins]);
  const holdersRef = useRef(holders);
  useEffect(() => { holdersRef.current = holders; }, [holders]);
  const topCandidatesRef = useRef(topCandidates);
  useEffect(() => { topCandidatesRef.current = topCandidates; }, [topCandidates]);
  // Only call a seat vacant when the officeholder feed actually loaded for
  // this office — otherwise "no holder" just means "not fetched".
  const hasHolderData = office === "us_house" || office === "us_senate";
  const hasHolderRef = useRef(false);
  useEffect(() => { hasHolderRef.current = hasHolderData && holders.size > 0; },
    [hasHolderData, holders]);

  // keep the level valid whenever the office changes
  useEffect(() => {
    if (!allowedLevels.some((l) => l.id === level)) setLevel(allowedLevels[0].id);
  }, [allowedLevels, level]);

  // Zoom-driven detail. Thresholds sit inside each layer's own zoom band (see
  // build_tiles.sh) so a level is never selected at a zoom where its geometry
  // is not in the archive and nothing would draw.
  useEffect(() => {
    if (!autoLevel) return;
    const ids = allowedLevels.map((l) => l.id);
    // Each threshold must fall INSIDE the overlap between the outgoing and
    // incoming layer's zoom bands, or there is a gap where neither draws.
    // The state layer ends at z6 and counties begin at z4, so handing over at
    // 5.5 is safely inside both; switching at 6.2 left a dead zone that
    // rendered "0 states in view".
    const want: DivisionLevel =
      zoom >= 5.5 && ids.includes("county") ? "county"
        : zoom >= 4.0 && ids.includes("cd") ? "cd"
          : zoom >= 5.0 && ids.includes("sldu") ? "sldu"
            : ids[0];
    if (want !== level) setLevel(want);
  }, [zoom, autoLevel, allowedLevels, level]);

  const refreshRows = useCallback((lvl: DivisionLevel) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const feats = viewportFeatures(map, lvl);
    const seen = new Map<string, Row>();
    for (const f of feats) {
      const p = (f.properties || {}) as Record<string, string>;
      if (!p.ocd_id || seen.has(p.ocd_id)) continue;
      const m = marginsRef.current.get(p.ocd_id);
      seen.set(p.ocd_id, {
        ocd_id: p.ocd_id, name: p.name, state: p.state,
        margin: m ? m.margin : null, winner: m?.winner_party,
        holders: hasHolderRef.current
          ? holdersRef.current.get(p.ocd_id) ?? []
          : undefined,
      });
    }
    setRows([...seen.values()].sort((a, b) => {
      const am = a.margin, bm = b.margin;
      if (am != null && bm != null) return Math.abs(am) - Math.abs(bm); // closest first
      if (am != null) return -1;
      if (bm != null) return 1;
      return a.state.localeCompare(b.state) || a.name.localeCompare(b.name, undefined, { numeric: true });
    }));
  }, []);

  // ── construct the map once ───────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    // The archive URL comes from the manifest, so construction is async.
    resolveTilesUrl().then((tilesUrl) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      cleanup = build(tilesUrl);
    });

    function build(TILES_URL: string) {
    const protocol = new Protocol();
    protocolRef.current = protocol;
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const wantGlobeIntro = introPhaseRef.current === "splash";
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapFor("dark").style as never,
      ...(wantGlobeIntro
        ? { center: [30, 20] as [number, number], zoom: 1.6 }
        : { bounds: US_BOUNDS, fitBoundsOptions: { padding: fitPadding() } }),
      maxZoom: 12, minZoom: 0.8, attributionControl: false,
    });
    mapRef.current = map;
    appliedBasemapRef.current = "dark";
    darkInkRef.current = true;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        "Results: OpenElections · Boundaries: US Census 2023 · Basemap: OpenFreeMap",
    }), "bottom-right");

    /**
     * Start the attribution collapsed on a phone.
     *
     * MapLibre's compact control opens itself, and at 390px the credit wraps
     * to three lines — 64px of a 564px map, over the part of the country the
     * reader came for. Collapsed, it is the ⓘ button that compact mode exists
     * to provide, one tap from the full text. Nothing is hidden, only closed,
     * and the class this touches is the same one that button toggles.
     *
     * It has to be an observer rather than a timed call. MapLibre re-adds
     * `compact-show` whenever the attribution text changes, which happens as
     * each source reports in: measured here, once during load and again at
     * ~1.75s when the basemap and PMTiles sources land. Removing it at any one
     * moment loses the race to the next source.
     *
     * The observer stands down permanently the first time the reader touches
     * the button — after that the panel is theirs, and a later source landing
     * must not close what they opened. Capture phase, so the flag is set
     * before MapLibre's own handler runs and changes the class.
     */
    let attribWatch: MutationObserver | null = null;
    if (isNarrow()) {
      const attrib = containerRef.current
        ?.querySelector<HTMLElement>(".maplibregl-ctrl-attrib");
      if (attrib) {
        let readerDecides = false;
        attrib.querySelector(".maplibregl-ctrl-attrib-button")
          ?.addEventListener("click", () => { readerDecides = true; }, true);
        // The guard is not an optimisation, it is the termination condition.
        // classList.remove() runs the DOM update steps and rewrites the class
        // attribute even when the token was already absent, and an attribute
        // write queues a MutationRecord even when the value is unchanged — so
        // an unguarded remove() inside its own observer is an infinite loop.
        // It wedges the main thread hard: the page paints and then answers
        // nothing, which reads as a hung tab rather than as a script bug.
        // takeRecords() then drops the record our own write just queued, so a
        // real re-add is the only thing that can wake this again.
        const SHOW = "maplibregl-compact-show";
        const close = () => {
          if (readerDecides || !attrib.classList.contains(SHOW)) return;
          attrib.classList.remove(SHOW);
          attribWatch?.takeRecords();
        };
        attribWatch = new MutationObserver(close);
        attribWatch.observe(attrib, { attributes: true, attributeFilter: ["class"] });
        close();
      }
    }

    // The page chrome settles after construction and MapLibre does not watch
    // its own container, so without this the canvas keeps its mount height.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    /**
     * Install every custom source and layer.
     *
     * Extracted because setStyle() discards all of them — switching the
     * basemap tears the style down and rebuilds it, so the election layers
     * must be re-added afterwards or the map comes back empty.
     */
    function installLayers() {
      // Overlay ink follows the BASEMAP, not the site theme: satellite imagery
      // is dark whatever theme the reader picked, so dark-on-white labels
      // would be unreadable over it.
      const ink = darkInkRef.current;
      // Idempotent by teardown, not by early return. setStyle's default diff
      // can keep a source alive while dropping every layer that used it, so
      // "source exists" is not evidence the layers do — checking it skipped
      // the reinstall and left the map blank.
      for (const l of LEVELS) {
        for (const suffix of ["fill", "line", "label"]) {
          const id = `${l.id}-${suffix}`;
          if (map.getLayer(id)) map.removeLayer(id);
        }
      }
      for (const id of ["race-glow", "race-dot", "race-label",
                        "news-glow", "news-dot",
                        "polls-glow", "polls-dot",
                        "home-glow", "home-dot"]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const src of [SOURCE_ID, LABEL_SOURCE, RACE_SOURCE, NEWS_SOURCE, POLLS_SOURCE,
                         HOME_SOURCE]) {
        if (map.getSource(src)) map.removeSource(src);
      }
      // promoteId lets feature state be keyed by division id, which is stable
      // across tiles — tile-local numeric ids are not.
      map.addSource(SOURCE_ID, { type: "vector", url: TILES_URL, promoteId: "ocd_id" });

      // Paint UNDER the basemap's labels. Adding the fills on top washed out
      // every city and state name — the single biggest readability problem.
      // MapLibre inserts before a named layer, so the first symbol layer in
      // the style is the boundary between "geometry" and "type".
      const firstSymbol = map.getStyle().layers
        ?.find((l) => l.type === "symbol")?.id;

      map.addSource(LABEL_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      for (const l of LEVELS) {
        map.addLayer({
          id: `${l.id}-fill`, type: "fill", source: SOURCE_ID, "source-layer": l.id,
          minzoom: l.minzoom, maxzoom: l.maxzoom,
          // Visibility tracks the CURRENT level, not "state". installLayers is
          // replayed after every basemap swap, and hardcoding the opening
          // level left the reader on counties looking at a hidden layer —
          // tiles fetched, nothing drawn, and no error to explain it.
          layout: { visibility: l.id === levelRef.current ? "visible" : "none" },
          paint: {
            "fill-color": marginFill(palette.fill) as never,
            "fill-opacity": marginOpacity() as never,
          },
        }, firstSymbol);
        map.addLayer({
          id: `${l.id}-line`, type: "line", source: SOURCE_ID, "source-layer": l.id,
          minzoom: l.minzoom, maxzoom: l.maxzoom,
          layout: { visibility: l.id === levelRef.current ? "visible" : "none" },
          paint: {
            "line-color": [
              "case",
              ["boolean", ["feature-state", "hover"], false], ink ? "#fbbf24" : "#0f172a",
              ["boolean", ["feature-state", "selected"], false], ink ? "#fbbf24" : "#0f172a",
              ink ? "#0f172a" : "#ffffff",
            ] as never,
            "line-width": boundaryWidth() as never,
            "line-opacity": 0.75,
          },
        }, firstSymbol);

        // Division names come from a POINT source, not the polygon layer.
        // A polygon spanning several tiles is labelled once per tile, which
        // put "Texas", "California" and "Florida" on the map three and four
        // times each. One centroid, one label.
        map.addLayer({
          id: `${l.id}-label`,
          type: "symbol",
          source: LABEL_SOURCE,
          minzoom: l.minzoom,
          maxzoom: l.maxzoom,
          layout: {
            visibility: l.id === levelRef.current ? "visible" : "none",
            "text-field": ["get", "label"] as never,
            // OpenFreeMap's glyph server ships exactly three faces —
            // Noto Sans Regular / Bold / Italic. Anything else 404s and the
            // whole label layer silently renders nothing. Bold also separates
            // division names from the basemap's city labels, which are Regular.
            "text-font": ["Noto Sans Bold"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 8, 13] as never,
            "text-padding": 6,
            "text-allow-overlap": false,
            "text-max-width": 9,
          },
          paint: {
            "text-color": ink ? "#f1f5f9" : "#0f172a",
            "text-halo-color": ink ? "#0f172a" : "#ffffff",
            "text-halo-width": 1.6,
            "text-halo-blur": 0.4,
          },
        });
      }
      // ── contested races, as circles at division centroids ──────────────
      map.addSource(NEWS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(POLLS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(RACE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(HOME_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // Glow beneath, solid dot on top: reads on a busy basemap without a
      // heavy stroke, and the soft edge suits a value that covers a whole
      // district rather than a point.
      map.addLayer({
        id: "race-glow", type: "circle", source: RACE_SOURCE,
        paint: {
          "circle-color": raceColor() as never,
          "circle-radius": raceRadius() as never,
          "circle-blur": 0.9,
          "circle-opacity": 0.5,
        },
      });
      map.addLayer({
        id: "race-dot", type: "circle", source: RACE_SOURCE,
        paint: {
          "circle-color": raceColor() as never,
          "circle-radius": raceRadius(0.42) as never,
          "circle-opacity": 0.95,
          "circle-stroke-width": 1.2,
          "circle-stroke-color": ink ? "#0f172a" : "#ffffff",
        },
      });
      // Label only the races big enough to be worth naming — 492 circles must
      // not become 492 labels.
      map.addLayer({
        id: "race-label", type: "symbol", source: RACE_SOURCE,
        // Only the biggest races carry a label at low zoom, and the bar drops
        // as you go in. 492 circles must not become 492 labels competing with
        // the division names underneath.
        minzoom: 3.5,
        filter: [">=", ["get", "total_raised"], 8_000_000],
        layout: {
          "text-field": ["get", "label"] as never,
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 8, 12] as never,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-allow-overlap": false,
          "text-padding": 8,
        },
        paint: {
          "text-color": ink ? "#e2e8f0" : "#0f172a",
          "text-halo-color": ink ? "#0f172a" : "#ffffff",
          "text-halo-width": 1.6,
        },
      });

      // News rings sit above the race circles: coverage is the newer signal
      // and a ring reads over a filled dot without hiding it.
      //
      // These live in installLayers, NOT in the load handler. The teardown at
      // the top of this function removes them, so creating them once on load
      // meant the first basemap swap deleted the news overlay permanently and
      // left its toggle switched on over nothing. Same failure that emptied
      // the choropleth; anything torn down here has to be rebuilt here.
      // Historical polling places. minzoom is load-bearing, not cosmetic:
      // these are individual buildings and at country zoom they cover the
      // choropleth entirely.
      map.addLayer({
        id: "polls-glow", type: "circle", source: POLLS_SOURCE,
        minzoom: POLLS_MIN_ZOOM,
        layout: { visibility: "none" },
        paint: {
          "circle-color": POLLS_COLOR,
          "circle-radius": pollsRadius() as never,
          "circle-blur": 1,
          "circle-opacity": 0.3,
        },
      });
      map.addLayer({
        id: "polls-dot", type: "circle", source: POLLS_SOURCE,
        minzoom: POLLS_MIN_ZOOM,
        layout: { visibility: "none" },
        paint: {
          "circle-color": POLLS_COLOR,
          "circle-radius": pollsRadius() as never,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
          "circle-stroke-opacity": 0.8,
          "circle-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "news-glow", type: "circle", source: NEWS_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "circle-color": "#f59e0b",
          "circle-radius": newsRadius() as never,
          "circle-blur": 1,
          "circle-opacity": 0.22,
        },
      });
      map.addLayer({
        id: "news-dot", type: "circle", source: NEWS_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "circle-color": "transparent",
          "circle-radius": newsRadius() as never,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#f59e0b",
          "circle-stroke-opacity": 0.95,
        },
      });

      // Home towns on top of everything: they are the only points here at a
      // real coordinate, so they must not be buried under a district circle
      // that merely covers the same ground.
      map.addLayer({
        id: "home-glow", type: "circle", source: HOME_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "circle-color": HOME_COLOR.glow,
          "circle-radius": homeRadius(2.2) as never,
          "circle-blur": 1,
          "circle-opacity": 0.3,
        },
      });
      map.addLayer({
        id: "home-dot", type: "circle", source: HOME_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "circle-color": HOME_COLOR.dot,
          "circle-radius": homeRadius() as never,
          "circle-opacity": 0.95,
          "circle-stroke-width": 1,
          "circle-stroke-color": ink ? "#0f172a" : HOME_COLOR.stroke,
        },
      });
    }
    installRef.current = installLayers;

    map.on("load", () => {
      installLayers();

      if (wantGlobeIntro) {
        applyProjection(map, "globe", true);
        let lastTime = 0;
        const spin = (ts: number) => {
          if (!lastTime) lastTime = ts;
          const dt = ts - lastTime;
          lastTime = ts;
          const c = map.getCenter();
          c.lng -= 0.018 * dt;
          map.setCenter(c);
          spinRef.current = requestAnimationFrame(spin);
        };
        spinRef.current = requestAnimationFrame(spin);
      }

      setReady(true);
      map.once("idle", () => refreshRows("state"));
    });

    map.on("move", () => setZoom(map.getZoom()));
    map.on("mousemove", (e) => setCursor({ lng: e.lngLat.lng, lat: e.lngLat.lat }));
    map.on("mouseout", () => setCursor(null));
    map.on("idle", () => refreshRows(levelRef.current));

    return () => {
      if (spinRef.current) cancelAnimationFrame(spinRef.current);
      spinRef.current = null;
      ro.disconnect();
      attribWatch?.disconnect();
      map.remove();
      mapRef.current = null;
      maplibregl.removeProtocol("pmtiles");
    };
    }

    return () => {
      disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── which years exist for this cut ───────────────────────────────────────
  useEffect(() => {
    let alive = true;
    apiService({ method: "get", url: `/us-election/years?level=${level}` })
      .then((r) => {
        if (!alive) return;
        const list: { year: number; count: number }[] = r?.data?.data?.[office] || [];
        const ys = [...new Set(list.map((x) => x.year))].sort((a, b) => b - a);
        setYears(ys);
        setYearCounts(new Map(list.map((x) => [x.year, x.count])));
        // Default to the best-covered cycle, not the most recent one.
        // OpenElections coverage is volunteer-contributed and uneven — 2016
        // has 51 states while 2025 has a single stray contest, so "latest"
        // would open on an almost-empty map.
        const best = list.reduce<{ year: number; count: number } | null>(
          (a, b) => (!a || b.count > a.count ? b : a), null);
        setYear((cur) =>
          cur && ys.includes(cur) ? cur : best?.year ?? ys[0] ?? null);
      })
      .catch(() => { if (alive) { setYears([]); setYear(null); } });
    return () => { alive = false; };
  }, [office, level]);

  // ── basemap switching ────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (appliedBasemapRef.current === basemap) return;
    appliedBasemapRef.current = basemap;
    darkInkRef.current = basemapFor(basemap).darkInk;
    // diff:false — a vector→raster swap is not meaningfully diffable, and a
    // partial diff is what leaves sources without their layers.
    map.setStyle(basemapFor(basemap).style as never, { diff: false });
    // styledata fires once the new style is in place; the election layers are
    // gone at that point and have to be reinstalled before anything renders.
    // `styledata` fires while the OUTGOING style is still loaded, so
    // isStyleLoaded() is true for the style that is about to be thrown away —
    // reinstalling there puts the layers onto a doomed style and they vanish.
    // `style.load` fires once the new style is actually in place.
    const onStyle = () => {
      // Re-register pmtiles with a FRESH Protocol before reinstalling.
      //
      // setStyle aborts every in-flight request belonging to the outgoing
      // style, and the Protocol instance caches per-URL results — including
      // the aborted one for the archive's TileJSON. The source then re-adds
      // cleanly and never fetches a single tile: 40 tile requests before a
      // swap, zero after, no error anywhere. The choropleth simply vanishes
      // while labels and GeoJSON overlays come back, which is what makes this
      // look like a layer bug rather than a transport one.
      try {
        maplibregl.removeProtocol("pmtiles");
      } catch {
        /* not registered — nothing to remove */
      }
      const fresh = new Protocol();
      protocolRef.current = fresh;
      maplibregl.addProtocol("pmtiles", fresh.tile);

      // A style-swap failure should degrade the map, never take down the page.
      try {
        installRef.current?.();
      } catch (e) {
        console.error("[election] layer reinstall failed", e);
      }
      // Projection and sky are style state too, so a swap silently drops the
      // reader back to mercator with the globe still selected in the chip row.
      // No camera move: they are already looking somewhere.
      applyProjection(map, projectionRef.current, darkInkRef.current);

      // Feature-state went with the old style; re-running the data effects is
      // what puts the margins back on the map.
      stateKeysRef.current = new Set();
      setStyleEpoch((n) => n + 1);
    };
    map.once("style.load", onStyle);
    return () => { map.off("style.load", onStyle); };
  }, [basemap, ready, refreshRows]);

  // ── 2D / 3D ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (projectionRef.current === projection) return;
    projectionRef.current = projection;
    applyProjection(map, projection, darkInkRef.current, { camera: true });
  }, [projection, ready]);

  // ── intro flyTo: splash done → stop spin → fly to Austin → open TX-52 ─
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || introPhase !== "flyto") return;

    if (spinRef.current) {
      cancelAnimationFrame(spinRef.current);
      spinRef.current = null;
    }

    map.flyTo({
      center: [-97.7431, 30.2672],
      zoom: 7,
      speed: 0.8,
      curve: 1.4,
      essential: true,
    });

    const onArrive = () => {
      // Austin's US House seat. The state-house district Talarico sits in
      // (sldl:52) is NOT in the archive — no geometry, no margins — so
      // targeting it painted a black map and a "not found" panel. TX-37 is
      // the district that actually covers Austin and it has certified
      // results at every cycle we hold.
      setOffice("us_house");
      setAutoLevel(false);
      setLevel("cd");
      setTimeout(() => {
        const austin: Row = {
          ocd_id: "ocd-division/country:us/state:tx/cd:37",
          name: "Congressional District 37",
          state: "TX",
          margin: null,
        };
        setSelected(austin);
        setDetail(austin);
        setSheetOpen(true);
        onIntroDone?.();
      }, 500);
    };
    map.once("moveend", onArrive);
    return () => { map.off("moveend", onArrive); };
  }, [introPhase, ready, onIntroDone]);

  // ── historical polling places, fetched per viewport ──────────────────
  //
  // Unlike the other overlays this one cannot be loaded once: there are
  // 216,822 placed rows and no useful way to show them all at once. So it
  // refetches on idle, bounded to what is on screen, and only above the zoom
  // where individual buildings mean anything. Off-screen or zoomed out, the
  // source is emptied rather than left holding a stale city.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!overlays.polls) {
      const src = map.getSource(POLLS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    let alive = true;
    const load = () => {
      if (!alive || map.getZoom() < POLLS_MIN_ZOOM) return;
      const b = map.getBounds();
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
        .map((n) => n.toFixed(4)).join(",");
      apiService({
        method: "get",
        url: `/us-election/polling-points?bbox=${bbox}&limit=1200`,
      })
        .then((r) => {
          if (!alive) return;
          const d = (r as { data?: { data?: { features?: unknown[] } } })?.data?.data;
          const src = map.getSource(POLLS_SOURCE) as maplibregl.GeoJSONSource | undefined;
          src?.setData({
            type: "FeatureCollection",
            features: (d?.features ?? []) as never[],
          });
        })
        .catch(() => { /* leave whatever is already drawn */ });
    };
    // Debounced: `idle` fires after every pan and every zoom step, and a
    // single zoom gesture produced 41 requests before this was added. The map
    // settles long before a reader has decided where they are looking.
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 350);
    };
    load();
    map.on("idle", schedule);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      map.off("idle", schedule);
    };
  }, [overlays.polls, ready, styleEpoch]);

  // ── polling place hover and click ────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const enter = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      map.getCanvas().style.cursor = "pointer";
      const p = (f.properties || {}) as Record<string, string>;
      const [lng, lat] =
        (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
      setPollTip({
        x: e.point.x, y: e.point.y,
        name: p.name || "Polling place",
        address: p.address || "",
        year: Number(p.year) || 0,
        kind: p.location_type || "",
        county: p.county || "",
        // Half of these were interpolated along a street segment rather than
        // matched to a rooftop; saying which is the difference between a pin
        // and a guess.
        exact: p.geo_match === "Exact",
        lat, lng,
      });
    };
    const leave = () => { map.getCanvas().style.cursor = ""; setPollTip(null); };
    map.on("mousemove", "polls-dot", enter);
    map.on("mouseleave", "polls-dot", leave);
    return () => {
      map.off("mousemove", "polls-dot", enter);
      map.off("mouseleave", "polls-dot", leave);
    };
  }, [ready]);

  // ── what this deployment can serve ───────────────────────────────────
  useEffect(() => {
    let alive = true;
    apiService({ method: "get", url: "/us-election/capabilities" })
      .then((r) => {
        const caps = (r as { data?: { data?: Record<string, boolean> } })?.data?.data;
        if (alive && caps) setCapabilities(caps);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // ── division name labels, from centroids ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let alive = true;
    apiService({ method: "get", url: `/us-election/division-points?level=${level}` })
      .then((r) => {
        if (!alive) return;
        const feats = (r as { data?: { data?: { features?: unknown[] } } })
          ?.data?.data?.features ?? [];
        const src = map.getSource(LABEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: feats } as never);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [level, ready, styleEpoch]);

  // ── election coverage as points ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !overlays.news) return;
    let alive = true;
    apiService({ method: "get", url: "/us-election/news-points?limit=400" })
      .then((r) => {
        if (!alive) return;
        const feats = (r as { data?: { data?: { features?: unknown[] } } })
          ?.data?.data?.features ?? [];
        const src = map.getSource(NEWS_SOURCE) as maplibregl.GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: feats } as never);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [ready, styleEpoch, overlays.news]);

  // clicking a news ring opens that division
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      if (!p.ocd_id) return;
      const row = { ocd_id: p.ocd_id, name: p.name, state: p.state,
        margin: null, holders: undefined };
      setSelected(row); setDetail(row); setSheetOpen(true);
    };
    const enter = (e: maplibregl.MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      if (p.ocd_id) {
        setNewsTip({
          x: e.point.x, y: e.point.y, name: p.name,
          articles: Number(p.articles || 0),
          people: String(p.people || ""),
          tilt: p.tilt === undefined || p.tilt === null ? null : Number(p.tilt),
          headline: String(p.headline || ""),
        });
      }
    };
    const leave = () => { map.getCanvas().style.cursor = ""; setNewsTip(null); };
    map.on("click", "news-dot", onClick);
    map.on("mousemove", "news-dot", enter);
    map.on("mouseleave", "news-dot", leave);
    return () => {
      map.off("click", "news-dot", onClick);
      map.off("mousemove", "news-dot", enter);
      map.off("mouseleave", "news-dot", leave);
    };
  }, [ready]);

  // ── contested races as points ────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let alive = true;
    if (!overlays.races) return;
    apiService({ method: "get", url: "/us-election/races?cycle=2026" })
      .then((r) => {
        if (!alive) return;
        const feats = (r as { data?: { data?: { features?: unknown[] } } })
          ?.data?.data?.features ?? [];
        const src = map.getSource(RACE_SOURCE) as maplibregl.GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: feats } as never);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [ready, styleEpoch, overlays.races]);

  // ── candidate home towns as points ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !overlays.homes) return;
    let alive = true;
    apiService({ method: "get", url: "/us-election/candidate-places?cycle=2026" })
      .then((r) => {
        if (!alive) return;
        const feats = (r as { data?: { data?: { features?: unknown[] } } })
          ?.data?.data?.features ?? [];
        const src = map.getSource(HOME_SOURCE) as maplibregl.GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: feats } as never);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [ready, styleEpoch, overlays.homes]);

  // hovering a home dot reads the town out; clicking opens who lives there
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      if (!p.place) return;
      let who: {
        name: string; party: string; office: string;
        district: number | null; fec_id: string; receipts: number;
      }[] = [];
      // GeoJSON feature properties are flat strings once they cross MapLibre,
      // so the candidate list travels as JSON and is parsed back here.
      try { who = JSON.parse(String(p.who || "[]")); } catch { who = []; }
      if (who.length === 1) {
        setCand({ fecId: who[0].fec_id, name: who[0].name });
      } else {
        setCand(null);
        setHomePlace({ place: String(p.place), po_box: Number(p.po_box || 0), who });
      }
      setSheetOpen(true);
    };
    const enter = (e: maplibregl.MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      if (!p.place) return;
      setHomeTip({
        x: e.point.x, y: e.point.y,
        place: String(p.place),
        candidates: Number(p.candidates || 0),
        dem: Number(p.dem || 0), rep: Number(p.rep || 0),
        other: Number(p.other || 0),
        raised: Number(p.raised || 0),
        po_box: Number(p.po_box || 0),
        names: String(p.names || ""),
      });
    };
    const leave = () => { map.getCanvas().style.cursor = ""; setHomeTip(null); };
    map.on("click", "home-dot", onClick);
    map.on("mousemove", "home-dot", enter);
    map.on("mouseleave", "home-dot", leave);
    return () => {
      map.off("click", "home-dot", onClick);
      map.off("mousemove", "home-dot", enter);
      map.off("mouseleave", "home-dot", leave);
    };
  }, [ready]);

  // One loop for every overlay — the registry owns which layers belong to
  // which toggle, so this never grows as layers are added.
  useEffect(() => {
    const map = mapRef.current;
    // getLayer is not a sufficient guard on its own: mid-swap it still returns
    // the OUTGOING style's layer while the style itself reports unloaded, and
    // setLayoutProperty then throws. styleEpoch re-runs this once the new
    // style is in place, so nothing is lost by skipping the attempt.
    if (!map || !ready || !map.isStyleLoaded()) return;
    for (const o of availableOverlays(capabilities)) {
      const v = overlays[o.id] ? "visible" : "none";
      for (const id of o.layerIds) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
      }
    }
  }, [overlays, capabilities, ready, styleEpoch]);

  // clicking a race circle opens that division
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      if (!p.ocd_id) return;
      const row = { ocd_id: p.ocd_id, name: p.name, state: p.state,
        margin: null, holders: undefined };
      setSelected(row);
      setDetail(row);
      setSheetOpen(true);
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", "race-dot", onClick);
    map.on("mouseenter", "race-dot", enter);
    map.on("mouseleave", "race-dot", leave);
    return () => {
      map.off("click", "race-dot", onClick);
      map.off("mouseenter", "race-dot", enter);
      map.off("mouseleave", "race-dot", leave);
    };
  }, [ready]);

  // ── who currently holds each seat ────────────────────────────────────────
  // Only the two federal chambers have an officeholder feed; president and
  // governor fall through to margins-only rather than showing a stale name.
  useEffect(() => {
    if (!hasHolderData) {
      setHolders(new Map());
      holdersRef.current = new Map();
      return;
    }
    let alive = true;
    apiService({ method: "get", url: `/us-election/officeholders?office=${office}` })
      .then((r) => {
        if (!alive) return;
        const list: Holder[] = r?.data?.data?.rows || [];
        const m = new Map<string, Holder[]>();
        for (const h of list) {
          const arr = m.get(h.ocd_id) || [];
          arr.push(h);
          m.set(h.ocd_id, arr);
        }
        setHolders(m);
        holdersRef.current = m;
        hasHolderRef.current = m.size > 0;
        refreshRows(levelRef.current);
      })
      .catch(() => { if (alive) setHolders(new Map()); });
    return () => { alive = false; };
  }, [office, hasHolderData, refreshRows]);

  // Margins per (level, office, year). Scrubbing and playback read from here
  // rather than refetching — animating eleven cycles over the network is
  // eleven round trips and visibly jerky, and the payloads are small enough
  // that holding them is cheaper than asking twice.
  const marginCacheRef = useRef<Map<string, MarginRow[]>>(new Map());
  const cutKey = useCallback(
    (y: number) => `${level}|${office}|${y}`, [level, office]);

  const fetchCut = useCallback(async (y: number): Promise<MarginRow[]> => {
    const k = cutKey(y);
    const hit = marginCacheRef.current.get(k);
    if (hit) return hit;
    const r = await apiService({
      method: "get",
      url: `/us-election/margins?level=${level}&office=${office}&year=${y}`,
    });
    const rows: MarginRow[] = (r as { data?: { data?: { rows?: MarginRow[] } } })
      ?.data?.data?.rows ?? [];
    marginCacheRef.current.set(k, rows);
    return rows;
  }, [cutKey, level, office]);

  /** Repaint the choropleth for one already-loaded cut. */
  const paintCut = useCallback((list: MarginRow[]) => {
    const map = mapRef.current;
    if (!map) return;
    // Clear the previous cut first, or a division missing from this year
    // keeps last year's colour — which during playback reads as a result
    // that never changed rather than one we do not have.
    for (const id of stateKeysRef.current) {
      map.removeFeatureState({ source: SOURCE_ID, sourceLayer: levelRef.current, id });
    }
    stateKeysRef.current = new Set();
    for (const row of list) {
      if (row.margin === null) continue;
      map.setFeatureState(
        { source: SOURCE_ID, sourceLayer: levelRef.current, id: row.ocd_id },
        { margin: row.margin },
      );
      stateKeysRef.current.add(row.ocd_id);
    }
    const m = new Map(list.map((x) => [x.ocd_id, x]));
    setMargins(m);
    marginsRef.current = m;
  }, []);

  // ── who ran, for the cut on screen ───────────────────────────────────────
  //
  // Cached per (level, office, year) exactly like the margins are, so dragging
  // the timeline across eleven cycles costs eleven requests once and nothing
  // afterwards. Failure is silent and leaves the map fully usable: the hover
  // simply omits the names section, which is also what happens for the cuts
  // that genuinely have no candidate rows (every county cut, and 31 of the 51
  // states for president 2024).
  const topCacheRef = useRef<Map<string, TopRow[]>>(new Map());
  useEffect(() => {
    if (!ready || !year) return;
    const k = `${level}|${office}|${year}`;
    const apply = (list: TopRow[]) =>
      setTopCandidates(new Map(list.map((r) => [r.ocd_id, r.top])));

    const hit = topCacheRef.current.get(k);
    if (hit) { apply(hit); return; }

    let alive = true;
    apiService({
      method: "get",
      url: `/us-election/top-candidates?level=${level}&office=${office}&year=${year}`,
    })
      .then((r) => {
        if (!alive) return;
        const list = (r as { data?: { data?: { rows?: TopRow[] } } })
          ?.data?.data?.rows ?? [];
        topCacheRef.current.set(k, list);
        apply(list);
      })
      .catch(() => { if (alive) setTopCandidates(new Map()); });
    return () => { alive = false; };
  }, [level, office, year, ready]);

  // ── fetch margins and push them in as feature state ──────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !year) return;
    let alive = true;
    setLoading(true);
    fetchCut(year)
      .then((list) => {
        if (!alive) return;
        paintCut(list);
        const m = new Map(list.map((x) => [x.ocd_id, x]));
        void m;
        refreshRows(level);
      })
      .catch(() => { if (alive) setMargins(new Map()); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [level, office, year, ready, refreshRows, styleEpoch]);

  // ── layer visibility ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    // `ready` is not enough. It stays true across a basemap swap, but
    // setStyle() tears the style down and rebuilds it, and every style mutation
    // throws "Style is not done loading" in the gap. Auto-level changes `level`
    // on zoom, so a reader who swaps basemap and keeps zooming lands in that
    // gap — and because this is a synchronous throw inside an effect, React
    // unmounts the whole tree into the error boundary. The page just dies.
    //
    // styleEpoch is what brings it back: it is bumped once the new style has
    // loaded, which re-runs this and applies the visibility that was skipped.
    if (!map || !ready || !map.isStyleLoaded()) return;
    for (const l of LEVELS) {
      const v = l.id === level ? "visible" : "none";
      // getLayer on every id, not just the label: a style swap can land here
      // with the fills rebuilt but a later layer still missing.
      for (const suffix of ["fill", "line", "label"]) {
        const id = `${l.id}-${suffix}`;
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
      }
    }
    setSelected(null);
    // Drop the hover readout too. Switching level unbinds the old layer's
    // handlers without firing mouseleave, so the tooltip would keep showing a
    // state while the map underneath had already become counties.
    setHoverInfo(null);
    hoverRef.current = null;
    map.once("idle", () => refreshRows(level));
  }, [level, ready, refreshRows, styleEpoch]);

  // paint the selected division so the map and the panel agree
  const selRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (selRef.current) {
      map.setFeatureState(
        { source: SOURCE_ID, sourceLayer: level, id: selRef.current },
        { selected: false },
      );
    }
    selRef.current = selected?.ocd_id ?? null;
    if (selRef.current) {
      map.setFeatureState(
        { source: SOURCE_ID, sourceLayer: level, id: selRef.current },
        { selected: true },
      );
    }
  }, [selected, level, ready]);

  // ── hover + click ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fill = `${level}-fill`;
    const clear = () => {
      if (hoverRef.current) {
        map.setFeatureState({ source: SOURCE_ID, sourceLayer: level, id: hoverRef.current }, { hover: false });
        hoverRef.current = null;
      }
    };
    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      const id = p.ocd_id;
      if (!id) return;
      const m = marginsRef.current.get(id);
      setHoverInfo({
        x: e.point.x, y: e.point.y,
        row: {
          ocd_id: id, name: p.name, state: p.state,
          margin: m ? m.margin : null, winner: m?.winner_party,
          holders: holdersRef.current.get(id),
        },
        total: m?.total,
        majorShare: m?.major_share,
        top: topCandidatesRef.current.get(id),
      });
      if (hoverRef.current === id) return;
      clear();
      hoverRef.current = id;
      map.setFeatureState({ source: SOURCE_ID, sourceLayer: level, id }, { hover: true });
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      clear();
      setHoverInfo(null);
      map.getCanvas().style.cursor = "";
    };
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const p = (e.features?.[0]?.properties || {}) as Record<string, string>;
      if (!p.ocd_id) return;
      const m = marginsRef.current.get(p.ocd_id);
      const row = { ocd_id: p.ocd_id, name: p.name, state: p.state,
        margin: m ? m.margin : null, winner: m?.winner_party,
        holders: holdersRef.current.get(p.ocd_id) };
      setSelected(row);
      setDetail(row);
      setSheetOpen(true);
    };
    map.on("mousemove", fill, onMove);
    map.on("mouseleave", fill, onLeave);
    map.on("click", fill, onClick);
    return () => {
      map.off("mousemove", fill, onMove);
      map.off("mouseleave", fill, onLeave);
      map.off("click", fill, onClick);
    };
  }, [level, ready]);

  // A reader usually remembers a name long before a district number, so the
  // same box that filters the viewport list also searches every candidate and
  // officeholder by name.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) { setPeople([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      apiService({ method: "get", url: `/us-election/search?q=${encodeURIComponent(q)}` })
        .then((r) => {
          const rows = (r as { data?: { data?: { rows?: typeof people } } })?.data?.data?.rows;
          if (alive) setPeople(rows ?? []);
        })
        .catch(() => { if (alive) setPeople([]); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  // Years ascending — a timeline reads left to right, and the picker's
  // newest-first order is wrong for a scrubber.
  const timeline = useMemo(() => [...years].sort((a, b) => a - b), [years]);

  /**
   * Play the cycles in order.
   *
   * Every cut is fetched up front. Stepping the year and letting the normal
   * effect fetch would put a network round trip inside the animation loop,
   * which stutters and — worse — lets frames arrive out of order, so the map
   * jumps backwards. Prefetch, then animate purely from memory.
   */
  const play = useCallback(async () => {
    if (playing || timeline.length < 2) return;
    setPrefetching(true);
    try {
      await Promise.all(timeline.map((y) => fetchCut(y)));
    } finally {
      setPrefetching(false);
    }
    setPlaying(true);
    let i = timeline.indexOf(year ?? timeline[0]);
    if (i < 0 || i >= timeline.length - 1) i = -1;   // restart from the beginning
    let last = 0;
    const STEP_MS = 900;
    const tick = (ts: number) => {
      if (!last) last = ts;
      if (ts - last >= STEP_MS) {
        last = ts;
        i += 1;
        if (i >= timeline.length) {
          setPlaying(false);
          playRef.current = null;
          return;
        }
        const y = timeline[i];
        setYear(y);
        const cached = marginCacheRef.current.get(cutKey(y));
        if (cached) paintCut(cached);
      }
      playRef.current = requestAnimationFrame(tick);
    };
    playRef.current = requestAnimationFrame(tick);
  }, [playing, timeline, year, fetchCut, cutKey, paintCut]);

  const stop = useCallback(() => {
    if (playRef.current) cancelAnimationFrame(playRef.current);
    playRef.current = null;
    setPlaying(false);
  }, []);

  // A level or office change invalidates the cut being animated.
  useEffect(() => { stop(); }, [level, office, stop]);
  useEffect(() => () => { if (playRef.current) cancelAnimationFrame(playRef.current); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.state.toLowerCase().includes(q));
  }, [rows, query]);

  const withData = useMemo(() => rows.filter((r) => r.margin != null).length, [rows]);

  // Seats in view facing voters at the next federal election. Derived from
  // term end dates, so it says which seats are contested — never who is
  // running, which would need a candidate filing feed.
  const nextBallot = useMemo(() => {
    const days = rows.flatMap((r) => r.holders?.map((h) => h.next_election) ?? [])
      .filter(Boolean).sort() as string[];
    const today = new Date().toISOString().slice(0, 10);
    return days.find((d) => d >= today) ?? null;
  }, [rows]);
  const upNext = useMemo(
    () => (nextBallot
      ? rows.filter((r) => r.holders?.some((h) => h.next_election === nextBallot)).length
      : 0),
    [rows, nextBallot],
  );

  const chip = (active: boolean) =>
    `rounded-[3px] border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] backdrop-blur transition-colors ${
      active
        ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.15)]"
        : "border-white/10 bg-slate-900/70 text-slate-400 hover:border-white/25 hover:text-slate-200"
    }`;

  const tbtn = (active: boolean) =>
    `flex h-8 w-8 items-center justify-center rounded-[4px] font-mono text-[11px] transition-colors ${
      active
        ? "bg-cyan-400/15 text-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.12)]"
        : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
    }`;

  const officeIcon = (id: string) => {
    switch (id) {
      case "president": return (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4"/></svg>
      );
      case "us_senate": return (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l9 4v2H3V7zM5 9v8M19 9v8M9 9v8M15 9v8M3 17h18v4H3z"/></svg>
      );
      case "us_house": return (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21H7a2 2 0 01-2-2V9l7-6 7 6v10a2 2 0 01-2 2zM9 21v-6h6v6"/></svg>
      );
      case "governor": return (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M3 9h18"/></svg>
      );
      default: return null;
    }
  };

  const marginPill = (m: number | null | undefined) => {
    if (m == null) return "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400";
    return m > 0 ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                 : "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  };

  return (
    <div ref={shellRef}
      style={shellH ? { height: shellH } : undefined}
      /* The collapsed sheet is max-h-14 and sits at bottom-0, which is exactly
         where MapLibre parks the attribution — so on a phone the Census and
         OpenElections credit was half-hidden behind it. Lift the control group
         clear of the sheet on narrow viewports; the desktop panel is a side
         panel and leaves the corner alone. */
      className="relative min-h-[26rem] w-full overflow-hidden bg-slate-950 [&_.maplibregl-ctrl-bottom-right]:bottom-14 md:[&_.maplibregl-ctrl-bottom-right]:bottom-0 dark:bg-slate-950">
      <div ref={containerRef} className="h-full w-full" />

      {/* Console furniture. Sits above the canvas and below the panels, and is
          pointer-events-none except where it is actually interactive. */}
      <ChromeHeader />
      <ChromeFooter
        cursor={cursor}
        zoom={zoom}
        level={level}
        year={year}
        inView={rows.length}
      />

      {/* Vignette: pulls the eye to the globe and stops the dark basemap
          reading as a flat rectangle of nothing at the corners. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[5]"
        style={{ background: "radial-gradient(ellipse at 42% 45%, transparent 38%, rgba(2,6,23,0.55) 100%)" }}
      />

      {/* ── controls ─────────────────────────────────────────────────── */}

      {/* Office selector — horizontal row, always visible */}
      <div className="pointer-events-auto absolute left-4 top-12 z-20 flex items-center gap-1">
        {OFFICES.map((o) => (
          <button
            key={o.id}
            onClick={() => setOffice(o.id)}
            title={o.label}
            className={`flex items-center gap-1.5 rounded-[4px] border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] backdrop-blur transition-colors ${
              office === o.id
                ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.15)]"
                : "border-white/10 bg-slate-900/80 text-slate-500 hover:border-white/25 hover:text-slate-200"
            }`}
          >
            {officeIcon(o.id)}
            <span className="hidden md:inline">{o.label}</span>
          </button>
        ))}
        {years.length > 0 && (
          <select
            value={year ?? ""}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label="Election year"
            className="ml-1 rounded-[4px] border border-white/10 bg-slate-900/80 px-2 py-1.5 font-mono text-[10px] tabular-nums uppercase tracking-wider text-slate-300 backdrop-blur outline-none"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}{yearCounts.get(y) ? ` · ${yearCounts.get(y)}` : ""}
              </option>
            ))}
          </select>
        )}
        {/* mobile toggle for the sidebar tools */}
        <button
          onClick={() => setToolsOpen((o) => !o)}
          aria-expanded={toolsOpen}
          className={`md:hidden ${tbtn(toolsOpen)} !h-auto !w-auto rounded-[4px] border border-white/10 bg-slate-900/80 px-2 py-1.5 backdrop-blur`}
          title="Toggle controls"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>

      {/* Vertical toolbar — grouped icon buttons */}
      <div className={`pointer-events-auto absolute left-4 top-[5.5rem] z-20 ${toolsOpen ? "flex" : "hidden"} flex-col md:flex`}>
        <div className="flex flex-col rounded-lg border border-white/10 bg-slate-900/80 backdrop-blur">
          {/* basemap group */}
          <div className="flex flex-col items-center gap-0.5 p-1" role="group" aria-label="Basemap">
            {BASEMAPS.map((bm) => (
              <button
                key={bm.id}
                onClick={() => setBasemap(bm.id)}
                title={`Basemap: ${bm.label}`}
                className={tbtn(basemap === bm.id)}
              >
                {bm.id === "light" && (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
                )}
                {bm.id === "dark" && (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>
                )}
                {bm.id === "satellite" && (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                )}
              </button>
            ))}
          </div>

          <div className="mx-2 border-t border-white/5" />

          {/* projection toggle */}
          <div className="flex flex-col items-center p-1" role="group" aria-label="Projection">
            <button
              onClick={() => setProjection((p) => (p === "globe" ? "mercator" : "globe"))}
              title={projection === "globe" ? "Switch to flat map" : "Switch to globe"}
              className={tbtn(projection === "globe")}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"/>
                <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/>
              </svg>
            </button>
          </div>

          {availableOverlays(capabilities).length > 0 && (
            <>
              <div className="mx-2 border-t border-white/5" />

              {/* overlay toggles */}
              <div className="flex flex-col items-center gap-0.5 p-1" role="group" aria-label="Overlays">
                {availableOverlays(capabilities).map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setOverlays((s) => ({ ...s, [o.id]: !s[o.id] }))}
                    title={`${o.label}: ${o.hint}`}
                    className={tbtn(overlays[o.id])}
                  >
                    {o.id === "races" && (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    )}
                    {o.id === "news" && (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16a2 2 0 002-2V4a2 2 0 00-2-2H8a2 2 0 00-2 2v16a2 2 0 01-2 2zm0 0a2 2 0 01-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M18 18h-8M18 10h-8"/></svg>
                    )}
                    {o.id === "homes" && (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12l9-9 9 9"/><path d="M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10"/></svg>
                    )}
                    {o.id === "polls" && (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="mx-2 border-t border-white/5" />

          {/* level selector */}
          <div className="flex flex-col items-center gap-0.5 p-1" role="group" aria-label="Detail level">
            <button
              onClick={() => setAutoLevel(true)}
              title="Auto: let zoom choose the level"
              className={tbtn(autoLevel)}
            >
              <span className="text-[10px] font-bold">A</span>
            </button>
            {allowedLevels.map((l) => (
              <button
                key={l.id}
                onClick={() => { setAutoLevel(false); setLevel(l.id); }}
                title={l.label}
                className={tbtn(!autoLevel && level === l.id)}
              >
                <span className="text-[9px] font-bold">{l.short.slice(0, 3).toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* hover readout — pointer-events-none so it never blocks the map */}
      {hoverInfo && (
        <div
          className="pointer-events-none absolute z-30 hidden w-[18rem] rounded-lg border border-cyan-500/20 bg-slate-950/95 shadow-2xl backdrop-blur md:block"
          style={{
            left: Math.min(hoverInfo.x + 14, (containerRef.current?.clientWidth ?? 0) - 310),
            top: Math.max(8, hoverInfo.y - 10),
          }}
        >
          {/* header: name + margin */}
          <div className="flex items-baseline justify-between gap-3 px-3 pt-2.5 pb-1.5">
            <span className="truncate font-mono text-xs font-semibold tracking-wide text-slate-100">
              {hoverInfo.row.name}
            </span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${marginPill(hoverInfo.row.margin)}`}>
              {marginLabel(hoverInfo.row.margin)}
            </span>
          </div>
          <div className="px-3 pb-2 font-mono text-[10px] text-slate-500">
            {hoverInfo.row.state}
            {hoverInfo.row.margin != null && ` · ${year} ${officeMeta.label.toLowerCase()}`}
            {hoverInfo.row.winner && (
              <span className="ml-1.5 inline-flex items-center gap-1">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                  hoverInfo.row.winner === "DEM" ? "bg-blue-500"
                    : hoverInfo.row.winner === "REP" ? "bg-red-500" : "bg-slate-400"
                }`} />
                <span className="text-slate-400">{hoverInfo.row.winner}</span>
              </span>
            )}
          </div>

          {/* turnout */}
          {hoverInfo.total != null && hoverInfo.total > 0 && (
            <>
              <div className="mx-3 border-t border-white/5" />
              <div className="flex items-center justify-between px-3 py-1.5 font-mono text-[10px] text-slate-400">
                <span>
                  <span className="tabular-nums text-slate-200">{hoverInfo.total.toLocaleString()}</span> votes
                </span>
                {hoverInfo.majorShare != null && (
                  <span>
                    major-party <span className="tabular-nums text-cyan-300">{(hoverInfo.majorShare * 100).toFixed(1)}%</span>
                  </span>
                )}
              </div>
            </>
          )}

          {/* who ran — names from /top-candidates, share from the margin row */}
          {hoverInfo.top?.length ? (
            <>
              <div className="mx-3 border-t border-white/5" />
              <div className="space-y-1 px-3 py-2">
                {hoverInfo.top.map((c) => {
                  // The share is derived from the SAME margin row the pill
                  // above reads, joined on party, so the two can never
                  // disagree. Where the margin row has no entry for this
                  // party the share is simply omitted — an empty slot is
                  // honest, an invented number is not.
                  //
                  // DEM and REP only. The margin row's OTH bucket is every
                  // minor candidate summed together, so printing it beside
                  // one name would credit Jill Stein with Chase Oliver's and
                  // Cornel West's votes as well. A named third-party finisher
                  // is shown without a share rather than with a wrong one.
                  const twoParty = c.party === "DEM" || c.party === "REP";
                  const votes = twoParty && hoverInfo.total && hoverInfo.total > 0
                    ? marginsRef.current.get(hoverInfo.row.ocd_id)?.votes?.[c.party]
                    : undefined;
                  const share = votes != null && hoverInfo.total
                    ? (votes / hoverInfo.total) * 100
                    : null;
                  return (
                    <div key={`${c.party}-${c.name}`} className="flex items-center gap-2">
                      <Portrait src={c.photo} name={c.name} party={c.party} size={20} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-200">
                        {c.name}
                        {c.sitting && (
                          <span className="ml-1 text-amber-400" title="Sitting member">★</span>
                        )}
                      </span>
                      <span className={`shrink-0 font-mono text-[10px] font-bold ${
                        c.party === "DEM" ? "text-blue-400"
                          : c.party === "REP" ? "text-red-400" : "text-slate-400"
                      }`}>
                        {c.party === "DEM" ? "D" : c.party === "REP" ? "R" : "O"}
                      </span>
                      {share != null && (
                        <span className="w-11 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-300">
                          {share.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* incumbents */}
          {hoverInfo.row.holders?.length ? (
            <>
              <div className="mx-3 border-t border-white/5" />
              <div className="space-y-1 px-3 py-2">
                {hoverInfo.row.holders.map((h) => (
                  <div key={h.bioguide || h.name} className="flex items-center gap-2">
                    <Portrait src={h.photo} name={h.name} party={h.party} size={22} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[11px] font-medium text-slate-200">
                          {h.name}
                        </span>
                        <span className={`shrink-0 rounded px-1 py-px font-mono text-[8px] font-bold tracking-wide ${
                          h.party === "Democratic" ? "bg-blue-900/60 text-blue-300"
                            : h.party === "Republican" ? "bg-red-900/60 text-red-300" : "bg-slate-800 text-slate-400"
                        }`}>
                          {h.party === "Democratic" ? "D" : h.party === "Republican" ? "R" : h.party?.charAt(0) ?? ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[9px] text-slate-500">
                        <span className="inline-flex items-center gap-0.5 text-cyan-400/80">
                          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="currentColor">
                            <path d="M6 1l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6 8.8 3 10.4l.6-3.4L1.1 4.6l3.4-.5z"/>
                          </svg>
                          INCUMBENT
                        </span>
                        {h.next_election && (
                          <span>next: <span className="text-slate-400">{h.next_election.slice(0, 4)}</span></span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <div className="border-t border-white/5 px-3 py-1.5 font-mono text-[9px] tracking-wide text-slate-600">
            CLICK FOR DETAIL
          </div>
        </div>
      )}

      {/* coverage readout */}
      {/* polling place readout — carries the aerial view of the building */}
      {pollTip && (
        <div
          className="pointer-events-none absolute z-30 hidden w-[17rem] overflow-hidden rounded-lg border border-amber-700/40 bg-white/95 shadow-lg backdrop-blur md:block dark:bg-slate-900/95"
          style={{
            left: Math.min(pollTip.x + 14, (containerRef.current?.clientWidth ?? 0) - 300),
            top: Math.max(8, pollTip.y - 10),
          }}
        >
          <img
            src={`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/${
              Math.floor((1 - Math.asinh(Math.tan(pollTip.lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** 18)
            }/${Math.floor(((pollTip.lng + 180) / 360) * 2 ** 18)}`}
            alt=""
            loading="lazy"
            className="h-28 w-full bg-slate-200 object-cover dark:bg-slate-800"
          />
          <div className="px-2.5 py-2">
            <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
              {pollTip.name}
            </div>
            {pollTip.address && (
              <div className="mt-0.5 line-clamp-2 text-[10px] text-slate-600 dark:text-slate-300">
                {pollTip.address}
              </div>
            )}
            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
              <span>
                {pollTip.year}
                {pollTip.kind ? ` · ${pollTip.kind.replace(/_/g, " ")}` : ""}
              </span>
              {/* An interpolated point sits somewhere along the street, not on
                  the building. Say so rather than implying rooftop accuracy. */}
              <span className={pollTip.exact ? "text-emerald-600" : "text-amber-600"}>
                {pollTip.exact ? "exact" : "approx. location"}
              </span>
            </div>
            <div className="mt-1 text-[9px] leading-relaxed text-slate-400">
              Where a booth stood in {pollTip.year} — not a current voting location.
              Imagery: Esri.
            </div>
          </div>
        </div>
      )}

      {newsTip && (
        <div
          className="pointer-events-none absolute z-30 hidden max-w-[19rem] rounded-lg border border-amber-500/40 bg-white/95 px-2.5 py-2 shadow-lg backdrop-blur md:block dark:bg-slate-900/95"
          style={{
            left: Math.min(newsTip.x + 14, (containerRef.current?.clientWidth ?? 0) - 320),
            top: Math.max(8, newsTip.y - 10),
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-xs font-semibold text-slate-900 dark:text-white">
              {newsTip.name}
            </span>
            <span className="shrink-0 rounded bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-300">
              {newsTip.articles} {newsTip.articles === 1 ? "story" : "stories"}
            </span>
          </div>
          {newsTip.headline && (
            <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-600 dark:text-slate-300">
              {newsTip.headline}
            </p>
          )}
          <div className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
            {newsTip.people}
          </div>
          {/* Lean is stated, never coloured — see usElectionMap for why. */}
          <div className="mt-0.5 text-[10px] italic text-amber-700 dark:text-amber-500">
            {tiltLabel(newsTip.tilt)}
          </div>
        </div>
      )}

      {/* home-town readout */}
      {homeTip && (
        <div
          className="pointer-events-none absolute z-30 hidden max-w-[19rem] rounded-lg border border-teal-500/40 bg-white/95 px-2.5 py-2 shadow-lg backdrop-blur md:block dark:bg-slate-900/95"
          style={{
            left: Math.min(homeTip.x + 14, (containerRef.current?.clientWidth ?? 0) - 320),
            top: Math.max(8, homeTip.y - 10),
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-xs font-semibold text-slate-900 dark:text-white">
              {homeTip.place}
            </span>
            <span className="shrink-0 rounded bg-teal-100 px-1.5 text-[10px] font-semibold text-teal-900 dark:bg-teal-950 dark:text-teal-300">
              {homeTip.candidates} {homeTip.candidates === 1 ? "candidate" : "candidates"}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-slate-600 dark:text-slate-300">
            {partyMixLabel(homeTip.dem, homeTip.rep, homeTip.other)}
            {homeTip.raised > 0 && ` · ${moneyLabel(homeTip.raised)} raised`}
          </div>
          <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
            {homeTip.names}
          </div>
          {/* The claim is the filing address, and where we can see it is a box
              we say so rather than implying a doorstep. */}
          <div className="mt-0.5 text-[10px] italic text-teal-700 dark:text-teal-500">
            {homeTip.po_box > 0
              ? `address on the FEC filing · ${homeTip.po_box} PO box${homeTip.po_box === 1 ? "" : "es"}`
              : "address on the FEC filing"}
          </div>
        </div>
      )}

      {/* ask */}
      <button
        onClick={() => {
          setChatOpen(true);
          setSheetOpen(true);
          // The page scrolls below the map on phones; without this the sheet
          // opens off-screen and the reader lands in the site footer.
          requestAnimationFrame(() =>
            containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}
        className="absolute bottom-10 right-3 z-30 flex items-center gap-1.5 rounded-[3px] border border-cyan-400/50 bg-cyan-400/10 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200 backdrop-blur transition-colors hover:bg-cyan-400/20 md:bottom-auto md:right-[24rem] md:top-12"
      >
        Ask
      </button>

      {/* timeline scrubber */}
      {timeline.length > 1 && (
        <div className="pointer-events-auto absolute bottom-9 left-1/2 z-20 hidden w-[min(34rem,calc(100%-24rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-black/10 bg-white/95 px-3 py-2 shadow-lg backdrop-blur md:flex dark:border-white/15 dark:bg-slate-900/95">
          <button
            onClick={() => (playing ? stop() : play())}
            disabled={prefetching}
            title={playing ? "Pause" : "Play the cycles in order"}
            className="shrink-0 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
          >
            {prefetching ? "…" : playing ? "❚❚" : "▶"}
          </button>
          <input
            type="range"
            min={0}
            max={timeline.length - 1}
            step={1}
            value={Math.max(0, timeline.indexOf(year ?? timeline[0]))}
            onChange={(e) => { stop(); setYear(timeline[Number(e.target.value)]); }}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-slate-900 dark:accent-white"
          />
          <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-700 dark:text-slate-200">
            <span className="font-semibold">{year ?? "—"}</span>
            <span className="ml-1 text-[10px] text-slate-400">
              {yearCounts.get(year ?? 0) ?? 0}
            </span>
          </span>
        </div>
      )}

      {/* legend */}
      <div className="pointer-events-none absolute bottom-9 left-3 z-20 rounded-lg border border-black/10 bg-white/90 px-3 py-2 text-[10px] shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/90">
        <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">Margin</div>
        <div className="flex items-center gap-1">
          <span className="text-blue-700 dark:text-blue-400">D+40</span>
          <span className="h-2.5 w-28 rounded-sm" style={{
            background: `linear-gradient(to right, ${MARGIN_STOPS.map(([, c]) => c).join(",")})`,
          }} />
          <span className="text-red-700 dark:text-red-400">R+40</span>
        </div>
      </div>

      {outOfBand && ready && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded-full bg-amber-500/95 px-3.5 py-1.5 text-xs font-medium text-amber-950 shadow-lg">
          {zoom < levelMeta.minzoom ? `Zoom in for ${levelMeta.label.toLowerCase()}` : `Zoom out for ${levelMeta.label.toLowerCase()}`}
        </div>
      )}

      {/* viewport panel */}
      <div className={`absolute z-20 flex flex-col overflow-hidden border-black/10 bg-white/95 shadow-2xl backdrop-blur dark:border-white/10 dark:bg-slate-900/95
        inset-x-0 bottom-0 rounded-t-2xl border-t transition-[max-height] duration-300
        md:bottom-8 md:top-11 md:right-3 md:left-auto md:w-[22rem] md:rounded-xl md:border
        ${chatOpen ? "max-h-[88%] md:max-h-none"
          : sheetOpen ? "max-h-[55%] md:max-h-none"
            : "max-h-14 md:max-h-none"}`}>
        {cand ? (
          <CandidateDetail
            fecId={cand.fecId}
            name={cand.name}
            ocdId={detail?.ocd_id}
            onBack={() => setCand(null)}
            onOpen={(fecId) => setCand({ fecId, name: "" })}
          />
        ) : homePlace ? (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <button
                onClick={() => setHomePlace(null)}
                className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                ← Back
              </button>
              <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                {homePlace.place}
              </span>
            </div>
            <p className="px-3 pt-2 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
              {homePlace.who.length} federal {homePlace.who.length === 1 ? "candidate files" : "candidates file"} from
              here for 2026. This is the address on the FEC filing — usually home,
              sometimes a PO box or a campaign office, and never verified by the FEC.
              {homePlace.po_box > 0 && ` ${homePlace.po_box} of these are PO boxes.`}
            </p>
            <div className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
              {homePlace.who.map((w) => (
                <button
                  key={w.fec_id}
                  onClick={() => setCand({ fecId: w.fec_id, name: w.name })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    w.party === "DEM" ? "bg-blue-600"
                      : w.party === "REP" ? "bg-red-600" : "bg-slate-400"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-slate-900 dark:text-white">
                      {w.name}
                    </span>
                    <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">
                      {w.office === "us_house"
                        ? `U.S. House${w.district ? ` · district ${w.district}` : ""}`
                        : w.office === "us_senate" ? "U.S. Senate" : "President"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                    {moneyLabel(w.receipts)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : chatOpen ? (
          <ElectionChat
            ocdId={detail?.ocd_id}
            placeName={detail?.name}
            onBack={() => setChatOpen(false)}
          />
        ) : person ? (
          <PersonDetail person={person} onBack={() => setPerson(null)} />
        ) : detail ? (
          <DivisionDetail
            ocdId={detail.ocd_id}
            name={detail.name}
            onBack={() => { setDetail(null); setPerson(null); }}
            onSelectPerson={setPerson}
            onSelectCandidate={setCand}
          />
        ) : (
          <>
          <button className="flex shrink-0 items-center justify-between px-4 py-3 text-left md:cursor-default"
            onClick={() => setSheetOpen((v) => !v)}>
            <span>
              <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                {filtered.length.toLocaleString()} {levelMeta.label.toLowerCase()} in view
              </span>
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                {loading ? "loading results…"
                  : withData > 0 ? `${withData.toLocaleString()} with ${year} results · closest first`
                  : `no ${year ?? ""} results at this level`}
              </span>
              {upNext > 0 && (
                <span className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  {upNext.toLocaleString()} on the {nextBallot} ballot
                </span>
              )}
            </span>
            <span className="text-slate-400 md:hidden">{sheetOpen ? "▾" : "▴"}</span>
          </button>
  
          <div className="shrink-0 px-3 pb-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a candidate, or filter this list…"
              className="w-full rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-500 dark:border-white/10 dark:bg-slate-800 dark:text-slate-100" />
          </div>
  
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {people.length > 0 && (
              <div className="mb-2 rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800/60">
                <p className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  People matching “{query.trim()}”
                </p>
                {people.slice(0, 8).map((pp) => (
                  <button key={`${pp.kind}-${pp.name}-${pp.fec_id ?? ""}`}
                    onClick={() => setCand({ fecId: pp.fec_id, name: pp.name })}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-white dark:hover:bg-slate-900">
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-slate-800 dark:text-slate-100">{pp.name}</span>
                      <span className="block truncate text-[10px] text-slate-500">
                        {pp.party} · {pp.state ?? ""}{pp.district ? `-${pp.district}` : ""} · {pp.kind}
                      </span>
                    </span>
                    <span className="shrink-0 text-slate-300">›</span>
                  </button>
                ))}
              </div>
            )}
            {!ready && <p className="px-2 py-6 text-center text-xs text-slate-500">Loading map…</p>}
            {ready && filtered.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-slate-500">Nothing in view at this zoom.</p>
            )}
            {filtered.slice(0, 300).map((r) => (
              <button key={r.ocd_id} onClick={() => { setSelected(r); setDetail(r); }}
                className={`mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                  selected?.ocd_id === r.ocd_id ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "hover:bg-slate-100 dark:hover:bg-slate-800"}`}>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{r.name}</span>
                  {r.holders?.length === 0 ? (
                    <span className="block truncate text-[10px] italic text-amber-700 dark:text-amber-500">
                      seat vacant
                    </span>
                  ) : r.holders?.length ? (
                    <span className={`block truncate text-[10px] ${
                      selected?.ocd_id === r.ocd_id ? "opacity-80" : "text-slate-500 dark:text-slate-400"}`}>
                      {r.holders.map((h) => (
                        <span key={h.bioguide || h.name}
                          className="mr-1.5 inline-flex items-center gap-1 whitespace-nowrap align-middle">
                          <Portrait src={h.photo} name={h.name} party={h.party} size={16} />
                          {h.name}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className={`block truncate font-mono text-[10px] ${
                      selected?.ocd_id === r.ocd_id ? "opacity-70" : "text-slate-400 dark:text-slate-500"}`}>
                      {r.ocd_id.replace("ocd-division/country:us/", "")}
                    </span>
                  )}
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${marginPill(r.margin)}`}>
                  {marginLabel(r.margin)}
                </span>
              </button>
            ))}
            {filtered.length > 300 && (
              <p className="px-3 py-2 text-[11px] text-slate-400">
                +{(filtered.length - 300).toLocaleString()} more — zoom in to narrow
              </p>
            )}
          </div>
  
          <p className="shrink-0 border-t border-black/5 px-4 py-2 text-[10px] leading-relaxed text-slate-500 dark:border-white/5 dark:text-slate-400">
            Certified results via OpenElections. Contests with thin party labelling
            are left unpainted rather than shown with an unreliable margin.
          </p>
          </>
        )}
      </div>
    </div>
  );
}
