/**
 * A stand-in for maplibre-gl in jsdom, which has no WebGL to draw a map with. tests/setup.ts puts it
 * in place of the library for every test, so no test loads the real one or reaches a tile server.
 *
 * It keeps what the app asks of the map (its options, its sources and layers, the colours it sets,
 * where it is moved to) and lets a test play the map's part: fire its events, say which features a
 * source has on screen, and where the map is looking. Nothing is drawn.
 */
import type { FeatureCollection, Point } from "geojson";
import { vi } from "vitest";

import { DARK_STYLE_URL } from "../../src/map/style";

type Handler = (event: Record<string, unknown>) => void;

/** A feature as `querySourceFeatures` gives it: a point and its properties. */
export interface FakeFeature {
  type: "Feature";
  geometry: Point;
  properties: Record<string, unknown>;
}

export interface FakeBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * A layer of the style, as `getLayer` returns it: its id, its type, the layer of the tiles it draws
 * (its `source-layer`: `transportation`, `building`, `place`...), and its paint as the style gives it
 * and `setPaintProperty` leaves it.
 */
export interface FakeLayer {
  id: string;
  type: string;
  sourceLayer?: string;
  paint?: Record<string, unknown>;
}

/**
 * The layers OpenFreeMap's Positron has (as fetched on 2026-10-16), in its order, as the map reports
 * them once that style has loaded: its land, parks and water, its buildings, some of its roads and
 * railways, labels, and lines and areas of other kinds (a border, a runway, a pier), with their own
 * colours. A test can take some away to see that a missing one is no harm.
 */
export const POSITRON_LAYERS: readonly FakeLayer[] = [
  { id: "background", type: "background", paint: { "background-color": "rgb(242,243,240)" } },
  { id: "park", type: "fill", sourceLayer: "park", paint: { "fill-color": "rgb(230, 233, 229)" } },
  { id: "water", type: "fill", sourceLayer: "water", paint: { "fill-color": "rgb(194, 200, 202)" } },
  { id: "landuse_residential", type: "fill", sourceLayer: "landuse", paint: { "fill-color": "rgb(234, 234, 230)", "fill-opacity": 0.6 } },
  {
    id: "landcover_wood",
    type: "fill",
    sourceLayer: "landcover",
    paint: { "fill-color": "rgb(220,224,220)", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 12, 1] },
  },
  { id: "waterway", type: "line", sourceLayer: "waterway", paint: { "line-color": "hsl(195,17%,78%)" } },
  { id: "building", type: "fill", sourceLayer: "building", paint: { "fill-color": "rgb(234, 234, 229)" } },
  { id: "aeroway-runway", type: "line", sourceLayer: "aeroway", paint: { "line-color": "rgba(255, 255, 255, 1)" } },
  { id: "road_area_pier", type: "fill", sourceLayer: "transportation", paint: { "fill-color": "rgb(242,243,240)" } },
  { id: "highway_minor", type: "line", sourceLayer: "transportation", paint: { "line-color": "hsl(0,0%,88%)" } },
  {
    id: "highway_major_casing",
    type: "line",
    sourceLayer: "transportation",
    paint: { "line-color": "rgb(213, 213, 213)", "line-dasharray": [12, 0] },
  },
  { id: "highway_major_inner", type: "line", sourceLayer: "transportation", paint: { "line-color": "#fff" } },
  { id: "railway", type: "line", sourceLayer: "transportation", paint: { "line-color": "#dddddd" } },
  { id: "boundary_2", type: "line", sourceLayer: "boundary", paint: { "line-color": "hsl(0,0%,70%)" } },
  { id: "water_name_point_label", type: "symbol", sourceLayer: "water_name", paint: { "text-color": "#495e91" } },
  { id: "highway-name-minor", type: "symbol", sourceLayer: "transportation_name", paint: { "text-color": "#666" } },
  { id: "label_city", type: "symbol", sourceLayer: "place", paint: { "text-color": "#000", "text-halo-color": "#fff" } },
];

/**
 * The layers of OpenFreeMap's Dark (as fetched on 2026-10-16), the same way. Its parks are another
 * layer than Positron's, and its wood is drawn with a pattern, which is drawn in place of a colour,
 * and at most 80% opaque. Its roads, piers, buildings and labels are near black and dim grey. Both
 * styles draw a major road's casing in dashes with no gaps (`[12, 0]`); Dark's paths are dashed.
 */
export const DARK_LAYERS: readonly FakeLayer[] = [
  { id: "background", type: "background", paint: { "background-color": "rgb(12,12,12)" } },
  { id: "water", type: "fill", sourceLayer: "water", paint: { "fill-color": "rgb(27 ,27 ,29)" } },
  { id: "landuse_residential", type: "fill", sourceLayer: "landuse", paint: { "fill-color": "hsl(0,2%,5%)", "fill-opacity": 0.4 } },
  {
    id: "landcover_wood",
    type: "fill",
    sourceLayer: "landcover",
    paint: {
      "fill-color": "rgb(32,32,32)",
      "fill-opacity": ["interpolate", ["exponential", 0.3], ["zoom"], 8, 0, 10, 0.8, 13, 0.4],
      "fill-pattern": "wood-pattern",
    },
  },
  { id: "landuse_park", type: "fill", sourceLayer: "landuse", paint: { "fill-color": "rgb(32,32,32)" } },
  { id: "waterway", type: "line", sourceLayer: "waterway", paint: { "line-color": "rgb(27 ,27 ,29)" } },
  { id: "water_name", type: "symbol", sourceLayer: "water_name", paint: { "text-color": "hsla(0,0%,0%,0.7)", "text-halo-color": "hsl(0,0%,27%)" } },
  { id: "building", type: "fill", sourceLayer: "building", paint: { "fill-color": "rgb(10,10,10)" } },
  { id: "road_area_pier", type: "fill", sourceLayer: "transportation", paint: { "fill-color": "rgb(12,12,12)" } },
  { id: "highway_path", type: "line", sourceLayer: "transportation", paint: { "line-color": "rgb(27 ,27 ,29)", "line-dasharray": [1.5, 1.5] } },
  { id: "highway_minor", type: "line", sourceLayer: "transportation", paint: { "line-color": "#181818" } },
  {
    id: "highway_major_casing",
    type: "line",
    sourceLayer: "transportation",
    paint: { "line-color": "rgba(60,60,60,0.8)", "line-dasharray": [12, 0] },
  },
  { id: "highway_major_inner", type: "line", sourceLayer: "transportation", paint: { "line-color": "hsl(0,0%,7%)" } },
  { id: "road_oneway", type: "symbol", sourceLayer: "transportation" },
  { id: "railway", type: "line", sourceLayer: "transportation", paint: { "line-color": "rgb(35,35,35)" } },
  { id: "highway_name_other", type: "symbol", sourceLayer: "transportation_name", paint: { "text-color": "rgba(80, 78, 78, 1)" } },
  { id: "boundary_state", type: "line", sourceLayer: "boundary", paint: { "line-color": "hsl(0,0%,21%)" } },
  { id: "place_city", type: "symbol", sourceLayer: "place", paint: { "text-color": "rgb(101,101,101)", "text-halo-color": "rgba(0,0,0,0.7)" } },
];

/** The layers of the style at `url`, once it has loaded: Dark's for the dark style, Positron's for any other. */
export const openFreeMapLayers = (url: string): readonly FakeLayer[] => (url === DARK_STYLE_URL ? DARK_LAYERS : POSITRON_LAYERS);

export class FakeSource {
  data: FeatureCollection;
  constructor(
    readonly map: FakeMap,
    readonly spec: Record<string, unknown>,
  ) {
    this.data = spec.data as FeatureCollection;
  }
  setData = vi.fn((data: FeatureCollection) => {
    this.data = data;
    this.map.renderSoon();
    return this;
  });
  /** What zoom a cluster opens up at; a test can change the answer. */
  getClusterExpansionZoom = vi.fn(async (_clusterId: number) => 16);
}

export class FakeMap {
  /** Every map made, in order; tests/setup.ts empties it after each test. */
  static instances: FakeMap[] = [];
  /** The layers a style fetched by its address has; tests/setup.ts puts it back after each test. */
  static styleLayers: (url: string) => readonly FakeLayer[] = openFreeMapLayers;
  /**
   * How far the next map gets by itself: its style and then its first tiles (`all`), its style and
   * no tiles yet (`style`), or nothing, for a test to fire what it wants (`none`).
   */
  static arrives: "all" | "style" | "none" = "all";

  readonly options: Record<string, unknown>;
  readonly container: HTMLElement;
  readonly handlers = new Map<string, Set<Handler>>();
  readonly sources = new Map<string, FakeSource>();
  readonly addedLayers: Record<string, unknown>[] = [];
  /** The layers of the style it has now: OpenFreeMap's for a style fetched by its address, none for one given whole. */
  layers: Map<string, FakeLayer>;
  removed = false;
  bounds: FakeBounds = { west: -16.95, south: 32.62, east: -16.87, north: 32.68 };
  /** Where the map looks and how far in, as the app's moves and the person's leave them. */
  center: [number, number];
  zoom: number;
  /** MapLibre's canvas: focusable when the map is, and named by the map's label. */
  readonly canvas: HTMLCanvasElement;
  /** The features `querySourceFeatures` gives; undefined: every point of the source's data, none clustered. */
  features: FakeFeature[] | undefined;
  /** MapLibre's two-finger handler: whether the app turned its rotation off. */
  readonly touchZoomRotate = { disableRotation: vi.fn() };
  /** MapLibre's keyboard handler: whether the app turned its turning and tilting (Shift and the arrows) off. */
  readonly keyboard = { disableRotation: vi.fn() };

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.container = options.container as HTMLElement;
    // A map made to show a box (`bounds`) looks at its middle; the fake has no size to work out a zoom from.
    const bounds = options.bounds as [number, number, number, number] | undefined;
    this.center =
      bounds === undefined
        ? ((options.center as [number, number] | undefined) ?? [0, 0])
        : [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    this.zoom = (options.zoom as number | undefined) ?? 0;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = options.interactive === false ? -1 : 0;
    this.canvas.setAttribute("role", "region");
    this.canvas.setAttribute("aria-label", (options.locale as Record<string, string> | undefined)?.["Map.Title"] ?? "Map");
    this.container.append(this.canvas);
    this.layers = FakeMap.layersOf(options.style);
    FakeMap.instances.push(this);
    // The style arrives a moment later, as it does over the network, and then the first tiles.
    const arrives = FakeMap.arrives;
    queueMicrotask(() => {
      if (this.removed || arrives === "none") return;
      this.fire("style.load");
      this.fire("render");
      if (arrives === "all") this.fire("load");
    });
  }

  on(type: string, handler: Handler) {
    let set = this.handlers.get(type);
    if (set === undefined) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return this;
  }
  off(type: string, handler: Handler) {
    this.handlers.get(type)?.delete(handler);
    return this;
  }
  /** Plays the map's part: tells every listener of `type`. */
  fire(type: string, event: Record<string, unknown> = {}) {
    if (this.removed) return this;
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler({ type, target: this, ...event });
    return this;
  }
  /** The map draws again a moment after its data changes. */
  renderSoon() {
    queueMicrotask(() => this.fire("render"));
  }

  /** The layers a style has once it has loaded, each a copy of its own, for the map to change. */
  private static layersOf(style: unknown): Map<string, FakeLayer> {
    const layers = typeof style === "string" ? FakeMap.styleLayers(style) : [];
    return new Map(layers.map((layer) => [layer.id, { ...layer, paint: { ...layer.paint } }]));
  }

  getLayer = vi.fn((id: string) => this.layers.get(id));
  /** A layer's paint property as the style gives it, or as `setPaintProperty` left it. */
  getPaintProperty = vi.fn((id: string, property: string) => this.layers.get(id)?.paint?.[property]);
  /** The ids of the style's layers, in the order they are drawn. */
  getLayersOrder = vi.fn(() => [...this.layers.keys()]);
  /** Changes a layer's paint, as MapLibre does: `undefined` takes the property away, so the layer draws without it. */
  setPaintProperty = vi.fn((id: string, property: string, value: unknown) => {
    const layer = this.layers.get(id);
    if (layer !== undefined) {
      const paint = { ...layer.paint };
      if (value === undefined) delete paint[property];
      else paint[property] = value;
      layer.paint = paint;
    }
    return this;
  });
  /**
   * A new style in place of the old one, built afresh (`diff: false`), as MapLibre does: it has its own
   * layers and none of the sources the app added, and it arrives a moment later, as the first did,
   * unless `FakeMap.arrives` is "none" when it is asked for: then a test fires what it wants.
   */
  setStyle = vi.fn((style: unknown, _options?: { diff?: boolean }) => {
    this.layers = FakeMap.layersOf(style);
    this.sources.clear();
    if (FakeMap.arrives !== "none") {
      queueMicrotask(() => {
        this.fire("style.load");
        this.fire("render");
      });
    }
    return this;
  });
  addSource = vi.fn((id: string, spec: Record<string, unknown>) => {
    this.sources.set(id, new FakeSource(this, spec));
    return this;
  });
  getSource = vi.fn((id: string) => this.sources.get(id));
  addLayer = vi.fn((layer: Record<string, unknown>) => {
    this.addedLayers.push(layer);
    return this;
  });
  isSourceLoaded = vi.fn((id: string) => this.sources.has(id));
  querySourceFeatures = vi.fn((id: string): FakeFeature[] => {
    if (this.features !== undefined) return this.features;
    const data = this.sources.get(id)?.data;
    return (data?.features ?? []).map((feature) => ({
      type: "Feature",
      geometry: feature.geometry as Point,
      properties: { ...feature.properties },
    }));
  });
  getBounds = vi.fn(() => {
    const { west, south, east, north } = this.bounds;
    return {
      getWest: () => west,
      getSouth: () => south,
      getEast: () => east,
      getNorth: () => north,
      contains: (lngLat: [number, number]) =>
        lngLat[0] >= west && lngLat[0] <= east && lngLat[1] >= south && lngLat[1] <= north,
    };
  });
  /** A move the app asks for: the map ends it with a `moveend` that no person caused. */
  easeTo = vi.fn((options: { center?: [number, number]; zoom?: number }, eventData: Record<string, unknown> = {}) => {
    if (options.center !== undefined) this.center = options.center;
    if (options.zoom !== undefined) this.zoom = options.zoom;
    this.fire("movestart", eventData).fire("moveend", eventData);
    return this;
  });
  /** A move the app asks for, to show a box: the map looks at its middle, and ends the move as `easeTo` does. */
  fitBounds = vi.fn((bounds: [number, number, number, number], _options?: unknown, eventData: Record<string, unknown> = {}) => {
    this.center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    this.fire("movestart", eventData).fire("moveend", eventData);
    return this;
  });
  zoomIn = vi.fn((_options?: unknown, eventData: Record<string, unknown> = {}) => {
    this.zoom += 1;
    this.fire("movestart", eventData).fire("moveend", eventData);
    return this;
  });
  zoomOut = vi.fn((_options?: unknown, eventData: Record<string, unknown> = {}) => {
    this.zoom -= 1;
    this.fire("movestart", eventData).fire("moveend", eventData);
    return this;
  });
  getCenter = () => ({ lng: this.center[0], lat: this.center[1] });
  getZoom = () => this.zoom;
  getCanvas = () => this.canvas;
  getCanvasContainer = () => this.container;
  remove = vi.fn(() => {
    this.removed = true;
    this.handlers.clear();
  });

  /**
   * Plays a person dragging the map to `bounds`, and pinching it to `zoom`. The map then looks at
   * `center`: by default the middle of the box's longitudes and latitudes, which a flat test map has;
   * MapLibre's is the middle of the box as drawn, a Mercator projection, so a test can give it.
   */
  dragTo(bounds: FakeBounds, zoom = this.zoom, center?: [number, number]) {
    this.bounds = bounds;
    this.center = center ?? [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
    this.zoom = zoom;
    const originalEvent = new MouseEvent("mouseup");
    this.fire("movestart", { originalEvent }).fire("moveend", { originalEvent });
  }
}

export class FakeMarker {
  static instances: FakeMarker[] = [];
  readonly element: HTMLElement;
  /** Which part of the element sits on the point: `center`, `bottom` ... */
  readonly anchor: string | undefined;
  lngLat: [number, number] | undefined;
  map: FakeMap | undefined;

  constructor(options: { element: HTMLElement; anchor?: string }) {
    this.element = options.element;
    this.anchor = options.anchor;
    FakeMarker.instances.push(this);
  }
  setLngLat(lngLat: [number, number]) {
    this.lngLat = lngLat;
    return this;
  }
  addTo(map: FakeMap) {
    this.map = map;
    map.container.append(this.element);
    return this;
  }
  getElement() {
    return this.element;
  }
  remove() {
    this.element.remove();
    this.map = undefined;
    return this;
  }
}

export const setWorkerUrl = vi.fn();

export { FakeMap as Map, FakeMarker as Marker };

/** Forgets every map and marker, and puts the style back; tests/setup.ts calls it after each test. */
export function resetFakeMaplibre(): void {
  FakeMap.instances = [];
  FakeMap.styleLayers = openFreeMapLayers;
  FakeMap.arrives = "all";
  FakeMarker.instances = [];
}
