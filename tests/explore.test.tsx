import type { NostrEvent } from "@nostrify/nostrify";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { HereProvider } from "../src/location/HereProvider";
import { distanceKm } from "../src/places/distance";
import { buildIndexes, type Chain, chainSlug, formatDistance } from "../src/places/indexes";
import { parsePlaces } from "../src/places/load";
import { openState } from "../src/places/hours";
import type { Place } from "../src/places/place";
import { placeKindLabel } from "../src/places/kinds";
import { PlacesProvider } from "../src/places/store";
import { routes } from "../src/routes";
import { ChainCard } from "../src/ui/ChainCard";
import { useLocale } from "../src/shell/useLocale";
import { useNow } from "../src/shell/useNow";
import { PlaceCard } from "../src/ui/PlaceCard";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;
const fixturePlaces = parsePlaces(fixtures);
const idx = buildIndexes(fixturePlaces);
const HERE = config.defaultCity;
const PAGE = 30;

/** A Wednesday morning on the clock of Funchal (UTC+1 in October): 08:45, before the brunch places open at 09:00. */
const MORNING = new Date("2026-10-07T07:45:00Z");

const place = (name: string): Place => {
  const found = fixturePlaces.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No fixture place is called ${name}`);
  return found;
};

// ---- Events made from the fixtures ----

let nextId = 1;
/** A place event like `base`, with the value of each tag in `over` replaced (or added, if it has none) and a fresh, fake id. */
function variant(base: NostrEvent, over: Record<string, string>): NostrEvent {
  const replaced = base.tags.map((tag) => (tag[0] !== undefined && tag[0] in over ? [tag[0], over[tag[0]]!] : tag));
  const added = Object.entries(over).filter(([name]) => !base.tags.some((tag) => tag[0] === name));
  return { ...base, id: (nextId++).toString(16).padStart(64, "0"), tags: [...replaced, ...added] };
}

const nameOnly = fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === "crafted-minimal"))!;
const loft = fixtures.find((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === "osm-node-3884132779"))!;

/** `count` places in a line going north from the centre of Funchal, each farther than the last. */
function line(count: number, over: (i: number) => Record<string, string> = () => ({})): NostrEvent[] {
  return Array.from({ length: count }, (_, i) =>
    variant(nameOnly, {
      d: `line-${i}`,
      name: `Line place ${String(i + 1).padStart(2, "0")}`,
      lat: String(HERE.lat + 0.002 * (i + 1)),
      lon: String(HERE.lon),
      ...over(i),
    }),
  );
}

// ---- The page, as a diner has it ----

/** `count` cafes in a line like `line`'s, for a list that has a second kind in it. */
const cafes = (count: number) =>
  line(count, (i) => ({ d: `cafe-${i}`, name: `Cafe line ${String(i + 1).padStart(2, "0")}`, category: "cafe" }));

/** Where the list keeps how deep it was on each page of the history. */
const shownKeys = () => Object.keys(window.sessionStorage).filter((key) => key.startsWith("regulars.explore.shown"));

/** The browser's window as the page asks about its width: wide, for the desktop layout. */
function wideWindow() {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** Explore at `path`, with the places read from `events`; resolves once the page is drawn. */
async function openExplore(path = "/", events: NostrEvent[] = fixtures) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <PlacesProvider reader={createMemoryReader(events)}>
      <HereProvider>
        <RouterProvider router={router} />
      </HereProvider>
    </PlacesProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: copy.pages.explore });
  return { router, ...view };
}

/** What a card is called: the words of the element its link takes its name from. */
const nameOf = (card: HTMLElement) => document.getElementById(card.getAttribute("aria-labelledby") ?? "")?.textContent ?? "";
const cards = () => within(screen.getByRole("list")).getAllByRole("link");
const names = () => cards().map(nameOf);
const card = (name: string) => screen.getByRole("link", { name });
const chip = (name: string) => within(screen.getByRole("group", { name: copy.explore.filtersLabel })).getByRole("button", { name });

/**
 * What the list should read for the places that pass `keep`, worked out from the places alone:
 * nearest first, a chain once at its nearest place, and a chain with one place left as that place.
 */
function listed(keep: (place: Place) => boolean = () => true): string[] {
  const rows = fixturePlaces
    .filter(keep)
    .map((candidate) => ({ candidate, km: distanceKm(HERE.lat, HERE.lon, candidate.lat, candidate.lon) }))
    .sort((a, b) => a.km - b.km);
  const left = new Map<Chain, number>();
  for (const { candidate } of rows) {
    const chain = idx.chainOf(candidate);
    if (chain !== undefined) left.set(chain, (left.get(chain) ?? 0) + 1);
  }
  const seen = new Set<Chain>();
  const out: string[] = [];
  for (const { candidate } of rows) {
    const chain = idx.chainOf(candidate);
    if (chain !== undefined && (left.get(chain) ?? 0) >= 2) {
      if (!seen.has(chain)) {
        seen.add(chain);
        out.push(chain.name);
      }
    } else {
      out.push(candidate.name);
    }
  }
  return out;
}

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

describe("Explore on a phone: the top of the page", () => {
  it("has the place the list is near, the search field, the toggle with its line, then the chips", async () => {
    await openExplore();
    const near = screen.getByRole("button", { name: "Near Funchal" });
    const search = screen.getByRole("link", { name: /Tacos, coffee, a place name/ });
    const toggle = screen.getByRole("group", { name: copy.view.label });
    const chips = screen.getByRole("group", { name: copy.explore.filtersLabel });
    const list = screen.getByRole("list");

    // Top to bottom.
    const inOrder = [near, search, toggle, chips, list];
    inOrder.slice(1).forEach((element, i) => {
      expect(inOrder[i]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    expect(search).toHaveAttribute("href", "/search");
    expect(search).toHaveAccessibleName(`${copy.search.label}: ${copy.search.placeholder}`);
    expect(within(toggle).getByRole("button", { name: "House picks" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toggle).getByRole("button", { name: "My circle" })).toHaveAttribute("aria-pressed", "false");
  });

  it("says whose scores these are, with a link to how that works", async () => {
    await openExplore();
    expect(copy.explore.houseLine).toBe("Scores from the reviewers that Mise en Place, our house curator, trusts.");
    const link = screen.getByRole("link", { name: "How this works" });
    expect(link).toHaveAttribute("href", "/about#how-scores-work");
    expect(link.parentElement).toHaveTextContent(`${copy.explore.houseLine} How this works`);
  });

  it("has the chips All, Open now, Restaurants and Cafes, with All pressed, and More, which goes to the filters", async () => {
    await openExplore();
    const group = screen.getByRole("group", { name: copy.explore.filtersLabel });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["All", "Open now", "Restaurants", "Cafes"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    for (const button of buttons) expect(button).toHaveAttribute("type", "button");

    const more = within(group).getByRole("link", { name: "More" });
    expect(more).toHaveAttribute("href", "/filters");
    expect(more.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws the pressed chip with no edge, as the design does, and the edge's width as padding, so nothing moves when it changes", async () => {
    const user = userEvent.setup();
    await openExplore();
    const pressed = chip("All");
    expect(pressed).toHaveClass("border-0", "bg-ink", "text-ground", "px-[calc(1rem+var(--border))]");
    expect(pressed).not.toHaveClass("border-token", "px-4");

    const resting = chip("Open now");
    expect(resting).toHaveClass("border-token", "border-line-strong", "bg-ground", "px-4");
    expect(resting).not.toHaveClass("border-0", "px-[calc(1rem+var(--border))]");

    await user.click(resting);
    expect(chip("Open now")).toHaveClass("border-0", "px-[calc(1rem+var(--border))]");
    expect(chip("All")).toHaveClass("border-token", "px-4");
  });

  it("names the page for a screen reader and the browser's tab", async () => {
    await openExplore();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Explore");
    expect(document.title).toBe(copy.titles.explore);
  });

  it("opens the search for its field, not a second text field", async () => {
    await openExplore();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("Explore on a phone: the list", () => {
  it("lists the places nearest first, the first thirty, each chain once", async () => {
    await openExplore();
    const everything = listed();
    expect(everything).toHaveLength(39);
    expect(names()).toEqual(everything.slice(0, PAGE));
  });

  it("is a list of links, one to a place", async () => {
    await openExplore();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(PAGE);
    const first = within(items[0]!).getByRole("link");
    expect(first).toHaveAttribute("href", `/place/${encodeURIComponent(place(names()[0]!).d)}`);
  });

  it("shows a chain with two nearby locations as one card, with its size and how many are near", async () => {
    await openExplore();
    const link = card("Loft Brunch & Cocktails");
    expect(link).toHaveAttribute("href", `/chain/${chainSlug(idx.chainOf(place("Loft Brunch & Cocktails"))!)}`);
    const closest = Math.min(
      ...fixturePlaces
        .filter((candidate) => candidate.name === "Loft Brunch & Cocktails")
        .map((candidate) => distanceKm(HERE.lat, HERE.lon, candidate.lat, candidate.lon)),
    );
    // The two locations are alike but for a cuisine on one: the kind is the nearest one's.
    const nearest = fixturePlaces
      .filter((candidate) => candidate.name === "Loft Brunch & Cocktails")
      .sort(
        (a, b) =>
          distanceKm(HERE.lat, HERE.lon, a.lat, a.lon) - distanceKm(HERE.lat, HERE.lon, b.lat, b.lon),
      )[0]!;
    const kind = placeKindLabel(nearest.category, nearest.cuisine);
    expect(link).toHaveTextContent(
      `Loft Brunch & Cocktails${copy.explore.chainKind(kind, 2)}${copy.explore.chainNearby(2, formatDistance(closest, "en-US"))}`,
    );
    expect(link).toHaveTextContent(`${kind} · 2 locations`);
    expect(link).toHaveTextContent(/2 near you, the closest \d+(\.\d)? mi/);
    // Both locations are in the one card.
    expect(screen.getAllByText("Loft Brunch & Cocktails")).toHaveLength(1);
  });

  it("draws the chain card tinted, with a chevron, and a place card plain", async () => {
    await openExplore();
    expect(card("Loft Brunch & Cocktails")).toHaveClass("bg-surface");
    expect(card("Loft Brunch & Cocktails").querySelector("svg path[d='M9 5l7 7-7 7']")).not.toBeNull();
    expect(card("Jacafé")).not.toHaveClass("bg-surface");
  });

  it("shows the first thirty and the rest on 'Show more'", async () => {
    const user = userEvent.setup();
    await openExplore();
    expect(cards()).toHaveLength(PAGE);
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(names()).toEqual(listed());
    expect(screen.queryByRole("button", { name: copy.explore.showMore })).not.toBeInTheDocument();
  });

  it("shows thirty more each time, and starts again from thirty after a new filter", async () => {
    const user = userEvent.setup();
    await openExplore("/", line(75));
    expect(cards()).toHaveLength(30);
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(60);
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(75);
    expect(screen.queryByRole("button", { name: copy.explore.showMore })).not.toBeInTheDocument();
    // Nearest first, all the way down.
    expect(names()[74]).toBe("Line place 75");

    await user.click(chip("Restaurants"));
    expect(cards()).toHaveLength(30);
    expect(screen.getByRole("button", { name: copy.explore.showMore })).toBeInTheDocument();
  });

  it("moves the focus to the first new card when 'Show more' is pressed, so a keyboard goes on from there", async () => {
    const user = userEvent.setup();
    await openExplore("/", line(75));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()[30]).toHaveFocus();
  });

  it("comes back to Explore with as many cards as it had, so Back lands where the person was", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore("/", line(75));
    // The first page of a tab has no key of its own (see below), so start from the next one.
    await user.click(chip("Restaurants"));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(60);

    await user.click(card("Line place 55"));
    expect(router.state.location.pathname).toBe("/place/line-54");
    await act(() => router.navigate(-1));
    expect(cards()).toHaveLength(60);

    // Another filter is another page: it starts from thirty again, and Back to the first one has its sixty.
    await user.click(chip("Cafes"));
    await user.click(chip("Restaurants"));
    expect(cards()).toHaveLength(30);
    await act(() => router.navigate(-2));
    expect(cards()).toHaveLength(60);
  });

  it("keeps nothing on the device for the first page of a tab or an address that was typed, which share one key", async () => {
    const user = userEvent.setup();
    await openExplore("/", line(75));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(60);
    expect(shownKeys()).toEqual([]);
  });

  it("remembers the depth of the first page of a tab for as long as the page is open, so Back to it lands where the person was", async () => {
    const user = userEvent.setup();
    const first = await openExplore("/", line(75));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(60);

    // The page is left and drawn again, as when the router brings the first entry back.
    first.unmount();
    await openExplore("/", line(75));
    expect(cards()).toHaveLength(60);
    expect(shownKeys()).toEqual([]);
  });

  it("brings Back to the first entry of the tab the depth it had", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore("/", line(75));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(60);

    await user.click(chip("Restaurants"));
    expect(cards()).toHaveLength(30);
    await act(() => router.navigate(-1));
    expect(router.state.location.key).toBe("default");
    expect(cards()).toHaveLength(60);
  });

  it("keeps the first page's depth for its own filter and place only", async () => {
    const user = userEvent.setup();
    const events = [...line(75), ...cafes(40)];
    const first = await openExplore("/", events);
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    first.unmount();

    // The same first entry, another chip: another list.
    const second = await openExplore("/?chip=cafes", events);
    expect(cards()).toHaveLength(30);
    second.unmount();

    // Another point to be near: another list, though it has the same places.
    window.localStorage.setItem(
      "regulars.here",
      JSON.stringify({ name: "Monte", country: "PT", lat: 32.66, lon: -16.9 }),
    );
    await openExplore("/", events);
    expect(cards()).toHaveLength(30);
  });

  it("does not take the depth of one list to another", async () => {
    const user = userEvent.setup();
    const events = [...line(75), ...cafes(40)];
    const first = await openExplore("/", events);
    for (let i = 0; i < 2; i++) await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(90);
    first.unmount();

    // The same tab, the address typed in: its first page has the same history key as the one above.
    await openExplore("/?chip=cafes", events);
    expect(cards()).toHaveLength(30);
    expect(screen.getByRole("button", { name: copy.explore.showMore })).toBeInTheDocument();
  });

  it("keeps no more cards than the list has, when it writes the depth and when it reads it", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore("/", line(75));
    await user.click(chip("Restaurants"));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(75);
    // Thirty more were asked for twice over 75: the page keeps 75, not 90.
    expect(shownKeys().map((key) => window.sessionStorage.getItem(key))).toEqual(["75"]);

    // A depth that is too deep, whatever wrote it, is cut to the list.
    for (const key of shownKeys()) window.sessionStorage.setItem(key, "500");
    await act(() => router.navigate(-1));
    await act(() => router.navigate(1));
    expect(cards()).toHaveLength(75);
    expect(screen.queryByRole("button", { name: copy.explore.showMore })).not.toBeInTheDocument();
    expect(shownKeys().map((key) => window.sessionStorage.getItem(key))).toEqual(["75"]);
  });

  it("lists on without that memory when the browser will not keep it", async () => {
    const user = userEvent.setup();
    const { getItem, setItem } = Storage.prototype;
    const refused = vi.fn();
    const refuse = (key: string) => {
      if (!key.startsWith("regulars.explore.shown")) return;
      refused(key);
      throw new DOMException("Blocked.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      refuse(key);
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      refuse(key);
      setItem.call(this, key, value);
    });
    await openExplore("/", line(75));
    await user.click(chip("Restaurants"));
    await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
    expect(cards()).toHaveLength(60);
    expect(refused).toHaveBeenCalled();
  });

  it("has no 'Show more' when everything fits", async () => {
    await openExplore("/", line(PAGE));
    expect(cards()).toHaveLength(PAGE);
    expect(screen.queryByRole("button", { name: copy.explore.showMore })).not.toBeInTheDocument();
  });

  describe("on scroll", () => {
    /** An IntersectionObserver the test drives by hand. */
    class Watcher {
      static all: Watcher[] = [];
      static live = () => Watcher.all.filter((watcher) => watcher.watching.size > 0);
      watching = new Set<Element>();
      constructor(
        public callback: IntersectionObserverCallback,
        public options?: IntersectionObserverInit,
      ) {
        Watcher.all.push(this);
      }
      observe = (target: Element) => void this.watching.add(target);
      unobserve = (target: Element) => void this.watching.delete(target);
      disconnect = () => this.watching.clear();
      takeRecords = () => [];
      /** What the watcher sees come into view, as the browser tells it. */
      see(isIntersecting: boolean) {
        this.callback(
          [...this.watching].map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
          this as unknown as IntersectionObserver,
        );
      }
    }

    beforeEach(() => {
      Watcher.all = [];
      vi.stubGlobal("IntersectionObserver", Watcher);
    });

    it("loads thirty more when the end of the list comes near, and not before", async () => {
      await openExplore("/", line(75));
      expect(Watcher.live()).toHaveLength(1);
      // Looking for the end of the list a little before it is in view.
      expect(Watcher.live()[0]!.options?.rootMargin).toMatch(/\d+px/);

      act(() => Watcher.live()[0]!.see(false));
      expect(cards()).toHaveLength(30);

      act(() => Watcher.live()[0]!.see(true));
      expect(cards()).toHaveLength(60);
      // The new end of the list is watched, and the old one is not.
      expect(Watcher.live()).toHaveLength(1);

      act(() => Watcher.live()[0]!.see(true));
      expect(cards()).toHaveLength(75);
      expect(Watcher.live()).toHaveLength(0);
    });

    it("keeps the button for a person who prefers it", async () => {
      const user = userEvent.setup();
      await openExplore("/", line(75));
      await user.click(screen.getByRole("button", { name: copy.explore.showMore }));
      expect(cards()).toHaveLength(60);
    });
  });
});

describe("Explore: how a place reads", () => {
  it("has its kind, how far it is, whether it is open, and that nobody has reviewed it yet", async () => {
    await openExplore();
    const jacafe = place("Jacafé");
    const km = distanceKm(HERE.lat, HERE.lon, jacafe.lat, jacafe.lon);
    const link = card("Jacafé");
    expect(link).toHaveAttribute("href", "/place/osm-node-11330857543");
    expect(link).toHaveAccessibleDescription(
      `Coffee shop · ${formatDistance(km, "en-US")} Closed · opens 9:30 am ${copy.score.noReviewsYet}`,
    );
    // No stars, no number: there is no score.
    expect(within(link).queryByRole("img")).not.toBeInTheDocument();
    expect(link).toHaveTextContent(copy.score.noReviewsYet);
    expect(copy.score.noReviewsYet).toBe("No reviews yet");
  });

  it("puts that under the hours, where the line about who rated it goes, and leaves the top right empty", async () => {
    await openExplore();
    const link = card("Jacafé");
    const top = within(link).getByText("Jacafé").parentElement!;
    // Nothing beside the name, so it has the whole width of the card.
    expect(top.children).toHaveLength(1);

    const reviews = within(link).getByText(copy.score.noReviewsYet);
    const hours = within(link).getByText("Closed").parentElement!;
    expect(reviews.parentElement).toBe(hours.parentElement);
    expect(hours.compareDocumentPosition(reviews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The look of that line in the design, in the muted colour: 14 px, semibold.
    expect(reviews).toHaveClass("text-secondary", "font-semibold", "text-muted");
    expect(reviews).not.toHaveClass("text-trust");
  });

  it("says a place is open until it closes, in the person's own clock", async () => {
    await openExplore();
    expect(card("Novo Tahiti")).toHaveAccessibleDescription(/Open until 10 pm/);
  });

  it("shows distances in kilometres and times on a 24-hour clock where the browser's language does", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    await openExplore();
    const km = distanceKm(HERE.lat, HERE.lon, place("Novo Tahiti").lat, place("Novo Tahiti").lon);
    expect(card("Novo Tahiti")).toHaveAccessibleDescription(
      new RegExp(`Restaurant · ${formatDistance(km, "pt-PT").replace(".", "\\.")} Open until 22:00`),
    );
    expect(formatDistance(km, "pt-PT")).toMatch(/ (km|m)$/);
  });

  it("keeps the open line up to date as the minutes pass", async () => {
    const tick: { run?: () => void } = {};
    const setInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 60_000) tick.run = handler;
      return setInterval(handler, ms, ...rest);
    }) as typeof globalThis.setInterval);

    await openExplore();
    expect(card("Jacafé")).toHaveAccessibleDescription(/Closed · opens 9:30 am/);
    expect(tick.run).toBeDefined();

    // 09:31 in Funchal.
    vi.setSystemTime(new Date("2026-10-07T08:31:00Z"));
    act(() => tick.run!());
    expect(card("Jacafé")).toHaveAccessibleDescription(/Open until 5:30 pm/);
  });
});

describe("Explore: the unrated card", () => {
  const first = fixturePlaces[0]!;
  function renderCard(over: Partial<ComponentProps<typeof PlaceCard>> = {}) {
    return render(
      <MemoryRouter>
        <PlaceCard place={first} km={0.4} variant="normal" locale="en-US" now={MORNING} {...over} />
      </MemoryRouter>,
    );
  }
  const link = () => screen.getByRole("link", { name: first.name });

  it("has the normal border, and says no one has reviewed it, in every list in M1", async () => {
    await openExplore();
    const places = cards().filter((each) => each.getAttribute("href")?.startsWith("/place/"));
    expect(places.length).toBeGreaterThan(20);
    for (const each of places) {
      expect(each).toHaveClass("border-line");
      expect(each).not.toHaveClass("border-dashed");
      expect(each).toHaveTextContent(copy.score.noReviewsYet);
    }
  });

  it("has a dashed border in the dashed variant, which a list with rated places has for the rest", () => {
    renderCard({ variant: "unrated-dashed" });
    expect(link()).toHaveClass("border-dashed", "border-line-dashed");
    expect(link()).not.toHaveClass("border-line");
  });

  it("says 'No score yet' at the top right in the dashed variant, as My circle's list does, and not 'No reviews yet'", () => {
    renderCard({ variant: "unrated-dashed" });
    expect(copy.score.noScoreYet).toBe("No score yet");
    const score = within(link()).getByText("No score yet");
    expect(score.parentElement).toBe(within(link()).getByText(first.name).parentElement);
    expect(score).toHaveClass("text-caption", "font-semibold", "text-muted", "whitespace-nowrap");
    expect(link()).not.toHaveTextContent(copy.score.noReviewsYet);
  });

  it("says 'No reviews yet' under the hours in the normal variant, and not 'No score yet'", () => {
    renderCard();
    expect(link()).toHaveTextContent(copy.score.noReviewsYet);
    expect(link()).not.toHaveTextContent(copy.score.noScoreYet);
  });

  it("has a plain solid border in the normal variant", () => {
    renderCard();
    expect(link()).toHaveClass("border-token", "border-line", "rounded-card");
    expect(link()).not.toHaveClass("border-dashed");
  });

  it("has a heavier ink border when it is the selected card", () => {
    renderCard({ selected: true });
    expect(link()).toHaveClass("border-2", "border-ink");
    expect(link()).not.toHaveClass("border-line");
  });
});

describe("Explore: hours that cannot be read", () => {
  const first = fixturePlaces[0]!;
  const renderWith = (openingHours: string | undefined) =>
    render(
      <MemoryRouter>
        <PlaceCard place={{ ...first, openingHours }} km={0.4} variant="normal" locale="en-US" now={MORNING} />
      </MemoryRouter>,
    );

  it("shows hours the app cannot read as they are written, on one line with the rest cut off", () => {
    const written = `Mo-Fr 10:00-12:00; ${"unreadable ".repeat(30)}`;
    expect(written.length).toBeGreaterThan(255);
    renderWith(written);
    const hours = screen.getByText(written.trim());
    expect(hours).toHaveClass("truncate");
    expect(hours).toHaveAttribute("title", written);
  });

  it("shows hours that are not given as 'Hours not listed'", () => {
    renderWith(undefined);
    expect(screen.getByRole("link")).toHaveAccessibleDescription(/Hours not listed/);
  });

  it("shows hours that depend on the sun as written", () => {
    renderWith("sunrise-sunset");
    expect(screen.getByText("sunrise-sunset")).toBeInTheDocument();
  });
});

describe("Explore: the filter chips", () => {
  it("keeps only the places that are open now with 'Open now'", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore();
    await user.click(chip("Open now"));

    expect(router.state.location.search).toBe("?chip=open");
    expect(chip("Open now")).toHaveAttribute("aria-pressed", "true");
    expect(chip("All")).toHaveAttribute("aria-pressed", "false");

    const open = (candidate: Place) => openState(candidate, MORNING).kind === "open";
    expect(listed(open).length).toBeLessThan(listed().length);
    expect(names()).toEqual(listed(open).slice(0, PAGE));
    // Everything left is open, so every line says so.
    for (const each of cards().filter((link) => !link.getAttribute("href")?.startsWith("/chain/"))) {
      expect(each).toHaveAccessibleDescription(/ Open (until|24 hours)/);
    }
    expect(screen.queryByRole("link", { name: "Jacafé" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Novo Tahiti" })).toBeInTheDocument();
  });

  it("keeps only the restaurants with 'Restaurants'", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore();
    await user.click(chip("Restaurants"));
    expect(router.state.location.search).toBe("?chip=restaurants");
    expect(names()).toEqual(listed((candidate) => candidate.category === "restaurant").slice(0, PAGE));
    expect(screen.queryByRole("link", { name: "A Confeitaria Coffee & Bakery" })).not.toBeInTheDocument();
  });

  it("keeps only the cafes with 'Cafes'", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore();
    await user.click(chip("Cafes"));
    expect(router.state.location.search).toBe("?chip=cafes");
    expect(names()).toEqual(listed((candidate) => candidate.category === "cafe"));
    expect(chip("Cafes")).toHaveAttribute("aria-pressed", "true");
  });

  it("takes a chip pressed again back to All", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore("/?chip=cafes");
    await user.click(chip("Cafes"));
    expect(router.state.location.search).toBe("");
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(listed().slice(0, PAGE));
  });

  it("does nothing when All is pressed on All", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore();
    await user.click(chip("All"));
    expect(router.state.location.search).toBe("");
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  });

  it("reads the chip from the address, and ignores one it does not know", async () => {
    await openExplore("/?chip=restaurants");
    expect(chip("Restaurants")).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(listed((candidate) => candidate.category === "restaurant").slice(0, PAGE));
  });

  it("is All for an unknown chip", async () => {
    await openExplore("/?chip=expensive");
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(listed().slice(0, PAGE));
  });

  it("keeps what else the address holds", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore("/?from=share");
    await user.click(chip("Open now"));
    expect(new URLSearchParams(router.state.location.search).get("from")).toBe("share");
    expect(new URLSearchParams(router.state.location.search).get("chip")).toBe("open");
  });

  it("goes back and forward with the browser", async () => {
    const user = userEvent.setup();
    const { router } = await openExplore();
    await user.click(chip("Open now"));
    await user.click(chip("Cafes"));
    expect(chip("Cafes")).toHaveAttribute("aria-pressed", "true");

    await act(() => router.navigate(-1));
    expect(chip("Open now")).toHaveAttribute("aria-pressed", "true");
    await act(() => router.navigate(-1));
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    await act(() => router.navigate(1));
    expect(chip("Open now")).toHaveAttribute("aria-pressed", "true");
  });

  it("filters before it groups: a chain counts only the locations that pass", async () => {
    const user = userEvent.setup();
    const hours = (value: string) => ({ "opening-hours": value });
    const events = [
      variant(loft, { d: "tide-1", name: "Tide Pool Bar", lat: "32.651", lon: "-16.908", ...hours("Mo-Su 08:00-20:00") }),
      variant(loft, { d: "tide-2", name: "Tide Pool Bar", lat: "32.652", lon: "-16.909", ...hours("Mo-Su 08:00-20:00") }),
      variant(loft, { d: "tide-3", name: "Tide Pool Bar", lat: "32.653", lon: "-16.91", ...hours("Mo-Su 12:00-23:00") }),
    ];
    await openExplore("/", events);
    expect(card("Tide Pool Bar")).toHaveTextContent("3 near you");

    await user.click(chip("Open now"));
    expect(card("Tide Pool Bar")).toHaveTextContent("2 near you");
    expect(card("Tide Pool Bar")).toHaveTextContent("3 locations");
  });

  it("says nothing matches, with a way back to all of the places, when the chip leaves none", async () => {
    const user = userEvent.setup();
    const restaurants = fixtures.filter((event) => event.tags.some((tag) => tag[0] === "category" && tag[1] === "restaurant"));
    const { router } = await openExplore("/?chip=cafes", restaurants);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(copy.explore.noneMatching)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.explore.showAll }));
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole("list")).toBeInTheDocument();
  });
});

describe("Explore: no place is near", () => {
  /** Every fixture place moved to Lisbon. They keep their names, but they are no longer in Funchal. */
  const lisbon = fixtures.map((event, i) =>
    variant(event, { lat: String(38.72 + i * 0.001), lon: "-9.14", locality: "Lisboa", country: "PT" }),
  );

  it("says so, in words, and offers to choose another town", async () => {
    await openExplore("/", lisbon);
    expect(screen.getByText("No places listed near Funchal yet. Try another town.")).toBeInTheDocument();
    expect(copy.explore.noneNearby("Funchal")).toBe("No places listed near Funchal yet. Try another town.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The header and the chips are still there.
    expect(screen.getByRole("button", { name: "Near Funchal" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: copy.explore.filtersLabel })).toBeInTheDocument();
  });

  it("opens the towns, and shows the places near the one that is picked", async () => {
    const user = userEvent.setup();
    await openExplore("/", lisbon);
    await user.click(screen.getByRole("button", { name: copy.explore.chooseTown }));

    const dialog = screen.getByRole("dialog", { name: copy.location.pickTitle });
    await user.click(within(dialog).getByRole("button", { name: /^Lisboa/ }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Near Lisboa" })).toBeInTheDocument();
    expect(cards().length).toBeGreaterThan(0);
    expect(screen.queryByText(/No places listed near/)).not.toBeInTheDocument();
  });
});

describe("Explore: names", () => {
  it("clamps a long name to two lines", async () => {
    await openExplore();
    const longName = "Restaurante Tradicional Madeirense da Família Fernandes e Filhos SA";
    expect(longName).toHaveLength(67);
    const name = within(card(longName)).getByText(longName);
    expect(name).toHaveClass("line-clamp-2");
    // It breaks inside a word rather than push the card wider than the screen.
    expect(name).toHaveClass("min-w-0", "wrap-break-word");
    expect(name).not.toHaveAttribute("lang");
  });

  it("marks a Japanese name as Japanese, so it is set in Noto Sans JP", async () => {
    await openExplore();
    const name = within(card("ペーパー・クレーン")).getByText("ペーパー・クレーン");
    expect(name).toHaveAttribute("lang", "ja");
  });

  it("marks a chain's name by its script as well", () => {
    const chain: Chain = { key: "寿司", country: "JP", name: "寿司ざんまい", places: [] };
    const row = (lat: number) => ({ place: { ...fixturePlaces[0]!, name: "寿司ざんまい", lat }, km: 1 });
    render(
      <MemoryRouter>
        <ChainCard chain={{ ...chain, places: [row(1).place, row(2).place] }} nearby={[row(1), row(2)]} locale="en-US" />
      </MemoryRouter>,
    );
    expect(screen.getByText("寿司ざんまい")).toHaveAttribute("lang", "ja");
  });

  it("shows a place with only a name, a kind and a position without empty labels", async () => {
    await openExplore();
    const link = card("Minimal Table");
    expect(link).toHaveAccessibleDescription(/^Restaurant · .+ Hours not listed No reviews yet$/);
    expect(link.textContent).not.toMatch(/undefined|null|·\s*$/);
  });
});

describe("Explore on a desktop", () => {
  it("leaves the search and the toggle to the top bar and has the line, the chips and the list in the column", async () => {
    wideWindow();
    await openExplore();
    expect(screen.getAllByRole("group", { name: copy.view.label })).toHaveLength(1);
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "How this works" })).toBeInTheDocument();
    expect(chip("Open now")).toBeInTheDocument();
    expect(names()).toEqual(listed().slice(0, PAGE));
  });
});

describe("Explore: a place moves with the person", () => {
  it("lists the places around the city that is picked", async () => {
    const user = userEvent.setup();
    const elsewhere = [
      ...fixtures,
      ...Array.from({ length: 3 }, (_, i) =>
        variant(nameOnly, {
          d: `lisbon-${i}`,
          name: `Lisbon place ${i + 1}`,
          lat: String(38.72 + i * 0.001),
          lon: "-9.14",
          locality: "Lisboa",
          country: "PT",
        }),
      ),
    ];
    await openExplore("/", elsewhere);
    await user.click(screen.getByRole("button", { name: "Near Funchal" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Lisboa/ }));

    // The town's centre is the middle place; the other two are the same distance from it.
    expect(names()[0]).toBe("Lisbon place 2");
    expect([...names()].sort()).toEqual(["Lisbon place 1", "Lisbon place 2", "Lisbon place 3"]);
    expect(screen.queryByRole("link", { name: "Jacafé" })).not.toBeInTheDocument();
  });
});

describe("useNow", () => {
  it("reads the clock again every minute", () => {
    const timers: Array<[() => void, number | undefined]> = [];
    const setInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
      timers.push([handler, ms]);
      return setInterval(() => {}, 1_000_000);
    }) as typeof globalThis.setInterval);

    const { result } = renderHook(() => useNow());
    expect(result.current).toEqual(MORNING);
    expect(timers.map(([, ms]) => ms)).toEqual([60_000]);

    vi.setSystemTime(new Date("2026-10-07T07:46:00Z"));
    act(() => timers[0]![0]());
    expect(result.current).toEqual(new Date("2026-10-07T07:46:00Z"));
  });

  it("reads it when the page comes back into view, and stops its timer when it goes", () => {
    const { result, unmount } = renderHook(() => useNow());
    vi.setSystemTime(new Date("2026-10-07T09:00:00Z"));

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toEqual(MORNING);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toEqual(new Date("2026-10-07T09:00:00Z"));

    unmount();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(result.current).toEqual(new Date("2026-10-07T09:00:00Z"));
  });
});

describe("useLocale", () => {
  it("is the browser's language, and follows it when the person changes it", () => {
    const language = vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    const { result } = renderHook(() => useLocale());
    expect(result.current).toBe("pt-PT");

    language.mockReturnValue("en-US");
    act(() => void window.dispatchEvent(new Event("languagechange")));
    expect(result.current).toBe("en-US");
  });

  it("reads as American English in a browser that gives none", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("");
    expect(renderHook(() => useLocale()).result.current).toBe("en-US");
  });
});
