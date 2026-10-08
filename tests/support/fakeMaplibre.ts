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

/** A layer of the style, as `getLayer` returns it: its id and its type. */
export interface FakeLayer {
  id: string;
  type: string;
}

/**
 * The layers a MapTiler style has (Dataviz Light, as fetched on 2026-10-07), as the map reports
 * them once that style has loaded. A test can take some away to see that a missing one is no harm.
 */
export const MAPTILER_LAYERS: readonly FakeLayer[] = [
  { id: "Background", type: "background" },
  { id: "Residential", type: "fill" },
  { id: "Landcover", type: "fill" },
  { id: "Forest", type: "fill" },
  { id: "Stadium", type: "fill" },
  { id: "Cemetery", type: "fill" },
  { id: "River", type: "line" },
  { id: "Water shadow", type: "fill" },
  { id: "Water", type: "fill" },
  { id: "Road", type: "line" },
  { id: "Building", type: "fill" },
  { id: "Place labels", type: "symbol" },
];

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
  /** The layers the next map's style has; tests/setup.ts puts it back after each test. */
  static styleLayers: readonly FakeLayer[] = MAPTILER_LAYERS;
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
  readonly layers: Map<string, FakeLayer>;
  removed = false;
  bounds: FakeBounds = { west: -16.95, south: 32.62, east: -16.87, north: 32.68 };
  /** Where the map looks and how far in, as the app's moves and the person's leave them. */
  center: [number, number];
  zoom: number;
  /** MapLibre's canvas: focusable when the map is, and named by the map's label. */
  readonly canvas: HTMLCanvasElement;
  /** The features `querySourceFeatures` gives; undefined: every point of the source's data, none clustered. */
  features: FakeFeature[] | undefined;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.container = options.container as HTMLElement;
    this.center = (options.center as [number, number] | undefined) ?? [0, 0];
    this.zoom = (options.zoom as number | undefined) ?? 0;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = options.interactive === false ? -1 : 0;
    this.canvas.setAttribute("role", "region");
    this.canvas.setAttribute("aria-label", (options.locale as Record<string, string> | undefined)?.["Map.Title"] ?? "Map");
    this.container.append(this.canvas);
    this.layers = new Map(
      (typeof options.style === "string" ? FakeMap.styleLayers : []).map((layer) => [layer.id, layer]),
    );
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

  getLayer = vi.fn((id: string) => this.layers.get(id));
  setPaintProperty = vi.fn((_id: string, _property: string, _value: unknown) => this);
  setStyle = vi.fn((_style: unknown) => this);
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

  /** Plays a person dragging the map to `bounds`, and pinching it to `zoom`. */
  dragTo(bounds: FakeBounds, zoom = this.zoom) {
    this.bounds = bounds;
    this.center = [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
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
  FakeMap.styleLayers = MAPTILER_LAYERS;
  FakeMap.arrives = "all";
  FakeMarker.instances = [];
}
