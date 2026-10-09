import type { NostrEvent } from "@nostrify/nostrify";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBrowserRouter, createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountProvider } from "../src/account/AccountProvider";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { forgetExploreIdx, setExploreIdx, stepsBackToExplore } from "../src/explore/returnPoint";
import { HereProvider } from "../src/location/HereProvider";
import { HereContext, type HereValue } from "../src/location/useLocation";
import { PIN_SOURCE } from "../src/map/pins";
import { osmNoteUrl } from "../src/place/osmLinks";
import { distanceKm, formatDistance } from "../src/places/distance";
import { openState } from "../src/places/hours";
import { buildIndexes, type Chain, chainSlug, groupForList, type PlaceDistance } from "../src/places/indexes";
import { FAMILIES, type FamilyId, kindOf, placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { PlacesProvider } from "../src/places/store";
import { ScoresProvider } from "../src/score/ScoresProvider";
import { routes } from "../src/routes";
import { SearchPage } from "../src/search/SearchPage";
import {
  applyFilters,
  type Filters,
  filterCount,
  filtersFromParams,
  filtersToParams,
  noFilters,
  snapWithin,
  widestKm,
  withFilters,
  withinChoices,
  withinLabel,
} from "../src/search/filters";
import { ChainCard } from "../src/ui/ChainCard";
import { PlaceRow } from "../src/ui/PlaceRow";
import raw from "./fixtures/funchal-items.json";
import { FakeMap } from "./support/fakeMaplibre";
import { createMemoryReader } from "./support/memoryReader";
import { appTowns } from "./support/towns";

const fixtures: NostrEvent[] = raw;
const fixturePlaces = parsePlaces(fixtures);
// With the towns the app loads with the places, so the town it starts at is the app's.
const idx = buildIndexes(fixturePlaces, appTowns);
const HERE = config.defaultCity;
const PAGE = 50;

/** A Wednesday morning on the clock of Funchal (UTC+1 in October): 08:45, before most places open. */
const MORNING = new Date("2026-10-07T07:45:00Z");

const place = (name: string): Place => {
  const found = fixturePlaces.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No fixture place is called ${name}`);
  return found;
};

const row = (name: string, km = 1): PlaceDistance => ({ place: place(name), km });

/** The browser's language in the tests (jsdom's own): it reads miles. */
const US = "en-US";
const PT = "pt-PT";
const filters = (over: Partial<Filters> = {}, locale = US): Filters => ({ ...noFilters(locale), ...over });

// ---- Events made from the fixtures ----

let nextId = 1;
/** A place event like `base`, with the value of each tag in `over` replaced (or added, if it has none) and a fresh, fake id. */
function variant(base: NostrEvent, over: Record<string, string>): NostrEvent {
  const replaced = base.tags.map((tag) => (tag[0] !== undefined && tag[0] in over ? [tag[0], over[tag[0]]!] : tag));
  const added = Object.entries(over).filter(([name]) => !base.tags.some((tag) => tag[0] === name));
  return { ...base, id: (nextId++).toString(16).padStart(64, "0"), tags: [...replaced, ...added] };
}

const nameOnly = fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === "crafted-minimal"))!;

/** `count` restaurants in a line going north from the centre of Funchal, each farther than the last. */
function line(count: number, over: (i: number) => Record<string, string> = () => ({})): NostrEvent[] {
  return Array.from({ length: count }, (_, i) =>
    variant(nameOnly, {
      d: `line-${i}`,
      name: `Line place ${String(i + 1).padStart(3, "0")}`,
      lat: String(HERE.lat + 0.0005 * (i + 1)),
      lon: String(HERE.lon),
      ...over(i),
    }),
  );
}

// ---- The browser, as the tests have it ----

/** The browser's window as the page asks about its width: wide, for the desktop layout. */
function wideWindow() {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function open(initialEntries: string[], events: NostrEvent[], initialIndex?: number) {
  const router = createMemoryRouter(routes, { initialEntries, initialIndex });
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
  return { router, ...view };
}

/**
 * The app on the browser's own history, which keeps each entry's index in `window.history.state`
 * (a memory router does not): the back arrow's jump to Explore reads it. The page is at `path`.
 */
const browserRouters: ReturnType<typeof createBrowserRouter>[] = [];
function openInBrowser(path: string, events: NostrEvent[] = fixtures) {
  window.history.replaceState(null, "", path);
  const router = createBrowserRouter(routes);
  browserRouters.push(router);
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
  return { router, ...view };
}

/** The search page at `path`, drawn. */
async function openSearch(path = "/search", events: NostrEvent[] = fixtures) {
  const opened = open([path], events);
  await screen.findByRole("heading", { level: 1, name: copy.pages.search });
  return opened;
}

/** The filters page at `path`, drawn. */
async function openFilters(path = "/filters", events: NostrEvent[] = fixtures) {
  const opened = open([path], events);
  await screen.findByRole("heading", { level: 1, name: copy.pages.filters });
  return opened;
}

/** What a row is called: the words of the element its link takes its name from. */
const nameOf = (link: HTMLElement) => document.getElementById(link.getAttribute("aria-labelledby") ?? "")?.textContent ?? "";
const rows = () => within(screen.getByRole("list")).getAllByRole("link");
const names = () => rows().map(nameOf);
const rowFor = (name: string) => screen.getByRole("link", { name });
const field = () => screen.getByRole("searchbox", { name: copy.search.label });
/** The link to add a place: its name has a word for a screen reader that it opens a new tab. */
const addMissingName = `${copy.search.addMissing} ${copy.common.newTab}`;
const addMissing = () => screen.getByRole("link", { name: addMissingName });
const chipsGroup = () => screen.getByRole("group", { name: copy.explore.filtersLabel });
const chip = (name: string | RegExp) => within(chipsGroup()).getByRole("button", { name });

/** The rows the page should list for a search, worked out from the indexes and the clock alone. */
function listed(q: string, keep: (place: Place) => boolean = () => true, radiusKm = 25, from: { lat: number; lon: number } = HERE): string[] {
  const found = idx.search(q, { lat: from.lat, lon: from.lon, radiusKm }).filter((each) => keep(each.place));
  return groupForList(found, idx).map((entry) => ("chain" in entry ? entry.chain.name : entry.place.name));
}
const isClosed = (candidate: Place) => openState(candidate, MORNING).kind === "closed";
/** How many places a search finds: a chain counts each of its locations that are among them. */
function counted(q: string, keep: (place: Place) => boolean = () => true, radiusKm = 25): number {
  return idx.search(q, { lat: HERE.lat, lon: HERE.lon, radiusKm }).filter((each) => keep(each.place)).length;
}

beforeEach(() => {
  // Only the clock is held still; timers and promises run as they do.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MORNING);
});

afterEach(() => {
  for (const router of browserRouters.splice(0)) router.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "matchMedia");
});

// =====================================================================================
// The filters, as data
// =====================================================================================

describe("filters in the address", () => {
  const read = (query: string, locale = US) => filtersFromParams(new URLSearchParams(query), locale);

  it("are none at all for an address that says nothing, with the sort left to the page and the widest distance", () => {
    expect(read("")).toEqual({ open: false, families: [], withinKm: 24 });
    expect(read("", PT)).toEqual({ open: false, families: [], withinKm: 25 });
    expect(read("").sort).toBeUndefined();
    expect(noFilters(US)).toEqual(read(""));
    expect(noFilters(PT)).toEqual(read("", PT));
    expect(filtersToParams(noFilters(US), US).toString()).toBe("");
    expect(filtersToParams(noFilters(PT), PT).toString()).toBe("");
  });

  describe.each([US, PT])("in %s", (locale) => {
    it.each<[string, Partial<Filters>]>([
      ["the defaults", {}],
      ["open now", { open: true }],
      ["one kind", { families: ["cafes"] }],
      ["several kinds", { families: ["restaurants", "bakeries", "breweries"] }],
      ["every kind", { families: FAMILIES.map((family) => family.id) }],
      ["sorted by distance", { sort: "distance" }],
      ["sorted by name", { sort: "name" }],
      ["sorted by score", { sort: "score" }],
    ])("make the same filters back from the address: %s", (_what, over) => {
      const original = filters(over, locale);
      expect(filtersFromParams(filtersToParams(original, locale), locale)).toEqual(original);
      // Through the text of an address as well.
      expect(filtersFromParams(new URLSearchParams(filtersToParams(original, locale).toString()), locale)).toEqual(original);
    });

    it.each(withinChoices(locale).map((choice) => [choice.label, choice.km] as const))(
      "make the same distance back from the address: %s",
      (_label, km) => {
        const original = filters({ withinKm: km, open: true, sort: "name" }, locale);
        expect(filtersFromParams(filtersToParams(original, locale), locale)).toEqual(original);
      },
    );
  });

  it("write only what is not the default, in short names, with the distance in kilometres", () => {
    expect(filtersToParams(filters({ open: true }), US).toString()).toBe("open=1");
    expect(filtersToParams(filters({ families: ["restaurants", "cafes"] }), US).toString()).toBe("kinds=restaurants%2Ccafes");
    expect(filtersToParams(filters({ withinKm: 1.6 }), US).toString()).toBe("within=1.6");
    expect(filtersToParams(filters({ withinKm: 2 }, PT), PT).toString()).toBe("within=2");
    expect(filtersToParams(filters({ sort: "name" }), US).toString()).toBe("sort=name");
    expect(filtersToParams(filters({ sort: "distance" }), US).toString()).toBe("sort=distance");
    expect(filtersToParams({ open: true, families: ["cafes"], withinKm: 8, sort: "name" }, US).toString()).toBe(
      "open=1&kinds=cafes&within=8&sort=name",
    );
    // The widest is the default for the language, and not written; another language's widest is not.
    expect(filtersToParams(filters({ withinKm: 24 }), US).toString()).toBe("");
    expect(filtersToParams(filters({ withinKm: 25 }, PT), PT).toString()).toBe("");
    expect(filtersToParams(filters({ withinKm: 25 }), US).toString()).toBe("within=25");
  });

  it("read what the address says and leave out what it gets wrong", () => {
    expect(read("open=1")).toEqual(filters({ open: true }));
    expect(read("open=yes")).toEqual(filters());
    expect(read("open=0")).toEqual(filters());
    expect(read("within=banana")).toEqual(filters());
    expect(read("within=")).toEqual(filters());
    expect(read("within=0")).toEqual(filters());
    expect(read("within=-3")).toEqual(filters());
    expect(read("within=Infinity")).toEqual(filters());
    expect(read("sort=newest")).toEqual(filters());
    expect(read("sort=newest").sort).toBeUndefined();
    expect(read("sort=name")).toEqual(filters({ sort: "name" }));
    expect(read("sort=distance")).toEqual(filters({ sort: "distance" }));
    // A kind that is not one of the ten is dropped, and one that is named twice counts once.
    expect(read("kinds=cafes,spaceports,cafes,bars")).toEqual(filters({ families: ["cafes", "bars"] }));
    expect(read("kinds=")).toEqual(filters());
    expect(read("kinds=constructor,__proto__")).toEqual(filters());
  });

  describe("a distance that is not one of the person's choices", () => {
    it("snaps to the nearest choice that is at least that far, so a shared link never shows fewer places than it meant", () => {
      // A reader in kilometres: 1, 2, 5, 10, 25.
      expect(read("within=3", PT).withinKm).toBe(5);
      expect(read("within=1.5", PT).withinKm).toBe(2);
      expect(read("within=5", PT).withinKm).toBe(5);
      expect(read("within=0.1", PT).withinKm).toBe(1);
      expect(read("within=10.5", PT).withinKm).toBe(25);
      // A reader in miles: 0.8, 1.6, 4.8, 8, 24 kilometres.
      expect(read("within=0.5").withinKm).toBe(0.8);
      expect(read("within=0.9").withinKm).toBe(1.6);
      expect(read("within=2").withinKm).toBe(4.8);
      expect(read("within=4.8").withinKm).toBe(4.8);
      expect(read("within=6").withinKm).toBe(8);
    });

    it("is the widest when it is wider than every choice", () => {
      expect(read("within=26", PT).withinKm).toBe(25);
      expect(read("within=1000").withinKm).toBe(24);
      expect(read("within=1e3", PT).withinKm).toBe(25);
    });

    it("moves a link from a reader in kilometres to a reader in miles, and back", () => {
      // 5 km is not a choice in miles: the next one up is 5 mi (8 km).
      const shared = filtersToParams(filters({ withinKm: 5 }, PT), PT).toString();
      expect(shared).toBe("within=5");
      const asRead = read(shared, US);
      expect(asRead.withinKm).toBe(8);
      expect(withinLabel(asRead.withinKm, US)).toBe("5 mi");
      // And 3 mi (4.8 km) is not a choice in kilometres: the next one up is 5 km.
      const back = read(filtersToParams(filters({ withinKm: 4.8 }, US), US).toString(), PT);
      expect(back.withinKm).toBe(5);
      expect(withinLabel(back.withinKm, PT)).toBe("5 km");
    });

    it("is what snapWithin says, and nothing it is not", () => {
      expect(snapWithin(3, PT)).toBe(5);
      expect(snapWithin(Number.NaN, PT)).toBe(25);
      expect(snapWithin(0, US)).toBe(24);
    });
  });

  it("count the filters that are on: Open now, each kind and a distance, not the sort", () => {
    expect(filterCount(filters(), US)).toBe(0);
    expect(filterCount(filters({ sort: "name" }), US)).toBe(0);
    expect(filterCount(filters({ open: true }), US)).toBe(1);
    expect(filterCount(filters({ withinKm: 8 }), US)).toBe(1);
    expect(filterCount(filters({ families: ["cafes", "bars"] }), US)).toBe(2);
    expect(filterCount({ open: true, families: ["cafes", "bars"], withinKm: 4.8, sort: "name" }, US)).toBe(4);
  });

  it("count the widest distance of the person's own language as no filter", () => {
    expect(filterCount(filters({ withinKm: 25 }, PT), PT)).toBe(0);
    expect(filterCount(filters({ withinKm: 24 }, US), US)).toBe(0);
    // 25 km is a filter to a reader in miles, whose widest is 24.
    expect(filterCount(filters({ withinKm: 25 }, US), US)).toBe(1);
  });

  it("go into an address that has other things in it without touching them", () => {
    const params = new URLSearchParams("q=pizza&from=share&open=1&within=1.6");
    const next = withFilters(params, filters({ families: ["cafes"], sort: "name" }), US);
    expect(next.toString()).toBe("q=pizza&from=share&kinds=cafes&sort=name");
    // The address it was given is as it was.
    expect(params.toString()).toBe("q=pizza&from=share&open=1&within=1.6");
    expect(withFilters(new URLSearchParams("q=a&open=1"), filters(), US).toString()).toBe("q=a");
  });

  it("let a filter that is in the address keep its place in it", () => {
    const next = withFilters(new URLSearchParams("open=1&q=a&within=8"), filters({ open: true, withinKm: 1.6, sort: "name" }), US);
    expect(next.toString()).toBe("open=1&q=a&within=1.6&sort=name");
  });
});

describe("applyFilters", () => {
  const NOW = MORNING;
  const everyone = idx.near(HERE.lat, HERE.lon, 25);

  it("keeps every row when there is nothing to filter, in the order it was given, for a sort left to the page", () => {
    const result = applyFilters(everyone, filters(), NOW);
    expect(result.rows).toEqual(everyone);
    expect(result.hiddenClosed).toBe(0);
  });

  it("does not change the rows it is given", () => {
    const given = [row("Novo Tahiti", 3), row("Jacafé", 1)];
    const copyOfGiven = [...given];
    applyFilters(given, filters({ sort: "name", open: true }), NOW);
    expect(given).toEqual(copyOfGiven);
  });

  describe("Open now", () => {
    it("removes the places that are closed and counts them", () => {
      const result = applyFilters(everyone, filters({ open: true }), NOW);
      const closed = everyone.filter((each) => isClosed(each.place));
      expect(closed.length).toBeGreaterThan(10);
      expect(result.hiddenClosed).toBe(closed.length);
      expect(result.rows.map((each) => each.place)).toEqual(everyone.filter((each) => !isClosed(each.place)).map((each) => each.place));
      expect(result.rows.some((each) => isClosed(each.place))).toBe(false);
    });

    it("keeps the places with unknown or unreadable hours, since there is no telling", () => {
      const unknown = everyone.filter((each) => openState(each.place, NOW).kind === "unknown");
      expect(unknown.length).toBeGreaterThan(0);
      const odd = { ...place("Jacafé"), name: "Odd hours", openingHours: "whenever the owner feels like it" };
      expect(openState(odd, NOW).kind).toBe("unparsed");
      const result = applyFilters([...everyone, { place: odd, km: 1 }], filters({ open: true }), NOW);
      for (const each of unknown) expect(result.rows.map((kept) => kept.place)).toContain(each.place);
      expect(result.rows.map((kept) => kept.place.name)).toContain("Odd hours");
      // Neither is counted among those left out.
      expect(result.hiddenClosed).toBe(everyone.filter((each) => isClosed(each.place)).length);
    });

    it("judges by the time it is given: the same places are open in the afternoon", () => {
      const afternoon = new Date("2026-10-07T14:00:00Z");
      const result = applyFilters(everyone, filters({ open: true }), afternoon);
      expect(result.hiddenClosed).toBe(everyone.filter((each) => openState(each.place, afternoon).kind === "closed").length);
      expect(result.hiddenClosed).not.toBe(applyFilters(everyone, filters({ open: true }), NOW).hiddenClosed);
    });

    it("counts nothing when it is off", () => {
      expect(applyFilters(everyone, filters({ open: false }), NOW).hiddenClosed).toBe(0);
    });

    it("counts only the closed places the other filters would have kept", () => {
      const result = applyFilters(everyone, filters({ open: true, families: ["bakeries"] }), NOW);
      const bakeries = everyone.filter((each) => kindOf(each.place.category).family === "bakeries");
      expect(result.hiddenClosed).toBe(bakeries.filter((each) => isClosed(each.place)).length);
      const within = applyFilters(everyone, filters({ open: true, withinKm: 1 }), NOW);
      expect(within.hiddenClosed).toBe(everyone.filter((each) => each.km <= 1 && isClosed(each.place)).length);
    });
  });

  describe("kinds", () => {
    it("keeps the places of the kinds chosen, any of them", () => {
      const result = applyFilters(everyone, filters({ families: ["cafes", "bars"] }), NOW);
      const wanted = new Set<FamilyId>(["cafes", "bars"]);
      expect(result.rows.length).toBeGreaterThan(5);
      expect(result.rows).toEqual(everyone.filter((each) => wanted.has(kindOf(each.place.category).family)));
    });

    it("keeps all of them when none is chosen", () => {
      expect(applyFilters(everyone, filters({ families: [] }), NOW).rows).toHaveLength(everyone.length);
    });
  });

  describe("distance", () => {
    it("keeps the places within the distance, the edge included", () => {
      const edge = [row("Jacafé", 1), row("Novo Tahiti", 1.0001), row("Maia", 0.2)];
      const result = applyFilters(edge, filters({ withinKm: 1 }), NOW);
      expect(result.rows.map((each) => each.place.name)).toEqual(["Jacafé", "Maia"]);
    });

    it("keeps everything the search found when it is the widest, in kilometres or in miles", () => {
      expect(applyFilters(everyone, filters({ withinKm: 25 }, PT), NOW).rows).toHaveLength(everyone.length);
      expect(applyFilters(everyone, filters({ withinKm: widestKm(US) }), NOW).rows).toHaveLength(everyone.length);
    });

    it("takes a distance in kilometres that is not a whole number", () => {
      const edge = [row("Jacafé", 1.6), row("Novo Tahiti", 1.61), row("Maia", 0.2)];
      expect(applyFilters(edge, filters({ withinKm: 1.6 }), NOW).rows.map((each) => each.place.name)).toEqual(["Jacafé", "Maia"]);
    });
  });

  describe("order", () => {
    it("is nearest first for Distance, whatever order the rows came in", () => {
      const jumbled = [row("Novo Tahiti", 3), row("Jacafé", 1), row("Maia", 2)];
      expect(applyFilters(jumbled, filters({ sort: "distance" }), NOW).rows.map((each) => each.place.name)).toEqual([
        "Jacafé",
        "Maia",
        "Novo Tahiti",
      ]);
    });

    it("keeps the order it was given for places the same distance away, under Distance", () => {
      const tied = [row("Maia", 1), row("Jacafé", 1), row("Novo Tahiti", 1), row("Joker", 0.5)];
      expect(applyFilters(tied, filters({ sort: "distance" }), NOW).rows.map((each) => each.place.name)).toEqual([
        "Joker",
        "Maia",
        "Jacafé",
        "Novo Tahiti",
      ]);
    });

    it("is A to Z for Name, the way English reads it: accents and capitals do not decide", () => {
      const named = ["Zé", "Banana", "Álvaro", "alma", "Éden"].map((name, i) => ({
        place: { ...place("Jacafé"), name, address: `a${i}` },
        km: i,
      }));
      expect(applyFilters(named, filters({ sort: "name" }), NOW).rows.map((each) => each.place.name)).toEqual([
        "alma",
        "Álvaro",
        "Banana",
        "Éden",
        "Zé",
      ]);
    });

    it("puts places with one name nearest first under Name", () => {
      const same = [row("Loft Brunch & Cocktails", 5), row("Jacafé", 3), row("Loft Brunch & Cocktails", 2)];
      const sorted = applyFilters(same, filters({ sort: "name" }), NOW).rows;
      expect(sorted.map((each) => [each.place.name, each.km])).toEqual([
        ["Jacafé", 3],
        ["Loft Brunch & Cocktails", 2],
        ["Loft Brunch & Cocktails", 5],
      ]);
    });

    it("is the order it was given when the sort is left to the page, whatever that order is", () => {
      // The page's own order: nearest first for a kind of place, best match first for words.
      const asGiven = [row("Novo Tahiti", 3), row("Jacafé", 1), row("Maia", 2)];
      expect(applyFilters(asGiven, filters(), NOW).rows.map((each) => each.place.name)).toEqual([
        "Novo Tahiti",
        "Jacafé",
        "Maia",
      ]);
      expect(filters().sort).toBeUndefined();
    });

    it("is the order it was given for House picks' score too: the page orders by the scores it reads, ties in this order", () => {
      const asGiven = [row("Novo Tahiti", 3), row("Jacafé", 1), row("Maia", 2)];
      expect(applyFilters(asGiven, filters({ sort: "score" }), NOW).rows.map((each) => each.place.name)).toEqual([
        "Novo Tahiti",
        "Jacafé",
        "Maia",
      ]);
    });
  });
});

describe("withinChoices", () => {
  it("are 1, 2, 5, 10 and 25 kilometres for a reader in kilometres", () => {
    for (const locale of [PT, "en-GB", "de", "fr-CA", "ja"]) {
      const choices = withinChoices(locale);
      expect(choices.map((choice) => choice.km)).toEqual([1, 2, 5, 10, 25]);
      expect(choices.map((choice) => choice.label)).toEqual(["1 km", "2 km", "5 km", "10 km", "25 km"]);
    }
  });

  it("are half a mile, 1, 3, 5 and 15 miles for a reader in miles, kept as the kilometres they come to", () => {
    for (const locale of [US, "en-LR", "my-MM", "en", "es-US"]) {
      const choices = withinChoices(locale);
      expect(choices.map((choice) => choice.km)).toEqual([0.8, 1.6, 4.8, 8, 24]);
      expect(choices.map((choice) => choice.label)).toEqual(["0.5 mi", "1 mi", "3 mi", "5 mi", "15 mi"]);
    }
  });

  it("end at the widest, which is the default for the language", () => {
    expect(widestKm(PT)).toBe(25);
    expect(widestKm(US)).toBe(24);
    expect(noFilters(PT).withinKm).toBe(25);
    expect(noFilters(US).withinKm).toBe(24);
  });

  it("are the same choices on every call for a language", () => {
    expect(withinChoices(US)).toEqual(withinChoices(US));
    expect(withinChoices(PT)).toBe(withinChoices("de"));
  });

  it("name a distance as its own choice does, and a distance that is no choice as the choice it snaps to", () => {
    expect(withinLabel(8, US)).toBe("5 mi");
    expect(withinLabel(25, PT)).toBe("25 km");
    expect(withinLabel(5, US)).toBe("5 mi");
    expect(withinLabel(3, PT)).toBe("5 km");
  });
});

// =====================================================================================
// The compact rows
// =====================================================================================

describe("a place row", () => {
  function renderRow(name = "Jacafé", over: Partial<Place> = {}, km = 0.4) {
    const shown = { ...place(name), ...over };
    return render(
      <MemoryRouter>
        <PlaceRow place={shown} km={km} locale="en-US" now={MORNING} />
      </MemoryRouter>,
    );
  }

  it("is a link to the place, named by the place's name", () => {
    renderRow();
    const link = screen.getByRole("link", { name: "Jacafé" });
    expect(link).toHaveAttribute("href", "/place/osm-node-11330857543");
  });

  it("has the kind, how far and the hours on one line, with 'No reviews yet' at the top right, where a score goes", () => {
    renderRow();
    const link = screen.getByRole("link", { name: "Jacafé" });
    const top = within(link).getByText("Jacafé").parentElement!;
    expect(top.children).toHaveLength(2);
    expect(within(top).getByText(copy.score.noReviewsYet)).toHaveClass("text-caption", "font-semibold", "text-muted", "whitespace-nowrap");

    const kind = `${placeKindLabel("cafe", "coffee_shop")} · 0.2 mi · Closed · opens 9:30 am`;
    expect(link).toHaveAccessibleDescription(`${kind} ${copy.score.noReviewsYet}`);
    // The word that says whether it is open is bold.
    expect(within(link).getByText("Closed")).toHaveClass("font-bold", "text-ink");
    expect(link.textContent).toContain("Coffee shop · 0.2 mi · Closed · opens 9:30 am");
  });

  it("draws the kind on a tile of the row's size, and a line under the last row's edge", () => {
    renderRow();
    const link = screen.getByRole("link", { name: "Jacafé" });
    // 44 px tile, 12 px radius, as in Search.dc.html.
    expect(link.querySelector("span[aria-hidden='true']")).toHaveClass("size-11", "rounded-[12px]");
    expect(link).toHaveClass("border-b-token", "border-line", "py-3.5", "gap-3");
    expect(link).not.toHaveClass("rounded-card");
  });

  it("breaks a long name onto two lines, not past the edge", () => {
    const longName = "Restaurante Tradicional Madeirense da Família Fernandes e Filhos SA";
    renderRow(longName);
    const name = screen.getByText(longName);
    expect(name).toHaveClass("line-clamp-2", "min-w-0", "wrap-break-word", "font-display", "text-[18px]", "font-bold");
  });

  it("marks a Japanese name as Japanese", () => {
    renderRow("ペーパー・クレーン");
    expect(screen.getByText("ペーパー・クレーン")).toHaveAttribute("lang", "ja");
  });

  it("says when the hours are not listed, in the line", () => {
    renderRow("Minimal Table");
    expect(screen.getByRole("link")).toHaveAccessibleDescription(/ · Hours not listed No reviews yet$/);
  });

  it("shows hours it cannot read as they were written, on a line of their own, cut off at the end of it", () => {
    const written = `Mo-Fr 10:00-12:00; ${"unreadable ".repeat(30)}`;
    renderRow("Jacafé", { openingHours: written });
    const hours = screen.getByText(written.trim());
    expect(hours).toHaveClass("truncate");
    expect(hours).toHaveAttribute("title", written);
  });

  it("says open places are open, in bold, and when they close", () => {
    renderRow("Novo Tahiti");
    expect(screen.getByRole("link")).toHaveAccessibleDescription(/ · Open until 10 pm /);
    expect(screen.getByText("Open")).toHaveClass("font-bold");
  });
});

describe("a chain row", () => {
  const chain = idx.chainOf(place("Loft Brunch & Cocktails")) as Chain;
  const nearby = idx
    .near(HERE.lat, HERE.lon, 25)
    .filter((each) => each.place.name === "Loft Brunch & Cocktails");

  const renderChain = (now = MORNING) =>
    render(
      <MemoryRouter>
        <ChainCard chain={chain} nearby={nearby} locale="en-US" variant="row" now={now} />
      </MemoryRouter>,
    );

  it("is a dark tile, the chain's name with a chevron, what it is and how many, and how many are near and open", () => {
    renderChain();
    const link = screen.getByRole("link", { name: "Loft Brunch & Cocktails" });
    expect(link).toHaveAttribute("href", `/chain/${chainSlug(chain)}`);
    expect(link.querySelector("span[aria-hidden='true']")).toHaveClass("bg-emphasis", "text-on-emphasis", "size-11");
    expect(link.querySelector("svg path[d='M9 5l7 7-7 7']")).not.toBeNull();
    // The kind is the nearest location's.
    const kind = placeKindLabel(nearby[0]!.place.category, nearby[0]!.place.cuisine);
    expect(link).toHaveTextContent(copy.explore.chainKind(kind, 2));
    // Both are closed at 08:45.
    expect(link).toHaveTextContent(copy.search.chainNearbyOpen(2, 0));
    expect(copy.search.chainNearbyOpen(2, 0)).toBe("2 near you, none open now");
  });

  it("has no tint or edge of its own: it is a row", () => {
    renderChain();
    const link = screen.getByRole("link", { name: "Loft Brunch & Cocktails" });
    expect(link).toHaveClass("border-b-token", "border-line", "py-3.5");
    expect(link).not.toHaveClass("bg-surface", "rounded-card");
  });

  it("counts the places open now, at the time it is given", () => {
    // 15:00 in Funchal.
    renderChain(new Date("2026-10-07T14:00:00Z"));
    const openNow = nearby.filter((each) => openState(each.place, new Date("2026-10-07T14:00:00Z")).kind === "open").length;
    expect(screen.getByRole("link")).toHaveTextContent(copy.search.chainNearbyOpen(2, openNow));
    expect(copy.search.chainNearbyOpen(3, 2)).toBe("3 near you, 2 open now");
  });
});

// =====================================================================================
// The search page
// =====================================================================================

describe("Search on a phone: the top of the page", () => {
  it("has a way back to Explore, the search field with what was searched for, the filters chip and the line", async () => {
    await openSearch("/search?q=pizza");
    const back = screen.getByRole("link", { name: copy.search.back });
    expect(back).toHaveAttribute("href", "/");
    expect(field()).toHaveValue("pizza");
    expect(field()).toHaveAttribute("type", "search");
    expect(screen.getByRole("button", { name: copy.search.clear })).toBeInTheDocument();
    expect(within(chipsGroup()).getByRole("link", { name: copy.search.filters(0) })).toHaveAttribute("href", "/filters?q=pizza");

    const inOrder = [back, field(), chipsGroup(), screen.getByRole("list")];
    inOrder.slice(1).forEach((element, i) => {
      expect(inOrder[i]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("names the page for a screen reader and the browser's tab", async () => {
    await openSearch();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
    await waitFor(() => expect(document.title).toBe(copy.titles.search));
  });

  it("is a single search field, not a second one next to it", async () => {
    await openSearch("/search?q=pizza");
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.getAllByRole("search")).toHaveLength(1);
  });

  it("puts the cursor in the field when the person comes from Explore, to type", async () => {
    const user = userEvent.setup();
    open(["/"], fixtures);
    await user.click(await screen.findByRole("link", { name: /Tacos, coffee, a place name/ }));
    expect(field()).toHaveFocus();
  });

  it("puts the cursor in the field for an address that was typed in", async () => {
    await openSearch("/search?q=pizza");
    expect(field()).toHaveFocus();
  });

  it("does not put it there when the person comes Back to the results, so the keyboard stays down", async () => {
    open(["/", "/search?q=pizza"], fixtures, 1);
    await screen.findByRole("heading", { level: 1, name: copy.pages.search });
    expect(field()).not.toHaveFocus();
  });

  it("clears the field and the search with the cross, and keeps the filters", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza&open=1");
    await user.click(screen.getByRole("button", { name: copy.search.clear }));
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
    expect(router.state.location.search).toBe("?open=1");
  });

  it("has no cross when the field is empty", async () => {
    await openSearch("/search");
    expect(screen.queryByRole("button", { name: copy.search.clear })).not.toBeInTheDocument();
  });
});

describe("Search: the way back", () => {
  const back = () => screen.getByRole("link", { name: copy.search.back });

  it("goes to Explore for an address that was typed in, which has no step in the app to go back to", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza");
    expect(back()).toHaveAttribute("href", "/");
    await user.click(back());
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("PUSH");
  });

  describe("to the Explore the person left", () => {
    const exploreChip = (name: string) =>
      within(screen.getByRole("group", { name: copy.explore.filtersLabel })).getByRole("button", { name });
    const searchLink = () => screen.findByRole("link", { name: /Tacos, coffee, a place name/ });
    const atExplore = async () => {
      const opened = openInBrowser("/");
      await screen.findByRole("heading", { level: 1, name: copy.pages.explore });
      return opened;
    };
    /** Waits for the router to be at the entry of the history with this key, and the page to be drawn. */
    const backAt = async (router: ReturnType<typeof createBrowserRouter>, key: string) => {
      await waitFor(() => expect(router.state.location.key).toBe(key));
      await screen.findByRole("heading", { level: 1, name: copy.pages.explore });
    };

    it("is the same entry of the history, so its chip is still on", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      await user.click(exploreChip("Cafes"));
      const explore = router.state.location.key;
      expect(router.state.location.search).toBe("?chip=cafes");

      await user.click(await searchLink());
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      await user.click(back());
      await backAt(router, explore);
      expect(router.state.historyAction).toBe("POP");
      expect(router.state.location.search).toBe("?chip=cafes");
      expect(exploreChip("Cafes")).toHaveAttribute("aria-pressed", "true");
    });

    it("is one press away after the filters were applied, which was two steps further on", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      const explore = router.state.location.key;

      await user.click(await searchLink());
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      await user.click(within(chipsGroup()).getByRole("link", { name: copy.search.filters(0) }));
      await screen.findByRole("heading", { level: 1, name: copy.pages.filters });
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      expect(router.state.location.search).toBe("?open=1");

      await user.click(back());
      await backAt(router, explore);
    });

    it("is one press away after the cross of the filters", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      const explore = router.state.location.key;
      await user.click(await searchLink());
      await user.click(within(chipsGroup()).getByRole("link", { name: copy.search.filters(0) }));
      await user.click(await screen.findByRole("link", { name: copy.filters.close }));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });

      await user.click(back());
      await backAt(router, explore);
    });

    it("is one press away after a chip took its filter off, which was a step of its own", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      const explore = router.state.location.key;
      // Anything that leaves Explore for the search counts, not only its link.
      await act(() => router.navigate("/search?open=1&within=8"));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      await user.click(chip("Open now"));
      await waitFor(() => expect(router.state.location.search).toBe("?within=8"));
      await user.click(chip("Within 5 mi"));
      await waitFor(() => expect(router.state.location.search).toBe(""));

      await user.click(back());
      await backAt(router, explore);
    });

    it("is one press away after the words were searched for in the field too", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      const explore = router.state.location.key;
      await user.click(await searchLink());
      await user.type(field(), "novo{Enter}");
      await waitFor(() => expect(router.state.location.search).toBe("?q=novo"));
      await user.click(back());
      await backAt(router, explore);
    });

    it("is the Explore the person was last at, when they went on to a place and came Back", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      await user.click(exploreChip("Open now"));
      const explore = router.state.location.key;
      await user.click(await searchLink());
      await user.type(field(), "novo{Enter}");
      await user.click(await screen.findByRole("link", { name: "Novo Tahiti" }));
      expect(router.state.location.pathname).toBe(`/place/${place("Novo Tahiti").d}`);
      await act(() => router.navigate(-1));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      await user.click(back());
      await backAt(router, explore);
    });

    it("goes to Explore as a new step when the page was opened at the search, and the history has no Explore behind it", async () => {
      const user = userEvent.setup();
      const { router } = openInBrowser("/search?q=pizza");
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      const first = router.state.location.key;
      await user.click(back());
      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(router.state.historyAction).toBe("PUSH");
      expect(router.state.location.key).not.toBe(first);
    });

    it("goes to Explore as a new step after the page was reloaded, which the module's memory does not outlive", async () => {
      const user = userEvent.setup();
      const { router } = await atExplore();
      const explore = router.state.location.key;
      await user.click(await searchLink());
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      // A reload starts the page's scripts again.
      forgetExploreIdx();
      await user.click(back());
      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(router.state.historyAction).toBe("PUSH");
      expect(router.state.location.key).not.toBe(explore);
    });

    it("goes to Explore as a new step when the typed-in first entry was replaced by the field, with nothing behind it to go back to", async () => {
      const user = userEvent.setup();
      const { router } = openInBrowser("/search?q=pizza");
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      await user.clear(field());
      await user.type(field(), "novo{Enter}");
      await waitFor(() => expect(router.state.location.search).toBe("?q=novo"));
      await user.click(back());
      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(router.state.historyAction).toBe("PUSH");
    });
  });

  describe("stepsBackToExplore", () => {
    const at = (idx: number | undefined) =>
      window.history.replaceState(idx === undefined ? null : { usr: null, key: "k", idx }, "", "/search");

    it("is how many steps the history is on from the Explore it recorded", () => {
      setExploreIdx(3);
      at(5);
      expect(stepsBackToExplore()).toBe(-2);
      at(4);
      expect(stepsBackToExplore()).toBe(-1);
    });

    it("is nothing when the recorded Explore is not behind this entry", () => {
      setExploreIdx(5);
      at(5);
      expect(stepsBackToExplore()).toBeUndefined();
      setExploreIdx(7);
      expect(stepsBackToExplore()).toBeUndefined();
    });

    it("is nothing when no Explore was recorded, as on a page that was just loaded", () => {
      at(5);
      forgetExploreIdx();
      expect(stepsBackToExplore()).toBeUndefined();
      setExploreIdx(undefined);
      expect(stepsBackToExplore()).toBeUndefined();
      setExploreIdx("3");
      expect(stepsBackToExplore()).toBeUndefined();
    });

    it("is nothing when the history says no index, as in a router that does not keep one", () => {
      setExploreIdx(3);
      at(undefined);
      expect(stepsBackToExplore()).toBeUndefined();
    });
  });

  it("still goes to Explore, not out of the app, when the words of a typed-in address were changed in the field", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza");
    await user.clear(field());
    await user.type(field(), "novo{Enter}");
    // The entry was replaced and has a key of its own now, but the person did not come from a page of the app.
    expect(router.state.location.key).not.toBe("default");
    await user.click(back());
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("PUSH");
  });

  it("keeps words that were typed and not yet searched for when the person leaves by it", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search");
    fireEvent.change(field(), { target: { value: "casa velha" } });
    // No time has passed: the field has not searched yet.
    expect(router.state.location.search).toBe("");
    await user.click(back());
    expect(router.state.location.pathname).toBe("/");

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toBe("?q=casa+velha");
    expect(field()).toHaveValue("casa velha");
  });

  it("keeps them when the person leaves by the Filters chip, to the filters and back", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?open=1");
    fireEvent.change(field(), { target: { value: "casa" } });
    expect(router.state.location.search).toBe("?open=1");

    await user.click(within(chipsGroup()).getByRole("link", { name: copy.search.filters(1) }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/filters"));
    // The filters page has the words, so Show places and the cross keep them.
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("casa");
    expect(new URLSearchParams(router.state.location.search).get("open")).toBe("1");

    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/search");
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("casa");
    expect(field()).toHaveValue("casa");
  });

  it("leaves the chip's own link alone when nothing is waiting", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza");
    await user.click(within(chipsGroup()).getByRole("link", { name: copy.search.filters(0) }));
    expect(router.state.location.pathname).toBe("/filters");
    expect(router.state.location.search).toBe("?q=pizza");
    expect(router.state.historyAction).toBe("PUSH");
  });
});

describe("Search: the results", () => {
  it("lists the places that match, with the line of how many, where, and in what order", async () => {
    await openSearch("/search?q=pizza");
    expect(names()).toEqual(["Ciao Pizzeria", "Xarambinha Pizzeria Expresso"]);
    expect(names()).toEqual(listed("pizza"));
    // Words that are not a kind of place: best match first.
    const summary = copy.search.summary(2, "Funchal", copy.search.sortedBy.relevance);
    expect(summary).toBe("2 places near Funchal. Best match first.");
    // A screen reader announces it when the results change.
    expect(screen.getByText(summary).closest('[role="status"]')).not.toBeNull();
  });

  it("is a list of links, one to a place", async () => {
    await openSearch("/search?q=pizza");
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole("link")).toHaveAttribute("href", `/place/${encodeURIComponent(place("Ciao Pizzeria").d)}`);
  });

  it("says each place's kind, distance and hours, and that nobody has reviewed it", async () => {
    await openSearch("/search?q=pizza");
    const ciao = place("Ciao Pizzeria");
    const km = distanceKm(HERE.lat, HERE.lon, ciao.lat, ciao.lon);
    const link = rowFor("Ciao Pizzeria");
    expect(link.textContent).toContain(`${placeKindLabel(ciao.category, ciao.cuisine)} · ${formatDistance(km, "en-US")} · Closed`);
    expect(link).toHaveTextContent(copy.score.noReviewsYet);
  });

  it("shows a chain as one row of its own, and counts its locations in the line", async () => {
    await openSearch("/search?q=loft");
    expect(names()).toEqual(["Loft Brunch & Cocktails"]);
    const link = rowFor("Loft Brunch & Cocktails");
    expect(link).toHaveAttribute("href", `/chain/${chainSlug(idx.chainOf(place("Loft Brunch & Cocktails"))!)}`);
    expect(link).toHaveTextContent("2 locations");
    // One row, two places: the line counts places, as every count of them in the app does.
    expect(counted("loft")).toBe(2);
    expect(screen.getByText(copy.search.summary(2, "Funchal", copy.search.sortedBy.relevance))).toBeInTheDocument();
    expect(copy.search.summary(1, "Funchal", "Nearest first")).toBe("1 place near Funchal. Nearest first.");
  });

  it("counts places the same in the line, the filters' button and the desktop's line", async () => {
    const line = copy.search.summary(counted("loft"), "Funchal", copy.search.sortedBy.relevance);
    const { unmount } = await openSearch("/search?q=loft");
    expect(screen.getByText(line)).toBeInTheDocument();
    unmount();

    const filters = await openFilters("/filters?q=loft");
    expect(screen.getByRole("button", { name: copy.filters.show(2) })).toBeInTheDocument();
    expect(screen.getByText(copy.filters.countStatus(2))).toBeInTheDocument();
    filters.unmount();

    wideWindow();
    await openSearch("/search?q=loft");
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it("lists the places around the person when nothing was typed", async () => {
    await openSearch("/search");
    expect(names()).toEqual(listed("").slice(0, PAGE));
    expect(screen.getByText(copy.search.summary(counted(""), "Funchal", copy.search.sortedBy.distance))).toBeInTheDocument();
  });

  it("reads a kind of place as a list of them, nearest first, and says so", async () => {
    await openSearch("/search?q=cafe");
    expect(idx.isKindQuery("cafe")).toBe(true);
    expect(names()).toEqual(listed("cafe"));
    expect(screen.getByText(copy.search.summary(counted("cafe"), "Funchal", "Nearest first"))).toBeInTheDocument();
  });

  it("says 'near you' when the places are around the device", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      get: () => ({
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: HERE.lat, longitude: HERE.lon, accuracy: 20 }, timestamp: 0 } as unknown as GeolocationPosition),
      }),
    });
    const user = userEvent.setup();
    const { router } = open(["/"], fixtures);
    await user.click(await screen.findByRole("button", { name: "Near Funchal" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: copy.location.useMine }));
    await screen.findByRole("button", { name: `Near ${copy.location.you}` });

    await act(() => router.navigate("/search?q=pizza"));
    expect(screen.getByText("2 places near you. Best match first.")).toBeInTheDocument();
    Reflect.deleteProperty(navigator, "geolocation");
  });

  it("shows distances in kilometres where the browser's language does", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    await openSearch("/search?q=pizza");
    // Portuguese writes a decimal comma: "2,3 km".
    expect(rowFor("Ciao Pizzeria").textContent).toMatch(/\d+ m|\d[.,]\d km/);
    expect(rowFor("Ciao Pizzeria").textContent).not.toMatch(/ mi\b/);
  });

  it("has the attribution for the place details at the foot", async () => {
    await openSearch("/search?q=pizza");
    expect(screen.getByText(/Place details/)).toHaveTextContent(copy.attribution.details);
    expect(screen.getByRole("link", { name: copy.attribution.openStreetMap })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
  });
});

describe("Search: the order", () => {
  /** Where a place is in a list of rows, by its name. */
  const kmOf = (name: string) => {
    const found = place(name);
    return distanceKm(HERE.lat, HERE.lon, found.lat, found.lon);
  };
  const byDistance = (list: string[]) => list.every((name, i) => i === 0 || kmOf(list[i - 1]!) <= kmOf(name));

  describe("left to the page", () => {
    it("is nearest first for a kind of place, and the line says so", async () => {
      await openSearch("/search?q=cafe");
      expect(idx.isKindQuery("cafe")).toBe(true);
      expect(names()).toEqual(listed("cafe"));
      expect(byDistance(names())).toBe(true);
      expect(screen.getByText(copy.search.summary(counted("cafe"), "Funchal", "Nearest first"))).toBeInTheDocument();
    });

    it("is nearest first when nothing was typed, and the line says so", async () => {
      await openSearch("/search");
      expect(byDistance(names())).toBe(true);
      expect(screen.getByText(copy.search.summary(counted(""), "Funchal", "Nearest first"))).toBeInTheDocument();
    });

    it("is the index's own order, best match first, for words, and the line says so", async () => {
      // "restaurante" is not a kind, and its best matches are not its nearest: a name with the word first beats a nearer one.
      expect(idx.isKindQuery("restaurante")).toBe(false);
      const found = listed("restaurante");
      expect(byDistance(found)).toBe(false);

      await openSearch("/search?q=restaurante");
      expect(names()).toEqual(found);
      expect(screen.getByText(copy.search.summary(counted("restaurante"), "Funchal", copy.search.sortedBy.relevance))).toBeInTheDocument();
      expect(copy.search.sortedBy.relevance).toBe("Best match first");
      expect(screen.queryByText(/Nearest first/)).not.toBeInTheDocument();
    });

    it("is not in the address, so the address stays short, and the filters page starts with no sort pressed", async () => {
      const { router } = await openSearch("/search?q=restaurante&open=1");
      expect(new URLSearchParams(router.state.location.search).has("sort")).toBe(false);
    });
  });

  describe("asked for", () => {
    it("is nearest first for Distance, for words as well, and the line says so", async () => {
      await openSearch("/search?q=restaurante&sort=distance");
      const found = names();
      expect(found).toHaveLength(listed("restaurante").length);
      expect(byDistance(found)).toBe(true);
      expect(found).not.toEqual(listed("restaurante"));
      expect(screen.getByText(copy.search.summary(counted("restaurante"), "Funchal", copy.search.sortedBy.distance))).toBeInTheDocument();
    });

    it("is A to Z for Name, and the line says so", async () => {
      await openSearch("/search?q=cafe&sort=name");
      const collator = new Intl.Collator("en");
      expect(names()).toEqual([...listed("cafe")].sort(collator.compare));
      expect(screen.getByText(copy.search.summary(counted("cafe"), "Funchal", copy.search.sortedBy.name))).toBeInTheDocument();
      expect(copy.search.sortedBy.name).toBe("A to Z");
    });

    it("is nearest first for House picks' score while no place has one, and the line says it is by the score", async () => {
      // A place with no score follows those with one, nearest first, whatever order the words found them in.
      await openSearch("/search?q=restaurante&sort=score");
      const found = names();
      expect(found).toHaveLength(listed("restaurante").length);
      expect(byDistance(found)).toBe(true);
      expect(
        screen.getByText(copy.search.summary(counted("restaurante"), "Funchal", copy.search.sortedBy.score)),
      ).toBeInTheDocument();
    });
  });
});

describe("Search: the filters that are on", () => {
  it("shows each as a chip that is pressed, and counts them in the Filters chip", async () => {
    await openSearch("/search?q=cafe&open=1&within=8&kinds=cafes,bars");
    const group = chipsGroup();
    const filtersLink = within(group).getByRole("link", { name: copy.search.filters(4) });
    expect(filtersLink).toHaveAttribute("href", "/filters?q=cafe&open=1&within=8&kinds=cafes%2Cbars");
    expect(copy.search.filters(4)).toBe("Filters · 4");

    const pressed = within(group).getAllByRole("button");
    expect(pressed.map((button) => button.textContent)).toEqual([
      "Open now",
      "Within 5 mi",
      "Cafes",
      "Bars and pubs",
    ]);
    expect(copy.search.within("5 mi")).toBe("Within 5 mi");
    for (const button of pressed) {
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("bg-emphasis", "text-on-emphasis", "h-11", "rounded-chip");
    }
  });

  it("shows none when none is on", async () => {
    await openSearch("/search?q=cafe&sort=name");
    expect(within(chipsGroup()).queryAllByRole("button")).toHaveLength(0);
    expect(within(chipsGroup()).getByRole("link")).toHaveTextContent("Filters");
  });

  it("takes one off when its chip is pressed, as a step the Back button undoes, and keeps the rest", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe&open=1&within=8&from=share");
    await user.click(chip("Open now"));
    expect(router.state.location.search).toBe("?q=cafe&within=8&from=share");
    expect(router.state.historyAction).toBe("PUSH");
    expect(screen.queryByRole("button", { name: "Open now" })).not.toBeInTheDocument();

    await user.click(chip("Within 5 mi"));
    expect(router.state.location.search).toBe("?q=cafe&from=share");

    await act(() => router.navigate(-1));
    expect(chip("Within 5 mi")).toHaveAttribute("aria-pressed", "true");
  });

  describe("focus when a chip takes its filter off", () => {
    it("goes to the next chip, since the one that was pressed is gone", async () => {
      const user = userEvent.setup();
      await openSearch("/search?q=cafe&open=1&within=8&kinds=cafes");
      await user.click(chip("Open now"));
      await waitFor(() => expect(chip("Within 5 mi")).toHaveFocus());
      await user.click(chip("Within 5 mi"));
      await waitFor(() => expect(chip("Cafes")).toHaveFocus());
    });

    it("goes to the Filters chip when no chip is next", async () => {
      const user = userEvent.setup();
      await openSearch("/search?q=cafe&open=1&kinds=cafes");
      await user.click(chip("Cafes"));
      await waitFor(() => expect(within(chipsGroup()).getByRole("link")).toHaveFocus());
      await user.click(chip("Open now"));
      await waitFor(() => expect(within(chipsGroup()).getByRole("link")).toHaveFocus());
    });

    it("goes to the next chip, or the Filters chip, when 'Show closed places too' takes Open now off", async () => {
      const user = userEvent.setup();
      await openSearch("/search?q=pizza&open=1&within=8");
      await user.click(screen.getByRole("button", { name: copy.search.showClosed }));
      await waitFor(() => expect(chip("Within 5 mi")).toHaveFocus());
    });

    it("goes to the Filters chip when 'Show closed places too' leaves no chip", async () => {
      const user = userEvent.setup();
      await openSearch("/search?q=pizza&open=1");
      await user.click(screen.getByRole("button", { name: copy.search.showClosed }));
      await waitFor(() => expect(within(chipsGroup()).getByRole("link")).toHaveFocus());
    });

    it("does not take the focus when the filters change some other way", async () => {
      const { router } = await openSearch("/search?q=cafe&open=1");
      field().blur();
      await act(() => router.navigate("/search?q=cafe"));
      expect(within(chipsGroup()).getByRole("link")).not.toHaveFocus();
    });
  });

  it("takes one kind off and leaves the others", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?kinds=cafes,bars,bakeries");
    await user.click(chip("Bars and pubs"));
    expect(new URLSearchParams(router.state.location.search).get("kinds")).toBe("cafes,bakeries");
    await user.click(chip("Cafes"));
    await user.click(chip("Bakeries and sweets"));
    expect(router.state.location.search).toBe("");
  });

  it("lists only the open places and those without hours with Open now, and says how many are left out", async () => {
    await openSearch("/search?q=cafe&open=1");
    const expected = listed("cafe", (each) => !isClosed(each));
    expect(expected.length).toBeLessThan(listed("cafe").length);
    expect(names()).toEqual(expected);
    const left = idx.search("cafe", { lat: HERE.lat, lon: HERE.lon, radiusKm: 25 }).filter((each) => isClosed(each.place)).length;
    expect(left).toBeGreaterThan(0);
    expect(screen.getByText(copy.search.hiddenClosed(left))).toBeInTheDocument();
    expect(screen.getByText(copy.search.hoursNote)).toBeInTheDocument();
    expect(screen.getByText(copy.search.summary(counted("cafe", (each) => !isClosed(each)), "Funchal", "Nearest first"))).toBeInTheDocument();
  });

  it("has the note about the places left out in a box under the results, with a way to bring them back", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe&open=1&within=8");
    const left = idx.search("cafe", { lat: HERE.lat, lon: HERE.lon, radiusKm: 8 }).filter((each) => isClosed(each.place)).length;
    const note = screen.getByText(copy.search.hiddenClosed(left)).parentElement!;
    expect(note).toHaveClass("bg-surface", "rounded-card");
    expect(within(note).getByText(copy.search.hoursNote)).toBeInTheDocument();
    expect(screen.getByRole("list").compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(note).getByRole("button", { name: copy.search.showClosed }));
    expect(router.state.location.search).toBe("?q=cafe&within=8");
    expect(screen.queryByText(copy.search.hoursNote)).not.toBeInTheDocument();
    expect(names()).toEqual(listed("cafe", () => true, 8));
  });

  it("says nothing about closed places when Open now is off, or when none was left out", async () => {
    await openSearch("/search?q=cafe");
    expect(screen.queryByText(copy.search.hoursNote)).not.toBeInTheDocument();
  });

  it("says one place is closed in the singular", () => {
    expect(copy.search.hiddenClosed(1)).toBe("1 more is closed right now");
    expect(copy.search.hiddenClosed(4)).toBe("4 more are closed right now");
  });

  it("keeps only the kinds chosen", async () => {
    await openSearch("/search?kinds=bakeries");
    expect(names()).toEqual(listed("", (each) => kindOf(each.category).family === "bakeries"));
    expect(names().length).toBeGreaterThan(0);
  });

  it("keeps only the places within the distance", async () => {
    // 1 mile, which is 1.6 kilometres.
    await openSearch("/search?within=1.6");
    const expected = listed("", () => true, 1.6);
    expect(expected.length).toBeLessThan(listed("").length);
    expect(names()).toEqual(expected);
    for (const link of rows().filter((each) => each.getAttribute("href")?.startsWith("/place/"))) {
      const found = [...idx.byD.values()].find((each) => `/place/${encodeURIComponent(each.d)}` === link.getAttribute("href"))!;
      expect(distanceKm(HERE.lat, HERE.lon, found.lat, found.lon)).toBeLessThanOrEqual(1.6);
    }
  });

  it("reads the distance in the person's own unit: a link in kilometres lands on the next choice in miles", async () => {
    // 5 km is not a choice in miles; the next one up is 5 mi (8 km), so no place the link meant is lost.
    await openSearch("/search?within=5");
    expect(chip("Within 5 mi")).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(listed("", () => true, 8));
  });

  it("names the distance in kilometres where the browser's language does", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    await openSearch("/search?within=5&kinds=cafes");
    expect(chip("Within 5 km")).toBeInTheDocument();
    // In Portuguese for Portugal, and in no town's time zone, the list starts at Portugal's town with the most places.
    const start = idx.cities.find((town) => town.country === "PT")!;
    expect(names()).toEqual(listed("", (each) => kindOf(each.category).family === "cafes", 5, start));
  });

  it("counts a chain only for the locations that pass", async () => {
    const hours = (value: string) => ({ "opening-hours": value, category: "restaurant" });
    const events = [
      variant(nameOnly, { d: "tide-1", name: "Tide Pool Bar", lat: "32.651", lon: "-16.908", ...hours("Mo-Su 08:00-20:00") }),
      variant(nameOnly, { d: "tide-2", name: "Tide Pool Bar", lat: "32.652", lon: "-16.909", ...hours("Mo-Su 08:00-20:00") }),
      variant(nameOnly, { d: "tide-3", name: "Tide Pool Bar", lat: "32.653", lon: "-16.91", ...hours("Mo-Su 12:00-23:00") }),
    ];
    const view = await openSearch("/search?q=tide", events);
    expect(rowFor("Tide Pool Bar")).toHaveTextContent("3 near you, 2 open now");
    expect(rowFor("Tide Pool Bar")).toHaveTextContent("3 locations");
    view.unmount();

    await openSearch("/search?q=tide&open=1", events);
    expect(rowFor("Tide Pool Bar")).toHaveTextContent("2 near you, 2 open now");
    expect(rowFor("Tide Pool Bar")).toHaveTextContent("3 locations");
  });

  it("keeps what else the address holds when the field changes", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza&open=1&from=share");
    await user.type(field(), "x{Enter}");
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("q")).toBe("pizzax");
    expect(params.get("open")).toBe("1");
    expect(params.get("from")).toBe("share");
  });
});

describe("Search: typing", () => {
  it("searches when the person submits, replacing the page in the history rather than adding to it", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search");
    await user.type(field(), "novo{Enter}");
    expect(router.state.location.search).toBe("?q=novo");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(names()).toEqual(["Novo Tahiti"]);
  });

  it("puts the keyboard away after a search is submitted", async () => {
    const user = userEvent.setup();
    await openSearch("/search");
    await user.type(field(), "novo{Enter}");
    expect(field()).not.toHaveFocus();
  });

  it("searches by itself once the person stops typing, replacing the page in the history", async () => {
    // The next test holds the timing on a fake clock: nothing is searched for until a quarter of a second
    // after the last letter. On a real clock a slow machine can leave that long between two letters, so
    // this one waits for the outcome only.
    const user = userEvent.setup();
    const { router } = await openSearch("/search");
    await user.type(field(), "novo");
    // The address changes first and the list is drawn after it, so both are waited for.
    await waitFor(
      () => {
        expect(router.state.location.search).toBe("?q=novo");
        expect(names()).toEqual(["Novo Tahiti"]);
      },
      { timeout: 1500 },
    );
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("waits the quarter of a second out from the last letter", async () => {
    const { router } = await openSearch("/search");
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: MORNING });

    fireEvent.change(field(), { target: { value: "nov" } });
    await act(async () => void vi.advanceTimersByTime(249));
    expect(router.state.location.search).toBe("");
    // Another letter starts the wait again.
    fireEvent.change(field(), { target: { value: "novo" } });
    await act(async () => void vi.advanceTimersByTime(249));
    expect(router.state.location.search).toBe("");
    await act(async () => void vi.advanceTimersByTime(1));
    expect(router.state.location.search).toBe("?q=novo");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(names()).toEqual(["Novo Tahiti"]);
  });

  it("writes the search without the spaces around it, and does not take them out of the field while the person is typing", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search");
    await user.type(field(), "casa velha ");
    await waitFor(() => expect(router.state.location.search).toBe("?q=casa+velha"), { timeout: 1500 });
    expect(field()).toHaveValue("casa velha ");
    await user.type(field(), "bar");
    expect(field()).toHaveValue("casa velha bar");
  });

  it("does not search again for a search the address already has", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=novo");
    const before = router.state.location.key;
    await user.type(field(), " {Enter}");
    expect(router.state.location.key).toBe(before);
  });

  it("follows the address when it changes some other way, as Back and the top bar's search do", async () => {
    const { router } = await openSearch("/search?q=novo");
    await act(() => router.navigate("/search?q=pizza"));
    expect(field()).toHaveValue("pizza");
    expect(names()).toEqual(listed("pizza"));
    await act(() => router.navigate(-1));
    expect(field()).toHaveValue("novo");
    expect(names()).toEqual(["Novo Tahiti"]);
  });

  it("drops the query from the address when the field is emptied", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=novo&open=1");
    await user.clear(field());
    await waitFor(() => expect(router.state.location.search).toBe("?open=1"), { timeout: 1500 });
    await waitFor(() => expect(names()).toEqual(listed("", (each) => !isClosed(each)).slice(0, PAGE)));
  });
});

describe("Search: nothing matches", () => {
  it("says so, with the words searched for and where, a hint, and a way to add the place", async () => {
    await openSearch("/search?q=zzzz");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText('No places match "zzzz" near Funchal.')).toBeInTheDocument();
    expect(copy.search.noResults("zzzz", "Funchal")).toBe('No places match "zzzz" near Funchal.');
    expect(screen.getByText(copy.search.noResultsHint)).toBeInTheDocument();
    // No count of nothing.
    expect(screen.queryByText(/0 places near/)).not.toBeInTheDocument();
    expect(addMissing()).toBeInTheDocument();
  });

  describe("a long search", () => {
    const long = "x".repeat(200);

    it("is shown as its first eighty letters and an ellipsis, so one sentence cannot fill the page", async () => {
      await openSearch(`/search?q=${long}`);
      const sentence = copy.search.noResults(`${"x".repeat(80)}…`, "Funchal");
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent("x".repeat(81));
      // The field still has all of it.
      expect(field()).toHaveValue(long);
    });

    it("is cut between characters, not through one", async () => {
      const faces = "😀".repeat(100);
      await openSearch(`/search?q=${encodeURIComponent(faces)}`);
      expect(screen.getByText(copy.search.noResults(`${"😀".repeat(80)}…`, "Funchal"))).toBeInTheDocument();
    });

    it("is shown whole when it is eighty letters or fewer", async () => {
      const eighty = "y".repeat(80);
      await openSearch(`/search?q=${eighty}`);
      expect(screen.getByText(copy.search.noResults(eighty, "Funchal"))).toBeInTheDocument();
    });

    it("wraps inside a word, so a search with no spaces does not push the page wider than the screen", async () => {
      await openSearch(`/search?q=${long}`);
      const sentence = screen.getByText(copy.search.noResults(`${"x".repeat(80)}…`, "Funchal"));
      expect(sentence).toHaveClass("wrap-break-word", "min-w-0");
    });
  });

  describe("the live region", () => {
    const status = (text: string) => screen.getByText(text).closest<HTMLElement>('[role="status"]')!;

    it("is one container that is always there, holding the line when there are results and the sentence when there are none, never both", async () => {
      const { router } = await openSearch("/search?q=pizza");
      const sentence = copy.search.noResults("zzzz", "Funchal");
      const region = status(copy.search.summary(2, "Funchal", "Best match first"));
      expect(region).toBeInTheDocument();

      // To no results and back: the same element, with the words changing in it.
      await act(() => router.navigate("/search?q=zzzz", { replace: true }));
      await waitFor(() => expect(screen.getByText(sentence)).toBeInTheDocument());
      expect(status(sentence)).toBe(region);
      expect(region).toHaveTextContent(sentence);
      expect(region).not.toHaveTextContent("places near");
      expect(screen.getAllByText(/Funchal/)).toHaveLength(1);

      await act(() => router.navigate("/search?q=pizza", { replace: true }));
      await waitFor(() => expect(screen.getByText(copy.search.summary(2, "Funchal", "Best match first"))).toBeInTheDocument());
      expect(status(copy.search.summary(2, "Funchal", "Best match first"))).toBe(region);
      expect(region).not.toHaveTextContent("No places match");
      expect(region).toBeInTheDocument();
    });

    it("holds the sentence for every kind of empty result, and the hint stays outside it", async () => {
      const { router } = await openSearch("/search?q=pizza&open=1");
      const region = status(copy.search.noResultsOpen("pizza", "Funchal"));
      await act(() => router.navigate("/search?q=zzzz", { replace: true }));
      await waitFor(() => expect(screen.getByText(copy.search.noResults("zzzz", "Funchal"))).toBeInTheDocument());
      expect(status(copy.search.noResults("zzzz", "Funchal"))).toBe(region);
      expect(region).not.toContainElement(screen.getByText(copy.search.noResultsHint));

      await act(() => router.navigate("/search?kinds=ice-cream", { replace: true }));
      await waitFor(() => expect(screen.getByText(copy.search.noResultsFiltered("Funchal"))).toBeInTheDocument());
      expect(status(copy.search.noResultsFiltered("Funchal"))).toBe(region);
    });

    it("is not an alert, and nothing else on the page says the same words as a status", async () => {
      await openSearch("/search?q=zzzz");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getAllByText(copy.search.noResults("zzzz", "Funchal"))).toHaveLength(1);
    });
  });

  it("is not an alert: nothing went wrong", async () => {
    await openSearch("/search?q=zzzz");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the field and the chips, so the person can change either", async () => {
    await openSearch("/search?q=zzzz&open=1");
    expect(field()).toHaveValue("zzzz");
    expect(chip("Open now")).toBeInTheDocument();
  });

  it("says the open places are the ones missing, and offers the closed ones, when Open now is what hid them", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza&open=1");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(copy.search.noResultsOpen("pizza", "Funchal"))).toBeInTheDocument();
    expect(copy.search.noResultsOpen("pizza", "Funchal")).toBe('No open places match "pizza" near Funchal.');
    expect(screen.getByText(copy.search.hiddenClosed(2))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.search.showClosed }));
    expect(router.state.location.search).toBe("?q=pizza");
    expect(names()).toEqual(["Ciao Pizzeria", "Xarambinha Pizzeria Expresso"]);
  });

  it("says no place passes the filters, when nothing was typed", async () => {
    await openSearch("/search?kinds=ice-cream");
    expect(screen.getByText(copy.search.noResultsFiltered("Funchal"))).toBeInTheDocument();
    expect(screen.getByText(copy.search.noResultsFilteredHint)).toBeInTheDocument();
    expect(copy.search.noResultsFiltered("Funchal")).toBe("No places near Funchal match those filters.");
  });

  it("says no place is listed near, when nothing was typed and no filter is on", async () => {
    const lisbon = fixtures.map((event, i) => variant(event, { lat: String(38.72 + i * 0.001), lon: "-9.14", locality: "Lisboa", country: "PT" }));
    await openSearch("/search", lisbon);
    expect(screen.getByText(copy.explore.noneNearby("Funchal"))).toBeInTheDocument();
  });
});

describe("Search: the link to add a place", () => {
  it("opens OpenStreetMap's note form at the place the list is near, in a new tab", async () => {
    await openSearch("/search?q=pizza");
    const link = addMissing();
    expect(link).toHaveAttribute("href", osmNoteUrl(HERE.lat, HERE.lon));
    expect(link).toHaveAttribute("href", "https://www.openstreetmap.org/note/new#map=19/32.650700/-16.908400");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(copy.search.addMissing).toBe("Can't find it? Add a missing place");
  });

  it("tells a screen reader that it opens a new tab, in words that are not drawn", async () => {
    await openSearch("/search?q=pizza");
    expect(copy.common.newTab).toBe("(opens in a new tab)");
    const link = addMissing();
    expect(link).toHaveAccessibleName(`${copy.search.addMissing} ${copy.common.newTab}`);
    const hidden = within(link).getByText(copy.common.newTab);
    expect(hidden).toHaveClass("sr-only");
    // What is drawn is the design's words alone.
    expect(link.textContent).toBe(`${copy.search.addMissing} ${copy.common.newTab}`);
  });

  it("is at the foot of the page, above the attribution and below the results", async () => {
    await openSearch("/search?q=pizza");
    const link = addMissing();
    const attribution = screen.getByText(/Place details/);
    expect(screen.getByRole("list").compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(attribution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link).toHaveClass("min-h-touch");
  });

  it("follows the person to the city they picked, with the city's own coordinates", async () => {
    window.localStorage.setItem("regulars.here", JSON.stringify({ name: "Monte", country: "PT", lat: 32.123456, lon: -16.987654 }));
    await openSearch("/search?q=pizza");
    expect(addMissing()).toHaveAttribute("href", "https://www.openstreetmap.org/note/new#map=19/32.123456/-16.987654");
  });

  it("is rounded to four decimals, about eleven metres, when the places are near the person's own device", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      get: () => ({
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 32.123456, longitude: -16.987654, accuracy: 20 }, timestamp: 0 } as unknown as GeolocationPosition),
      }),
    });
    const user = userEvent.setup();
    const { router } = open(["/"], fixtures);
    await user.click(await screen.findByRole("button", { name: "Near Funchal" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: copy.location.useMine }));
    await screen.findByRole("button", { name: `Near ${copy.location.you}` });

    await act(() => router.navigate("/search?q=pizza"));
    expect(addMissing()).toHaveAttribute("href", "https://www.openstreetmap.org/note/new#map=19/32.123500/-16.987700");
    Reflect.deleteProperty(navigator, "geolocation");
  });

  it("is left out when the place the list is near is not a point", async () => {
    const here: HereValue = {
      label: "Funchal",
      lat: Number.NaN,
      lon: Number.NaN,
      source: "default",
      pending: false,
      useDevice: () => {},
      pickCity: () => {},
    };
    const router = createMemoryRouter([{ path: "/search", element: <SearchPage /> }], { initialEntries: ["/search?q=pizza"] });
    render(
      <PlacesProvider reader={createMemoryReader(fixtures)}>
        <ScoresProvider>
          <HereContext.Provider value={here}>
            <RouterProvider router={router} />
          </HereContext.Provider>
        </ScoresProvider>
      </PlacesProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: copy.pages.search });
    await waitFor(() => expect(screen.getByText(copy.search.noResults("pizza", "Funchal"))).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Add a missing place/ })).not.toBeInTheDocument();
    // The attribution is still there.
    expect(screen.getByText(/Place details/)).toBeInTheDocument();
  });
});

describe("Search: a long list", () => {
  const many = line(120);

  it("shows the first fifty and the rest on 'Show more', fifty at a time", async () => {
    const user = userEvent.setup();
    await openSearch("/search?q=line", many);
    expect(rows()).toHaveLength(PAGE);
    expect(names()[0]).toBe("Line place 001");
    expect(names()[PAGE - 1]).toBe("Line place 050");
    // The count is of all of them, not of those drawn.
    expect(screen.getByText(copy.search.summary(120, "Funchal", "Best match first"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.search.showMore }));
    expect(rows()).toHaveLength(100);
    await user.click(screen.getByRole("button", { name: copy.search.showMore }));
    expect(rows()).toHaveLength(120);
    expect(names()[119]).toBe("Line place 120");
    expect(screen.queryByRole("button", { name: copy.search.showMore })).not.toBeInTheDocument();
  });

  it("has no 'Show more' when everything fits", async () => {
    await openSearch("/search?q=line", line(PAGE));
    expect(rows()).toHaveLength(PAGE);
    expect(screen.queryByRole("button", { name: copy.search.showMore })).not.toBeInTheDocument();
  });

  it("moves the focus to the first new row when 'Show more' is pressed", async () => {
    const user = userEvent.setup();
    await openSearch("/search?q=line", many);
    await user.click(screen.getByRole("button", { name: copy.search.showMore }));
    expect(rows()[PAGE]).toHaveFocus();
  });

  it("starts from fifty again for another search", async () => {
    const user = userEvent.setup();
    await openSearch("/search?q=line", many);
    await user.click(screen.getByRole("button", { name: copy.search.showMore }));
    expect(rows()).toHaveLength(100);
    await user.type(field(), " place{Enter}");
    expect(rows()).toHaveLength(PAGE);
    expect(screen.getByRole("button", { name: copy.search.showMore })).toBeInTheDocument();
  });

  it("comes back to the results with as many rows as they had", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=line", many);
    // The first page of a tab has no key of its own; the address typed in is kept in memory.
    await user.click(screen.getByRole("button", { name: copy.search.showMore }));
    expect(rows()).toHaveLength(100);

    await user.click(rowFor("Line place 090"));
    expect(router.state.location.pathname).toBe("/place/line-89");
    await act(() => router.navigate(-1));
    expect(rows()).toHaveLength(100);
  });
});

describe("Search on a desktop (D1: the phone's screens 1 to 4 in Explore's layout)", () => {
  const menus = () => screen.getByRole("group", { name: copy.explore.filtersLabel });
    /** The map made last, once its pins are on it. */
  const theMap = () =>
    waitFor(() => {
      const map = FakeMap.instances.at(-1);
      if (map === undefined || !map.sources.has(PIN_SOURCE)) throw new Error("No map with pins yet");
      return map;
    });
  const pinAddresses = (map: FakeMap) =>
    map.sources.get(PIN_SOURCE)!.data.features.map((feature) => (feature.properties as { address: string }).address);
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pin = (name: string) => screen.getByRole("button", { name: new RegExp(`^${literal(name)},`) });
  /** A pin, once the map has drawn it: its markers come after its pins are in its source. */
  const findPin = (name: string) => screen.findByRole("button", { name: new RegExp(`^${literal(name)},`) });
  /** The box around some places, as the map takes one: west, south, east, north. */
  const boxOf = (places: Place[]) => [
    Math.min(...places.map((each) => each.lon)),
    Math.min(...places.map((each) => each.lat)),
    Math.max(...places.map((each) => each.lon)),
    Math.max(...places.map((each) => each.lat)),
  ];
  /** The places a search lists, a chain at its nearest: where their pins are. */
  const pinned = (q: string, radiusKm = 25) =>
    groupForList(idx.search(q, { lat: HERE.lat, lon: HERE.lon, radiusKm }), idx).map((entry) =>
      "chain" in entry ? entry.nearby[0]!.place : entry.place,
    );

  it("shows the results beside the map, as the desktop's Explore does, with the filter menus above them", async () => {
    wideWindow();
    await openSearch("/search?q=pizza");
    const map = await theMap();

    // One field, the top bar's, with the words in it; no way back and no Filters chip, which the menus replace.
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.getByRole("searchbox")).toHaveValue("pizza");
    expect(screen.queryByRole("link", { name: copy.search.back })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.search.filters(0) })).not.toBeInTheDocument();

    // The list's column, then the map, as on Explore: the page is the window's height, and the column scrolls inside it.
    expect(screen.getByRole("main").parentElement).toHaveClass("h-dvh");
    const column = screen.getByRole("list").closest("section")!;
    expect(column).toHaveClass("w-list", "shrink-0", "overflow-y-auto");
    const mapArea = map.container.closest(".bg-map-land")!;
    expect(mapArea).toHaveClass("flex-1");
    expect(column.parentElement).toBe(mapArea.parentElement);
    expect(column).toContainElement(menus());
    expect(within(menus()).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Open now",
      "Kind of place",
      "Distance",
      expect.stringMatching(/^Sort: /),
    ]);

    // The results as cards, the line of how many in the live region, and a pin for each.
    expect(names()).toEqual(listed("pizza"));
    const line = copy.search.summary(2, "Funchal", copy.search.sortedBy.relevance);
    expect(screen.getByText(line).closest('[role="status"]')).not.toBeNull();
    expect(pinAddresses(map)).toEqual(pinned("pizza").map((each) => each.address));
    expect(screen.getByRole("link", { name: copy.common.aboutData })).toHaveAttribute("href", "/about");
    expect(screen.getByRole("link", { name: addMissingName })).toBeInTheDocument();
  });

  it("fits the map to the results, and again to each new search", async () => {
    wideWindow();
    const user = userEvent.setup();
    await openSearch("/search?q=pizza");
    const map = await theMap();
    expect(map.options.bounds).toEqual(boxOf(pinned("pizza")));

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "cafe{Enter}");
    await waitFor(() => expect(map.fitBounds).toHaveBeenLastCalledWith(boxOf(pinned("cafe")), expect.anything()));
    expect(FakeMap.instances.at(-1)).toBe(map);
  });

  it("picks out a result's card when its pin is clicked, and its pin while the card is pointed at", async () => {
    wideWindow();
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    try {
      await openSearch("/search?q=pizza");
      const card = rowFor("Ciao Pizzeria");
      await user.click(await findPin("Ciao Pizzeria"));
      expect(card).toHaveClass("border-2", "border-ink");
      await user.hover(rowFor("Xarambinha Pizzeria Expresso"));
      expect(pin("Xarambinha Pizzeria Expresso").firstElementChild).toHaveClass("border-accent");
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("keeps the filters in the address from the menus, as the phone's filters page does", async () => {
    wideWindow();
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe");
    await user.click(within(menus()).getByRole("button", { name: "Open now" }));
    expect(router.state.location.search).toBe("?q=cafe&open=1");
    expect(names()).toEqual(listed("cafe", (each) => !isClosed(each)));
  });

  it("has the note on the closed places Open now left out, under the cards, with a way to bring them back", async () => {
    wideWindow();
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe&open=1");
    const left = idx.search("cafe", { lat: HERE.lat, lon: HERE.lon, radiusKm: 25 }).filter((each) => isClosed(each.place)).length;
    const note = screen.getByText(copy.search.hiddenClosed(left)).parentElement!;
    expect(screen.getByRole("list").compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(note).getByRole("button", { name: copy.search.showClosed }));
    expect(router.state.location.search).toBe("?q=cafe");
  });

  it("says when nothing matches, in the same live region, with no cards", async () => {
    wideWindow();
    await openSearch("/search?q=zzzzqq");
    const sentence = copy.search.noResults("zzzzqq", "Funchal");
    expect(screen.getByText(sentence).closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText(copy.search.noResultsHint)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("names the sort menu for the order in use, and shows it in the menu as the filters page does", async () => {
    wideWindow();
    const user = userEvent.setup();
    await openSearch("/search?q=pizza");
    const menu = within(menus()).getByRole("button", { name: copy.deskExplore.sort.relevance });
    expect(copy.deskExplore.sort.relevance).toBe("Sort: best match");
    await user.click(menu);
    const group = screen.getByRole("group", { name: copy.filters.sortBy });
    for (const button of within(group).getAllByRole("button")) expect(button).toHaveAttribute("aria-pressed", "false");
    expect(group).toHaveAccessibleDescription(copy.search.sortedBy.relevance);

    await user.click(within(group).getByRole("button", { name: "Distance" }));
    expect(within(menus()).getByRole("button", { name: copy.deskExplore.sort.distance })).toBeInTheDocument();
  });

  it("names the sort menu Sort: distance for a kind of place, with Distance pressed in it", async () => {
    wideWindow();
    const user = userEvent.setup();
    await openSearch("/search?q=cafe");
    await user.click(within(menus()).getByRole("button", { name: copy.deskExplore.sort.distance }));
    const group = screen.getByRole("group", { name: copy.filters.sortBy });
    expect(within(group).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not put the cursor in the field", async () => {
    wideWindow();
    await openSearch("/search?q=pizza");
    expect(screen.getByRole("searchbox")).not.toHaveFocus();
  });

  it("searches from the top bar: Enter goes to the results for the words, keeping the filters", async () => {
    wideWindow();
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=pizza&open=1");
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "novo{Enter}");
    expect(router.state.location.pathname).toBe("/search");
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("novo");
    expect(new URLSearchParams(router.state.location.search).get("open")).toBe("1");
    expect(names()).toEqual(["Novo Tahiti"]);
  });

  it("searches from the top bar on any other page, and goes to the results", async () => {
    wideWindow();
    const user = userEvent.setup();
    const { router } = open(["/"], fixtures);
    await screen.findByRole("heading", { level: 1, name: copy.pages.explore });
    await user.type(screen.getByRole("searchbox"), "pizza{Enter}");
    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toBe("?q=pizza");
    await screen.findByRole("heading", { level: 1, name: copy.pages.search });
    expect(names()).toEqual(listed("pizza"));
  });

  it("keeps the phone's page on a phone", async () => {
    await openSearch("/search?q=pizza");
    expect(screen.getByRole("main").parentElement).toHaveClass("min-h-dvh");
    expect(screen.getByRole("link", { name: copy.search.back })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.search.filters(0) })).toBeInTheDocument();
    expect(FakeMap.instances).toHaveLength(0);
  });
});

// =====================================================================================
// The filters page
// =====================================================================================

describe("Filters", () => {
  const groupNamed = (name: string) => screen.getByRole("group", { name });

  it("is a page with a heading, a tab title and a cross that closes it", async () => {
    await openFilters("/filters?q=pizza&open=1");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Filters");
    await waitFor(() => expect(document.title).toBe(copy.titles.filters));
    expect(screen.getByRole("link", { name: copy.filters.close })).toHaveAttribute("href", "/search?q=pizza&open=1");
  });

  describe("sort", () => {
    it("offers House picks' score, which needs no sign in, Distance and Name", async () => {
      await openFilters();
      const sort = groupNamed(copy.filters.sortBy);
      const buttons = within(sort).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["House picks' score", "Distance", "Name"]);
      expect(buttons[0]).toBeEnabled();
      expect(buttons[0]).not.toHaveAccessibleDescription();
    });

    const sortButton = (name: string) => within(groupNamed(copy.filters.sortBy)).getByRole("button", { name });
    const pressedSorts = () =>
      within(groupNamed(copy.filters.sortBy))
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent);

    it.each([
      ["nothing typed", "/filters"],
      ["a kind of place", "/filters?q=cafe"],
    ])("shows the order in use when none is chosen: for %s it is nearest first, so Distance is pressed", async (_, path) => {
      await openFilters(path);
      expect(pressedSorts()).toEqual(["Distance"]);
      expect(screen.queryByText(copy.search.sortedBy.relevance)).not.toBeInTheDocument();
    });

    it("presses none for words that are not a kind of place, and says those are best match first", async () => {
      await openFilters("/filters?q=pizza");
      expect(pressedSorts()).toEqual([]);
      const note = screen.getByText(copy.search.sortedBy.relevance);
      expect(copy.search.sortedBy.relevance).toBe("Best match first");
      expect(groupNamed(copy.filters.sortBy)).toHaveAccessibleDescription(copy.search.sortedBy.relevance);
      expect(note).toHaveClass("text-caption", "text-muted");
    });

    it("presses Name when the person does, and goes back to the order in use when Name is pressed again", async () => {
      const user = userEvent.setup();
      await openFilters();
      await user.click(sortButton("Name"));
      expect(pressedSorts()).toEqual(["Name"]);
      await user.click(sortButton("Name"));
      expect(pressedSorts()).toEqual(["Distance"]);
    });

    it("chooses Distance for words, and goes back to best match when Distance is pressed again", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?q=pizza");
      await user.click(sortButton("Distance"));
      expect(pressedSorts()).toEqual(["Distance"]);
      expect(screen.queryByText(copy.search.sortedBy.relevance)).not.toBeInTheDocument();
      await user.click(sortButton("Distance"));
      expect(pressedSorts()).toEqual([]);
      expect(screen.getByText(copy.search.sortedBy.relevance)).toBeInTheDocument();
    });

    it("chooses Distance when it is pressed while it shows the order in use, and the address gets it", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe");
      await user.click(sortButton("Distance"));
      expect(pressedSorts()).toEqual(["Distance"]);
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      expect(new URLSearchParams(router.state.location.search).get("sort")).toBe("distance");
    });

    it.each([
      ["/filters?q=pizza&sort=distance", "Distance"],
      ["/filters?sort=name", "Name"],
    ])("has the one the address asks for pressed: %s", async (path, pressed) => {
      await openFilters(path);
      expect(pressedSorts()).toEqual([pressed]);
    });

    it("has House picks' score pressed for an address that asks for it", async () => {
      await openFilters("/filters?sort=score");
      expect(pressedSorts()).toEqual(["House picks' score"]);
    });

    it("goes to the results with no sort in the address when none is pressed, and with the one that is", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe");
      await user.click(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Distance" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      expect(new URLSearchParams(router.state.location.search).get("sort")).toBe("distance");
    });

    it("applies none: the address has no sort, so the page picks it", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe&sort=name");
      await user.click(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Name" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      expect(new URLSearchParams(router.state.location.search).has("sort")).toBe(false);
    });

    it("draws the chips as the design does: pressed is filled with no edge, the rest have one", async () => {
      await openFilters("/filters?sort=distance");
      const pressed = within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Distance" });
      expect(pressed).toHaveClass("bg-emphasis", "text-on-emphasis", "h-11", "rounded-chip");
      expect(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Name" })).toHaveClass("border-token", "border-line-strong", "bg-ground");
    });
  });

  describe("Open now", () => {
    it("is a switch with its note, off to begin with", async () => {
      await openFilters();
      const toggle = screen.getByRole("switch", { name: "Open now" });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(toggle).toHaveAccessibleDescription(copy.filters.openNowNote);
      expect(screen.getByText("Keeps places with no hours listed.")).toBeInTheDocument();
    });

    it("turns on and off, and is 44 px tall to touch", async () => {
      const user = userEvent.setup();
      await openFilters();
      const toggle = screen.getByRole("switch", { name: "Open now" });
      expect(toggle).toHaveClass("h-11", "w-14");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", "true");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("is on when the address says so", async () => {
      await openFilters("/filters?open=1");
      expect(screen.getByRole("switch", { name: "Open now" })).toHaveAttribute("aria-checked", "true");
    });
  });

  describe("distance", () => {
    it("offers half a mile, 1, 3, 5 and 15 miles to a reader in miles, with the widest pressed to begin with", async () => {
      await openFilters();
      const group = groupNamed(copy.filters.distance);
      const buttons = within(group).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["0.5 mi", "1 mi", "3 mi", "5 mi", "15 mi"]);
      expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "true"]);
      expect(group).toHaveClass("grid-cols-5");
    });

    it("offers 1, 2, 5, 10 and 25 kilometres where the browser's language reads kilometres", async () => {
      vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
      await openFilters();
      const buttons = within(groupNamed(copy.filters.distance)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["1 km", "2 km", "5 km", "10 km", "25 km"]);
      expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "true"]);
    });

    it("presses the one the person taps, and the address's own when it has one", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?within=8");
      const group = groupNamed(copy.filters.distance);
      expect(within(group).getByRole("button", { name: "5 mi" })).toHaveAttribute("aria-pressed", "true");
      await user.click(within(group).getByRole("button", { name: "1 mi" }));
      expect(within(group).getByRole("button", { name: "1 mi" })).toHaveAttribute("aria-pressed", "true");
      expect(within(group).getByRole("button", { name: "5 mi" })).toHaveAttribute("aria-pressed", "false");
    });

    it("presses the choice a link from the other unit snaps to", async () => {
      await openFilters("/filters?within=5");
      expect(within(groupNamed(copy.filters.distance)).getByRole("button", { name: "5 mi" })).toHaveAttribute("aria-pressed", "true");
    });

    it("goes back to the widest when the one that is pressed is pressed again", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?within=1.6");
      const group = groupNamed(copy.filters.distance);
      await user.click(within(group).getByRole("button", { name: "1 mi" }));
      expect(within(group).getByRole("button", { name: "15 mi" })).toHaveAttribute("aria-pressed", "true");
    });

    it("does nothing when the widest is pressed on the widest", async () => {
      const user = userEvent.setup();
      await openFilters();
      const group = groupNamed(copy.filters.distance);
      await user.click(within(group).getByRole("button", { name: "15 mi" }));
      expect(within(group).getByRole("button", { name: "15 mi" })).toHaveAttribute("aria-pressed", "true");
    });

    it("goes to the results with the distance in kilometres in the address", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe");
      await user.click(within(groupNamed(copy.filters.distance)).getByRole("button", { name: "3 mi" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      expect(new URLSearchParams(router.state.location.search).get("within")).toBe("4.8");
    });

    it("writes no distance for the widest", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe&within=1.6");
      await user.click(within(groupNamed(copy.filters.distance)).getByRole("button", { name: "1 mi" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      expect(new URLSearchParams(router.state.location.search).has("within")).toBe(false);
    });
  });

  describe("kinds of place", () => {
    it("are the ten families, in two columns, each with its icon and its name", async () => {
      await openFilters();
      const group = groupNamed(copy.filters.kinds);
      const buttons = within(group).getAllByRole("button");
      expect(buttons).toHaveLength(10);
      expect(buttons.map((button) => button.textContent)).toEqual(FAMILIES.map((family) => family.label));
      expect(group).toHaveClass("grid-cols-2");
      for (const button of buttons) {
        expect(button.querySelector("svg")).not.toBeNull();
        expect(button.querySelector("svg")!.closest("[aria-hidden='true']")).not.toBeNull();
        expect(button).toHaveAttribute("aria-pressed", "false");
        expect(button).toHaveClass("h-14", "rounded-button");
      }
    });

    it("press as the person chooses them, any number, and the pressed ones are the filled ones", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?kinds=cafes");
      const group = groupNamed(copy.filters.kinds);
      expect(within(group).getByRole("button", { name: "Cafes" })).toHaveAttribute("aria-pressed", "true");
      expect(within(group).getByRole("button", { name: "Cafes" })).toHaveClass("bg-emphasis", "text-on-emphasis", "border-emphasis");
      await user.click(within(group).getByRole("button", { name: "Bars and pubs" }));
      expect(within(group).getByRole("button", { name: "Bars and pubs" })).toHaveAttribute("aria-pressed", "true");
      expect(within(group).getByRole("button", { name: "Cafes" })).toHaveAttribute("aria-pressed", "true");
      await user.click(within(group).getByRole("button", { name: "Cafes" }));
      expect(within(group).getByRole("button", { name: "Cafes" })).toHaveAttribute("aria-pressed", "false");
      expect(within(group).getByRole("button", { name: "Bars and pubs" })).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("has no filter for how a place is paid for", async () => {
    await openFilters();
    expect(document.body).not.toHaveTextContent(/payment|bitcoin|accepts|card|cash/i);
  });

  describe("Show places and Clear all", () => {
    it("says how many places the filters leave, as the search page would list them", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?q=cafe");
      const count = counted("cafe");
      expect(screen.getByRole("button", { name: copy.filters.show(count) })).toBeInTheDocument();
      expect(copy.filters.show(5)).toBe("Show 5 places");
      expect(copy.filters.show(1)).toBe("Show 1 place");

      await user.click(screen.getByRole("switch", { name: "Open now" }));
      const open = listed("cafe", (each) => !isClosed(each)).length;
      expect(open).toBeLessThan(count);
      expect(screen.getByRole("button", { name: copy.filters.show(open) })).toBeInTheDocument();

      await user.click(within(groupNamed(copy.filters.kinds)).getByRole("button", { name: "Bars and pubs" }));
      expect(
        screen.getByRole("button", { name: copy.filters.show(counted("cafe", (each) => !isClosed(each) && kindOf(each.category).family === "bars")) }),
      ).toBeInTheDocument();
    });

    it("counts places for nothing typed", async () => {
      await openFilters("/filters");
      expect(screen.getByRole("button", { name: copy.filters.show(counted("")) })).toBeInTheDocument();
    });

    it("cannot be pressed when nothing is left, and says so", async () => {
      await openFilters("/filters?q=pizza&open=1");
      const button = screen.getByRole("button", { name: copy.filters.show(0) });
      expect(button).toBeDisabled();
      expect(copy.filters.show(0)).toBe("No places match");
    });

    it("goes to the results with the filters, keeping the words searched for and the rest of the address, in place of this page in the history", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe&from=share");
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      await user.click(within(groupNamed(copy.filters.distance)).getByRole("button", { name: "5 mi" }));
      await user.click(within(groupNamed(copy.filters.kinds)).getByRole("button", { name: "Cafes" }));
      await user.click(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Name" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));

      expect(router.state.location.pathname).toBe("/search");
      expect(router.state.historyAction).toBe("REPLACE");
      const params = new URLSearchParams(router.state.location.search);
      expect(Object.fromEntries(params)).toEqual({
        q: "cafe",
        from: "share",
        open: "1",
        kinds: "cafes",
        within: "8",
        sort: "name",
      });
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      expect(field()).toHaveValue("cafe");
      expect(chip("Open now")).toBeInTheDocument();
    });

    it("goes to the results for nothing typed with no words in the address", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters");
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      expect(router.state.location.pathname + router.state.location.search).toBe("/search?open=1");
    });

    it("changes nothing in the address until the person applies", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe");
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      expect(router.state.location.search).toBe("?q=cafe");
    });

    it("clears every filter at once, the sort too, and keeps the words searched for", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?q=cafe&open=1&kinds=cafes,bars&within=1.6&sort=name");
      expect(screen.getByRole("switch", { name: "Open now" })).toHaveAttribute("aria-checked", "true");
      await user.click(screen.getByRole("button", { name: copy.filters.clearAll }));

      expect(screen.getByRole("switch", { name: "Open now" })).toHaveAttribute("aria-checked", "false");
      for (const button of within(groupNamed(copy.filters.kinds)).getAllByRole("button")) {
        expect(button).toHaveAttribute("aria-pressed", "false");
      }
      expect(within(groupNamed(copy.filters.distance)).getByRole("button", { name: "15 mi" })).toHaveAttribute("aria-pressed", "true");
      // No sort chosen: the order in use for a kind of place, nearest first, is the one shown.
      const pressed = within(groupNamed(copy.filters.sortBy))
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true");
      expect(pressed.map((button) => button.textContent)).toEqual(["Distance"]);
      expect(screen.getByRole("button", { name: copy.filters.show(counted("cafe")) })).toBeInTheDocument();
      expect(copy.filters.clearAll).toBe("Clear all");
    });

    it("closes without applying what was changed, and keeps the filters the search had", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe&open=1");
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      await user.click(within(groupNamed(copy.filters.kinds)).getByRole("button", { name: "Cafes" }));
      await user.click(screen.getByRole("link", { name: copy.filters.close }));
      expect(router.state.location.pathname + router.state.location.search).toBe("/search?q=cafe&open=1");
      expect(router.state.historyAction).toBe("REPLACE");
    });
  });

  it("is reached from the search page's chip, and comes back to the results with the words kept", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe&open=1");
    await user.click(within(chipsGroup()).getByRole("link", { name: copy.search.filters(1) }));
    expect(router.state.location.pathname).toBe("/filters");
    await screen.findByRole("heading", { level: 1, name: copy.pages.filters });
    expect(screen.getByRole("switch", { name: "Open now" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
    await screen.findByRole("heading", { level: 1, name: copy.pages.search });
    expect(field()).toHaveValue("cafe");
  });

  describe("coming back to the results", () => {
    it("does not put the cursor in the search field after Show places, so the keyboard stays down", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe");
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      expect(router.state.location.state).toEqual({ from: "filters" });
      expect(field()).toHaveValue("cafe");
      expect(field()).not.toHaveFocus();
      expect(document.body).toHaveFocus();
    });

    it("does not put it there after the cross either", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe&open=1");
      await user.click(screen.getByRole("link", { name: copy.filters.close }));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      expect(router.state.location.state).toEqual({ from: "filters" });
      expect(field()).not.toHaveFocus();
    });

    it("does put it there when the person comes to search from Explore, as before", async () => {
      const user = userEvent.setup();
      open(["/"], fixtures);
      await user.click(await screen.findByRole("link", { name: /Tacos, coffee, a place name/ }));
      expect(field()).toHaveFocus();
    });

    it("does not carry that to the next page: the state is gone after the person goes on", async () => {
      const user = userEvent.setup();
      const { router } = await openFilters("/filters?q=cafe");
      await user.click(screen.getByRole("switch", { name: "Open now" }));
      await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
      await screen.findByRole("heading", { level: 1, name: copy.pages.search });
      await user.click(chip("Open now"));
      expect(router.state.location.state).toBeNull();
    });
  });

  describe("for a screen reader", () => {
    const heading = (name: string) => screen.getByRole("heading", { level: 2, name });

    it("names each group by the heading above it, which is the one that is drawn, not by a second copy of its words", async () => {
      await openFilters();
      for (const name of [copy.filters.sortBy, copy.filters.distance, copy.filters.kinds]) {
        const group = groupNamed(name);
        expect(group).not.toHaveAttribute("aria-label");
        expect(group).toHaveAttribute("aria-labelledby", heading(name).id);
      }
    });

    it("names the switch by its own words, and describes it by the note under them", async () => {
      await openFilters();
      const toggle = screen.getByRole("switch", { name: "Open now" });
      expect(toggle).not.toHaveAttribute("aria-label");
      expect(toggle).toHaveAccessibleDescription(copy.filters.openNowNote);
    });

    it("announces how many places the filters leave, politely, in a region that is always there", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?q=cafe");
      const count = counted("cafe");
      const region = screen.getByText(copy.filters.countStatus(count));
      expect(region).toHaveAttribute("role", "status");
      expect(region).toHaveClass("sr-only");

      await user.click(screen.getByRole("switch", { name: "Open now" }));
      const open = listed("cafe", (each) => !isClosed(each)).length;
      expect(open).not.toBe(count);
      // The same element says the new count.
      expect(region).toHaveTextContent(copy.filters.countStatus(open));
      expect(region).toBeInTheDocument();

      await user.click(within(groupNamed(copy.filters.kinds)).getByRole("button", { name: "Ice cream" }));
      expect(region).toHaveTextContent(copy.filters.countStatus(0));
      expect(copy.filters.countStatus(0)).toBe("No places match");
      expect(copy.filters.countStatus(1)).toBe("1 place matches");
      expect(copy.filters.countStatus(12)).toBe("12 places match");
    });
  });

  it("on a desktop, gives its place in the history to the search with the same filters: the menus there are the filters", async () => {
    wideWindow();
    const { router } = open(["/search?q=pizza", "/filters?q=pizza&open=1&kinds=cafes"], fixtures, 1);
    await screen.findByRole("heading", { level: 1, name: copy.pages.search });
    expect(router.state.location.pathname).toBe("/search");
    expect(router.state.location.search).toBe("?q=pizza&open=1&kinds=cafes");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.getByRole("group", { name: copy.explore.filtersLabel })).toBeInTheDocument();
    // Back goes to where the person was before the filters, not to them again.
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe("?q=pizza");
  });
});
