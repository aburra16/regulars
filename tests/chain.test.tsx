import type { NostrEvent } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


import { fitView } from "../src/chain/fit";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { PIN_SOURCE } from "../src/map/pins";
import * as distanceModule from "../src/places/distance";
import { distanceKm, formatDistance } from "../src/places/distance";
import { openLine, openState } from "../src/places/hours";
import { buildIndexes, type Chain, chainSlug } from "../src/places/indexes";
import { placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { unbrokenPostcodes } from "../src/ui/address";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, openAppWithSaved, resetWidth } from "./support/app";
import { FakeMap, FakeMarker } from "./support/fakeMaplibre";

const fixtures: NostrEvent[] = raw;
const idx = buildIndexes(parsePlaces(fixtures));
const HERE = config.defaultCity;
const US = "en-US";

/** Wednesday 7 October 2026, 15:00 on the clock of Funchal (UTC+1 in October). */
const AFTERNOON = new Date("2026-10-07T14:00:00Z");

/** Four A Confeitaria Coffee & Bakery, all in Funchal; and two Loft Brunch & Cocktails. */
const CONFEITARIA = idx.chains.get("PT:a confeitaria coffee & bakery")!;
const confeitariaPath = `/chain/${chainSlug(CONFEITARIA)}`;

// ---- Events made from the fixtures ----

let nextId = 1;
/** A place event like `base`, with the value of each tag in `over` replaced (or added) and a fresh, fake id. */
function variant(base: NostrEvent, over: Record<string, string>): NostrEvent {
  const replaced = base.tags.map((tag) => (tag[0] !== undefined && tag[0] in over ? [tag[0], over[tag[0]]!] : tag));
  const added = Object.entries(over).filter(([name]) => !base.tags.some((tag) => tag[0] === name));
  return { ...base, id: (nextId++).toString(16).padStart(64, "0"), tags: [...replaced, ...added] };
}

const eventOf = (d: string) => fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === d))!;
const confeitariaEvent = eventOf("osm-node-4183148414");
const nameOnlyEvent = eventOf("crafted-minimal");

/** Locations of the chain `name` in Lisbon, a little under a thousand kilometres from Funchal: in the chain, and not near. */
function inLisbon(name: string, count: number, over: (i: number) => Record<string, string> = () => ({})): NostrEvent[] {
  return Array.from({ length: count }, (_, i) =>
    variant(nameOnlyEvent, {
      d: `lisbon-${name.replace(/\W+/g, "-")}-${i}`,
      name,
      lat: String(38.72 + i * 0.001),
      lon: String(-9.14 + i * 0.001),
      ...over(i),
    }),
  );
}

/** More A Confeitaria Coffee & Bakery, in Lisbon, so the chain has more locations than are near. */
const lisbonConfeitaria = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    variant(confeitariaEvent, {
      d: `lisbon-confeitaria-${i}`,
      address: `${i + 1} Rua Augusta Lisboa`,
      locality: "Lisboa",
      lat: String(38.72 + i * 0.001),
      lon: String(-9.14 + i * 0.001),
    }),
  );

/** More A Confeitaria Coffee & Bakery, in the middle of Funchal, so the chain has many locations near you. */
const funchalConfeitaria = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    variant(confeitariaEvent, {
      d: `funchal-confeitaria-${i}`,
      address: `${i + 1} Rua Nova Funchal`,
      lat: String(32.651 + i * 0.0002),
      lon: "-16.908",
    }),
  );

// ---- Reading the page ----

const heading = () => screen.getByRole("heading", { level: 1 });
const header = () => heading().closest("section")!;
/** The rows of the list of locations. */
const rows = () => within(screen.getByRole("list")).getAllByRole("link");
const rowNames = () => rows().map((row) => row.textContent ?? "");
const rowHrefs = () => rows().map((row) => row.getAttribute("href"));
const placeHref = (place: Place) => `/place/${encodeURIComponent(place.d)}`;

/** The chain's places, nearest first, as the page lists them. */
function nearestFirst(chain: Chain): { place: Place; km: number }[] {
  return chain.places
    .map((place) => ({ place, km: distanceKm(HERE.lat, HERE.lon, place.lat, place.lon) }))
    .sort((a, b) => a.km - b.km);
}

/** The words a location is known by: its street address (its postcode kept whole), or else its town, or else its name. */
const knownBy = (place: Place) => unbrokenPostcodes(place.street ?? place.locality ?? place.name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AFTERNOON);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  config.features.signIn = false;
});

// ---- The header ----

describe("the chain page: header", () => {
  it("names the chain, counts its locations and the ones near, and says each is scored on its own", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    expect(CONFEITARIA.places).toHaveLength(4);
    expect(heading()).toHaveTextContent("A Confeitaria Coffee & Bakery");

    // The kind and the count, as Explore's card says them, then how many are near.
    const kind = placeKindLabel("bakery", undefined);
    expect(header()).toHaveTextContent(`${kind} · 4 locations · 4 near you`);
    expect(copy.chain.line(kind, 4, 4)).toBe(`${kind} · 4 locations · 4 near you`);

    const order = [heading(), screen.getByText(copy.chain.eachScored)];
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(copy.chain.eachScored).toBe("Each location is scored on its own");
    expect(screen.getByText(copy.chain.eachScoredDetail)).toBeInTheDocument();
  });

  it("counts every location of the chain, and those within the city's reach of here", async () => {
    // Three more in Lisbon: seven locations, four of them near.
    await openApp(confeitariaPath, { events: [...fixtures, ...lisbonConfeitaria(3)] });
    expect(header()).toHaveTextContent("7 locations · 4 near you");
  });

  it("says none are near you, and lists the nearest three, when every location is far away", async () => {
    const events = [...fixtures, ...inLisbon("Lisboa Cafe", 5)];
    // The crafted place has no country, so the chain is keyed by the empty one.
    const lisboa = buildIndexes(parsePlaces(events)).chains.get(":lisboa cafe")!;
    await openApp(`/chain/${chainSlug(lisboa)}`, { events });

    expect(header()).toHaveTextContent("5 locations · none near you");
    expect(copy.chain.nearYou(0)).toBe("none near you");
    expect(rows()).toHaveLength(3);
    expect(rowHrefs()).toEqual(nearestFirst(lisboa).slice(0, 3).map(({ place }) => placeHref(place)));
    expect(screen.getByRole("heading", { level: 2, name: copy.chain.nearest })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all 5 locations" })).toBeInTheDocument();
  });

  it("is named for the chain in the browser's tab", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    await waitFor(() => expect(document.title).toBe(`A Confeitaria Coffee & Bakery · ${config.appName}`));
    expect(copy.titles.chain("A Confeitaria Coffee & Bakery")).toBe(document.title);
  });

  it("explains that places with the same name are grouped", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    expect(screen.getByText(copy.chain.grouped)).toBeInTheDocument();
  });

  it("goes back the way the person came, and to Explore when the chain was the first page opened", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = await openApp(confeitariaPath, { events: fixtures });
    expect(screen.getByRole("link", { name: copy.place.backHome })).toHaveAttribute("href", "/");
    first.unmount();

    const { router } = await openApp(confeitariaPath, { events: fixtures, entries: ["/search?q=bakery", confeitariaPath] });
    await user.click(screen.getByRole("link", { name: copy.place.back }));
    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.historyAction).toBe("POP");
  });
});

// ---- The locations ----

describe("the chain page: locations", () => {
  it("keeps a location's postcode whole on its line", async () => {
    const loft = idx.chains.get("PT:loft brunch & cocktails")!;
    await openApp(`/chain/${chainSlug(loft)}`, { events: fixtures });
    const named = screen.getAllByRole("link").map((link) => document.getElementById(link.getAttribute("aria-labelledby") ?? "")?.textContent ?? "");
    expect(named).toContain("49 Rua da Conceição Funchal 9050\u2011026");
  });

  it("lists the locations near you by street address, nearest first, each a link to its place", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    const expected = nearestFirst(CONFEITARIA);
    expect(rows()).toHaveLength(4);
    expect(rows().map((row) => row.getAttribute("href"))).toEqual(expected.map(({ place }) => placeHref(place)));
    for (const [i, { place }] of expected.entries()) {
      expect(rows()[i]).toHaveAccessibleName(knownBy(place));
      expect(place.street).toBeDefined();
    }
    // The distances grow down the list.
    expect(expected.map(({ km }) => km)).toEqual([...expected.map(({ km }) => km)].sort((a, b) => a - b));
    expect(screen.getByRole("heading", { level: 2, name: copy.chain.near })).toBeInTheDocument();
  });

  it("says how far each is, whether it is open, and that nobody has reviewed it", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    for (const [i, { place, km }] of nearestFirst(CONFEITARIA).entries()) {
      const line = `${formatDistance(km, US)} · ${openLine(openState(place, new Date()), US, "card")}`;
      expect(rows()[i]).toHaveAccessibleDescription(`${line} ${copy.score.noReviewsYet}`);
    }
    // 15:00 on a Wednesday; A Confeitaria on Rua do Hospital Velho is open Mo-Fr 08:00-19:00.
    expect(rows()[0]).toHaveTextContent("Open until 7 pm");
    expect(within(rows()[0]!).getByText("Open")).toHaveClass("font-bold");
    expect(within(rows()[0]!).getByText(copy.score.noReviewsYet)).toBeInTheDocument();
    expect(copy.score.noReviewsYet).toBe("No reviews yet");
  });

  it("opens the place when a location is chosen", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = await openApp(confeitariaPath, { events: fixtures });
    await user.click(rows()[0]!);
    expect(router.state.location.pathname).toBe(placeHref(nearestFirst(CONFEITARIA)[0]!.place));
  });

  it("knows a location by its town, or its name, when it has no street address", async () => {
    const events = [
      ...fixtures,
      variant(nameOnlyEvent, { d: "fb-1", name: "Fallback Cafe", lat: "32.651", lon: "-16.908", address: "9 Rua Nova Funchal" }),
      variant(nameOnlyEvent, { d: "fb-2", name: "Fallback Cafe", lat: "32.652", lon: "-16.908", locality: "Câmara de Lobos" }),
      variant(nameOnlyEvent, { d: "fb-3", name: "Fallback Cafe", lat: "32.653", lon: "-16.908" }),
    ];
    const chain = buildIndexes(parsePlaces(events)).chains.get(":fallback cafe")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });
    expect(rowNames().map((text) => text.split(copy.score.noReviewsYet)[0])).toEqual([
      expect.stringMatching(/^9 Rua Nova Funchal/),
      expect.stringMatching(/^Câmara de Lobos/),
      expect.stringMatching(/^Fallback Cafe/),
    ]);
  });

  it("shows every location of the chain, nearest first, when 'Show all' is pressed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const events = [...fixtures, ...lisbonConfeitaria(3)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });
    expect(rows()).toHaveLength(4);

    const showAll = screen.getByRole("button", { name: "Show all 7 locations" });
    expect(copy.chain.showAll(7)).toBe("Show all 7 locations");
    await user.click(showAll);

    expect(rows()).toHaveLength(7);
    expect(rowHrefs()).toEqual(nearestFirst(chain).map(({ place }) => placeHref(place)));
    // The ones in Lisbon come last, and say how far they are.
    expect(rows().at(-1)).toHaveTextContent(/\d{3} mi/);
    expect(screen.queryByRole("button", { name: /^Show all/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: copy.pages.chain })).toBeInTheDocument();
    // The focus goes to the first location that was not there.
    expect(rows()[4]).toHaveFocus();
  });

  it("has no 'Show all' when every location is already listed", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    expect(screen.queryByRole("button", { name: /^Show all/ })).not.toBeInTheDocument();
  });

  it("shows every location when 'Show all' is pressed, with no more paging after it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // 4 near, 75 in Lisbon: 79 locations.
    const events = [...fixtures, ...lisbonConfeitaria(75)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });
    expect(rows()).toHaveLength(4);

    await user.click(screen.getByRole("button", { name: "Show all 79 locations" }));
    expect(rows()).toHaveLength(79);
    expect(rows()[4]).toHaveFocus();
    expect(rowHrefs()).toEqual(nearestFirst(chain).map(({ place }) => placeHref(place)));
    // Nothing is left to show: no button of any name is under the list.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lists the nearest five hundred of a chain that has more, and the button says so", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // 4 near, 520 in Lisbon: 524 locations.
    const events = [...fixtures, ...lisbonConfeitaria(520)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });
    expect(header()).toHaveTextContent("524 locations · 4 near you");

    await user.click(screen.getByRole("button", { name: "Show the nearest 500" }));
    expect(copy.chain.showNearest(500)).toBe("Show the nearest 500");
    expect(rows()).toHaveLength(500);
    expect(rowHrefs()).toEqual(nearestFirst(chain).slice(0, 500).map(({ place }) => placeHref(place)));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lists fifty of the locations near you when there are many, and 'Show all' shows the rest", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // 4 near already, and 60 more in the middle of Funchal.
    const events = [...fixtures, ...funchalConfeitaria(60)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });

    expect(header()).toHaveTextContent("64 locations · 64 near you");
    expect(rows()).toHaveLength(50);
    expect(rowHrefs()).toEqual(nearestFirst(chain).slice(0, 50).map(({ place }) => placeHref(place)));
    expect(screen.getByRole("heading", { level: 2, name: copy.chain.near })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all 64 locations" }));
    expect(rows()).toHaveLength(64);
    expect(rows()[50]).toHaveFocus();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not draw the rows it has shown again when more are shown", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const events = [...fixtures, ...lisbonConfeitaria(3)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });
    // Each row works out how far it is as it is drawn.
    const drawn = vi.spyOn(distanceModule, "formatDistance");
    drawn.mockClear();
    await user.click(screen.getByRole("button", { name: "Show all 7 locations" }));
    expect(rows()).toHaveLength(7);
    expect(drawn).toHaveBeenCalledTimes(3);
  });

  it("is as long as it was when the person comes back to it from a place", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const events = [...fixtures, ...lisbonConfeitaria(3)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    const path = `/chain/${chainSlug(chain)}`;
    const { router } = await openApp(path, { events, entries: ["/", path] });

    await user.click(screen.getByRole("button", { name: "Show all 7 locations" }));
    await user.click(rows()[6]!);
    expect(router.state.location.pathname).toMatch(/^\/place\//);

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe(path);
    await waitFor(() => expect(rows()).toHaveLength(7));
  });

  it("keeps a long name inside the page, in its own script", async () => {
    const name = "ペーパー・クレーン";
    const events = [
      ...fixtures,
      variant(nameOnlyEvent, { d: "jp-1", name, lat: "32.651", lon: "-16.908" }),
      variant(nameOnlyEvent, { d: "jp-2", name, lat: "32.652", lon: "-16.908" }),
    ];
    const chain = buildIndexes(parsePlaces(events)).chains.get(`:${name}`)!;
    await openApp(`/chain/${chainSlug(chain)}`, { events });
    expect(heading()).toHaveAttribute("lang", "ja");
    expect(heading()).toHaveClass("wrap-break-word");
  });
});

// ---- A chain's pin on the map, and a link to it ----

describe("the chain page: reached from the map", () => {
  it("opens from the chain's pin on the map", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = await openApp("/map", { events: fixtures });
    const pin = await screen.findByRole("button", { name: /^A Confeitaria Coffee & Bakery, a chain/ });
    await user.click(pin);
    await user.click(screen.getByRole("link", { name: "A Confeitaria Coffee & Bakery" }));

    expect(router.state.location.pathname).toBe(confeitariaPath);
    expect(heading()).toHaveTextContent("A Confeitaria Coffee & Bakery");
    expect(rows()).toHaveLength(4);
  });
});

// ---- A phone ----

describe("the chain page on a phone", () => {
  it("has a link to the map beside 'Near you', and no map of its own", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    const link = screen.getByRole("link", { name: copy.chain.seeOnMap });
    expect(link).toHaveAttribute("href", "/map");
    expect(link).toHaveClass("min-h-touch", "text-accent");
    expect(FakeMap.instances).toHaveLength(0);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("leaves the link out when no location is near", async () => {
    const events = [...fixtures, ...inLisbon("Lisboa Cafe", 4)];
    const lisboa = buildIndexes(parsePlaces(events)).chains.get(":lisboa cafe")!;
    await openApp(`/chain/${chainSlug(lisboa)}`, { events });
    expect(screen.queryByRole("link", { name: copy.chain.seeOnMap })).not.toBeInTheDocument();
  });

  it("credits where the details come from, with a link to say more", async () => {
    await openApp(confeitariaPath, { events: fixtures });
    const credit = screen.getByText((_, element) => element?.tagName === "P" && element.textContent === copy.attribution.details);
    expect(credit).toBeVisible();
    expect(screen.getByRole("link", { name: copy.common.aboutData })).toHaveAttribute("href", "/about");
  });
});

// ---- A desktop ----

describe("the chain page on a desktop", () => {
  it("is a column of the header and the locations beside a rail with the map and the credit", async () => {
    await openApp(confeitariaPath, { events: fixtures, px: DESKTOP });
    const rail = screen.getByRole("complementary", { name: copy.chain.railLabel });
    expect(rail).toHaveClass("w-rail");

    // The list and the header are in the column, not the rail.
    expect(rail).not.toContainElement(heading());
    expect(rail).not.toContainElement(screen.getByRole("list"));
    expect(rows()).toHaveLength(4);

    // The map is a picture of where the locations are; the credit is under it.
    const picture = within(rail).getByRole("img", { name: copy.chain.mapLabel("A Confeitaria Coffee & Bakery") });
    expect(picture).toBeInTheDocument();
    const credit = within(rail).getByText((_, element) => element?.tagName === "P" && element.textContent === copy.attribution.details);
    expect(picture.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rail).getByRole("link", { name: copy.common.aboutData })).toHaveAttribute("href", "/about");

    // The phone's link to the map is not needed beside one.
    expect(screen.queryByRole("link", { name: copy.chain.seeOnMap })).not.toBeInTheDocument();
    // The way back, in words, above the page.
    expect(screen.getByRole("link", { name: copy.place.backHome })).toBeInTheDocument();
  });

  it("pins the locations that are listed, fitted to them, with the nearest chosen", async () => {
    await openApp(confeitariaPath, { events: fixtures, px: DESKTOP });
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined || !made.sources.has(PIN_SOURCE)) throw new Error("No map yet");
      return made;
    });
    const near = nearestFirst(CONFEITARIA).map(({ place }) => place);
    const view = fitView(near);
    expect(map.options).toMatchObject({ interactive: false, center: view.center, zoom: view.zoom });
    // The chosen one, the nearest, is drawn on its own; the source the map gathers into bubbles has the rest.
    const addresses = map.sources.get(PIN_SOURCE)!.data.features.map((feature) => (feature.properties as { address: string }).address);
    expect(addresses.sort()).toEqual(near.slice(1).map((place) => place.address).sort());
    // Several locations: the view takes them all in, so it is wider than one street.
    expect(view.zoom).toBeLessThan(15);
  });

  it("draws each location once: the bubbles count the others, and the chosen one is a pin of its own", async () => {
    await openApp(confeitariaPath, { events: fixtures, px: DESKTOP });
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined || !made.sources.has(PIN_SOURCE)) throw new Error("No map yet");
      return made;
    });
    const near = nearestFirst(CONFEITARIA).map(({ place }) => place);
    expect(near.length).toBeGreaterThan(2);

    // At the rail's zoom the map gathers everything its source holds into one bubble.
    const held = map.sources.get(PIN_SOURCE)!.data.features;
    map.features = [
      {
        type: "Feature",
        geometry: held[0]!.geometry as { type: "Point"; coordinates: number[] },
        properties: { cluster: true, cluster_id: 1, point_count: held.length },
      },
    ];
    act(() => map.fire("render"));

    // Each marker on the map: a bubble stands for its count, a pin for one place.
    const drawn = FakeMarker.instances.filter((marker) => marker.map === map);
    const bubbles = drawn.map((marker) => Number(marker.element.textContent)).filter((n) => n > 0);
    const pins = drawn.length - bubbles.length;
    expect(bubbles).toEqual([near.length - 1]);
    expect(pins).toBe(1);
    expect(bubbles.reduce((sum, n) => sum + n, 0) + pins).toBe(near.length);
  });

  it("pins the locations the list shows, and takes in more of them when the list shows more", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const events = [...fixtures, ...lisbonConfeitaria(3)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events, px: DESKTOP });
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined || !made.sources.has(PIN_SOURCE)) throw new Error("No map yet");
      return made;
    });
    // What the map gathers into bubbles: every location pinned but the chosen one, the nearest, drawn on its own.
    const pinned = () =>
      map.sources.get(PIN_SOURCE)!.data.features.map((feature) => (feature.properties as { address: string }).address).sort();
    const everyPlace = nearestFirst(chain).map(({ place }) => place);
    expect(pinned()).toEqual(everyPlace.slice(1, 4).map((place) => place.address).sort());

    await user.click(screen.getByRole("button", { name: "Show all 7 locations" }));
    await waitFor(() => expect(pinned()).toEqual(everyPlace.slice(1).map((place) => place.address).sort()));
    // The view takes in the ones in Lisbon: it is farther out than it was.
    const all = fitView(everyPlace);
    expect(map.center).toEqual(all.center);
    expect(map.zoom).toBe(all.zoom);
    expect(all.zoom).toBeLessThan(fitView(everyPlace.slice(0, 4)).zoom);
  });

  it("centres on the one location when there is one, close in", async () => {
    // One location within reach: the others are in Lisbon.
    const events = [...fixtures.filter((event) => !event.tags.some((tag) => tag[0] === "d" && ["osm-node-3884742383", "osm-node-10912591292", "osm-node-10958561090"].includes(tag[1]!))), ...lisbonConfeitaria(2)];
    const chain = buildIndexes(parsePlaces(events)).chains.get("PT:a confeitaria coffee & bakery")!;
    await openApp(`/chain/${chainSlug(chain)}`, { events, px: DESKTOP });
    const nearest = nearestFirst(chain)[0]!.place;
    expect(header()).toHaveTextContent("3 locations · 1 near you");
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined || !made.sources.has(PIN_SOURCE)) throw new Error("No map yet");
      return made;
    });
    expect(map.options).toMatchObject({ center: [nearest.lon, nearest.lat], zoom: 15 });
  });

  it("pins the nearest three, far away as they are, when none is near", async () => {
    const events = [...fixtures, ...inLisbon("Lisboa Cafe", 5)];
    const lisboa = buildIndexes(parsePlaces(events)).chains.get(":lisboa cafe")!;
    await openApp(`/chain/${chainSlug(lisboa)}`, { events, px: DESKTOP });
    const map = await waitFor(() => {
      const made = FakeMap.instances.at(-1);
      if (made === undefined || !made.sources.has(PIN_SOURCE)) throw new Error("No map yet");
      return made;
    });
    const nearest = nearestFirst(lisboa).slice(0, 3).map(({ place }) => place);
    const addresses = map.sources.get(PIN_SOURCE)!.data.features.map((feature) => (feature.properties as { address: string }).address);
    // The nearest is the chosen one, drawn on its own.
    expect(addresses.sort()).toEqual(nearest.slice(1).map((place) => place.address).sort());
    expect(map.options.center).toEqual(fitView(nearest).center);
  });
});

// ---- A chain that is not on the list ----

describe("the chain page: a chain that is not listed", () => {
  it.each([
    ["a key that is no chain's", "/chain/PT:no-such-chain"],
    ["a key with no country", "/chain/nonsense"],
    // One place with the name is no chain.
    ["a place that is alone with its name", `/chain/${chainSlug({ country: "PT", key: "jacafé" })}`],
  ])("says so for %s", async (_, path) => {
    await openApp(path, { events: fixtures });
    expect(heading()).toHaveTextContent(copy.place.noLongerListed);
    expect(screen.getByText(copy.place.noLongerListedDetail)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.place.backToExplore })).toHaveAttribute("href", "/");
    await waitFor(() => expect(document.title).toBe(copy.titles.notListed));
  });

  it("waits for the latest list when the places on screen are the saved ones, before saying so", async () => {
    // A chain that is new in the latest list is not off the map; the place page has the same rule.
    const added = [...fixtures, ...inLisbon("Brand New Cafe", 2)];
    await openAppWithSaved("/chain/:brand new cafe", fixtures, added);
    expect(screen.queryByText(copy.place.noLongerListedDetail)).not.toBeInTheDocument();
    expect(screen.getByText(copy.load.loading)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Brand New Cafe" })).toBeInTheDocument();
  });

  it("says so once the latest list does not have it either", async () => {
    await openAppWithSaved("/chain/:brand new cafe", fixtures, fixtures);
    expect(screen.queryByText(copy.place.noLongerListedDetail)).not.toBeInTheDocument();
    expect(await screen.findByText(copy.place.noLongerListedDetail)).toBeInTheDocument();
  });
});

// ---- Where the map looks ----

describe("fitView", () => {
  const box = { width: 240, height: 120 };
  /** Pixels a span of the map takes at a zoom, as MapLibre draws it (512 px tiles). */
  const worldPx = (zoom: number) => 512 * 2 ** zoom;
  const mercatorY = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };

  it("centres on one point, close in", () => {
    expect(fitView([{ lat: 32.65, lon: -16.9 }])).toEqual({ center: [-16.9, 32.65], zoom: 15 });
  });

  it("centres on the nearest of points that are all in one place", () => {
    expect(fitView([{ lat: 32.65, lon: -16.9 }, { lat: 32.65, lon: -16.9 }])).toEqual({ center: [-16.9, 32.65], zoom: 15 });
  });

  it("falls back to a world view for no points", () => {
    expect(fitView([])).toEqual({ center: [0, 0], zoom: 1 });
  });

  it.each([
    ["a town", [{ lat: 32.62, lon: -16.95 }, { lat: 32.68, lon: -16.87 }]],
    ["a long thin line east to west", [{ lat: 32.65, lon: -17.2 }, { lat: 32.66, lon: -16.7 }]],
    ["a tall thin line north to south", [{ lat: 32.4, lon: -16.9 }, { lat: 32.9, lon: -16.91 }]],
    ["a country", [{ lat: 37.1, lon: -8.9 }, { lat: 41.2, lon: -6.8 }, { lat: 38.7, lon: -9.1 }]],
  ])("takes in %s, and no more than it must", (_, points) => {
    const { center, zoom } = fitView(points);
    const lons = points.map((point) => point.lon);
    const lats = points.map((point) => point.lat);
    const widthPx = ((Math.max(...lons) - Math.min(...lons)) / 360) * worldPx(zoom);
    const heightPx = (Math.max(...lats.map(mercatorY)) - Math.min(...lats.map(mercatorY))) * -worldPx(zoom);
    // It fits the box...
    expect(widthPx).toBeLessThanOrEqual(box.width + 0.5);
    expect(Math.abs(heightPx)).toBeLessThanOrEqual(box.height + 0.5);
    // ...and a tenth of a zoom level closer would not.
    const closer = worldPx(zoom + 0.1);
    const tooBig =
      ((Math.max(...lons) - Math.min(...lons)) / 360) * closer > box.width ||
      (Math.max(...lats.map(mercatorY)) - Math.min(...lats.map(mercatorY))) * closer > box.height;
    expect(tooBig).toBe(true);
    // The middle of the points is the middle of the map.
    expect(center[0]).toBeCloseTo((Math.max(...lons) + Math.min(...lons)) / 2, 6);
    expect(mercatorY(center[1])).toBeCloseTo((Math.max(...lats.map(mercatorY)) + Math.min(...lats.map(mercatorY))) / 2, 6);
  });

  it("never goes closer than one street, nor farther than the world", () => {
    expect(fitView([{ lat: 32.65, lon: -16.9 }, { lat: 32.650001, lon: -16.900001 }]).zoom).toBe(15);
    const far = fitView([{ lat: -40, lon: -170 }, { lat: 60, lon: 170 }]);
    expect(far.zoom).toBeGreaterThanOrEqual(1);
  });
});
