import type { NostrEvent } from "@nostrify/nostrify";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import houseBadge64 from "../src/assets/house/house-64.png";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import { LIST_LIMIT, OPEN_NOW_HOURS_LIMIT } from "../src/explore/useArea";
import { areaOf, placesInBox } from "../src/map/area";
import { BaseMap } from "../src/map/BaseMap";
import { CLUSTER_OPTIONS, MAX_MARKERS, type Pin, PIN_SOURCE, pinsFor, pinsGeoJSON } from "../src/map/pins";
import { filtersFromParams, withFilters } from "../src/search/filters";
import { MAPTILER_STYLE_URL, mapStyle, recolour } from "../src/map/style";
import { distanceKm } from "../src/places/distance";
import * as hoursModule from "../src/places/hours";
import { openLine, openState } from "../src/places/hours";
import { buildIndexes, formatDistance, groupForList } from "../src/places/indexes";
import { kindOf, placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { PlacesProvider } from "../src/places/store";
import { ScoresProvider } from "../src/score/ScoresProvider";
import { ScoresStore } from "../src/score/store";
import { routes } from "../src/routes";
import raw from "./fixtures/funchal-items.json";
import { type FakeFeature, FakeMap, FakeMarker, type FakeSource, MAPTILER_LAYERS } from "./support/fakeMaplibre";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;
const fixturePlaces = parsePlaces(fixtures);
const idx = buildIndexes(fixturePlaces);
const HERE = config.defaultCity;
const PHONE = 390;
const DESKTOP = 1360;

/** A Wednesday morning on the clock of Funchal (UTC+1 in October): 08:45. */
const MORNING = new Date("2026-10-07T07:45:00Z");

const place = (name: string): Place => {
  const found = fixturePlaces.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No fixture place is called ${name}`);
  return found;
};

// ---- Events made from the fixtures ----

let nextId = 1;
/** A place event like `base`, with the value of each tag in `over` replaced (or added) and a fresh, fake id. */
function variant(base: NostrEvent, over: Record<string, string>): NostrEvent {
  const replaced = base.tags.map((tag) => (tag[0] !== undefined && tag[0] in over ? [tag[0], over[tag[0]]!] : tag));
  const added = Object.entries(over).filter(([name]) => !base.tags.some((tag) => tag[0] === name));
  return { ...base, id: (nextId++).toString(16).padStart(64, "0"), tags: [...replaced, ...added] };
}

const nameOnly = fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === "crafted-minimal"))!;

/** Three cafes called Copper Kettle, close together in the middle of Funchal: a chain. */
const kettles = [0, 1, 2].map((i) =>
  variant(nameOnly, {
    d: `kettle-${i}`,
    name: "Copper Kettle",
    category: "cafe",
    lat: String(HERE.lat + 0.001 * (i + 1)),
    lon: String(HERE.lon + 0.001),
  }),
);

/** Three places in Lisbon, far from Funchal. */
const lisbon = [0, 1, 2].map((i) =>
  variant(nameOnly, { d: `lisbon-${i}`, name: `Lisbon place ${i + 1}`, lat: String(38.72 + i * 0.001), lon: "-9.14" }),
);
const LISBON_VIEW = { west: -9.2, south: 38.68, east: -9.08, north: 38.76 };

// ---- The browser window, as wide as a phone or a desktop ----

let width = PHONE;

/** Gives the page a `window.matchMedia` that answers `(min-width: Npx)` for `px`. */
function setWidth(px: number) {
  width = px;
  window.matchMedia = ((query: string) => {
    const min = Number(/\(min-width:\s*(\d+)px\)/.exec(query)?.[1] ?? Number.NaN);
    return {
      media: query,
      get matches() {
        return width >= min;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }) as unknown as typeof window.matchMedia;
}

// ---- The app ----

/** The whole app at `path`, with the places read from `events`; resolves once the map is made. */
async function openApp(path: string, { px = PHONE, events = fixtures }: { px?: number; events?: NostrEvent[] } = {}) {
  setWidth(px);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <PlacesProvider reader={createMemoryReader(events)}>
      <ScoresProvider>
        <HereProvider>
          <RouterProvider router={router} />
        </HereProvider>
      </ScoresProvider>
    </PlacesProvider>,
  );
  const map = await theMap();
  return { router, map, ...view };
}

/** The map that was made last, once its style has loaded and the pins are on it. */
async function theMap(): Promise<FakeMap> {
  return waitFor(() => {
    const map = FakeMap.instances.at(-1);
    if (map === undefined || !map.sources.has(PIN_SOURCE)) throw new Error("No map with pins yet");
    return map;
  });
}

const pinSource = (map: FakeMap): FakeSource => map.sources.get(PIN_SOURCE)!;
/** A pin of the map's source on its own, as `querySourceFeatures` gives it. */
const pointFeature = (address: string, lon: number, lat: number): FakeFeature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { address },
});
const pinAddresses = (map: FakeMap) =>
  pinSource(map).data.features.map((feature) => (feature.properties as { address: string }).address);

/** A pattern that matches `text` as it is. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The pin of a place, by the name a screen reader reads first. */
const pin = (name: string) => screen.getByRole("button", { name: new RegExp(`^${literal(name)},`) });
const findPin = (name: string) => screen.findByRole("button", { name: new RegExp(`^${literal(name)},`) });
/** The ring, pill or bubble the pin draws. */
const look = (button: HTMLElement) => button.firstElementChild as HTMLElement;

/** What a card is called: the words of the element its link takes its name from. */
const nameOf = (card: HTMLElement) => document.getElementById(card.getAttribute("aria-labelledby") ?? "")?.textContent ?? "";

/** The attribution on a map: one line, its two names links. */
const mapAttribution = () =>
  screen.getByText((_, element) => element?.tagName === "P" && element.textContent === copy.attribution.map);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MORNING);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "matchMedia");
  document.documentElement.style.removeProperty("--map-land");
  Reflect.deleteProperty(navigator, "geolocation");
});

// ---- The style ----

describe("the map's style", () => {
  it("is MapTiler's Dataviz Light, with the key, when there is a key", () => {
    expect(MAPTILER_STYLE_URL).toBe("https://api.maptiler.com/maps/dataviz-light/style.json");
    expect(mapStyle("k")).toBe("https://api.maptiler.com/maps/dataviz-light/style.json?key=k");
    expect(mapStyle("a b&c")).toBe("https://api.maptiler.com/maps/dataviz-light/style.json?key=a%20b%26c");
  });

  it("is a plain ground in the land colour, with nothing to fetch, when there is no key", () => {
    for (const key of [undefined, "", "   "]) {
      const style = mapStyle(key);
      expect(style).toEqual({
        version: 8,
        sources: {},
        layers: [{ id: "background", type: "background", paint: { "background-color": "#E4EAEE" } }],
      });
      const text = JSON.stringify(style);
      expect(text).not.toMatch(/https?:|\/\/|maptiler|openstreetmap|glyphs|sprite|url/i);
    }
  });

  it("takes the land colour from the page's --map-land when it has one", () => {
    document.documentElement.style.setProperty("--map-land", " #123456 ");
    expect(mapStyle(undefined)).toMatchObject({ layers: [{ paint: { "background-color": "#123456" } }] });
  });

  /** The colours `recolour` set, without the transitions it turned off first. */
  const coloursSet = (map: FakeMap) => map.setPaintProperty.mock.calls.filter(([, property]) => !property.endsWith("-transition"));

  it("recolours MapTiler's land, parks and water to the tokens, by each layer's type", () => {
    const map = new FakeMap({ container: document.createElement("div"), style: "https://x.test/style.json" });
    recolour(map as never);
    expect(coloursSet(map)).toEqual([
      ["Background", "background-color", "#E4EAEE"],
      ["Residential", "fill-color", "#E4EAEE"],
      ["Landcover", "fill-color", "#CFE3DA"],
      ["Forest", "fill-color", "#CFE3DA"],
      ["Stadium", "fill-color", "#CFE3DA"],
      ["Cemetery", "fill-color", "#CFE3DA"],
      ["Water shadow", "fill-color", "#CBDDEA"],
      ["Water", "fill-color", "#CBDDEA"],
      ["River", "line-color", "#CBDDEA"],
    ]);
  });

  it("changes each colour at once, without the style's fade from MapTiler's grey", () => {
    const map = new FakeMap({ container: document.createElement("div"), style: "https://x.test/style.json" });
    recolour(map as never);
    const calls = map.setPaintProperty.mock.calls;
    for (const [id, property] of coloursSet(map)) {
      const transition = calls.findIndex((call) => call[0] === id && call[1] === `${property}-transition`);
      const colour = calls.findIndex((call) => call[0] === id && call[1] === property);
      expect(calls[transition]?.[2]).toEqual({ duration: 0, delay: 0 });
      expect(transition).toBeLessThan(colour);
    }
  });

  it("skips a layer the style does not have, and never throws for one", () => {
    FakeMap.styleLayers = MAPTILER_LAYERS.filter((layer) => !["Forest", "River", "Background"].includes(layer.id));
    const map = new FakeMap({ container: document.createElement("div"), style: "https://x.test/style.json" });
    expect(() => recolour(map as never)).not.toThrow();
    expect(coloursSet(map).map(([id]) => id)).toEqual(["Residential", "Landcover", "Stadium", "Cemetery", "Water shadow", "Water"]);
  });
});

// ---- The pins ----

describe("the pins", () => {
  const rows = (places: Place[]) =>
    places
      .map((each) => ({ place: each, km: distanceKm(HERE.lat, HERE.lon, each.lat, each.lon) }))
      .sort((a, b) => a.km - b.km);

  it("are a ring for a place with no score: no label, its name, kind and hours for a screen reader", () => {
    const jacafe = place("Jacafé");
    const [only] = pinsFor(groupForList(rows([jacafe]), idx), "en-US", MORNING);
    const hours = openLine(openState(jacafe, MORNING), "en-US", "card");
    expect(only).toEqual({
      address: jacafe.address,
      lat: jacafe.lat,
      lon: jacafe.lon,
      category: jacafe.category,
      name: `Jacafé, ${placeKindLabel(jacafe.category, jacafe.cuisine)}, ${hours}, no reviews yet`,
    });
    expect(only).not.toHaveProperty("label");
    expect(only).not.toHaveProperty("chainCount");
  });

  it("are one pin for a chain with two or more of its places among them, at the nearest, with how many", () => {
    const places = parsePlaces([...fixtures, ...kettles]);
    const chainIdx = buildIndexes(places);
    const kettleRows = rows(places.filter((each) => each.name === "Copper Kettle"));
    const pins = pinsFor(groupForList(kettleRows, chainIdx), "en-US", MORNING);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      address: kettleRows[0]!.place.address,
      lat: kettleRows[0]!.place.lat,
      chainCount: 3,
      name: "Copper Kettle, a chain, 3 locations nearby",
    });
  });

  it("go on the map as GeoJSON points, longitude first, with the place's address", () => {
    const pins: Pin[] = [{ address: "39999:abc:one", lat: 32.65, lon: -16.9, name: "One" }];
    expect(pinsGeoJSON(pins)).toEqual({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [-16.9, 32.65] }, properties: { address: "39999:abc:one" } },
      ],
    });
  });

  it("cluster in a GeoJSON source, so a crowd of pins becomes a count", () => {
    expect(CLUSTER_OPTIONS).toEqual({ cluster: true, clusterRadius: 50, clusterMaxZoom: 14 });
  });
});

describe("the area a map shows", () => {
  /** Where a latitude is drawn on a Mercator map, and back: the middle of a map is the middle of what it draws. */
  const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const fromMercatorY = (y: number) => (Math.atan(Math.sinh(y)) * 180) / Math.PI;

  it("is the view's box, with the middle of the view as its centre", () => {
    const area = areaOf([-16.92, 32.64, -16.9, 32.66]);
    expect(area.lat).toBeCloseTo(32.65, 4);
    expect(area.lon).toBeCloseTo(-16.91, 6);
    expect(area.box).toEqual([-16.92, 32.64, -16.9, 32.66]);
    expect(area).not.toHaveProperty("radiusKm");
  });

  it("has the middle of the map as drawn as its centre, not the middle of its latitudes", () => {
    // A view from 35°N to 70°N: the map's middle is near 56.3°N, well north of 52.5°N.
    const area = areaOf([-10, 35, 30, 70]);
    expect(area.lat).toBeCloseTo(fromMercatorY((mercatorY(35) + mercatorY(70)) / 2), 6);
    expect(area.lat).toBeGreaterThan(56);
    expect(area.lon).toBe(10);
    // The map's own centre, when it is given, is the centre.
    expect(areaOf([-10, 35, 30, 70], [11, 56.4])).toMatchObject({ lat: 56.4, lon: 11 });
  });

  it("reaches as far as the view does, however wide: no city's radius caps it", () => {
    expect(areaOf([-10, 36, -6, 42])).toMatchObject({ lon: -8, box: [-10, 36, -6, 42] });
    const world = areaOf([-180, -85, 180, 85]);
    expect(world).toMatchObject({ lon: 0, box: [-180, -85, 180, 85] });
    expect(world.lat).toBeCloseTo(0, 9);
  });

  it("is on the Earth when the view has gone round it", () => {
    expect(areaOf([179, -1, 183, 1]).lon).toBeCloseTo(-179, 6);
  });

  it("holds the places of a box that crosses the 180th meridian, or goes round the Earth, once each", () => {
    const at = (lon: number, i: number) =>
      variant(nameOnly, { d: `meridian-${i}`, name: `Meridian place ${i}`, lat: "0", lon: String(lon) });
    const meridian = parsePlaces([at(179.5, 0), at(-179.5, 1), at(0, 2)]);
    const meridianIdx = buildIndexes(meridian);
    const names = (box: [number, number, number, number]) => placesInBox(meridianIdx, box).map((each) => each.name).sort();
    expect(names([179, -1, 181, 1])).toEqual(["Meridian place 0", "Meridian place 1"]);
    expect(names([-181, -1, -179, 1])).toEqual(["Meridian place 0", "Meridian place 1"]);
    expect(names([-1, -1, 1, 1])).toEqual(["Meridian place 2"]);
    expect(names([-250, -90, 250, 90])).toEqual(["Meridian place 0", "Meridian place 1", "Meridian place 2"]);
  });
});

// ---- BaseMap on its own ----

describe("BaseMap", () => {
  const funchal: [number, number] = [HERE.lon, HERE.lat];
  const pins: Pin[] = [
    { address: "a", lat: 32.65, lon: -16.91, name: "Alpha, Cafe, Hours not listed, no reviews yet", category: "cafe" },
    { address: "b", lat: 32.651, lon: -16.905, name: "Bravo, a chain, 3 locations nearby", chainCount: 3, category: "cafe" },
  ];

  it("loads the map library when it is drawn, and makes one map with its own attribution, not MapLibre's", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} />);
    const map = await theMap();
    expect(FakeMap.instances).toHaveLength(1);
    expect(map.options).toMatchObject({ center: funchal, zoom: 13, interactive: true, attributionControl: false });
    expect(map.options.cooperativeGestures).toBe(false);
    // Turned and tilted as MapLibre lets any map be: only a flat map is kept from it.
    for (const option of ["dragRotate", "touchPitch", "pitchWithRotate"]) expect(map.options).not.toHaveProperty(option);
    expect(map.touchZoomRotate.disableRotation).not.toHaveBeenCalled();
    expect(map.keyboard.disableRotation).not.toHaveBeenCalled();
    // MapLibre's own words, in the app's: the map's name, and what it says when a gesture is left to the page.
    expect(map.options.locale).toEqual({
      "Map.Title": copy.map.label,
      "CooperativeGesturesHandler.WindowsHelpText": copy.map.gestureHelp.ctrl,
      "CooperativeGesturesHandler.MacHelpText": copy.map.gestureHelp.mac,
      "CooperativeGesturesHandler.MobileHelpText": copy.map.gestureHelp.touch,
    });
    expect(mapAttribution()).toBeVisible();
    expect(mapAttribution().closest(".bg-map-land")).toContainElement(map.container);
  });

  it("names a map that moves for its label, and leaves the page to scroll past it when it is cooperative", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive cooperative label="Map showing where Alpha is" />);
    const map = await theMap();
    expect(map.options).toMatchObject({ interactive: true, cooperativeGestures: true });
    expect(map.options.locale).toMatchObject({ "Map.Title": "Map showing where Alpha is" });
    expect(screen.getByRole("region", { name: "Map showing where Alpha is" })).toBe(map.canvas);
    expect(screen.queryByRole("img", { name: "Map showing where Alpha is" })).not.toBeInTheDocument();
  });

  it("renames a moving map's region when its label changes, and calls it Map again without one", async () => {
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive label="Map showing where Alpha is" />);
    const map = await theMap();
    expect(map.canvas).toHaveAccessibleName("Map showing where Alpha is");
    rerender(<BaseMap center={funchal} zoom={13} interactive label="Map showing where Bravo is" />);
    await waitFor(() => expect(map.canvas).toHaveAccessibleName("Map showing where Bravo is"));
    expect(screen.getByRole("region", { name: "Map showing where Bravo is" })).toBe(map.canvas);
    rerender(<BaseMap center={funchal} zoom={13} interactive />);
    await waitFor(() => expect(map.canvas).toHaveAccessibleName(copy.map.label));
  });

  it("keeps a flat map north up and flat: no drag, two fingers or keys turn or tilt it", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive flat />);
    const map = await theMap();
    // Right-drag and Ctrl and a drag are MapLibre's drag-rotate; two fingers turn and tilt it; Shift and the arrows do too.
    expect(map.options).toMatchObject({ interactive: true, dragRotate: false, touchPitch: false, pitchWithRotate: false });
    expect(map.touchZoomRotate.disableRotation).toHaveBeenCalledTimes(1);
    expect(map.keyboard.disableRotation).toHaveBeenCalledTimes(1);
  });

  it("offers a way back to where it started at its top left, once the person has moved it, and not before", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive flat zoomButtons back="Back to the start" />);
    const map = await theMap();
    const queryBack = () => screen.queryByRole("button", { name: "Back to the start" });
    expect(queryBack()).not.toBeInTheDocument();
    act(() => map.dragTo(LISBON_VIEW, 11));
    const back = await screen.findByRole("button", { name: "Back to the start" });
    // In the map's top left corner, clear of the pin in the middle and the buttons at the bottom right,
    // and first in the keyboard's order, before the zoom buttons.
    expect(back.parentElement).toBe(mapAttribution().closest(".bg-map-land"));
    expect(back).toHaveClass("absolute", "top-3", "left-3", "wide:top-4", "wide:left-4");
    expect(back.compareDocumentPosition(screen.getByRole("button", { name: copy.map.zoomIn })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(back);
    // A flat map has only its centre and zoom to go back to.
    await waitFor(() => expect(map.easeTo).toHaveBeenLastCalledWith({ center: funchal, zoom: 13 }));
    await waitFor(() => expect(queryBack()).not.toBeInTheDocument());
    expect(map.canvas).toHaveFocus();

    // A new centre is a new start: the way back to the old one goes.
    act(() => map.dragTo(LISBON_VIEW, 11));
    expect(await screen.findByRole("button", { name: "Back to the start" })).toBeInTheDocument();
    rerender(<BaseMap center={[-9.14, 38.72]} zoom={13} interactive flat zoomButtons back="Back to the start" />);
    await waitFor(() => expect(queryBack()).not.toBeInTheDocument());
  });

  it("offers a way back only while the map is away from where it started, whatever the person did", async () => {
    const user = userEvent.setup();
    const onMoveEnd = vi.fn();
    render(<BaseMap center={funchal} zoom={13} interactive flat zoomButtons back="Back to the start" onMoveEnd={onMoveEnd} />);
    const map = await theMap();
    const queryBack = () => screen.queryByRole("button", { name: "Back to the start" });
    // A key that would turn a flat map moves it nowhere, yet MapLibre ends it as the person's move.
    const originalEvent = new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true });
    act(() => void map.fire("movestart", { originalEvent }).fire("moveend", { originalEvent }));
    await waitFor(() => expect(onMoveEnd).toHaveBeenCalledTimes(1));
    expect(queryBack()).not.toBeInTheDocument();

    // In and out again with the buttons: away, then back where it started, by the person's own hand.
    await user.click(screen.getByRole("button", { name: copy.map.zoomIn }));
    expect(await screen.findByRole("button", { name: "Back to the start" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.map.zoomOut }));
    await waitFor(() => expect(queryBack()).not.toBeInTheDocument());
    expect(map.zoom).toBe(13);
  });

  it("has no way back on a map that is not given one", async () => {
    const onMoveEnd = vi.fn();
    render(<BaseMap center={funchal} zoom={13} interactive zoomButtons onMoveEnd={onMoveEnd} />);
    const map = await theMap();
    act(() => map.dragTo(LISBON_VIEW, 11));
    // The move has been taken as the person's.
    await waitFor(() => expect(onMoveEnd).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      copy.map.zoomIn,
      copy.map.zoomOut,
    ]);
  });

  it("uses MapTiler's style with the key, and the plain one without", async () => {
    config.mapTilerKey = "test-key";
    const first = render(<BaseMap center={funchal} zoom={13} interactive />);
    expect((await theMap()).options.style).toBe(`${MAPTILER_STYLE_URL}?key=test-key`);
    first.unmount();

    config.mapTilerKey = undefined;
    render(<BaseMap center={funchal} zoom={13} interactive />);
    await waitFor(() => expect(FakeMap.instances).toHaveLength(2));
    expect(typeof FakeMap.instances[1]!.options.style).toBe("object");
    expect(JSON.stringify(FakeMap.instances[1]!.options.style)).not.toMatch(/https?:/);
  });

  it("recolours MapTiler's layers once the style has loaded", async () => {
    config.mapTilerKey = "test-key";
    render(<BaseMap center={funchal} zoom={13} interactive />);
    const map = await theMap();
    expect(map.setPaintProperty).toHaveBeenCalledWith("Water", "fill-color", "#CBDDEA");
    expect(map.setPaintProperty).toHaveBeenCalledWith("Background", "background-color", "#E4EAEE");
  });

  it("colours the map and puts the pins on as soon as the style is there, before its tiles", async () => {
    config.mapTilerKey = "test-key";
    FakeMap.arrives = "style";
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} />);
    const map = await theMap();
    expect(map.setPaintProperty).toHaveBeenCalledWith("Background", "background-color", "#E4EAEE");
    expect(await findPin("Alpha")).toBeInTheDocument();
  });

  it("falls back to the plain ground when MapTiler's style does not come, and still puts the pins on it", async () => {
    config.mapTilerKey = "test-key";
    FakeMap.arrives = "none";
    // In development each error is written as a warning, since the map's own logging is replaced.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} />);
    const map = await waitFor(() => FakeMap.instances[0] ?? Promise.reject(new Error("No map yet")));

    // A tile that does not come is no reason to drop the style.
    act(() => map.fire("error", { error: new Error("tile"), sourceId: "maptiler_planet" }));
    expect(map.setStyle).not.toHaveBeenCalled();

    act(() => map.fire("error", { error: new Error("style") }));
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(map.setStyle).toHaveBeenCalledWith(mapStyle(undefined));
    act(() => map.fire("error", { error: new Error("style") }));
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(3);

    act(() => map.fire("style.load"));
    expect(map.sources.has(PIN_SOURCE)).toBe(true);
    act(() => map.fire("render"));
    expect(pin("Alpha")).toBeInTheDocument();
  });

  it("still says '© MapTiler © OpenStreetMap contributors' when there is no key", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive />);
    await theMap();
    expect(mapAttribution()).toHaveTextContent("© MapTiler © OpenStreetMap contributors");
    expect(within(mapAttribution()).getByRole("link", { name: "MapTiler" })).toBeInTheDocument();
  });

  it("puts the pins in a clustered GeoJSON source, and changes its data when the pins change", async () => {
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive pins={pins} />);
    const map = await theMap();
    expect(map.addSource).toHaveBeenCalledWith(PIN_SOURCE, {
      type: "geojson",
      data: pinsGeoJSON(pins),
      cluster: true,
      clusterRadius: 50,
      clusterMaxZoom: 14,
    });
    expect(pinAddresses(map)).toEqual(["a", "b"]);

    rerender(<BaseMap center={funchal} zoom={13} interactive pins={pins.slice(1)} />);
    await waitFor(() => expect(pinAddresses(map)).toEqual(["b"]));
    expect(pinSource(map).setData).toHaveBeenCalledTimes(1);
  });

  it("draws a place with no score as a ring, and a chain as one pill that says how many", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} />);
    await theMap();
    const ring = await findPin("Alpha");
    expect(ring).toHaveAccessibleName("Alpha, Cafe, Hours not listed, no reviews yet");
    expect(ring).toHaveAttribute("aria-pressed", "false");
    expect(look(ring)).toHaveClass("rounded-full", "border-4", "border-muted", "bg-ground");
    expect(look(ring)).toBeEmptyDOMElement();

    const chain = pin("Bravo");
    expect(chain).toHaveAccessibleName("Bravo, a chain, 3 locations nearby");
    expect(look(chain)).toHaveTextContent(/^×3$/);
    expect(look(chain)).toHaveClass("bg-ground", "text-ink");
  });

  it("draws a crowd of pins as the bubbles MapLibre clusters them into, and a tap zooms in on one", async () => {
    const crowd: Pin[] = Array.from({ length: 61 }, (_, i) => ({
      address: `p${i}`,
      lat: 32.65 + i * 1e-4,
      lon: -16.91,
      name: `Place ${i}, Cafe, Hours not listed, no reviews yet`,
    }));
    const user = userEvent.setup();
    render(<BaseMap center={funchal} zoom={13} interactive pins={crowd} onSelect={() => {}} />);
    const map = await theMap();
    expect(pinSource(map).spec).toMatchObject({ cluster: true });

    const bubble: FakeFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-16.91, 32.653] },
      properties: { cluster: true, cluster_id: 7, point_count: 61 },
    };
    map.features = [bubble];
    act(() => map.fire("render"));
    expect(screen.queryByRole("button", { name: /^Place 0,/ })).not.toBeInTheDocument();
    const cluster = screen.getByRole("button", { name: "61 places here, zoom in" });
    expect(cluster).toHaveTextContent("61");
    expect(cluster).toHaveClass("rounded-full", "bg-emphasis", "text-on-emphasis");

    await user.click(cluster);
    expect(pinSource(map).getClusterExpansionZoom).toHaveBeenCalledWith(7);
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [-16.91, 32.653], zoom: 16 }));
  });

  it("draws no more than 200 pins at once, those in view first", async () => {
    const many: Pin[] = Array.from({ length: 260 }, (_, i) => ({
      address: `p${i}`,
      // The first 60 are far outside the view.
      lat: i < 60 ? 10 : 32.64 + (i % 100) * 1e-4,
      lon: -16.91 + Math.floor(i / 100) * 1e-4,
      name: `Place ${i}, Cafe, Hours not listed, no reviews yet`,
    }));
    render(<BaseMap center={funchal} zoom={15} interactive pins={many} onSelect={() => {}} />);
    await theMap();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Place / })).toHaveLength(200));
    expect(screen.queryByRole("button", { name: /^Place 0,/ })).not.toBeInTheDocument();
  });

  /** `pins` as a map of every place has them: points, and each pin worked out when it is drawn. */
  const pointsOf = (given: readonly Pin[]) => ({
    points: given.map(({ address, lat, lon }) => ({ address, lat, lon })),
    pinOf: (address: string) => given.find((each) => each.address === address),
  });

  it("keeps the chosen pin in a map of every place's data: choosing and letting go of a pin never sends the data again", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const every = pointsOf(pins);
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive {...every} onSelect={onSelect} />);
    const map = await theMap();
    await user.click(await findPin("Alpha"));
    rerender(<BaseMap center={funchal} zoom={13} interactive {...every} onSelect={onSelect} selected="a" />);
    expect(pin("Alpha")).toHaveAttribute("aria-pressed", "true");
    rerender(<BaseMap center={funchal} zoom={13} interactive {...every} onSelect={onSelect} selected="b" />);
    rerender(<BaseMap center={funchal} zoom={13} interactive {...every} onSelect={onSelect} />);
    expect(pinSource(map).setData).not.toHaveBeenCalled();
    expect(pinAddresses(map)).toEqual(["a", "b"]);
  });

  it("keeps a map of a few pins without the chosen one, so no bubble counts it as well", async () => {
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} />);
    const map = await theMap();
    rerender(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} selected="a" />);
    await waitFor(() => expect(pinAddresses(map)).toEqual(["b"]));
    expect(pin("Alpha")).toHaveAttribute("aria-pressed", "true");
  });

  it("draws the chosen pin of a map of every place on its own over the bubble it is in, which still counts it", async () => {
    const every = pointsOf(pins);
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive {...every} onSelect={() => {}} />);
    const map = await theMap();
    map.features = [
      { type: "Feature", geometry: { type: "Point", coordinates: [-16.908, 32.6505] }, properties: { cluster: true, cluster_id: 4, point_count: 2 } },
    ];
    act(() => map.fire("render"));
    rerender(<BaseMap center={funchal} zoom={13} interactive {...every} onSelect={() => {}} selected="a" />);
    expect(pin("Alpha")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "2 places here, zoom in" })).toBeInTheDocument();
    expect(pinSource(map).setData).not.toHaveBeenCalled();
  });

  it("leaves no place in view without a marker when more pins are in view than it draws", async () => {
    const user = userEvent.setup();
    // 260 places on their own in view, and no bubble: the 200 nearest the middle are pins, the rest in bubbles.
    const crowd: Pin[] = Array.from({ length: 260 }, (_, i) => ({
      address: `p${i}`,
      lat: 32.621 + (i % 20) * 0.0029,
      lon: -16.949 + Math.floor(i / 20) * 0.0061,
      name: `Place ${i}, Cafe, Hours not listed, no reviews yet`,
    }));
    render(<BaseMap center={funchal} zoom={15} interactive pins={crowd} onSelect={() => {}} />);
    const map = await theMap();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Place / }).length).toBe(MAX_MARKERS));
    const bubbles = () => screen.queryAllByRole("button", { name: /places here, zoom in$/ });
    const counted = (each: HTMLElement) => Number(/^(\d+) places/.exec(each.getAttribute("aria-label") ?? "")![1]);
    expect(bubbles().length).toBeGreaterThan(0);
    expect(MAX_MARKERS + bubbles().map(counted).reduce((a, b) => a + b, 0)).toBe(crowd.length);
    // The pins kept are the nearest the middle of the view.
    const middle = screen.getByRole("button", { name: /^Place 130,/ });
    expect(middle).toBeInTheDocument();

    // A bubble made of the pins left over opens up the way a bubble does: closer in, where it is.
    map.easeTo.mockClear();
    const zoom = map.zoom;
    await user.click(bubbles()[0]!);
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ zoom: zoom + 2 })));
  });

  it("puts the pins left over into the bubbles already there, so each place in view is in some marker", async () => {
    const crowd: Pin[] = Array.from({ length: 250 }, (_, i) => ({
      address: `p${i}`,
      lat: 32.621 + (i % 20) * 0.0029,
      lon: -16.949 + Math.floor(i / 20) * 0.0061,
      name: `Place ${i}, Cafe, Hours not listed, no reviews yet`,
    }));
    render(<BaseMap center={funchal} zoom={13} interactive pins={crowd} onSelect={() => {}} />);
    const map = await theMap();
    const bubble = (id: number, lon: number, lat: number): FakeFeature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { cluster: true, cluster_id: id, point_count: 10 },
    });
    map.features = [
      ...[1, 2, 3, 4, 5].map((id) => bubble(id, -16.94 + id * 0.01, 32.63)),
      ...crowd.map((each) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [each.lon, each.lat] }, properties: { address: each.address } })),
    ];
    act(() => map.fire("render"));
    const drawnPins = screen.getAllByRole("button", { name: /^Place / });
    const bubbles = screen.getAllByRole("button", { name: /places here, zoom in$/ });
    expect(drawnPins).toHaveLength(MAX_MARKERS - 5);
    expect(bubbles).toHaveLength(5);
    const counted = bubbles.map((each) => Number(/^(\d+) places/.exec(each.getAttribute("aria-label") ?? "")![1]));
    expect(drawnPins.length + counted.reduce((a, b) => a + b, 0)).toBe(5 * 10 + crowd.length);
  });

  it("tells the page which pins it draws as they change, once for each new set of them", async () => {
    const onPinsDrawn = vi.fn();
    const points = [
      { address: "north", lat: 32.66, lon: -16.91 },
      { address: "south", lat: 32.64, lon: -16.91 },
    ];
    const pinOf = (address: string): Pin | undefined => {
      const point = points.find((each) => each.address === address);
      return point === undefined ? undefined : { ...point, name: `${address}, Cafe, Hours not listed, no reviews yet` };
    };
    // The north pin chosen, and inside a bubble: drawn on its own after the pins the map shows.
    FakeMap.arrives = "none";
    render(<BaseMap center={funchal} zoom={13} interactive points={points} pinOf={pinOf} onPinsDrawn={onPinsDrawn} selected="north" />);
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined) throw new Error("No map yet");
      return made;
    });
    map.features = [pointFeature("south", -16.91, 32.64)];
    act(() => {
      map.fire("style.load");
      map.fire("render");
    });
    await waitFor(() => expect(onPinsDrawn).toHaveBeenLastCalledWith(["north", "south"]));
    const calls = onPinsDrawn.mock.calls.length;
    // Now the map shows it on its own too, first in its reading order: the same pins, nothing new to say.
    map.features = [pointFeature("north", -16.91, 32.66), pointFeature("south", -16.91, 32.64)];
    act(() => map.fire("render"));
    await act(async () => {});
    expect(onPinsDrawn).toHaveBeenCalledTimes(calls);
  });

  it("says which pin was tapped, marks the selected one, and says when the map away from the pins is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={onSelect} />);
    const map = await theMap();
    await user.click(await findPin("Alpha"));
    expect(onSelect).toHaveBeenLastCalledWith("a", "pointer");
    act(() => pin("Bravo").focus());
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("b", "keyboard");

    rerender(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={onSelect} selected="a" />);
    expect(pin("Alpha")).toHaveAttribute("aria-pressed", "true");
    expect(look(pin("Alpha"))).toHaveClass("border-accent");

    act(() => map.fire("click", { originalEvent: new MouseEvent("click") }));
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it("ignores the map's own click for a tap that landed on a pin", async () => {
    const onSelect = vi.fn();
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={onSelect} />);
    const map = await theMap();
    const button = await findPin("Alpha");
    const originalEvent = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(originalEvent, "target", { value: look(button) });
    act(() => map.fire("click", { originalEvent }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("draws a highlighted pin in the accent colour, even one inside a cluster", async () => {
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} />);
    const map = await theMap();
    map.features = [];
    act(() => map.fire("render"));
    expect(screen.queryByRole("button", { name: /^Alpha,/ })).not.toBeInTheDocument();

    rerender(<BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} highlighted="a" />);
    expect(look(pin("Alpha"))).toHaveClass("border-accent");
    expect(pin("Alpha")).toHaveAttribute("aria-pressed", "false");
  });

  it("tells the page when a person moves the map, and not when the page moves it", async () => {
    const onMoveEnd = vi.fn();
    render(<BaseMap center={funchal} zoom={13} interactive onMoveEnd={onMoveEnd} />);
    const map = await theMap();
    act(() => void map.easeTo({ center: [0, 0] }));
    expect(onMoveEnd).not.toHaveBeenCalled();

    act(() => map.dragTo(LISBON_VIEW));
    expect(onMoveEnd).toHaveBeenCalledWith([-9.2, 38.68, -9.08, 38.76], [-9.14, 38.72]);
    // The map's own centre, which is not the middle of the box's latitudes on a Mercator map.
    act(() => map.dragTo({ west: -10, south: 35, east: 30, north: 70 }, 4, [10, 56.3]));
    expect(onMoveEnd).toHaveBeenLastCalledWith([-10, 35, 30, 70], [10, 56.3]);
  });

  it("moves to a new centre, and back to the same one when asked again", async () => {
    const { rerender } = render(<BaseMap center={funchal} zoom={13} interactive />);
    const map = await theMap();
    expect(map.easeTo).not.toHaveBeenCalled();

    rerender(<BaseMap center={[-9.14, 38.72]} zoom={13} interactive />);
    expect(map.easeTo).toHaveBeenLastCalledWith({ center: [-9.14, 38.72], zoom: 13 });

    rerender(<BaseMap center={[-9.14, 38.72]} zoom={13} interactive recentre={1} />);
    expect(map.easeTo).toHaveBeenCalledTimes(2);
  });

  it("shows where the person is, when it knows", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive you={funchal} />);
    await theMap();
    expect(await screen.findByRole("img", { name: copy.map.youAreHere })).toHaveClass("bg-you-are-here");
  });

  it("removes the map when it goes", async () => {
    const { unmount } = render(<BaseMap center={funchal} zoom={13} interactive pins={pins} />);
    const map = await theMap();
    unmount();
    expect(map.remove).toHaveBeenCalledTimes(1);
  });

  it("makes no map at all if it goes before the library has loaded", async () => {
    const { unmount } = render(<BaseMap center={funchal} zoom={13} interactive />);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeMap.instances).toHaveLength(0);
  });
});

// ---- The map page, on a phone ----

describe("the map on a phone", () => {
  it("is a page called Map with the search field and the toggle over the map, the tabs below", async () => {
    await openApp("/map");
    expect(screen.getByRole("heading", { level: 1, name: copy.pages.map })).toHaveClass("sr-only");
    const search = screen.getByRole("link", { name: `${copy.search.label}: ${copy.search.placeholder}` });
    expect(search).toHaveAttribute("href", "/search");
    expect(search).toHaveClass("bg-ground", "shadow-float");
    expect(screen.getByRole("group", { name: copy.view.label })).toHaveClass("bg-ground", "shadow-float");
    expect(screen.getByRole("navigation", { name: copy.nav.label })).toBeInTheDocument();
    expect(mapAttribution()).toBeVisible();
    await waitFor(() => expect(document.title).toBe(copy.titles.map));
  });

  it("starts at the place the list is near, at zoom 13, with a pin for every place, a chain's each on its own", async () => {
    const { map } = await openApp("/map");
    expect(map.options).toMatchObject({ center: [HERE.lon, HERE.lat], zoom: 13 });
    expect([...pinAddresses(map)].sort()).toEqual(fixturePlaces.map((each) => each.address).sort());
    expect(await findPin("Jacafé")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^A Confeitaria Coffee & Bakery,/ })).toHaveLength(4);
  });

  it("docks the place's card at the foot of the map when its pin is tapped; the card opens the place", async () => {
    const user = userEvent.setup();
    const { router, map } = await openApp("/map");
    expect(screen.queryByRole("link", { name: "Jacafé" })).not.toBeInTheDocument();

    await user.click(await findPin("Jacafé"));
    expect(pin("Jacafé")).toHaveAttribute("aria-pressed", "true");
    const card = screen.getByRole("link", { name: "Jacafé" });
    expect(card).toHaveAttribute("href", `/place/${place("Jacafé").d}`);
    expect(card).toHaveClass("shadow-card-over-map", "bg-ground");
    // Under the attribution, as the design has it.
    expect(mapAttribution().compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => map.fire("click", { originalEvent: new MouseEvent("click") }));
    expect(screen.queryByRole("link", { name: "Jacafé" })).not.toBeInTheDocument();

    await user.click(pin("Jacafé"));
    await user.click(screen.getByRole("link", { name: "Jacafé" }));
    expect(router.state.location.pathname).toBe(`/place/${place("Jacafé").d}`);
  });

  it("docks a chain's place's card for its pin, under it the way to the chain; that opens the chain", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/map");
    await findPin("Jacafé");
    await user.click(screen.getAllByRole("button", { name: /^A Confeitaria Coffee & Bakery,/ })[0]!);
    const region = screen.getByRole("region", { name: copy.map.selected });
    const card = within(region).getByRole("link", { name: "A Confeitaria Coffee & Bakery" });
    expect(card.getAttribute("href")).toMatch(/^\/place\//);
    const chain = idx.chains.get("PT:a confeitaria coffee & bakery")!;
    const toChain = within(region).getByRole("link", { name: copy.map.partOfChain(chain.name, chain.places.length) });
    expect(toChain).toHaveTextContent("Part of A Confeitaria Coffee & Bakery · 4 locations");
    expect(card.compareDocumentPosition(toChain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(toChain);
    expect(router.state.location.pathname).toMatch(/^\/chain\//);
  });

  it("docks a place's card with no way to a chain when the place is in none", async () => {
    const user = userEvent.setup();
    await openApp("/map");
    await user.click(await findPin("Jacafé"));
    const region = screen.getByRole("region", { name: copy.map.selected });
    expect(within(region).getAllByRole("link")).toHaveLength(1);
  });

  it("has no Search this area: every place is a pin wherever the person moves the map, and its pin docks its card", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
    const every = parsePlaces([...fixtures, ...lisbon]).map((each) => each.address).sort();
    expect([...pinAddresses(map)].sort()).toEqual(every);

    act(() => map.dragTo(LISBON_VIEW));
    act(() => map.dragTo({ west: -180, south: -85, east: 180, north: 85 }, 1));
    expect(screen.queryByRole("button", { name: copy.map.searchArea })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.map.noneInArea)).not.toBeInTheDocument();
    expect([...pinAddresses(map)].sort()).toEqual(every);
    expect(pinSource(map).setData).not.toHaveBeenCalled();

    await user.click(await findPin("Lisbon place 1"));
    expect(within(screen.getByRole("region", { name: copy.map.selected })).getByRole("link", { name: "Lisbon place 1" })).toBeInTheDocument();
  });

  it("asks for the device's location with Locate me, and goes there", async () => {
    const user = userEvent.setup();
    const getCurrentPosition = vi.fn((done: PositionCallback) =>
      done({ coords: { latitude: 38.72, longitude: -9.14 } } as GeolocationPosition),
    );
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    const { map } = await openApp("/map", { events: [...fixtures, ...lisbon] });

    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(map.easeTo).toHaveBeenLastCalledWith({ center: [-9.14, 38.72], zoom: 13 }));
    expect(await screen.findByRole("img", { name: copy.map.youAreHere })).toBeInTheDocument();
    await waitFor(() => expect(pinAddresses(map)).toContain(parsePlaces(lisbon)[0]!.address));

    // Moved away and asked again: back to where the person is.
    act(() => map.dragTo({ west: -9.6, south: 38.9, east: -9.5, north: 39 }));
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: copy.map.searchArea })).not.toBeInTheDocument();
  });

  it("zooms in on a cluster when it is tapped", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/map");
    map.features = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [HERE.lon, HERE.lat] },
        properties: { cluster: true, cluster_id: 3, point_count: 12 },
      },
    ];
    act(() => map.fire("render"));
    await user.click(screen.getByRole("button", { name: "12 places here, zoom in" }));
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [HERE.lon, HERE.lat], zoom: 16 }));
    expect(screen.queryByRole("button", { name: copy.map.searchArea })).not.toBeInTheDocument();
  });

  it("goes to the desktop's Explore at a desktop's width, which has the map beside the list", async () => {
    const { router } = await openApp("/map", { px: DESKTOP });
    expect(router.state.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { level: 1, name: copy.pages.explore })).toBeInTheDocument();
  });
});

// ---- Explore on a desktop ----

describe("Explore on a desktop", () => {
  const list = () => screen.getByRole("list");
  const cards = () => within(list()).getAllByRole("link");
  const menus = () => screen.getByRole("group", { name: copy.explore.filtersLabel });

  it("at 1360 px has the list, 520 px wide, beside the map, with the filter menus above the list", async () => {
    const { map } = await openApp("/", { px: DESKTOP });
    const column = list().closest("section")!;
    expect(column).toHaveClass("w-list", "shrink-0", "overflow-y-auto");
    const mapArea = mapAttribution().closest(".bg-map-land")!;
    expect(mapArea).toContainElement(map.container);
    expect(mapArea).toHaveClass("flex-1");
    expect(column.compareDocumentPosition(mapArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(column.parentElement).toBe(mapArea.parentElement);

    expect(column).toContainElement(menus());
    expect(menus().compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const buttons = within(menus()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Open now", "Kind of place", "Distance", "Sort: distance"]);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
    for (const button of buttons.slice(1)) expect(button).toHaveAttribute("aria-expanded", "false");

    // One search and one toggle: the top bar's.
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: copy.view.label })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
  });

  it("lists what the phone's Explore lists, as cards, and pins every place", async () => {
    const { map } = await openApp("/", { px: DESKTOP });
    const entries = groupForList(idx.near(HERE.lat, HERE.lon, HERE.radiusKm), idx);
    const names = entries.map((entry) => ("chain" in entry ? entry.chain.name : entry.place.name));
    expect(cards().map(nameOf)).toEqual(names.slice(0, 30));
    expect(pinAddresses(map)).toHaveLength(fixturePlaces.length);
    const houseLine = screen.getByRole("link", { name: copy.explore.howThisWorks }).parentElement!;
    expect(houseLine).toHaveTextContent(
      `${copy.deskExplore.count(fixturePlaces.length)} ${copy.explore.houseLine} How this works`,
    );
    expect(screen.getByRole("link", { name: copy.common.aboutData })).toHaveAttribute("href", "/about");
  });

  it("puts the house's badge beside its name in the line over the list, as the phone does", async () => {
    await openApp("/", { px: DESKTOP });
    const houseLine = (await screen.findByRole("link", { name: copy.explore.howThisWorks })).parentElement!;
    const badges = houseLine.querySelectorAll("img");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute("alt", "");
    expect(badges[0]).toHaveAttribute("src", houseBadge64);
    expect(badges[0]).toHaveClass("size-5", "rounded-full");
    expect(badges[0]!.parentElement!.textContent).toBe(copy.house.name);
  });

  it("keeps Open now in the address, as the search does, and lists only the places that are open", async () => {
    const user = userEvent.setup();
    const { router, map } = await openApp("/", { px: DESKTOP });
    await user.click(within(menus()).getByRole("button", { name: "Open now" }));
    expect(router.state.location.search).toBe("?open=1");
    expect(within(menus()).getByRole("button", { name: "Open now" })).toHaveAttribute("aria-pressed", "true");
    const closed = fixturePlaces.filter((each) => openState(each, MORNING).kind === "closed");
    expect(closed.length).toBeGreaterThan(0);
    for (const each of closed) expect(cards().map(nameOf)).not.toContain(each.name);
    // The pins drawn on their own are the open places; the map's data is still every place, so a
    // bubble's count still has the closed places in it.
    const drawnPins = () =>
      FakeMarker.instances.filter((marker) => marker.map !== undefined && marker.element.querySelector("button[aria-pressed]") !== null);
    await waitFor(() => expect(drawnPins()).toHaveLength(fixturePlaces.length - closed.length));
    expect(pinAddresses(map)).toHaveLength(fixturePlaces.length);
  });

  it("chooses kinds of place in a menu, which the address keeps; the phone's filters read the same address", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/", { px: DESKTOP });
    const kinds = within(menus()).getByRole("button", { name: "Kind of place" });
    await user.click(kinds);
    expect(kinds).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("group", { name: copy.filters.kinds });
    await user.click(within(panel).getByRole("button", { name: "Cafes" }));
    expect(router.state.location.search).toBe("?kinds=cafes");
    // The menu's button says what is chosen; the panel, still open for another kind, has a Cafes of its own.
    expect(within(menus()).getByRole("button", { name: "Cafes", expanded: true })).toBeInTheDocument();
    for (const card of cards()) {
      expect(card).toHaveAccessibleDescription(/^Cafe|^Coffee shop/);
    }

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: copy.filters.kinds })).not.toBeInTheDocument();
    expect(within(menus()).getByRole("button", { name: "Cafes" })).toHaveFocus();
    // What the phone's filters page reads from an address is what the menus wrote.
    expect(filtersFromParams(new URLSearchParams(router.state.location.search), "en-US").families).toEqual(["cafes"]);
  });

  it("reads the filters the phone's filters page writes, and names the kinds menu for how many are chosen", async () => {
    const address = withFilters(new URLSearchParams(), { open: false, families: ["cafes", "bars"], withinKm: 4.8 }, "en-US");
    await openApp(`/?${address}`, { px: DESKTOP });
    expect(within(menus()).getByRole("button", { name: "Kind of place · 2" })).toBeInTheDocument();
    expect(within(menus()).getByRole("button", { name: "Within 3 mi" })).toBeInTheDocument();
    for (const card of cards()) expect(card).toHaveAccessibleDescription(/^(Cafe|Coffee shop|Bar|Pub)/);
  });

  it("limits the distance and sorts from menus, each named for what it is set to", async () => {
    const user = userEvent.setup();
    const { router } = await openApp("/?within=1&sort=name", { px: DESKTOP });
    expect(within(menus()).getByRole("button", { name: "Within 1 mi" })).toBeInTheDocument();
    expect(within(menus()).getByRole("button", { name: "Sort: name" })).toBeInTheDocument();
    const names = cards().map(nameOf);
    expect(names).toEqual([...names].sort(new Intl.Collator("en").compare));

    await user.click(within(menus()).getByRole("button", { name: "Within 1 mi" }));
    await user.click(within(screen.getByRole("group", { name: copy.filters.distance })).getByRole("button", { name: "3 mi" }));
    expect(new URLSearchParams(router.state.location.search).get("within")).toBe("4.8");
    expect(screen.queryByRole("group", { name: copy.filters.distance })).not.toBeInTheDocument();

    await user.click(within(menus()).getByRole("button", { name: "Sort: name" }));
    await user.click(within(screen.getByRole("group", { name: copy.filters.sortBy })).getByRole("button", { name: "Distance" }));
    expect(new URLSearchParams(router.state.location.search).get("sort")).toBe("distance");
  });

  it("closes a menu when the person clicks outside it", async () => {
    const user = userEvent.setup();
    await openApp("/", { px: DESKTOP });
    await user.click(within(menus()).getByRole("button", { name: "Sort: distance" }));
    expect(screen.getByRole("group", { name: copy.filters.sortBy })).toBeInTheDocument();
    await user.click(list());
    expect(screen.queryByRole("group", { name: copy.filters.sortBy })).not.toBeInTheDocument();
  });

  it("highlights a card's pin while the card is hovered or focused", async () => {
    const user = userEvent.setup();
    await openApp("/", { px: DESKTOP });
    const ring = await findPin("Jacafé");
    expect(look(ring)).toHaveClass("border-muted");

    const card = within(list()).getByRole("link", { name: "Jacafé" });
    await user.hover(card);
    expect(look(pin("Jacafé"))).toHaveClass("border-accent");
    await user.unhover(card);
    expect(look(pin("Jacafé"))).toHaveClass("border-muted");

    act(() => card.focus());
    expect(look(pin("Jacafé"))).toHaveClass("border-accent");
    act(() => card.blur());
    expect(look(pin("Jacafé"))).toHaveClass("border-muted");
  });

  it("gives a pin's card the dark outline when the pin is clicked, and brings the card into view", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await openApp("/", { px: DESKTOP });
      const card = within(list()).getByRole("link", { name: "Jacafé" });
      expect(card).not.toHaveClass("border-2");

      await user.click(await findPin("Jacafé"));
      expect(card).toHaveClass("border-2", "border-ink");
      expect(scrollIntoView).toHaveBeenCalled();
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(card.closest("li"));

      await user.click(pin("Museu Café"));
      expect(card).not.toHaveClass("border-2");
      expect(within(list()).getByRole("link", { name: "Museu Café" })).toHaveClass("border-2", "border-ink");
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("shows more of the list to reach a pin's card that is not shown yet", async () => {
    const user = userEvent.setup();
    const far = Array.from({ length: 40 }, (_, i) =>
      variant(nameOnly, { d: `far-${i}`, name: `Far place ${String(i + 1).padStart(2, "0")}`, lat: String(HERE.lat + 0.05 + i * 0.001), lon: String(HERE.lon) }),
    );
    await openApp("/", { px: DESKTOP, events: [...fixtures, ...far] });
    expect(within(list()).queryByRole("link", { name: "Far place 40" })).not.toBeInTheDocument();
    await user.click(await findPin("Far place 40"));
    expect(within(list()).getByRole("link", { name: "Far place 40" })).toHaveClass("border-2", "border-ink");
  });

  it("searches the area the person moved the map to, in the list too", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    expect(cards().map(nameOf).sort()).toEqual(["Lisbon place 1", "Lisbon place 2", "Lisbon place 3"]);
  });
});

// ---- Round 1 of the review ----

/** Whether an element is a pin, or inside one: in one of the map's markers. */
const inMarker = (element: Element | null) =>
  element !== null && FakeMarker.instances.some((marker) => marker.element.contains(element));

/** The browser says the device is at this point whenever it is asked. */
function deviceAt(lat: number, lon: number) {
  const getCurrentPosition = vi.fn((done: PositionCallback) =>
    done({ coords: { latitude: lat, longitude: lon } } as GeolocationPosition),
  );
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
  return getCurrentPosition;
}

/** The `count`th map made, once its pins are on it: a page that comes back makes a new one. */
async function mapNumber(count: number): Promise<FakeMap> {
  return waitFor(() => {
    const map = FakeMap.instances[count - 1];
    if (map === undefined || !map.sources.has(PIN_SOURCE)) throw new Error(`No map ${count} with pins yet`);
    return map;
  });
}

/** A view a little east of the middle of Funchal, which still has the middle in it. */
const EAST_OF_FUNCHAL = { west: -16.93, south: 32.63, east: -16.85, north: 32.67 };

describe("the map and the keyboard", () => {
  it("reaches the search, the toggle and the map's controls before the map and its pins", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/map");
    await findPin("Jacafé");
    const reached: Element[] = [];
    while (!inMarker(document.activeElement) && reached.length < 20) {
      await user.tab();
      reached.push(document.activeElement!);
    }
    const at = (element: Element) => reached.indexOf(element);
    const firstPin = reached.findIndex(inMarker);
    expect(firstPin).toBeGreaterThan(0);
    expect(at(screen.getByRole("link", { name: `${copy.search.label}: ${copy.search.placeholder}` }))).toBe(0);
    for (const control of [
      screen.getByRole("button", { name: copy.view.house }),
      screen.getByRole("button", { name: copy.location.useMine }),
      within(mapAttribution()).getByRole("link", { name: "MapTiler" }),
      map.canvas,
    ]) {
      expect(at(control)).toBeGreaterThan(-1);
      expect(at(control)).toBeLessThan(firstPin);
    }
  });

  it("puts the docked card before the pins", async () => {
    const user = userEvent.setup();
    await openApp("/map");
    await user.click(await findPin("Jacafé"));
    const card = screen.getByRole("link", { name: "Jacafé" });
    expect(card.compareDocumentPosition(pin("Jacafé")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves the pins out of view out of the keyboard's order", async () => {
    const { map } = await openApp("/map");
    await findPin("Jacafé");
    expect(pin("Museu Café")).not.toHaveAttribute("tabindex", "-1");
    const jacafe = place("Jacafé");
    map.bounds = { west: jacafe.lon - 5e-4, east: jacafe.lon + 5e-4, south: jacafe.lat - 5e-4, north: jacafe.lat + 5e-4 };
    act(() => map.fire("render"));
    expect(pin("Jacafé")).not.toHaveAttribute("tabindex", "-1");
    expect(pin("Museu Café")).toHaveAttribute("tabindex", "-1");
    for (const each of screen.getAllByRole("button", { name: /^A Confeitaria Coffee & Bakery,/ })) {
      expect(each).toHaveAttribute("tabindex", "-1");
    }
  });

  it("leaves out of the keyboard's order the pins under what floats over the map", async () => {
    // A browser that lays the page out: the map 800 px tall, the controls over its top 200 px, the
    // attribution and the card over its bottom 100 px.
    const rects = new Map<Element, Partial<DOMRect>>();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, ...rects.get(this) } as DOMRect;
    });
    const observed: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const funchal: [number, number] = [HERE.lon, HERE.lat];
    const pins: Pin[] = [
      { address: "under-controls", lat: 32.675, lon: -16.91, name: "Under the controls, Cafe, Hours not listed, no reviews yet" },
      { address: "clear", lat: 32.65, lon: -16.91, name: "In the clear, Cafe, Hours not listed, no reviews yet" },
      { address: "under-card", lat: 32.622, lon: -16.91, name: "Under the card, Cafe, Hours not listed, no reviews yet" },
    ];
    const { container } = render(
      <BaseMap center={funchal} zoom={13} interactive pins={pins} onSelect={() => {}} below={<p>card</p>}>
        <div>controls</div>
      </BaseMap>,
    );
    const map = await theMap();
    const root = container.firstElementChild!;
    rects.set(root, { top: 0, bottom: 800, height: 800 });
    rects.set(screen.getByText("controls"), { top: 16, bottom: 200, height: 184 });
    rects.set(mapAttribution().parentElement!, { top: 700, bottom: 788, height: 88 });
    act(() => {
      for (const callback of observed) callback();
      map.fire("render");
    });
    expect(pin("Under the controls")).toHaveAttribute("tabindex", "-1");
    expect(pin("In the clear")).not.toHaveAttribute("tabindex");
    expect(pin("Under the card")).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the focus in the map when a bubble is opened from the keyboard", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/map");
    map.features = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [HERE.lon, HERE.lat] },
        properties: { cluster: true, cluster_id: 3, point_count: 12 },
      },
    ];
    act(() => map.fire("render"));
    act(() => screen.getByRole("button", { name: "12 places here, zoom in" }).focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(map.easeTo).toHaveBeenCalled());
    expect(document.activeElement).toBe(map.canvas);
    expect(map.canvas).toHaveAccessibleName(copy.map.label);

    // The bubble opens up into its pins; the focus stays where it is.
    map.features = undefined;
    act(() => map.fire("render"));
    expect(document.activeElement).toBe(map.canvas);
  });

  it("moves the focus to the docked card when a pin is chosen from the keyboard, not from a tap", async () => {
    const user = userEvent.setup();
    await openApp("/map");
    const jacafe = await findPin("Jacafé");
    act(() => jacafe.focus());
    await user.keyboard("{Enter}");
    const region = screen.getByRole("region", { name: copy.map.selected });
    const card = within(region).getByRole("link", { name: "Jacafé" });
    expect(card).toHaveFocus();
    expect(pin("Jacafé")).toHaveAttribute("aria-controls", region.id);
    expect(pin("Museu Café")).toHaveAttribute("aria-controls", region.id);

    await user.click(pin("Museu Café"));
    expect(within(region).getByRole("link", { name: "Museu Café" })).toBeInTheDocument();
    expect(pin("Museu Café")).toHaveFocus();
  });

  it("on a desktop, moves the focus to the pin's card in the list when it is chosen from the keyboard", async () => {
    const user = userEvent.setup();
    await openApp("/", { px: DESKTOP });
    const jacafe = await findPin("Jacafé");
    const list = screen.getByRole("list");
    expect(jacafe).toHaveAttribute("aria-controls", list.id);
    act(() => jacafe.focus());
    await user.keyboard("{Enter}");
    expect(within(list).getByRole("link", { name: "Jacafé" })).toHaveFocus();
  });
});

describe("distances on the map's pages, when the device has said where the person is", () => {
  it("are from the device on the docked card, wherever the map is", async () => {
    const user = userEvent.setup();
    deviceAt(HERE.lat, HERE.lon);
    const { map } = await openApp("/map");
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    await screen.findByRole("img", { name: copy.map.youAreHere });

    act(() => map.dragTo(EAST_OF_FUNCHAL));
    await user.click(await findPin("Jacafé"));
    const jacafe = place("Jacafé");
    const fromDevice = formatDistance(distanceKm(HERE.lat, HERE.lon, jacafe.lat, jacafe.lon), "en-US");
    const fromCentre = formatDistance(distanceKm(32.65, -16.89, jacafe.lat, jacafe.lon), "en-US");
    expect(fromDevice).not.toBe(fromCentre);
    expect(screen.getByRole("link", { name: "Jacafé" })).toHaveAccessibleDescription(expect.stringContaining(` · ${fromDevice} `));
  });

  it("are from the device in the desktop's list, which is nearest the device first and limited from it", async () => {
    const user = userEvent.setup();
    deviceAt(HERE.lat, HERE.lon);
    const { map } = await openApp("/?within=0.8", { px: DESKTOP });
    await user.click(screen.getByRole("button", { name: "Near Funchal" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: copy.location.useMine }));
    await screen.findByRole("img", { name: copy.map.youAreHere });

    act(() => map.dragTo(EAST_OF_FUNCHAL));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));

    const rows = placesInBox(idx, [EAST_OF_FUNCHAL.west, EAST_OF_FUNCHAL.south, EAST_OF_FUNCHAL.east, EAST_OF_FUNCHAL.north])
      .map((each) => ({ place: each, km: distanceKm(HERE.lat, HERE.lon, each.lat, each.lon) }))
      .filter((row) => row.km <= 0.8)
      .sort((a, b) => a.km - b.km);
    const names = groupForList(rows, idx).map((entry) => ("chain" in entry ? entry.chain.name : entry.place.name));
    expect(names.length).toBeGreaterThan(3);
    const cards = within(screen.getByRole("list")).getAllByRole("link");
    expect(cards.map(nameOf)).toEqual(names.slice(0, 30));
    expect(cards[0]).toHaveAccessibleDescription(expect.stringContaining(` · ${formatDistance(rows[0]!.km, "en-US")} `));
  });

  it("put no limit on a searched area at the widest distance, however far it is from the device", async () => {
    const user = userEvent.setup();
    deviceAt(HERE.lat, HERE.lon);
    const { map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
    await user.click(screen.getByRole("button", { name: "Near Funchal" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: copy.location.useMine }));
    await screen.findByRole("img", { name: copy.map.youAreHere });

    act(() => map.dragTo(LISBON_VIEW));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    expect(within(screen.getByRole("list")).getAllByRole("link").map(nameOf).sort()).toEqual([
      "Lisbon place 1",
      "Lisbon place 2",
      "Lisbon place 3",
    ]);
  });
});

describe("an area searched on the map with nothing to show", () => {
  it("says so on a desktop, in place of the list", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/", { px: DESKTOP });
    act(() => map.dragTo({ west: -20.1, south: 30, east: -20, north: 30.1 }));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    expect(screen.getByText(copy.map.noneInArea)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    // The map still has every place on it, elsewhere.
    expect(pinAddresses(map)).toHaveLength(fixturePlaces.length);
  });

  it("names the area, not the town, when the desktop's filters leave none of it", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/?kinds=cafes", { px: DESKTOP, events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    expect(screen.getByText(copy.search.noResultsFiltered(copy.map.thisArea), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(copy.search.noResultsFiltered("Funchal"), { exact: false })).not.toBeInTheDocument();
  });
});

describe("the map on Back", () => {
  it("comes back on the phone where it was, at its zoom", async () => {
    const user = userEvent.setup();
    const { router, map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW, 15));
    await user.click(await findPin("Lisbon place 1"));
    await user.click(screen.getByRole("link", { name: "Lisbon place 1" }));
    expect(router.state.location.pathname).toBe("/place/lisbon-0");
    expect(map.remove).toHaveBeenCalled();

    await act(() => router.navigate(-1));
    // The first map was Explore's, the second the place page's own.
    const back = await mapNumber(3);
    expect(back.options).toMatchObject({ center: [-9.14, 38.72], zoom: 15 });
    expect(pinAddresses(back)).toEqual(expect.arrayContaining(parsePlaces(lisbon).map((each) => each.address)));
    expect(back.easeTo).not.toHaveBeenCalled();
    // Kept in memory, not on the device: a reload starts again where the person is near.
    expect([...Object.keys(window.sessionStorage), ...Object.keys(window.localStorage)].filter((key) => /map|area/i.test(key))).toEqual([]);
  });

  it("comes back on a desktop where it was, with the list of the area that was searched", async () => {
    const user = userEvent.setup();
    const { router, map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW, 14));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    await user.click(within(screen.getByRole("list")).getByRole("link", { name: "Lisbon place 2" }));
    expect(router.state.location.pathname).toBe("/place/lisbon-1");

    await act(() => router.navigate(-1));
    // The first map was Explore's, the second the place page's own.
    const back = await mapNumber(3);
    expect(back.options).toMatchObject({ center: [-9.14, 38.72], zoom: 14 });
    expect(within(screen.getByRole("list")).getAllByRole("link").map(nameOf).sort()).toEqual([
      "Lisbon place 1",
      "Lisbon place 2",
      "Lisbon place 3",
    ]);
  });

  it("starts where the person is near on a new visit to the page", async () => {
    const { router, map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW, 15));
    await act(() => router.navigate("/saved"));
    await act(() => router.navigate("/map"));
    const fresh = await mapNumber(2);
    expect(fresh.options).toMatchObject({ center: [HERE.lon, HERE.lat], zoom: 13 });
    expect(pinAddresses(fresh)).toContain(place("Jacafé").address);
  });
});

// ---- Every place on the map, at any zoom (decision 25) ----

describe("every place on Explore's maps, at any zoom (decision 25)", () => {
  /** The whole world, as a map zoomed all the way out gives it. */
  const WORLD = { west: -180, south: -85, east: 180, north: 85 };

  /** 120 places over the world, none near another and none sharing a name: no chains among them. */
  const worldwide = Array.from({ length: 120 }, (_, i) =>
    variant(nameOnly, {
      d: `world-${i}`,
      name: `World place ${String(i).padStart(3, "0")}`,
      lat: String(-50 + (i % 10) * 11),
      lon: String(-175 + Math.floor(i / 10) * 29),
    }),
  );
  const everyone = [...fixtures, ...lisbon, ...worldwide];
  /** 600 places over the world, spread wider still. */
  const many = Array.from({ length: 600 }, (_, i) =>
    variant(nameOnly, {
      d: `many-${i}`,
      name: `Many place ${i}`,
      lat: String(-60 + (i % 30) * 4.1),
      lon: String(-170 + Math.floor(i / 30) * 17),
    }),
  );
  /** 300 places in the middle of Funchal, in the map's first view: more than a map draws at once. */
  const crowd = Array.from({ length: 300 }, (_, i) =>
    variant(nameOnly, {
      d: `crowd-${i}`,
      name: `Crowd place ${i}`,
      lat: String(32.63 + (i % 20) * 0.002),
      lon: String(-16.94 + Math.floor(i / 20) * 0.004),
    }),
  );
  const everyPlace = parsePlaces(everyone);
  const everyIdx = buildIndexes(everyPlace);
  const allAddresses = everyPlace.map((each) => each.address).sort();

  const searchArea = () => screen.getByRole("button", { name: copy.map.searchArea });
  const list = () => screen.getByRole("list");
  const cards = () => within(list()).getAllByRole("link");
  const houseLine = () => screen.getByRole("link", { name: copy.explore.howThisWorks }).parentElement!;
  const sortedPins = (map: FakeMap) => [...pinAddresses(map)].sort();
  /** The names a list of entries shows, a chain by its own. */
  const namesOf = (entries: ReturnType<typeof groupForList>) =>
    entries.map((entry) => ("chain" in entry ? entry.chain.name : entry.place.name));

  /** A point of the map's source on its own, as `querySourceFeatures` gives it. */
  const pointOf = (each: Place): FakeFeature => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [each.lon, each.lat] },
    properties: { address: each.address },
  });
  const bubbleOf = (lon: number, lat: number, count: number): FakeFeature => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { cluster: true, cluster_id: 9, point_count: count },
  });

  /** The addresses each `want` of the scores store was asked, in order, leaving out asks of nothing. */
  const asks = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([addresses]) => [...(addresses as Iterable<string>)]).filter((addresses) => addresses.length > 0);

  describe("the pins", () => {
    it("are every place, on the phone's map, before and after the person zooms out to the world", async () => {
      const { map } = await openApp("/map", { events: everyone });
      expect(sortedPins(map)).toEqual(allAddresses);

      act(() => map.dragTo(WORLD, 1));
      expect(sortedPins(map)).toEqual(allAddresses);
      // The same places: the map's source is never sent them again.
      expect(pinSource(map).setData).not.toHaveBeenCalled();
    });

    it("are every place on the desktop's map too, whatever the list holds", async () => {
      const user = userEvent.setup();
      const { map } = await openApp("/", { px: DESKTOP, events: everyone });
      expect(sortedPins(map)).toEqual(allAddresses);
      act(() => map.dragTo(WORLD, 1));
      await user.click(searchArea());
      expect(sortedPins(map)).toEqual(allAddresses);
      expect(pinSource(map).setData).not.toHaveBeenCalled();
    });

    it("are the places of the kinds chosen on the desktop, the same data for as long as the kinds are", async () => {
      const user = userEvent.setup();
      const cafes = (each: Place) => kindOf(each.category).family === "cafes";
      const { map } = await openApp("/?kinds=cafes", { px: DESKTOP, events: everyone });
      expect(sortedPins(map)).toEqual(everyPlace.filter(cafes).map((each) => each.address).sort());

      // Moving, searching and another sort keep the source as it is.
      act(() => map.dragTo(WORLD, 1));
      await user.click(searchArea());
      const menus = screen.getByRole("group", { name: copy.explore.filtersLabel });
      await user.click(within(menus).getByRole("button", { name: "Sort: distance" }));
      await user.click(within(screen.getByRole("group", { name: copy.filters.sortBy })).getByRole("button", { name: "Name" }));
      expect(pinSource(map).setData).not.toHaveBeenCalled();

      // Another kind is new data, sent once.
      await user.click(within(menus).getByRole("button", { name: "Cafes" }));
      await user.click(within(screen.getByRole("group", { name: copy.filters.kinds })).getByRole("button", { name: "Restaurants" }));
      await waitFor(() => expect(pinSource(map).setData).toHaveBeenCalledTimes(1));
      const both = (each: Place) => ["cafes", "restaurants"].includes(kindOf(each.category).family);
      expect(sortedPins(map)).toEqual(everyPlace.filter(both).map((each) => each.address).sort());
    });

    it("are the places within the distance chosen on the desktop, as the list's are", async () => {
      const { map } = await openApp("/?within=0.8", { px: DESKTOP });
      const near = fixturePlaces.filter((each) => distanceKm(HERE.lat, HERE.lon, each.lat, each.lon) <= 0.8);
      expect(near.length).toBeGreaterThan(3);
      expect(near.length).toBeLessThan(fixturePlaces.length);
      expect(sortedPins(map)).toEqual(near.map((each) => each.address).sort());
    });

    it("are each place of a chain on its own, with the place's own name", async () => {
      await openApp("/map");
      await findPin("Jacafé");
      const confeitaria = screen.getAllByRole("button", { name: /^A Confeitaria Coffee & Bakery,/ });
      expect(confeitaria).toHaveLength(4);
      for (const each of confeitaria) expect(each).not.toHaveAccessibleName(/a chain/);
      expect(screen.queryByText(/^×\d/)).not.toBeInTheDocument();
    });

    it("work out the hours of the pins drawn on their own, not of every place", async () => {
      const hours = vi.spyOn(hoursModule, "openState");
      const { map } = await openApp("/map", { events: [...fixtures, ...crowd, ...many] });
      await screen.findAllByRole("button", { name: /^Crowd place \d+,/ });
      expect(pinAddresses(map)).toHaveLength(fixtures.length + crowd.length + many.length);
      // The pins drawn, at most MAX_MARKERS of them; never the 343 places near, nor the 943 in all.
      expect(hours.mock.calls.length).toBeGreaterThan(0);
      expect(hours.mock.calls.length).toBeLessThanOrEqual(MAX_MARKERS);
    });

    it("leave the desktop's search results map with the results alone, a chain as one pin", async () => {
      const { map } = await openApp("/search?q=confeitaria", { px: DESKTOP, events: everyone });
      const chain = everyIdx.chains.get("PT:a confeitaria coffee & bakery")!;
      const nearest = groupForList(everyIdx.search("confeitaria", { lat: HERE.lat, lon: HERE.lon, radiusKm: 25 }), everyIdx).map((entry) =>
        "chain" in entry ? entry.nearby[0]!.place.address : entry.place.address,
      );
      expect(pinAddresses(map)).toEqual(nearest);
      expect(pinAddresses(map)).not.toContain(parsePlaces(lisbon)[0]!.address);
      expect(await findPin("A Confeitaria Coffee & Bakery")).toHaveAccessibleName(
        `A Confeitaria Coffee & Bakery, a chain, ${chain.places.length} locations nearby`,
      );
    });
  });

  describe("the list of an area searched on the map", () => {
    it("is the 50 places nearest the middle of a world-wide box, with how many are in view", async () => {
      const user = userEvent.setup();
      const { map } = await openApp("/", { px: DESKTOP, events: everyone });
      act(() => map.dragTo(WORLD, 1));
      await user.click(searchArea());

      // No device: the distances, and the nearest, are from the middle of the view.
      const rows = everyPlace
        .map((each) => ({ place: each, km: distanceKm(0, 0, each.lat, each.lon) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, LIST_LIMIT);
      const expected = namesOf(groupForList(rows, everyIdx));
      expect(cards().map(nameOf)).toEqual(expected.slice(0, 30));
      await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
      expect(cards().map(nameOf)).toEqual(expected);
      expect(screen.queryByRole("button", { name: copy.explore.showMore })).not.toBeInTheDocument();

      expect(houseLine()).toHaveTextContent(
        `${copy.deskExplore.inArea(everyPlace.length)} ${copy.explore.houseLine} How this works`,
      );
      // It says the area that was searched: a pan since does not make it wrong.
      expect(copy.deskExplore.inArea(2345)).toBe("2,345 places in this area. Zoom in to see the rest.");
      expect(cards()[0]).toHaveAccessibleDescription(expect.stringContaining(` · ${formatDistance(rows[0]!.km, "en-US")} `));
    });

    it("says how many places as it always has when it lists every place in view", async () => {
      const user = userEvent.setup();
      const { map } = await openApp("/", { px: DESKTOP, events: everyone });
      act(() => map.dragTo(LISBON_VIEW));
      await user.click(searchArea());
      expect(cards().map(nameOf).sort()).toEqual(["Lisbon place 1", "Lisbon place 2", "Lisbon place 3"]);
      expect(houseLine()).toHaveTextContent(`${copy.deskExplore.count(3)} ${copy.explore.houseLine}`);
      expect(houseLine()).not.toHaveTextContent(/in this area/);
    });

    it("counts the places the filters leave, and lists the nearest 50 of them", async () => {
      const user = userEvent.setup();
      const { map } = await openApp("/?sort=name", { px: DESKTOP, events: everyone });
      act(() => map.dragTo(WORLD, 1));
      await user.click(searchArea());
      const nearest = new Set(
        everyPlace
          .map((each) => ({ each, km: distanceKm(0, 0, each.lat, each.lon) }))
          .sort((a, b) => a.km - b.km)
          .slice(0, LIST_LIMIT)
          .map(({ each }) => each.name),
      );
      await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
      const names = cards().map(nameOf);
      // A to Z, as the menu says, among the 50 nearest the middle.
      expect(names).toEqual([...names].sort(new Intl.Collator("en").compare));
      for (const name of names) {
        if (name !== "A Confeitaria Coffee & Bakery") expect(nearest).toContain(name);
      }
      expect(houseLine()).toHaveTextContent(copy.deskExplore.inArea(everyPlace.length));
    });

    it("says the count in a polite status, alone, and not again as Open now's minutes pass", async () => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      try {
        const { map } = await openApp("/?open=1", { px: DESKTOP, events: everyone });
        act(() => map.dragTo(WORLD, 1));
        await user.click(searchArea());
        const status = within(houseLine()).getByRole("status");
        // Places of the kinds and distance chosen: it does not say how many are open, which would need every place's hours.
        expect(status).toHaveTextContent(new RegExp(`^${literal(copy.deskExplore.inArea(everyPlace.length))}$`));
        expect(within(status).queryByRole("link")).not.toBeInTheDocument();

        // A minute on, the list is worked out again; the line is the same, and nothing in it changes to be said again.
        const changes: MutationRecord[] = [];
        const watch = new MutationObserver((records) => changes.push(...records));
        watch.observe(status, { subtree: true, childList: true, characterData: true });
        vi.setSystemTime(new Date(MORNING.getTime() + 60_000));
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        await act(async () => {});
        watch.disconnect();
        expect(within(houseLine()).getByRole("status")).toBe(status);
        expect(changes).toEqual([]);
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }
    });

    it("says the town's count with Open now when the person changes the list, and not as the minutes pass", async () => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      try {
        // A time later in the day when the town has another number of places open.
        const town = idx.near(HERE.lat, HERE.lon, HERE.radiusKm);
        const openAt = (at: Date) => town.filter(({ place: each }) => openState(each, at).kind !== "closed").length;
        let later = MORNING;
        for (let minutes = 15; openAt(later) === openAt(MORNING) && minutes < 24 * 60; minutes += 15) {
          later = new Date(MORNING.getTime() + minutes * 60_000);
        }
        expect(openAt(later)).not.toBe(openAt(MORNING));

        await openApp("/?open=1", { px: DESKTOP });
        const status = within(houseLine()).getByRole("status");
        expect(status).toHaveTextContent(new RegExp(`^${literal(copy.deskExplore.count(openAt(MORNING)))}$`));

        // The minutes pass: the line shows the new count, and the status has nothing new to say.
        const changes: MutationRecord[] = [];
        const watch = new MutationObserver((records) => changes.push(...records));
        watch.observe(status, { subtree: true, childList: true, characterData: true });
        vi.setSystemTime(later);
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        await act(async () => {});
        watch.disconnect();
        expect(houseLine()).toHaveTextContent(copy.deskExplore.count(openAt(later)));
        expect(within(houseLine()).getByRole("status")).toBe(status);
        expect(changes).toEqual([]);

        // The person turns Open now off: the status says the town's count.
        const menus = screen.getByRole("group", { name: copy.explore.filtersLabel });
        await user.click(within(menus).getByRole("button", { name: "Open now" }));
        expect(within(houseLine()).getByRole("status")).toHaveTextContent(new RegExp(`^${literal(copy.deskExplore.count(fixturePlaces.length))}$`));
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }
    });

    it("lists, with Open now, the 50 open places nearest the middle, working out the hours of only those it reaches", async () => {
      const user = userEvent.setup();
      const events = [...everyone, ...crowd, ...many];
      const all = parsePlaces(events);
      const allIdx = buildIndexes(all);
      const { map } = await openApp("/?open=1", { px: DESKTOP, events });
      act(() => map.dragTo(WORLD, 1));
      // Nothing drawn on its own, so the pins work out no hours meanwhile.
      map.features = [bubbleOf(0, 0, all.length)];
      act(() => map.fire("render"));
      const hours = vi.spyOn(hoursModule, "openState");
      await user.click(searchArea());
      expect(hours.mock.calls.length).toBeGreaterThan(LIST_LIMIT);
      expect(hours.mock.calls.length).toBeLessThan(all.length / 2);

      const open = all
        .map((each) => ({ place: each, km: distanceKm(0, 0, each.lat, each.lon) }))
        .sort((a, b) => a.km - b.km)
        .filter(({ place: each }) => openState(each, MORNING).kind !== "closed")
        .slice(0, LIST_LIMIT);
      await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
      // The same places (places the same distance away may come in either order), nearest first.
      expect(cards().map(nameOf).sort()).toEqual(namesOf(groupForList(open, allIdx)).sort());
      const shownKm = cards().map((card) => all.find((each) => each.name === nameOf(card))!).map((each) => distanceKm(0, 0, each.lat, each.lon));
      expect(shownKm).toEqual([...shownKm].sort((a, b) => a - b));
      expect(houseLine()).toHaveTextContent(copy.deskExplore.inArea(all.length));
    });

    /** 2,400 places closed all morning round (10.3°N, 10.2°E), on Lagos's clock: more than Open now reads the hours of. */
    const shut = Array.from({ length: 2400 }, (_, i) =>
      variant(nameOnly, {
        d: `shut-${i}`,
        name: `Shut place ${i}`,
        lat: String(10 + (i % 60) * 0.01),
        lon: String(10 + Math.floor(i / 60) * 0.01),
        "opening-hours": "Mo-Su 20:00-22:00",
      }),
    );
    /** Open places at the edge of the box, farther from its middle than every closed one. */
    const openFar = [0, 1, 2].map((i) =>
      variant(nameOnly, { d: `far-open-${i}`, name: `Far open ${i}`, lat: String(10.98 - i * 0.002), lon: "10.98", "opening-hours": "24/7" }),
    );
    const SHUT_BOX = { west: 9.5, south: 9.5, east: 11, north: 11 };

    /** Searches `SHUT_BOX` with Open now, the map drawing no pin on its own; the spy has the hours read by the search. */
    async function searchShutBox(events: NostrEvent[]) {
      const user = userEvent.setup();
      const { map } = await openApp("/?open=1", { px: DESKTOP, events });
      map.features = [bubbleOf(10.25, 10.25, events.length)];
      act(() => map.dragTo(SHUT_BOX, 7));
      const hours = vi.spyOn(hoursModule, "openState");
      await user.click(searchArea());
      return hours;
    }

    it("reads the hours of no more places than Open now allows, and says no open place is near the middle", async () => {
      const hours = await searchShutBox([...fixtures, ...shut, ...openFar]);
      expect(hours.mock.calls.length).toBeGreaterThan(OPEN_NOW_HOURS_LIMIT / 2);
      expect(hours.mock.calls.length).toBeLessThanOrEqual(OPEN_NOW_HOURS_LIMIT);
      // It stopped before the open places at the edge, so it cannot say there are none: it says none is near the middle.
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      expect(screen.getByText(copy.deskExplore.noneOpenNearMiddle)).toBeInTheDocument();
      expect(copy.deskExplore.noneOpenNearMiddle).toBe("No open places near the middle of this area. Zoom in to see more.");
    });

    it("lists the open places it found nearest the middle when it stops reading hours, and says so", async () => {
      const openNear = Array.from({ length: 10 }, (_, i) =>
        variant(nameOnly, { d: `near-open-${i}`, name: `Near open ${i}`, lat: String(10.25 + i * 0.001), lon: "10.25", "opening-hours": "24/7" }),
      );
      const hours = await searchShutBox([...fixtures, ...shut, ...openFar, ...openNear]);
      expect(hours.mock.calls.length).toBeLessThanOrEqual(OPEN_NOW_HOURS_LIMIT + openNear.length);
      expect(cards().map(nameOf).sort()).toEqual(openNear.map((_, i) => `Near open ${i}`).sort());
      const status = within(houseLine()).getByRole("status");
      expect(status).toHaveTextContent(new RegExp(`^${literal(copy.deskExplore.nearestOpen)}$`));
      expect(copy.deskExplore.nearestOpen).toBe("Showing the open places nearest the middle of this area. Zoom in to see more.");
    });

    it("is nearest the middle of the map as drawn", async () => {
      const user = userEvent.setup();
      // One place at the middle of a view from 35°N to 70°N as MapLibre draws it, one at the middle of its latitudes.
      const middles = [
        variant(nameOnly, { d: "drawn-middle", name: "At the drawn middle", lat: "56.3", lon: "10" }),
        variant(nameOnly, { d: "mean-middle", name: "At the mean latitude", lat: "52.5", lon: "10" }),
      ];
      const { map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...middles] });
      act(() => map.dragTo({ west: -10, south: 35, east: 30, north: 70 }, 4, [10, 56.3]));
      await user.click(searchArea());
      expect(cards().map(nameOf)).toEqual(["At the drawn middle", "At the mean latitude"]);
      expect(cards()[0]).toHaveAccessibleDescription(expect.stringContaining(` · ${formatDistance(0, "en-US")} `));
    });

    it("reaches past 25 km from its middle: a searched area has no city's radius", async () => {
      const user = userEvent.setup();
      const spread = [40, 80].map((km) =>
        variant(nameOnly, { d: `spread-${km}`, name: `Spread place ${km} km`, lat: String(38.72 + km / 111.2), lon: "-9.14" }),
      );
      const { map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon, ...spread] });
      act(() => map.dragTo({ west: -10.64, south: 37.72, east: -7.64, north: 39.72 }, 8));
      await user.click(searchArea());
      expect(cards().map(nameOf)).toEqual(["Lisbon place 1", "Lisbon place 2", "Lisbon place 3", "Spread place 40 km", "Spread place 80 km"]);
    });

    it("leaves where the person is near as it was before any search: the town, as far as a city reaches", async () => {
      const far = variant(nameOnly, { d: "far-out", name: "Thirty km out", lat: String(HERE.lat + 30 / 111.2), lon: String(HERE.lon) });
      await openApp("/", { px: DESKTOP, events: [...fixtures, far] });
      await waitFor(() => expect(cards().length).toBeGreaterThan(20));
      expect(cards().map(nameOf)).not.toContain("Thirty km out");
      expect(houseLine()).toHaveTextContent(copy.deskExplore.count(fixturePlaces.length));
    });
  });

  describe("the scores asked for", () => {
    const manyEvents = [...fixtures, ...crowd, ...many];
    const manyPlaces = parsePlaces(manyEvents);

    it("on the phone, are the pins drawn on their own, and never a bubble's places", async () => {
      const want = vi.spyOn(ScoresStore.prototype, "want");
      const { map } = await openApp("/map", { events: manyEvents });
      await screen.findAllByRole("button", { name: /^Crowd place \d+,/ });
      for (const call of asks(want)) expect(call.length).toBeLessThanOrEqual(MAX_MARKERS);

      // Zoomed out: one bubble, and two pins on their own.
      act(() => map.dragTo(WORLD, 1));
      want.mockClear();
      map.features = [bubbleOf(0, 0, manyPlaces.length - 2), pointOf(place("Jacafé")), pointOf(place("Maia"))];
      act(() => map.fire("render"));
      await waitFor(() => expect(asks(want).at(-1)?.sort()).toEqual([place("Jacafé").address, place("Maia").address].sort()));
      for (const call of asks(want)) expect(call.length).toBeLessThanOrEqual(2);
    });

    it("on a desktop, are the places listed and the pins drawn on their own, never every place", async () => {
      const user = userEvent.setup();
      const want = vi.spyOn(ScoresStore.prototype, "want");
      const { map } = await openApp("/", { px: DESKTOP, events: manyEvents });
      await screen.findAllByRole("button", { name: /^Crowd place \d+,/ });
      // Before a search the list is the town's, as it was, and asks for its places as it did.
      act(() => map.dragTo(WORLD, 1));
      want.mockClear();
      await user.click(searchArea());
      await waitFor(() => expect(houseLine()).toHaveTextContent(copy.deskExplore.inArea(manyPlaces.length)));

      // Every ask is the list's (at most 50) or the pins' (at most MAX_MARKERS), with the chosen pin.
      for (const call of asks(want)) expect(call.length).toBeLessThanOrEqual(Math.max(LIST_LIMIT, MAX_MARKERS) + 1);
      expect(new Set(asks(want).flat()).size).toBeLessThan(manyPlaces.length);
      const listedAddresses = new Set(
        everyPlaceRows(manyPlaces)
          .slice(0, LIST_LIMIT)
          .map(({ place: each }) => each.address),
      );
      expect(asks(want)).toContainEqual(expect.arrayContaining([...listedAddresses].filter((address) => !inChain(address))));

      // Zoomed out: one bubble, and one pin on its own. Only that pin is asked about now.
      want.mockClear();
      map.features = [bubbleOf(0, 0, manyPlaces.length - 1), pointOf(place("Jacafé"))];
      act(() => map.fire("render"));
      await waitFor(() => expect(asks(want).at(-1)).toEqual([place("Jacafé").address]));
      expect(asks(want)).toEqual([[place("Jacafé").address]]);
    });

    /** The places nearest the middle of the world, nearest first. */
    function everyPlaceRows(all: Place[]) {
      return all.map((each) => ({ place: each, km: distanceKm(0, 0, each.lat, each.lon) })).sort((a, b) => a.km - b.km);
    }
    /** Whether the place at `address` is one of a chain in the fixtures (its card is the chain's, which asks for none). */
    function inChain(address: string) {
      const found = manyPlaces.find((each) => each.address === address);
      return found !== undefined && idx.chainOf(found) !== undefined;
    }
  });

  it.each([
    ["the phone", PHONE, "/map"],
    ["a desktop", DESKTOP, "/"],
  ])("never sends the map's data again when a pin is chosen and let go, on %s", async (_, px, path) => {
    const user = userEvent.setup();
    const { map } = await openApp(path, { px });
    await user.click(await findPin("Jacafé"));
    expect(pin("Jacafé")).toHaveAttribute("aria-pressed", "true");
    act(() => map.fire("click", { originalEvent: new MouseEvent("click") }));
    expect(pin("Jacafé")).toHaveAttribute("aria-pressed", "false");
    expect(pinSource(map).setData).not.toHaveBeenCalled();
  });

  describe("a pin chosen outside the list", () => {
    it("on the phone, docks its place's card, with how far it is from where the list is near", async () => {
      const user = userEvent.setup();
      const { map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
      act(() => map.dragTo(LISBON_VIEW, 15));
      await user.click(await findPin("Lisbon place 1"));
      const region = screen.getByRole("region", { name: copy.map.selected });
      const card = within(region).getByRole("link", { name: "Lisbon place 1" });
      expect(card).toHaveAttribute("href", "/place/lisbon-0");
      const lisbon1 = parsePlaces(lisbon)[0]!;
      const km = formatDistance(distanceKm(HERE.lat, HERE.lon, lisbon1.lat, lisbon1.lon), "en-US");
      expect(card).toHaveAccessibleDescription(expect.stringContaining(` · ${km} `));
      expect(pin("Lisbon place 1")).toHaveAttribute("aria-pressed", "true");
    });

    it("on the phone, docks a chain's place's own card, which opens the place", async () => {
      const user = userEvent.setup();
      const { router } = await openApp("/map");
      await findPin("Jacafé");
      const [first] = screen.getAllByRole("button", { name: /^A Confeitaria Coffee & Bakery,/ });
      await user.click(first!);
      const region = screen.getByRole("region", { name: copy.map.selected });
      const card = within(region).getByRole("link", { name: "A Confeitaria Coffee & Bakery" });
      expect(card.getAttribute("href")).toMatch(/^\/place\//);
      await user.click(card);
      expect(router.state.location.pathname).toMatch(/^\/place\//);
    });

    it("on a desktop, puts its place's card at the top of the list, picked out, until it is let go", async () => {
      const user = userEvent.setup();
      Element.prototype.scrollIntoView = vi.fn();
      try {
        const { map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
        const before = cards().map(nameOf);
        expect(before).not.toContain("Lisbon place 1");

        await user.click(await findPin("Lisbon place 1"));
        const card = within(list()).getByRole("link", { name: "Lisbon place 1" });
        expect(card).toHaveClass("border-2", "border-ink");
        expect(card.closest("li")).toBe(list().firstElementChild);
        expect(cards().map(nameOf).slice(1)).toEqual(before);
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
        const lisbon1 = parsePlaces(lisbon)[0]!;
        const km = formatDistance(distanceKm(HERE.lat, HERE.lon, lisbon1.lat, lisbon1.lon), "en-US");
        expect(card).toHaveAccessibleDescription(expect.stringContaining(` · ${km} `));

        act(() => map.fire("click", { originalEvent: new MouseEvent("click") }));
        expect(within(list()).queryByRole("link", { name: "Lisbon place 1" })).not.toBeInTheDocument();
        expect(cards().map(nameOf)).toEqual(before);
      } finally {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });

    it("on a desktop, moves the focus to that card when the pin is chosen from the keyboard", async () => {
      const user = userEvent.setup();
      await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
      const far = await findPin("Lisbon place 1");
      act(() => far.focus());
      await user.keyboard("{Enter}");
      expect(within(list()).getByRole("link", { name: "Lisbon place 1" })).toHaveFocus();
    });

    it("on a desktop, gives a chain's place its own card, and leaves the chain's card as it is", async () => {
      const user = userEvent.setup();
      Element.prototype.scrollIntoView = vi.fn();
      try {
        await openApp("/", { px: DESKTOP });
        const chainCard = within(list()).getByRole("link", { name: "A Confeitaria Coffee & Bakery" });
        expect(chainCard.getAttribute("href")).toMatch(/^\/chain\//);
        // Once the map has drawn its pins.
        const [first] = await screen.findAllByRole("button", { name: /^A Confeitaria Coffee & Bakery,/ });
        await user.click(first!);
        const item = within(list().firstElementChild as HTMLElement);
        const top = item.getByRole("link", { name: "A Confeitaria Coffee & Bakery" });
        expect(top.getAttribute("href")).toMatch(/^\/place\//);
        expect(top).toHaveClass("border-2", "border-ink");
        expect(chainCard).not.toHaveClass("border-2");
        // Under it, the way to its chain.
        const chain = idx.chains.get("PT:a confeitaria coffee & bakery")!;
        expect(item.getByRole("link", { name: copy.map.partOfChain(chain.name, chain.places.length) })).toHaveAttribute(
          "href",
          chainCard.getAttribute("href"),
        );
      } finally {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });

    it("on a desktop, shows its card above what the list says when the area searched has no places", async () => {
      const user = userEvent.setup();
      Element.prototype.scrollIntoView = vi.fn();
      try {
        const { map } = await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
        act(() => map.dragTo({ west: -20.1, south: 30, east: -20, north: 30.1 }));
        await user.click(searchArea());
        expect(screen.getByText(copy.map.noneInArea)).toBeInTheDocument();
        expect(screen.queryByRole("list")).not.toBeInTheDocument();

        await user.click(await findPin("Lisbon place 1"));
        const card = within(list()).getByRole("link", { name: "Lisbon place 1" });
        expect(card).toHaveClass("border-2", "border-ink");
        expect(cards()).toHaveLength(1);
        expect(card.compareDocumentPosition(screen.getByText(copy.map.noneInArea)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      } finally {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });

    it("on a desktop, lets the chosen pin go when a filter leaves its place out: its card goes with its pin", async () => {
      const user = userEvent.setup();
      Element.prototype.scrollIntoView = vi.fn();
      try {
        await openApp("/", { px: DESKTOP, events: [...fixtures, ...lisbon] });
        // One beyond the list, at its top; then the kinds menu leaves it out (it is a restaurant).
        await user.click(await findPin("Lisbon place 1"));
        expect(within(list()).getByRole("link", { name: "Lisbon place 1" })).toBeInTheDocument();
        const menus = screen.getByRole("group", { name: copy.explore.filtersLabel });
        await user.click(within(menus).getByRole("button", { name: "Kind of place" }));
        await user.click(within(screen.getByRole("group", { name: copy.filters.kinds })).getByRole("button", { name: "Cafes" }));
        await waitFor(() => expect(within(list()).queryByRole("link", { name: "Lisbon place 1" })).not.toBeInTheDocument());
        expect(screen.queryByRole("button", { name: /^Lisbon place 1,/ })).not.toBeInTheDocument();
        expect(screen.queryAllByRole("button", { pressed: true, name: /, (Restaurant|Cafe|Coffee)/ })).toEqual([]);
      } finally {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });

    it("on a desktop, picks out a listed place's own card, as before", async () => {
      const user = userEvent.setup();
      Element.prototype.scrollIntoView = vi.fn();
      try {
        await openApp("/", { px: DESKTOP });
        const before = cards().map(nameOf);
        await user.click(await findPin("Jacafé"));
        expect(cards().map(nameOf)).toEqual(before);
        expect(within(list()).getByRole("link", { name: "Jacafé" })).toHaveClass("border-2", "border-ink");
      } finally {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });
  });
});
