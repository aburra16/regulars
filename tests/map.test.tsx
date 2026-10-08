import type { NostrEvent } from "@nostrify/nostrify";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountProvider } from "../src/account/AccountProvider";
import houseBadge64 from "../src/assets/house/house-64.png";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import { areaOf } from "../src/map/area";
import { BaseMap } from "../src/map/BaseMap";
import { CLUSTER_OPTIONS, type Pin, PIN_SOURCE, pinsFor, pinsGeoJSON } from "../src/map/pins";
import { filtersFromParams, withFilters } from "../src/search/filters";
import { MAPTILER_STYLE_URL, mapStyle, recolour } from "../src/map/style";
import { distanceKm } from "../src/places/distance";
import { openLine, openState } from "../src/places/hours";
import { buildIndexes, formatDistance, groupForList } from "../src/places/indexes";
import { placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { PlacesProvider } from "../src/places/store";
import { ScoresProvider } from "../src/score/ScoresProvider";
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
        <AccountProvider>
          <HereProvider>
            <RouterProvider router={router} />
          </HereProvider>
        </AccountProvider>
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
  it("is around the middle of the view, half its diagonal across", () => {
    const area = areaOf([-16.92, 32.64, -16.9, 32.66]);
    expect(area.lat).toBeCloseTo(32.65, 6);
    expect(area.lon).toBeCloseTo(-16.91, 6);
    expect(area.radiusKm).toBeCloseTo(distanceKm(32.64, -16.92, 32.66, -16.9) / 2, 6);
  });

  it("reaches no farther than a city's radius", () => {
    expect(areaOf([-10, 36, -6, 42]).radiusKm).toBe(25);
  });

  it("is on the Earth when the view has gone round it", () => {
    expect(areaOf([179, -1, 183, 1]).lon).toBeCloseTo(-179, 6);
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
    expect(onMoveEnd).toHaveBeenCalledWith([-9.2, 38.68, -9.08, 38.76]);
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

  it("starts at the place the list is near, at zoom 13, with a pin for each place and chain there", async () => {
    const { map } = await openApp("/map");
    expect(map.options).toMatchObject({ center: [HERE.lon, HERE.lat], zoom: 13 });
    const entries = groupForList(idx.near(HERE.lat, HERE.lon, HERE.radiusKm), idx);
    expect(pinAddresses(map)).toEqual(
      entries.map((entry) => ("chain" in entry ? entry.nearby[0]!.place.address : entry.place.address)),
    );
    expect(await findPin("Jacafé")).toBeInTheDocument();
    expect(pin("A Confeitaria Coffee & Bakery")).toHaveAccessibleName("A Confeitaria Coffee & Bakery, a chain, 4 locations nearby");
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

  it("docks a chain's card for a chain's pin; it opens the chain", async () => {
    const user = userEvent.setup();
    await openApp("/map");
    await user.click(await findPin("A Confeitaria Coffee & Bakery"));
    const card = screen.getByRole("link", { name: "A Confeitaria Coffee & Bakery" });
    expect(card.getAttribute("href")).toMatch(/^\/chain\//);
  });

  it("offers to search this area only after the person moves the map, and then lists the places there", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
    const button = () => screen.queryByRole("button", { name: copy.map.searchArea });
    expect(button()).not.toBeInTheDocument();

    act(() => void map.easeTo({ center: [-9.14, 38.72] }));
    expect(button()).not.toBeInTheDocument();

    act(() => map.dragTo(LISBON_VIEW));
    expect(button()).toBeInTheDocument();
    expect(pinAddresses(map)).not.toContain(parsePlaces(lisbon)[0]!.address);

    await user.click(button()!);
    expect(button()).not.toBeInTheDocument();
    await waitFor(() =>
      expect(pinAddresses(map)).toEqual(expect.arrayContaining(parsePlaces(lisbon).map((each) => each.address))),
    );
    expect(pinAddresses(map)).not.toContain(place("Jacafé").address);
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

  it("lists what the phone's Explore lists, as cards, and pins the same places", async () => {
    const { map } = await openApp("/", { px: DESKTOP });
    const entries = groupForList(idx.near(HERE.lat, HERE.lon, HERE.radiusKm), idx);
    const names = entries.map((entry) => ("chain" in entry ? entry.chain.name : entry.place.name));
    expect(cards().map(nameOf)).toEqual(names.slice(0, 30));
    expect(pinAddresses(map)).toHaveLength(entries.length);
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
    const before = pinAddresses(map).length;
    await user.click(within(menus()).getByRole("button", { name: "Open now" }));
    expect(router.state.location.search).toBe("?open=1");
    expect(within(menus()).getByRole("button", { name: "Open now" })).toHaveAttribute("aria-pressed", "true");
    const closed = fixturePlaces.filter((each) => openState(each, MORNING).kind === "closed");
    expect(closed.length).toBeGreaterThan(0);
    for (const each of closed) expect(cards().map(nameOf)).not.toContain(each.name);
    await waitFor(() => expect(pinAddresses(map).length).toBeLessThan(before));
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

      await user.click(pin("A Confeitaria Coffee & Bakery"));
      expect(card).not.toHaveClass("border-2");
      expect(within(list()).getByRole("link", { name: "A Confeitaria Coffee & Bakery" })).toHaveClass("border-2", "border-ink");
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
    expect(pin("A Confeitaria Coffee & Bakery")).toHaveAttribute("tabindex", "-1");
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
  it("are from the device on the docked card, wherever the map searched", async () => {
    const user = userEvent.setup();
    deviceAt(HERE.lat, HERE.lon);
    const { map } = await openApp("/map");
    await user.click(screen.getByRole("button", { name: copy.location.useMine }));
    await screen.findByRole("img", { name: copy.map.youAreHere });

    act(() => map.dragTo(EAST_OF_FUNCHAL));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
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

    const area = areaOf([EAST_OF_FUNCHAL.west, EAST_OF_FUNCHAL.south, EAST_OF_FUNCHAL.east, EAST_OF_FUNCHAL.north]);
    const rows = idx
      .near(area.lat, area.lon, area.radiusKm)
      .map(({ place: each }) => ({ place: each, km: distanceKm(HERE.lat, HERE.lon, each.lat, each.lon) }))
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
  it("says so over the phone's map", async () => {
    const user = userEvent.setup();
    const { map } = await openApp("/map");
    // The regions over the map are there before anything is said in them, so a screen reader hears it.
    const regions = within(mapAttribution().closest<HTMLElement>(".bg-map-land")!).getAllByRole("status");
    expect(screen.queryByText(copy.map.noneInArea)).not.toBeInTheDocument();
    act(() => map.dragTo({ west: -20.1, south: 30, east: -20, north: 30.1 }));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    const said = screen.getByText(copy.map.noneInArea);
    expect(regions).toContain(said.closest("[role=status]"));
    expect(pinAddresses(map)).toEqual([]);
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
  it("comes back on the phone where it was, at its zoom, with the area that was searched", async () => {
    const user = userEvent.setup();
    const { router, map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW, 15));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
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
    const user = userEvent.setup();
    const { router, map } = await openApp("/map", { events: [...fixtures, ...lisbon] });
    act(() => map.dragTo(LISBON_VIEW, 15));
    await user.click(screen.getByRole("button", { name: copy.map.searchArea }));
    await act(() => router.navigate("/saved"));
    await act(() => router.navigate("/map"));
    const fresh = await mapNumber(2);
    expect(fresh.options).toMatchObject({ center: [HERE.lon, HERE.lat], zoom: 13 });
    expect(pinAddresses(fresh)).toContain(place("Jacafé").address);
  });
});
