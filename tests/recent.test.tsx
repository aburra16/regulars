import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_KEY } from "../src/account/session";
import * as client from "../src/circle/brainstorm";
import { CIRCLE_KEY } from "../src/circle/CircleProvider";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader, RelayWriter } from "../src/nostr/events";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { FEED_FRESH_MS, FEED_PAGE, RecentFeed } from "../src/recent/feed";
import { REVIEW_KIND } from "../src/reviews/review";
import { FLUSH_WINDOW_MS, ScoresStore } from "../src/score/store";
import { VIEW_STORAGE_KEY } from "../src/view/ViewProvider";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";
import { createMemoryWriter, type MemoryWriter } from "./support/memoryWriter";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";

/*
 * Recent (Avi, 2026-10-08): the newest reviews of places everywhere, from the people who count in the
 * view on screen, newest first, each a link to its place. The relays are held in memory: Brainstorm's
 * search relay (reviews and names), the house's trust relay (its list, and the circle's ranks) and a
 * made-up scorer for the house. Brainstorm's client is mocked: the one call it could get is the
 * returning visitor's look, which a kept circle skips. Nothing opens a socket or reaches the network.
 */

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

const SEARCH = "wss://search.brainstorm.world";
/** The house's trust relay, which holds its list, and where Brainstorm's scorers publish a circle's ranks. */
const SCORES = "wss://scores.brainstorm.world";
/** The house's scorer and its relay, made up: the real one is never written into the app or its tests. */
const HOUSE_SCORER = hex64("5");
const HOUSE_RELAY = "wss://ranks.example.test";
/** The person's own scorer, made up. */
const CIRCLE_SCORER = hex64("6");
const CIRCLE_AT = { pubkey: CIRCLE_SCORER, relay: SCORES };

/** Thursday 8 October 2026, 12:00 UTC, in seconds: where the clock stands. */
const NOW_S = 1_791_460_800;
const HOUR = 3_600;

/** Jacafé's place event under another d: the same place, filed twice (brief § 4.3). */
const jacafeAgainEvent = (): NostrEvent => {
  const jacafe = (raw as NostrEvent[]).find((ev) => ev.tags.some((tag) => tag[0] === "d" && tag[1] === "osm-node-11330857543"))!;
  return { ...jacafe, id: hex64("9"), tags: jacafe.tags.map((tag) => (tag[0] === "d" ? ["d", "jacafe-again"] : tag)) };
};
const placeEvents: NostrEvent[] = [...(raw as NostrEvent[]), jacafeAgainEvent()];
const ALL = parsePlaces(placeEvents);
const placeAt = (d: string): Place => ALL.find((place) => place.d === d)!;
const JACAFE = placeAt("osm-node-11330857543");
const JACAFE_AGAIN = placeAt("jacafe-again");
const MAIA = placeAt("osm-node-10169374926");
const MUSEU = placeAt("osm-node-1782789982");
const NOVO = placeAt("osm-node-12615578978");
const placePath = (place: Place) => `/place/${encodeURIComponent(place.d)}`;

const [ALICE, BOB, CAROL, DAVE, ERIN, FRANK] = ["a", "b", "c", "d", "e", "f"].map(hex64) as [string, string, string, string, string, string];
/** Someone nobody ranks, the `i`th. */
const stranger = (i: number) => (0x1000 + i).toString(16).padStart(64, "7");

/** The house's kind 10040, naming its scorer. */
const trustList = () => shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", HOUSE_SCORER, HOUSE_RELAY]] });
const rankBy = (scorer: string) => (subject: string, rank: number) =>
  shapedEvent({ kind: 30382, pubkey: scorer, tags: [["d", subject], ["rank", String(rank)]] });
const houseRank = rankBy(HOUSE_SCORER);
const circleRank = rankBy(CIRCLE_SCORER);

/** The ranks the tests give, which no page may show in any form (decision 19). */
const RANKS = [81.5, 66.25, 3.75, 72.5, 93.5, 57.25, 2.5];
/** The house trusts Alice, Bob, Erin and Frank, and not Carol; nobody ranks Dave. */
const HOUSE = [houseRank(ALICE, 81.5), houseRank(BOB, 66.25), houseRank(CAROL, 3.75), houseRank(ERIN, 72.5), houseRank(FRANK, 72.5)];
/** The circle has Bob and Carol, and not Alice. */
const CIRCLE = [circleRank(BOB, 93.5), circleRank(CAROL, 57.25), circleRank(ALICE, 2.5)];

const profileOf = (pubkey: string, name: string) => shapedEvent({ kind: 0, pubkey, content: JSON.stringify({ name }) });
const PROFILES = [
  profileOf(ALICE, "Alice Bento"),
  profileOf(BOB, "Bob"),
  profileOf(CAROL, "Carol"),
  profileOf(DAVE, "Dave"),
  profileOf(ERIN, "Erin"),
  profileOf(FRANK, "Frank"),
];

/** `reviewer`'s review of `place`, as the app writes them, at `createdAt`. */
const reviewOf = (reviewer: string, place: Place | string, stars: number | null, text: string, createdAt: number) => {
  const address = typeof place === "string" ? place : place.address;
  return shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    created_at: createdAt,
    content: text,
    tags: [["d", `place:${address}`], ["a", address], ["m", "place"], ...(stars === null ? [] : [["s", String(stars)]])],
  });
};

/** `promise`, or the signal's reason as soon as it aborts. */
function orAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    void promise.then(resolve);
  });
}

/** What the relays hold, and every request made of them, in order. A test changes them between reads. */
interface Network {
  reviews: NostrEvent[];
  house: NostrEvent[];
  circle: NostrEvent[];
  profiles: NostrEvent[];
  log: { url: string; filter: NostrFilter }[];
  /** While true, the search relay fails every read of reviews. */
  searchDown: boolean;
  /** Reads of the house's ranks that name any of these wait until `release`. */
  holdRanksOf: Set<string>;
  /** While true, reads of the newest reviews wait until `release`. */
  holdFeed: boolean;
  release(): void;
  readers(url: string): RelayReader;
}

function network({ reviews = [], house = HOUSE, circle = CIRCLE }: { reviews?: NostrEvent[]; house?: NostrEvent[]; circle?: NostrEvent[] } = {}): Network {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const net: Network = {
    reviews: [...reviews],
    house: [...house],
    circle: [...circle],
    profiles: [...PROFILES],
    log: [],
    searchDown: false,
    holdRanksOf: new Set(),
    holdFeed: false,
    release: () => open(),
    readers: (url) => ({
      async *req(filter, signal) {
        net.log.push({ url, filter });
        let events: NostrEvent[] = [];
        if (url === SEARCH) {
          if (filter.kinds?.includes(REVIEW_KIND) && net.searchDown) throw new Error("The relay answered 503");
          if (filter["#m"] !== undefined && net.holdFeed) await orAbort(gate, signal);
          events = [...net.reviews, ...net.profiles];
        } else if (url === SCORES) {
          events = [trustList(), ...net.circle];
        } else if (url === HOUSE_RELAY) {
          if (filter["#d"]?.some((pubkey) => net.holdRanksOf.has(pubkey))) await orAbort(gate, signal);
          events = net.house;
        }
        yield* createMemoryReader(events).req(filter, signal);
      },
    }),
  };
  return net;
}

/** The reads of the newest reviews: Recent's, by `m`. */
const feedReads = (net: Network) => net.log.filter(({ url, filter }) => url === SEARCH && filter["#m"] !== undefined);
/** Every read of reviews, Recent's and the places'. */
const reviewReads = (net: Network) => net.log.filter(({ url, filter }) => url === SEARCH && filter.kinds?.includes(REVIEW_KIND));

/** Signs a person in to the tab with a browser add-on, as a reload of a signed-in tab finds them, named `name`. */
function signedIn(net: Network, name = "Maya"): string {
  const key = generateSecretKey();
  Object.defineProperty(window, "nostr", {
    configurable: true,
    writable: true,
    value: {
      getPublicKey: async () => getPublicKey(key),
      signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, key),
    },
  });
  const pubkey = getPublicKey(key);
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
  net.profiles.push(profileOf(pubkey, name));
  return pubkey;
}

/** Earlier in this session, the person's circle was found ready: a reload of the tab finds it, and asks Brainstorm nothing. */
function keptCircle(pubkey: string): void {
  window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "ready", scorer: CIRCLE_AT, notice: false }));
}

/** Recent, at the end of `entries`, reading `net`, and sending reviews with `writers`. */
const openRecent = (
  net: Network,
  { px = PHONE, entries = ["/recent"], writers }: { px?: number; entries?: string[]; writers?: (url: string) => RelayWriter } = {},
) => openApp(String(entries.at(-1)), { events: placeEvents, entries, px, readers: net.readers, ...(writers === undefined ? {} : { writers }) });

const theList = () => screen.getByRole("list", { name: copy.pages.recent });
const entryLinks = () => within(theList()).getAllByRole("link");
/** The names of the links listed, in order, once the list is there. */
const listed = () => (screen.queryByRole("list", { name: copy.pages.recent }) === null ? [] : entryLinks().map((link) => link.getAttribute("aria-label")));
/** Waits for the list to name exactly `names`, in order. */
const listsExactly = (names: string[]) => waitFor(() => expect(listed()).toEqual(names));
const toggle = () => screen.getByRole("group", { name: copy.view.label });
const housePicks = () => within(toggle()).getByRole("button", { name: copy.view.house });
const myCircle = () => within(toggle()).getByRole("button", { name: /^My circle/ });
const tabBar = () => screen.queryByRole("navigation", { name: copy.nav.label });
/** The polite region that says `text`, once it does. */
const saidPolitely = async (text: string) => (await screen.findByText(text)).closest('[role="status"]');

/** Lets what is queued run: effects, the store's window for gathering asks, and reads that answer at once. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, FLUSH_WINDOW_MS + 10)));
  for (let i = 0; i < 5; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

const ALICE_AT_JACAFE = "Alice Bento's review of Jacafé, 2 hours ago";
const BOB_AT_MAIA = "Bob's review of Maia, yesterday";

beforeEach(() => {
  config.reviewRelays = [SEARCH];
  config.features.circle = true;
  brainstorm.scorerOf.mockReset().mockResolvedValue(null);
  for (const call of [brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) call.mockReset();
  // The clock stands still at NOW_S: how long ago each review was written is known.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW_S * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
});

describe("Recent: the list", () => {
  it("lists the reviews of the reviewers the house trusts, newest first, each with who, when, the place, its distance, the stars and the words, linking to the place", async () => {
    const net = network({
      reviews: [
        reviewOf(BOB, MAIA, 5, "Fresh fish, slow service.", NOW_S - 25 * HOUR),
        reviewOf(ALICE, JACAFE, 4, "Get the bolo.\nAnd sit outside.", NOW_S - 2 * HOUR),
        // Below the house's line, and ranked by nobody: newer, and not listed.
        reviewOf(CAROL, MUSEU, 2, "Too sweet.", NOW_S - HOUR),
        reviewOf(DAVE, NOVO, 3, "Fine.", NOW_S - HOUR / 2),
      ],
    });
    await openRecent(net);

    expect(screen.getByRole("heading", { level: 1, name: copy.pages.recent })).toBeInTheDocument();
    expect(copy.pages.recent).toBe("Recent reviews");
    expect(document.title).toBe(copy.titles.recent);
    expect(screen.getByText(copy.recent.houseLine)).toBeInTheDocument();
    expect(copy.recent.houseLine).toBe("From the reviewers the house trusts.");
    await listsExactly([ALICE_AT_JACAFE, BOB_AT_MAIA]);

    const [alice, bob] = entryLinks() as [HTMLElement, HTMLElement];
    expect(alice).toHaveAttribute("href", placePath(JACAFE));
    expect(within(alice).getByText("Alice Bento")).toBeInTheDocument();
    const when = within(alice).getByText("2 hours ago");
    expect(when.tagName).toBe("TIME");
    expect(when).toHaveAttribute("dateTime", new Date((NOW_S - 2 * HOUR) * 1000).toISOString());
    expect(within(alice).getByText(JACAFE.name)).toBeInTheDocument();
    expect(within(alice).getByText("Coffee shop · 0.1 mi")).toBeInTheDocument();
    expect(within(alice).getByRole("img", { name: "4 out of 5" })).toBeInTheDocument();
    const words = within(alice).getByText(/^Get the bolo\./);
    expect(words).toHaveClass("line-clamp-3");
    // The link says the rest of the entry after its name.
    expect(alice).toHaveAccessibleDescription("Coffee shop · 0.1 mi 4 out of 5 Get the bolo.\nAnd sit outside.");

    expect(bob).toHaveAttribute("href", placePath(MAIA));
    expect(within(bob).getByText("yesterday")).toBeInTheDocument();
    expect(within(bob).getByText("Cafe · 0.2 mi")).toBeInTheDocument();
    expect(within(bob).getByRole("img", { name: "5 out of 5" })).toBeInTheDocument();

    expect(screen.queryByText("Too sweet.")).not.toBeInTheDocument();
    expect(screen.queryByText("Fine.")).not.toBeInTheDocument();
    // Every review there is has been read: the list says so, under it.
    expect(screen.getByText(copy.recent.end)).toBeInTheDocument();
    expect(copy.recent.end).toBe("That's every review so far.");

    // One read of the newest reviews of places, with the search relay's words.
    expect(feedReads(net).map(({ filter }) => filter)).toEqual([
      { kinds: [REVIEW_KIND], "#m": ["place"], limit: FEED_PAGE, search: "include:spam" },
    ]);
    expect(FEED_PAGE).toBe(100);
    expectNoNumbersAboutPeople(RANKS);
  });

  it("names a reviewer as the place's page does, Someone when their profile has no name, and is a list of links", async () => {
    const net = network({ reviews: [reviewOf(ERIN, JACAFE, null, "", NOW_S - 3 * 60)] });
    net.profiles = net.profiles.filter((profile) => profile.pubkey !== ERIN);
    await openRecent(net);
    await waitFor(() => expect(net.log.some(({ filter }) => filter.kinds?.includes(0) && filter.authors?.includes(ERIN))).toBe(true));
    await listsExactly(["Someone's review of Jacafé, 3 minutes ago"]);
    const [erin] = entryLinks() as [HTMLElement];
    // No stars and no words: neither is drawn, nor said.
    expect(within(erin).queryByRole("img")).not.toBeInTheDocument();
    expect(erin).toHaveAccessibleDescription("Coffee shop · 0.1 mi");
    expect(within(theList()).getAllByRole("listitem")).toHaveLength(1);
  });

  it("says how long ago in plain words, from now to years", () => {
    const when = (seconds: number, days: number, months = 0) => copy.recent.when(seconds, days, months);
    expect(when(20, 0)).toBe("now");
    expect(when(60, 0)).toBe("1 minute ago");
    expect(when(59 * 60, 0)).toBe("59 minutes ago");
    expect(when(HOUR, 0)).toBe("1 hour ago");
    expect(when(23 * HOUR, 1)).toBe("23 hours ago");
    expect(when(25 * HOUR, 1)).toBe("yesterday");
    expect(when(50 * HOUR, 2)).toBe("2 days ago");
    expect(when(8 * 24 * HOUR, 8)).toBe("1 week ago");
    expect(when(20 * 24 * HOUR, 20)).toBe("2 weeks ago");
    expect(when(40 * 24 * HOUR, 40, 1)).toBe("1 month ago");
    expect(when(400 * 24 * HOUR, 400, 13)).toBe("1 year ago");
    for (const text of [when(8 * 24 * HOUR, 8), when(40 * 24 * HOUR, 40, 1)]) expect(text).not.toMatch(/^last/);
  });

  it("leaves out a review of a place not on the list, and one from the future; and gives each reviewer one review of a place filed twice", async () => {
    const net = network({
      reviews: [
        reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR),
        // A place that is not on the list.
        reviewOf(ALICE, `39999:${hex64("9")}:somewhere-else`, 5, "Somewhere else.", NOW_S - HOUR),
        // Two days ahead of the clock: made up, and it does not replace Bob's real one.
        reviewOf(BOB, MAIA, 1, "From the future.", NOW_S + 2 * 24 * HOUR),
        reviewOf(BOB, MAIA, 5, "Fresh fish.", NOW_S - 5 * HOUR),
        // Jacafé, filed twice: Erin's newer review stands.
        reviewOf(ERIN, JACAFE, 2, "Older words.", NOW_S - 6 * HOUR),
        reviewOf(ERIN, JACAFE_AGAIN, 5, "Newer words.", NOW_S - 4 * HOUR),
      ],
    });
    await openRecent(net);
    await listsExactly([ALICE_AT_JACAFE, "Erin's review of Jacafé, 4 hours ago", "Bob's review of Maia, 5 hours ago"]);
    expect(entryLinks()[1]).toHaveAttribute("href", placePath(JACAFE_AGAIN));
    for (const words of ["Somewhere else.", "From the future.", "Older words."]) expect(screen.queryByText(words)).not.toBeInTheDocument();
  });
});

describe("Recent: whose reviews", () => {
  it("lists the circle's reviewers and the person's own in My circle, and switching reads no review", async () => {
    const net = network();
    const me = signedIn(net);
    keptCircle(me);
    net.reviews.push(
      reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR),
      reviewOf(BOB, MAIA, 5, "Fresh fish.", NOW_S - 25 * HOUR),
      reviewOf(CAROL, MUSEU, 2, "Too sweet.", NOW_S - HOUR),
      // The house does not rank the person: their review counts in My circle only.
      reviewOf(me, NOVO, 3, "Good value.", NOW_S - 3 * HOUR),
    );
    const user = userEvent.setup();
    await openRecent(net);
    await listsExactly([ALICE_AT_JACAFE, BOB_AT_MAIA]);
    const reads = reviewReads(net).length;
    // The names of the circle's reviewers are read too, though House picks does not list them.
    await waitFor(() => expect(net.log.some(({ filter }) => filter.kinds?.includes(0) && filter.authors?.includes(CAROL))).toBe(true));
    await settle();

    await user.click(myCircle());
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(copy.recent.circleLine)).toBeInTheDocument();
    expect(copy.recent.circleLine).toBe("From your circle.");
    // At once, and by name: switching reads nothing.
    expect(listed()).toEqual(["Carol's review of Museu Café, 1 hour ago", "Your review of Novo Tahiti, 3 hours ago", BOB_AT_MAIA]);
    expect(within(entryLinks()[1]!).getByText(copy.recent.you)).toBeInTheDocument();
    expect(within(entryLinks()[1]!).queryByText("Maya")).not.toBeInTheDocument();
    expectNoNumbersAboutPeople(RANKS);

    await user.click(housePicks());
    await listsExactly([ALICE_AT_JACAFE, BOB_AT_MAIA]);
    // Switching filters the reviews already read: not one more read of reviews.
    expect(reviewReads(net)).toHaveLength(reads);
    expectNoNumbersAboutPeople(RANKS);
  });

  it("lists nobody before the house has said who counts, then lists them", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR), reviewOf(CAROL, MUSEU, 2, "Too sweet.", NOW_S - HOUR)] });
    net.holdRanksOf.add(ALICE);
    await openRecent(net);
    await waitFor(() => expect(net.log.some(({ url }) => url === HOUSE_RELAY)).toBe(true));
    expect(await saidPolitely(copy.recent.loading)).not.toBeNull();
    // Neither listed nor said to be nobody's: nobody is outside the view before its scorer has said so.
    expect(listed()).toEqual([]);
    expect(screen.queryByText(copy.recent.emptyHouse)).not.toBeInTheDocument();

    net.release();
    await listsExactly([ALICE_AT_JACAFE]);
    expect(screen.queryByText(copy.recent.loading)).not.toBeInTheDocument();
  });

  it("keeps a reviewer from an older page out of the list until the house has answered for them, beside those it has", async () => {
    // A full first page: Alice, who counts, and 99 people nobody ranks. Erin is on the page after it.
    const first = Array.from({ length: FEED_PAGE - 1 }, (_, i) => reviewOf(stranger(i), JACAFE, 3, `Stranger ${i}.`, NOW_S - 60 * (i + 2)));
    const net = network({
      reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 60), ...first, reviewOf(ERIN, MAIA, 5, "Fresh fish.", NOW_S - 300 * 60)],
    });
    net.holdRanksOf.add(ERIN);
    await openRecent(net);
    // Fewer than enough count: the next page is read by itself.
    await waitFor(() => expect(feedReads(net)).toHaveLength(2));
    await waitFor(() => expect(net.log.some(({ url, filter }) => url === HOUSE_RELAY && filter["#d"]?.includes(ERIN))).toBe(true));
    await listsExactly(["Alice Bento's review of Jacafé, 1 minute ago"]);

    net.release();
    await listsExactly(["Alice Bento's review of Jacafé, 1 minute ago", "Erin's review of Maia, 5 hours ago"]);
  });

  it("says when House picks can't be worked out, with Try again, and lists nobody", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR)], house: [] });
    const readers = net.readers;
    let houseDown = true;
    net.readers = (url) => (url === HOUSE_RELAY && houseDown ? createMemoryReader([], { failWith: new Error("down") }) : readers(url));
    const user = userEvent.setup();
    await openRecent(net);
    expect(await screen.findByText(copy.score.houseUnavailable)).toBeInTheDocument();
    expect(listed()).toEqual([]);
    expect(screen.queryByText(copy.recent.emptyHouse)).not.toBeInTheDocument();

    houseDown = false;
    net.house.push(houseRank(ALICE, 81.5));
    await user.click(screen.getByRole("button", { name: copy.load.retry }));
    await listsExactly([ALICE_AT_JACAFE]);
    expect(screen.queryByText(copy.score.houseUnavailable)).not.toBeInTheDocument();
  });
});

describe("Recent: paging", () => {
  /** The `i`th newest of 350 reviews, a minute apart. */
  const at = (i: number) => NOW_S - 60 * (i + 1);
  /** 350 reviews, by people nobody ranks but Alice (10th), Bob (50th), Erin (220th) and Frank (320th). */
  const longFeed = () =>
    Array.from({ length: 350 }, (_, i) => {
      const reviewer = { 10: ALICE, 50: BOB, 220: ERIN, 320: FRANK }[i] ?? stranger(i);
      return reviewOf(reviewer, JACAFE, 4, `Review ${i}.`, at(i));
    });

  it("reads up to three pages by itself while fewer than 20 count, then older ones on request, until there are no more", async () => {
    const net = network({ reviews: longFeed() });
    const user = userEvent.setup();
    await openRecent(net);
    await listsExactly([
      "Alice Bento's review of Jacafé, 11 minutes ago",
      "Bob's review of Jacafé, 51 minutes ago",
      "Erin's review of Jacafé, 3 hours ago",
    ]);
    // Three pages, each up to the oldest of the one before less a second, and then it waits.
    expect(feedReads(net).map(({ filter }) => filter.until)).toEqual([undefined, at(99) - 1, at(199) - 1]);
    const older = screen.getByRole("button", { name: copy.recent.showOlder });
    expect(older).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(copy.recent.end)).not.toBeInTheDocument();
    expect(feedReads(net)).toHaveLength(3);

    await user.click(older);
    await waitFor(() => expect(listed().at(-1)).toBe("Frank's review of Jacafé, 5 hours ago"));
    expect(listed()).toHaveLength(4);
    expect(feedReads(net).at(-1)?.filter).toMatchObject({ until: at(299) - 1, limit: FEED_PAGE, "#m": ["place"] });
    // The focus goes to the first review the page brought.
    await waitFor(() => expect(entryLinks()[3]).toHaveFocus());
    // That page was not full: every review there is has been read.
    expect(await screen.findByText(copy.recent.end)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.recent.showOlder })).not.toBeInTheDocument();
    expect(feedReads(net)).toHaveLength(4);
  });

  it("stops reading by itself once 20 count", async () => {
    // 250 reviews; the house trusts the people who wrote the newest 25.
    const reviews = Array.from({ length: 250 }, (_, i) => reviewOf(stranger(i), JACAFE, 4, `Review ${i}.`, at(i)));
    const net = network({ reviews, house: Array.from({ length: 25 }, (_, i) => houseRank(stranger(i), 72.5)) });
    await openRecent(net);
    await waitFor(() => expect(listed()).toHaveLength(25));
    expect(feedReads(net)).toHaveLength(1);
    expect(screen.getByRole("button", { name: copy.recent.showOlder })).toBeInTheDocument();
  });

  it("says when older reviews could not be read, and reads them again from Show older reviews", async () => {
    const net = network({ reviews: longFeed() });
    const user = userEvent.setup();
    await openRecent(net);
    await waitFor(() => expect(listed()).toHaveLength(3));
    net.searchDown = true;
    await user.click(screen.getByRole("button", { name: copy.recent.showOlder }));
    expect(await screen.findByText(copy.recent.olderFailed)).toBeInTheDocument();
    expect(screen.getByText(copy.recent.olderFailed).closest('[role="status"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: copy.recent.showOlder })).toHaveFocus();

    net.searchDown = false;
    await user.click(screen.getByRole("button", { name: copy.recent.showOlder }));
    await waitFor(() => expect(listed()).toHaveLength(4));
    expect(screen.queryByText(copy.recent.olderFailed)).not.toBeInTheDocument();
  });
});

describe("Recent: read states", () => {
  it("says politely that it is reading, until the reviews come", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR)] });
    net.holdFeed = true;
    await openRecent(net);
    expect(await saidPolitely(copy.recent.loading)).not.toBeNull();
    expect(listed()).toEqual([]);
    net.release();
    await listsExactly([ALICE_AT_JACAFE]);
  });

  it("says politely that the reviews couldn't be loaded, and Try again reads them again", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR)] });
    net.searchDown = true;
    const user = userEvent.setup();
    await openRecent(net);
    expect(await saidPolitely(copy.recent.failed)).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listed()).toEqual([]);

    net.searchDown = false;
    await user.click(screen.getByRole("button", { name: copy.load.retry }));
    await listsExactly([ALICE_AT_JACAFE]);
    expect(feedReads(net)).toHaveLength(2);
  });

  it("says when nobody the house trusts has reviewed a place, once every review is read", async () => {
    const net = network({ reviews: [reviewOf(CAROL, MUSEU, 2, "Too sweet.", NOW_S - HOUR), reviewOf(DAVE, NOVO, 3, "Fine.", NOW_S - 2 * HOUR)] });
    await openRecent(net);
    expect(await screen.findByText(copy.recent.emptyHouse)).toBeInTheDocument();
    expect(copy.recent.emptyHouse).toBe("No reviews from the reviewers the house trusts yet.");
    expect(screen.queryByRole("list", { name: copy.pages.recent })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.recent.toHouse })).not.toBeInTheDocument();
    // Its own words say there is nothing more: no end line under it, and nothing older to read.
    expect(screen.queryByText(copy.recent.end)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.recent.showOlder })).not.toBeInTheDocument();
  });

  it("says when nobody in the circle has reviewed a place, with one tap to House picks", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR)] });
    const me = signedIn(net);
    keptCircle(me);
    window.sessionStorage.setItem(VIEW_STORAGE_KEY, "circle");
    const user = userEvent.setup();
    await openRecent(net);
    expect(await screen.findByText(copy.recent.emptyCircle)).toBeInTheDocument();
    expect(copy.recent.emptyCircle).toBe("Nobody in your circle has reviewed a place yet.");

    await user.click(screen.getByRole("button", { name: copy.recent.toHouse }));
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    await listsExactly([ALICE_AT_JACAFE]);
  });
});

describe("Recent: the person's own review, and coming back", () => {
  it("puts a review the person posts this session at the top, without reading again", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR)] });
    const me = signedIn(net);
    net.house.push(houseRank(me, 72.5));
    // The review relay takes it, and does not send it back yet: it lags.
    const writer: MemoryWriter = createMemoryWriter();
    const user = userEvent.setup();
    const { router } = await openRecent(net, { writers: (url) => (url === SEARCH ? writer : createMemoryWriter({ refuse: "not in this test" })) });
    await listsExactly([ALICE_AT_JACAFE]);

    await user.click(entryLinks()[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(placePath(JACAFE)));
    await user.click((await screen.findAllByRole("link", { name: copy.place.rate }))[0]!);
    const stars = within(await screen.findByRole("radiogroup", { name: copy.review.howWasIt })).getAllByRole("radio");
    await user.click(stars[4]!);
    await user.type(screen.getByRole("textbox", { name: copy.review.textLabel }), "Pastéis still warm.");
    await user.click(screen.getByRole("button", { name: copy.review.post }));
    await waitFor(() => expect(router.state.location.pathname).toBe(placePath(JACAFE)));
    expect(writer.published).toHaveLength(1);

    await act(() => router.navigate("/recent"));
    await listsExactly(["Your review of Jacafé, now", ALICE_AT_JACAFE]);
    expect(within(entryLinks()[0]!).getByText("Pastéis still warm.")).toBeInTheDocument();
    expect(feedReads(net)).toHaveLength(1);
  });

  it("finds the list as it was on Back from a place, reading nothing; after two minutes it reads the newest and puts it on top", async () => {
    const net = network({
      reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR), reviewOf(BOB, MAIA, 5, "Fresh fish.", NOW_S - 25 * HOUR)],
    });
    const user = userEvent.setup();
    const { router } = await openRecent(net);
    await listsExactly([ALICE_AT_JACAFE, BOB_AT_MAIA]);

    await user.click(entryLinks()[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(placePath(MAIA)));
    await act(() => router.navigate(-1));
    // At once: the same list, nothing being read.
    expect(listed()).toEqual([ALICE_AT_JACAFE, BOB_AT_MAIA]);
    expect(screen.queryByText(copy.recent.loading)).not.toBeInTheDocument();
    expect(feedReads(net)).toHaveLength(1);

    // Another tab and back, within two minutes: nothing read.
    vi.setSystemTime((NOW_S + 60) * 1000);
    await act(() => router.navigate("/you"));
    await act(() => router.navigate("/recent"));
    expect(listed()).toHaveLength(2);
    expect(feedReads(net)).toHaveLength(1);

    // More than two minutes after the read: the newest page again. Erin's new review goes on top; Bob's,
    // removed meanwhile, the relay no longer sends.
    net.reviews.push(reviewOf(ERIN, NOVO, 5, "New on the list.", NOW_S + 60));
    net.reviews.splice(1, 1);
    vi.setSystemTime(NOW_S * 1000 + FEED_FRESH_MS + 1_000);
    await act(() => router.navigate("/you"));
    await act(() => router.navigate("/recent"));
    expect(listed()).toHaveLength(2);
    await listsExactly(["Erin's review of Novo Tahiti, 1 minute ago", "Alice Bento's review of Jacafé, 2 hours ago"]);
    expect(feedReads(net)).toHaveLength(2);
    expect(feedReads(net)[1]?.filter.until).toBeUndefined();
    expect(FEED_FRESH_MS).toBe(120_000);
  });

  it("keeps the list when the newest reviews couldn't be read again, says so politely, and Try again reads them", async () => {
    const net = network({ reviews: [reviewOf(ALICE, JACAFE, 4, "Get the bolo.", NOW_S - 2 * HOUR)] });
    const user = userEvent.setup();
    const { router } = await openRecent(net);
    await listsExactly([ALICE_AT_JACAFE]);

    net.searchDown = true;
    net.reviews.push(reviewOf(ERIN, NOVO, 5, "New on the list.", NOW_S + 60));
    vi.setSystemTime(NOW_S * 1000 + FEED_FRESH_MS + 1_000);
    await act(() => router.navigate("/you"));
    await act(() => router.navigate("/recent"));
    expect(await saidPolitely(copy.recent.newerFailed)).not.toBeNull();
    expect(listed()).toEqual([ALICE_AT_JACAFE]);

    net.searchDown = false;
    await user.click(screen.getByRole("button", { name: copy.load.retry }));
    await listsExactly(["Erin's review of Novo Tahiti, 1 minute ago", ALICE_AT_JACAFE]);
    expect(screen.queryByText(copy.recent.newerFailed)).not.toBeInTheDocument();
  });
});

describe("Recent: getting there", () => {
  it("is a tab on a phone, between Map and You, marked while it is open", async () => {
    const net = network();
    await openRecent(net);
    const tabs = within(tabBar()!).getAllByRole("link");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Explore", "Map", "Recent", "You"]);
    expect(tabs.map((tab) => tab.getAttribute("href"))).toEqual(["/", "/map", "/recent", "/you"]);
    const recent = within(tabBar()!).getByRole("link", { name: copy.nav.recent });
    expect(recent).toHaveAttribute("aria-current", "page");
    expect(recent.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    // The toggle is on the page, under the heading.
    expect(within(screen.getByRole("main")).getByRole("group", { name: copy.view.label })).toBeInTheDocument();
  });

  it("is a link in the desktop's top bar, with the account button and past the toggle, marked while its page is open", async () => {
    const net = network();
    const { router } = await openRecent(net, { px: DESKTOP });
    const bar = screen.getByRole("banner");
    const link = within(bar).getByRole("link", { name: copy.nav.recent });
    expect(link).toHaveAttribute("href", "/recent");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(within(bar).getByRole("group", { name: copy.view.label }).compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(within(bar).getByRole("link", { name: copy.nav.signIn })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The page has no toggle of its own: the top bar's is the one.
    expect(within(screen.getByRole("main")).queryByRole("group", { name: copy.view.label })).not.toBeInTheDocument();
    expect(tabBar()).not.toBeInTheDocument();

    await act(() => router.navigate("/"));
    expect(within(screen.getByRole("banner")).getByRole("link", { name: copy.nav.recent })).not.toHaveAttribute("aria-current");
  });

  it("takes a person who has not signed in from My circle to sign in", async () => {
    const net = network();
    const user = userEvent.setup();
    const { router } = await openRecent(net);
    await user.click(myCircle());
    expect(router.state.location.pathname).toBe("/signin");
  });

  it("opens the door to Personalize from My circle for a person signed in with no circle yet", async () => {
    const net = network();
    signedIn(net);
    const user = userEvent.setup();
    await openRecent(net);
    const half = await within(toggle()).findByRole("button", { name: copy.view.circle, expanded: false });
    await user.click(half);
    expect(await screen.findByRole("button", { name: copy.circle.personalize })).toHaveFocus();
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
  });
});

describe("the scores store, for Recent", () => {
  it("says whether a person counts in a view, yes or no, and nothing before their rank is read", async () => {
    const net = network();
    const store = new ScoresStore(net.readers);
    store.start();
    const OWNER = hex64("1");
    store.setCircle({ owner: OWNER, scorer: CIRCLE_AT });
    expect(store.countsIn(ALICE, "house")).toBeUndefined();
    store.wantRanks([ALICE, CAROL, DAVE, OWNER]);
    await vi.waitFor(() => expect(store.countsIn(DAVE, "house")).toBe(false));
    expect(store.countsIn(ALICE, "house")).toBe(true);
    expect(store.countsIn(CAROL, "house")).toBe(false);
    await vi.waitFor(() => expect(store.countsIn(CAROL, "circle")).toBe(true));
    expect(store.countsIn(ALICE, "circle")).toBe(false);
    // The person whose circle it is counts in it, and is never asked about.
    expect(store.countsIn(OWNER, "circle")).toBe(true);
    const asked = net.log.filter(({ filter }) => filter.kinds?.includes(30382) && filter["#d"] !== undefined);
    expect(asked.filter(({ filter }) => filter.authors?.includes(CIRCLE_SCORER)).flatMap(({ filter }) => filter["#d"])).not.toContain(OWNER);

    // Asked again, nobody is read again.
    const reads = net.log.length;
    store.wantRanks([ALICE, CAROL]);
    expect(net.log).toHaveLength(reads);
    store.stop();
  });

  it("gives a page's reviews with the person's own held ones, less those they removed", () => {
    const store = new ScoresStore(network().readers);
    const me = hex64("1");
    const mine = reviewOf(me, JACAFE, 4, "Mine.", NOW_S - 10);
    const theirs = reviewOf(ALICE, MAIA, 5, "Theirs.", NOW_S - 20);
    const removed = reviewOf(me, MAIA, 2, "Gone.", NOW_S - 30);
    store.noteOwnReview(mine);
    store.noteRemoval(`${REVIEW_KIND}:${me}:place:${MAIA.address}`, NOW_S - 5);
    expect(store.withOwn([theirs, removed], me).map((ev) => ev.id)).toEqual([theirs.id, mine.id]);
    expect(store.withOwn([theirs], undefined).map((ev) => ev.id)).toEqual([theirs.id]);
  });
});

describe("the feed", () => {
  it("starts again from the newest page when it no longer reaches the reviews it holds", async () => {
    const old = Array.from({ length: 50 }, (_, i) => reviewOf(stranger(i), JACAFE, 4, `Old ${i}.`, NOW_S - 60 * (i + 1)));
    const net = network({ reviews: old });
    const feed = new RecentFeed(net.readers);
    feed.start();
    feed.open();
    await vi.waitFor(() => expect(feed.snapshot().first).toBe("read"));
    expect(feed.snapshot()).toMatchObject({ pages: 1, end: true });
    expect(feed.snapshot().events).toHaveLength(50);

    // 150 new reviews since: the newest page of 100 does not reach back to the old ones.
    const fresh = Array.from({ length: 150 }, (_, i) => reviewOf(stranger(500 + i), JACAFE, 4, `New ${i}.`, NOW_S + 60 * (i + 1)));
    net.reviews.push(...fresh);
    vi.setSystemTime(NOW_S * 1000 + FEED_FRESH_MS + 1_000);
    feed.open();
    await vi.waitFor(() => expect(feed.snapshot().newer).toBe("idle"));
    await vi.waitFor(() => expect(feed.snapshot().events).toHaveLength(FEED_PAGE));
    expect(feed.snapshot()).toMatchObject({ pages: 1, end: false });
    expect(Math.min(...feed.snapshot().events.map((ev) => ev.created_at))).toBe(NOW_S + 60 * 51);

    // Show older reads on from there: the rest of the new ones, and the old.
    await feed.readOlder();
    expect(feed.snapshot().events).toHaveLength(200);
    expect(feed.snapshot()).toMatchObject({ pages: 2, end: false });
    feed.stop();
  });
});
