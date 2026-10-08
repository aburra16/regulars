import type { NostrEvent } from "@nostrify/nostrify";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import { osmNoteUrl } from "../src/place/osmLinks";
import { distanceKm, formatDistance, formatRadius } from "../src/places/distance";
import { openState } from "../src/places/hours";
import { buildIndexes, type Chain, chainSlug, groupForList, type PlaceDistance } from "../src/places/indexes";
import { FAMILIES, type FamilyId, kindOf, placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { PlacesProvider } from "../src/places/store";
import { routes } from "../src/routes";
import {
  applyFilters,
  type Filters,
  filterCount,
  filtersFromParams,
  filtersToParams,
  noFilters,
  withFilters,
} from "../src/search/filters";
import { ChainCard } from "../src/ui/ChainCard";
import { PlaceRow } from "../src/ui/PlaceRow";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;
const fixturePlaces = parsePlaces(fixtures);
const idx = buildIndexes(fixturePlaces);
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
const filters = (over: Partial<Filters> = {}): Filters => ({ ...noFilters(), ...over });

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
      <HereProvider>
        <RouterProvider router={router} />
      </HereProvider>
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
const chipsGroup = () => screen.getByRole("group", { name: copy.explore.filtersLabel });
const chip = (name: string | RegExp) => within(chipsGroup()).getByRole("button", { name });

/** The rows the page should list for a search, worked out from the indexes and the clock alone. */
function listed(q: string, keep: (place: Place) => boolean = () => true, radiusKm = 25): string[] {
  const found = idx.search(q, { lat: HERE.lat, lon: HERE.lon, radiusKm }).filter((each) => keep(each.place));
  return groupForList(found, idx).map((entry) => ("chain" in entry ? entry.chain.name : entry.place.name));
}
const isClosed = (candidate: Place) => openState(candidate, MORNING).kind === "closed";

beforeEach(() => {
  // Only the clock is held still; timers and promises run as they do.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MORNING);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "matchMedia");
});

// =====================================================================================
// The filters, as data
// =====================================================================================

describe("filters in the address", () => {
  it("are none at all for an address that says nothing", () => {
    expect(filtersFromParams(new URLSearchParams())).toEqual({
      open: false,
      families: [],
      withinKm: 25,
      sort: "distance",
    });
    expect(noFilters()).toEqual(filtersFromParams(new URLSearchParams()));
    expect(filtersToParams(noFilters()).toString()).toBe("");
  });

  it.each<[string, Filters]>([
    ["the defaults", filters()],
    ["open now", filters({ open: true })],
    ["one kind", filters({ families: ["cafes"] })],
    ["several kinds", filters({ families: ["restaurants", "bakeries", "breweries"] })],
    ["every kind", filters({ families: FAMILIES.map((family) => family.id) })],
    ["each distance", filters({ withinKm: 1 })],
    ["each distance", filters({ withinKm: 2 })],
    ["each distance", filters({ withinKm: 5 })],
    ["each distance", filters({ withinKm: 10 })],
    ["sorted by name", filters({ sort: "name" })],
    ["sorted by score", filters({ sort: "score" })],
    ["all of it", { open: true, families: ["bars", "ice-cream"], withinKm: 5, sort: "name" }],
  ])("make the same filters back from the address: %s", (_what, original) => {
    expect(filtersFromParams(filtersToParams(original))).toEqual(original);
    // Through the text of an address as well.
    expect(filtersFromParams(new URLSearchParams(filtersToParams(original).toString()))).toEqual(original);
  });

  it("write only what is not the default, in short names", () => {
    expect(filtersToParams(filters({ open: true })).toString()).toBe("open=1");
    expect(filtersToParams(filters({ families: ["restaurants", "cafes"] })).toString()).toBe("kinds=restaurants%2Ccafes");
    expect(filtersToParams(filters({ withinKm: 2 })).toString()).toBe("within=2");
    expect(filtersToParams(filters({ sort: "name" })).toString()).toBe("sort=name");
    expect(filtersToParams({ open: true, families: ["cafes"], withinKm: 5, sort: "name" }).toString()).toBe(
      "open=1&kinds=cafes&within=5&sort=name",
    );
  });

  it("read what the address says and leave out what it gets wrong", () => {
    const read = (query: string) => filtersFromParams(new URLSearchParams(query));
    expect(read("open=1")).toEqual(filters({ open: true }));
    expect(read("open=yes")).toEqual(filters());
    expect(read("open=0")).toEqual(filters());
    expect(read("within=3")).toEqual(filters());
    expect(read("within=banana")).toEqual(filters());
    expect(read("within=0")).toEqual(filters());
    expect(read("within=10")).toEqual(filters({ withinKm: 10 }));
    expect(read("sort=newest")).toEqual(filters());
    expect(read("sort=name")).toEqual(filters({ sort: "name" }));
    // A kind that is not one of the ten is dropped, and one that is named twice counts once.
    expect(read("kinds=cafes,spaceports,cafes,bars")).toEqual(filters({ families: ["cafes", "bars"] }));
    expect(read("kinds=")).toEqual(filters());
    expect(read("kinds=constructor,__proto__")).toEqual(filters());
  });

  it("count the filters that are on: Open now, each kind and a distance, not the sort", () => {
    expect(filterCount(filters())).toBe(0);
    expect(filterCount(filters({ sort: "name" }))).toBe(0);
    expect(filterCount(filters({ open: true }))).toBe(1);
    expect(filterCount(filters({ withinKm: 5 }))).toBe(1);
    expect(filterCount(filters({ families: ["cafes", "bars"] }))).toBe(2);
    expect(filterCount({ open: true, families: ["cafes", "bars"], withinKm: 2, sort: "name" })).toBe(4);
  });

  it("go into an address that has other things in it without touching them", () => {
    const params = new URLSearchParams("q=pizza&from=share&open=1&within=2");
    const next = withFilters(params, filters({ families: ["cafes"], sort: "name" }));
    expect(next.toString()).toBe("q=pizza&from=share&kinds=cafes&sort=name");
    // The address it was given is as it was.
    expect(params.toString()).toBe("q=pizza&from=share&open=1&within=2");
    expect(withFilters(new URLSearchParams("q=a&open=1"), filters()).toString()).toBe("q=a");
  });
});

describe("applyFilters", () => {
  const NOW = MORNING;
  const everyone = idx.near(HERE.lat, HERE.lon, 25);

  it("keeps every row when there is nothing to filter, in the order it was given", () => {
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
      expect(result.rows.map((each) => each.place.name)).toEqual(["Maia", "Jacafé"]);
    });

    it("keeps everything the search found when it is 25 km, the widest", () => {
      expect(applyFilters(everyone, filters({ withinKm: 25 }), NOW).rows).toHaveLength(everyone.length);
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

    it("keeps the order it was given for places the same distance away", () => {
      const tied = [row("Maia", 1), row("Jacafé", 1), row("Novo Tahiti", 1), row("Joker", 0.5)];
      expect(applyFilters(tied, filters(), NOW).rows.map((each) => each.place.name)).toEqual([
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

    it("is nearest first for My circle's score too, in M1, when nobody has a score", () => {
      const jumbled = [row("Novo Tahiti", 3), row("Jacafé", 1), row("Maia", 2)];
      expect(applyFilters(jumbled, filters({ sort: "score" }), NOW).rows.map((each) => each.place.name)).toEqual([
        "Jacafé",
        "Maia",
        "Novo Tahiti",
      ]);
    });
  });
});

describe("formatRadius", () => {
  it.each<[number, string, string]>([
    [1, "pt-PT", "1 km"],
    [2, "en-GB", "2 km"],
    [5, "de", "5 km"],
    [10, "pt-PT", "10 km"],
    [25, "pt-PT", "25 km"],
    [1, "en-US", "0.6 mi"],
    [2, "en-US", "1.2 mi"],
    [5, "en-US", "3.1 mi"],
    [10, "en-US", "6.2 mi"],
    [25, "en-US", "16 mi"],
    [5, "en-LR", "3.1 mi"],
  ])("writes %s km for %s as %s", (km, locale, shown) => {
    expect(formatRadius(km, locale)).toBe(shown);
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
    expect(link.querySelector("span[aria-hidden='true']")).toHaveClass("bg-ink", "text-ground", "size-11");
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
    expect(document.title).toBe(copy.titles.search);
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

describe("Search: the results", () => {
  it("lists the places that match, with the line of how many, where, and in what order", async () => {
    await openSearch("/search?q=pizza");
    expect(names()).toEqual(["Ciao Pizzeria", "Xarambinha Pizzeria Expresso"]);
    expect(names()).toEqual(listed("pizza"));
    const summary = copy.search.summary(2, "Funchal", copy.search.sortedBy.distance);
    expect(summary).toBe("2 places near Funchal. Nearest first.");
    // A screen reader announces it when the results change.
    expect(screen.getByText(summary)).toHaveAttribute("role", "status");
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

  it("counts a chain once, as a row of its own", async () => {
    await openSearch("/search?q=loft");
    expect(names()).toEqual(["Loft Brunch & Cocktails"]);
    const link = rowFor("Loft Brunch & Cocktails");
    expect(link).toHaveAttribute("href", `/chain/${chainSlug(idx.chainOf(place("Loft Brunch & Cocktails"))!)}`);
    expect(link).toHaveTextContent("2 locations");
    // One entry, one place in the line: the chain.
    expect(screen.getByText(copy.search.summary(1, "Funchal", copy.search.sortedBy.distance))).toBeInTheDocument();
    expect(copy.search.summary(1, "Funchal", "Nearest first")).toBe("1 place near Funchal. Nearest first.");
  });

  it("lists the places around the person when nothing was typed", async () => {
    await openSearch("/search");
    expect(names()).toEqual(listed("").slice(0, PAGE));
    expect(screen.getByText(copy.search.summary(listed("").length, "Funchal", copy.search.sortedBy.distance))).toBeInTheDocument();
  });

  it("reads a kind of place as a list of them, nearest first, and says so", async () => {
    await openSearch("/search?q=cafe");
    expect(idx.isKindQuery("cafe")).toBe(true);
    expect(names()).toEqual(listed("cafe"));
    expect(screen.getByText(copy.search.summary(listed("cafe").length, "Funchal", "Nearest first"))).toBeInTheDocument();
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
    expect(screen.getByText("2 places near you. Nearest first.")).toBeInTheDocument();
    Reflect.deleteProperty(navigator, "geolocation");
  });

  it("shows distances in kilometres where the browser's language does", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    await openSearch("/search?q=pizza");
    expect(rowFor("Ciao Pizzeria").textContent).toMatch(/\d+ m|\d\.\d km/);
    expect(rowFor("Ciao Pizzeria").textContent).not.toMatch(/ mi\b/);
  });

  it("has the attribution for the place details at the foot", async () => {
    await openSearch("/search?q=pizza");
    expect(screen.getByText(/Place details/)).toHaveTextContent(copy.attribution.details);
    expect(screen.getByRole("link", { name: copy.attribution.openStreetMap })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
  });
});

describe("Search: the order", () => {
  it("is A to Z with ?sort=name, and the line says so", async () => {
    await openSearch("/search?q=cafe&sort=name");
    const collator = new Intl.Collator("en");
    expect(names()).toEqual([...listed("cafe")].sort(collator.compare));
    expect(screen.getByText(copy.search.summary(listed("cafe").length, "Funchal", copy.search.sortedBy.name))).toBeInTheDocument();
    expect(copy.search.sortedBy.name).toBe("A to Z");
  });

  it("is nearest first when the address asks for My circle's score, which nobody has yet", async () => {
    await openSearch("/search?q=cafe&sort=score");
    expect(names()).toEqual(listed("cafe"));
    expect(screen.getByText(copy.search.summary(listed("cafe").length, "Funchal", copy.search.sortedBy.distance))).toBeInTheDocument();
  });
});

describe("Search: the filters that are on", () => {
  it("shows each as a chip that is pressed, and counts them in the Filters chip", async () => {
    await openSearch("/search?q=cafe&open=1&within=5&kinds=cafes,bars");
    const group = chipsGroup();
    const filtersLink = within(group).getByRole("link", { name: copy.search.filters(4) });
    expect(filtersLink).toHaveAttribute("href", "/filters?q=cafe&open=1&within=5&kinds=cafes%2Cbars");
    expect(copy.search.filters(4)).toBe("Filters · 4");

    const pressed = within(group).getAllByRole("button");
    expect(pressed.map((button) => button.textContent)).toEqual([
      "Open now",
      copy.search.within(formatRadius(5, "en-US")),
      "Cafes",
      "Bars and pubs",
    ]);
    for (const button of pressed) {
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("bg-ink", "text-ground", "h-11", "rounded-chip");
    }
  });

  it("shows none when none is on", async () => {
    await openSearch("/search?q=cafe&sort=name");
    expect(within(chipsGroup()).queryAllByRole("button")).toHaveLength(0);
    expect(within(chipsGroup()).getByRole("link")).toHaveTextContent("Filters");
  });

  it("takes one off when its chip is pressed, as a step the Back button undoes, and keeps the rest", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe&open=1&within=5&from=share");
    await user.click(chip("Open now"));
    expect(router.state.location.search).toBe("?q=cafe&within=5&from=share");
    expect(router.state.historyAction).toBe("PUSH");
    expect(screen.queryByRole("button", { name: "Open now" })).not.toBeInTheDocument();

    await user.click(chip(copy.search.within(formatRadius(5, "en-US"))));
    expect(router.state.location.search).toBe("?q=cafe&from=share");

    await act(() => router.navigate(-1));
    expect(chip(copy.search.within(formatRadius(5, "en-US")))).toHaveAttribute("aria-pressed", "true");
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
    expect(screen.getByText(copy.search.summary(expected.length, "Funchal", "Nearest first"))).toBeInTheDocument();
  });

  it("has the note about the places left out in a box under the results, with a way to bring them back", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search?q=cafe&open=1&within=5");
    const left = idx.search("cafe", { lat: HERE.lat, lon: HERE.lon, radiusKm: 5 }).filter((each) => isClosed(each.place)).length;
    const note = screen.getByText(copy.search.hiddenClosed(left)).parentElement!;
    expect(note).toHaveClass("bg-surface", "rounded-card");
    expect(within(note).getByText(copy.search.hoursNote)).toBeInTheDocument();
    expect(screen.getByRole("list").compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(note).getByRole("button", { name: copy.search.showClosed }));
    expect(router.state.location.search).toBe("?q=cafe&within=5");
    expect(screen.queryByText(copy.search.hoursNote)).not.toBeInTheDocument();
    expect(names()).toEqual(listed("cafe", () => true, 5));
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
    await openSearch("/search?within=1");
    const expected = listed("", () => true, 1);
    expect(expected.length).toBeLessThan(listed("").length);
    expect(names()).toEqual(expected);
    for (const link of rows().filter((each) => each.getAttribute("href")?.startsWith("/place/"))) {
      const found = [...idx.byD.values()].find((each) => `/place/${encodeURIComponent(each.d)}` === link.getAttribute("href"))!;
      expect(distanceKm(HERE.lat, HERE.lon, found.lat, found.lon)).toBeLessThanOrEqual(1);
    }
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

  it("searches by itself a quarter of a second after the person stops typing, and not before", async () => {
    const user = userEvent.setup();
    const { router } = await openSearch("/search");
    await user.type(field(), "novo");
    // Typing is not yet a search.
    expect(router.state.location.search).toBe("");
    await waitFor(() => expect(router.state.location.search).toBe("?q=novo"), { timeout: 1500 });
    expect(router.state.historyAction).toBe("REPLACE");
    expect(names()).toEqual(["Novo Tahiti"]);
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
    expect(screen.getByRole("link", { name: copy.search.addMissing })).toBeInTheDocument();
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
    const link = screen.getByRole("link", { name: copy.search.addMissing });
    expect(link).toHaveAttribute("href", osmNoteUrl(HERE.lat, HERE.lon));
    expect(link).toHaveAttribute("href", "https://www.openstreetmap.org/note/new#map=19/32.650700/-16.908400");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(copy.search.addMissing).toBe("Can't find it? Add a missing place");
  });

  it("is at the foot of the page, above the attribution and below the results", async () => {
    await openSearch("/search?q=pizza");
    const link = screen.getByRole("link", { name: copy.search.addMissing });
    const attribution = screen.getByText(/Place details/);
    expect(screen.getByRole("list").compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(attribution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link).toHaveClass("min-h-touch");
  });

  it("follows the person to the city they picked", async () => {
    window.localStorage.setItem("regulars.here", JSON.stringify({ name: "Monte", country: "PT", lat: 32.66, lon: -16.9 }));
    await openSearch("/search?q=pizza");
    expect(screen.getByRole("link", { name: copy.search.addMissing })).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/note/new#map=19/32.660000/-16.900000",
    );
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
    expect(screen.getByText(copy.search.summary(120, "Funchal", "Nearest first"))).toBeInTheDocument();

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

describe("Search on a desktop", () => {
  it("leaves the field to the top bar: the page has the chips, the line and the rows in a column", async () => {
    wideWindow();
    await openSearch("/search?q=pizza");
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    // The one field is the top bar's, with what was searched for in it.
    expect(screen.getByRole("searchbox")).toHaveValue("pizza");
    expect(screen.queryByRole("link", { name: copy.search.back })).not.toBeInTheDocument();
    expect(names()).toEqual(listed("pizza"));
    expect(screen.getByText(copy.search.summary(2, "Funchal", "Nearest first"))).toBeInTheDocument();
    expect(within(chipsGroup()).getByRole("link", { name: copy.search.filters(0) })).toBeInTheDocument();
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

  it("puts the rows in a column no wider than the page's content", async () => {
    wideWindow();
    await openSearch("/search?q=pizza");
    const column = screen.getByRole("list").closest(".max-w-content");
    expect(column).not.toBeNull();
    expect(column).toHaveClass("mx-auto", "w-full");
    expect(column).toContainElement(chipsGroup());
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
    expect(document.title).toBe(copy.titles.filters);
    expect(screen.getByRole("link", { name: copy.filters.close })).toHaveAttribute("href", "/search?q=pizza&open=1");
  });

  describe("sort", () => {
    it("offers My circle's score, which cannot be chosen yet, Distance and Name", async () => {
      await openFilters();
      const sort = groupNamed(copy.filters.sortBy);
      const buttons = within(sort).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["My circle's score", "Distance", "Name"]);
      expect(buttons[0]).toBeDisabled();
      expect(buttons[0]).toHaveAccessibleDescription(copy.filters.sortScoreSignedOut);
      expect(screen.getByText(copy.filters.sortScoreSignedOut)).toBeVisible();
      expect(copy.filters.sortScoreSignedOut).toBe("Sign in to sort by your circle's scores");
    });

    it("has Distance pressed to begin with", async () => {
      await openFilters();
      const sort = groupNamed(copy.filters.sortBy);
      expect(within(sort).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
      expect(within(sort).getByRole("button", { name: "Name" })).toHaveAttribute("aria-pressed", "false");
      expect(within(sort).getByRole("button", { name: "My circle's score" })).toHaveAttribute("aria-pressed", "false");
    });

    it("presses Name when the person does, and goes back to Distance when Name is pressed again", async () => {
      const user = userEvent.setup();
      await openFilters();
      const sort = groupNamed(copy.filters.sortBy);
      await user.click(within(sort).getByRole("button", { name: "Name" }));
      expect(within(sort).getByRole("button", { name: "Name" })).toHaveAttribute("aria-pressed", "true");
      expect(within(sort).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "false");
      await user.click(within(sort).getByRole("button", { name: "Name" }));
      expect(within(sort).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
    });

    it("does nothing when Distance is pressed on Distance", async () => {
      const user = userEvent.setup();
      await openFilters();
      await user.click(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Distance" }));
      expect(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
    });

    it("reads Distance for an address that asks for the score, which cannot be had", async () => {
      await openFilters("/filters?sort=score");
      expect(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
    });

    it("draws the chips as the design does: pressed is filled with no edge, the rest have one", async () => {
      await openFilters();
      const sort = groupNamed(copy.filters.sortBy);
      expect(within(sort).getByRole("button", { name: "Distance" })).toHaveClass("bg-ink", "text-ground", "h-11", "rounded-chip");
      expect(within(sort).getByRole("button", { name: "Name" })).toHaveClass("border-token", "border-line-strong", "bg-ground");
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
    it("offers 1, 2, 5, 10 and 25 kilometres, in the unit the person's language reads, with the widest to begin with", async () => {
      await openFilters();
      const group = groupNamed(copy.filters.distance);
      const buttons = within(group).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual([1, 2, 5, 10, 25].map((km) => formatRadius(km, "en-US")));
      expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "true"]);
      expect(group).toHaveClass("grid-cols-5");
    });

    it("says kilometres where the browser's language does", async () => {
      vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
      await openFilters();
      expect(within(groupNamed(copy.filters.distance)).getAllByRole("button").map((button) => button.textContent)).toEqual([
        "1 km",
        "2 km",
        "5 km",
        "10 km",
        "25 km",
      ]);
    });

    it("presses the one the person taps, and the address's own when it has one", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?within=10");
      const group = groupNamed(copy.filters.distance);
      expect(within(group).getByRole("button", { name: formatRadius(10, "en-US") })).toHaveAttribute("aria-pressed", "true");
      await user.click(within(group).getByRole("button", { name: formatRadius(2, "en-US") }));
      expect(within(group).getByRole("button", { name: formatRadius(2, "en-US") })).toHaveAttribute("aria-pressed", "true");
      expect(within(group).getByRole("button", { name: formatRadius(10, "en-US") })).toHaveAttribute("aria-pressed", "false");
    });

    it("goes back to the widest when the one that is pressed is pressed again", async () => {
      const user = userEvent.setup();
      await openFilters("/filters?within=2");
      const group = groupNamed(copy.filters.distance);
      await user.click(within(group).getByRole("button", { name: formatRadius(2, "en-US") }));
      expect(within(group).getByRole("button", { name: formatRadius(25, "en-US") })).toHaveAttribute("aria-pressed", "true");
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
      expect(within(group).getByRole("button", { name: "Cafes" })).toHaveClass("bg-ink", "text-ground", "border-ink");
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
      const count = listed("cafe").length;
      expect(screen.getByRole("button", { name: copy.filters.show(count) })).toBeInTheDocument();
      expect(copy.filters.show(5)).toBe("Show 5 places");
      expect(copy.filters.show(1)).toBe("Show 1 place");

      await user.click(screen.getByRole("switch", { name: "Open now" }));
      const open = listed("cafe", (each) => !isClosed(each)).length;
      expect(open).toBeLessThan(count);
      expect(screen.getByRole("button", { name: copy.filters.show(open) })).toBeInTheDocument();

      await user.click(within(groupNamed(copy.filters.kinds)).getByRole("button", { name: "Bars and pubs" }));
      expect(
        screen.getByRole("button", { name: copy.filters.show(listed("cafe", (each) => !isClosed(each) && kindOf(each.category).family === "bars").length) }),
      ).toBeInTheDocument();
    });

    it("counts places for nothing typed", async () => {
      await openFilters("/filters");
      expect(screen.getByRole("button", { name: copy.filters.show(listed("").length) })).toBeInTheDocument();
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
      await user.click(within(groupNamed(copy.filters.distance)).getByRole("button", { name: formatRadius(5, "en-US") }));
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
        within: "5",
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
      await openFilters("/filters?q=cafe&open=1&kinds=cafes,bars&within=2&sort=name");
      expect(screen.getByRole("switch", { name: "Open now" })).toHaveAttribute("aria-checked", "true");
      await user.click(screen.getByRole("button", { name: copy.filters.clearAll }));

      expect(screen.getByRole("switch", { name: "Open now" })).toHaveAttribute("aria-checked", "false");
      for (const button of within(groupNamed(copy.filters.kinds)).getAllByRole("button")) {
        expect(button).toHaveAttribute("aria-pressed", "false");
      }
      expect(within(groupNamed(copy.filters.distance)).getByRole("button", { name: formatRadius(25, "en-US") })).toHaveAttribute("aria-pressed", "true");
      expect(within(groupNamed(copy.filters.sortBy)).getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: copy.filters.show(listed("cafe").length) })).toBeInTheDocument();
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

  it("shows the same controls on a desktop, in a column", async () => {
    wideWindow();
    await openFilters();
    expect(screen.getByRole("switch", { name: "Open now" })).toBeInTheDocument();
    expect(within(groupNamed(copy.filters.kinds)).getAllByRole("button")).toHaveLength(10);
  });
});
