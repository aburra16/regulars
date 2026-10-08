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
import type { RelayReader } from "../src/nostr/events";
import { buildIndexes, chainSlug } from "../src/places/indexes";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { REVIEW_KIND } from "../src/reviews/review";
import { shownScore } from "../src/score/shown";
import { FLUSH_WINDOW_MS, ScoresStore } from "../src/score/store";
import { VIEW_STORAGE_KEY } from "../src/view/ViewProvider";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";

/*
 * My circle's scores (M3 Task 3): the same reviews, scored from the person's circle, beside House
 * picks'. The scores store keeps each view's ranks, so the toggle asks for nothing (Review Focus 5).
 * Brainstorm's client is mocked: its one call here is the returning visitor's look, which finds the
 * person's scorer. Reviews, the house's ranks and the circle's ranks are read from relays in memory;
 * nothing opens a socket or reaches the network (tests/setup.ts).
 */

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

const places: NostrEvent[] = raw;
const idx = buildIndexes(parsePlaces(places));

const placeAt = (d: string): Place => {
  const found = idx.byD.get(d);
  if (found === undefined) throw new Error(`No fixture place has d ${d}`);
  return found;
};

const JACAFE = placeAt("osm-node-11330857543");
const MAIA = placeAt("osm-node-10169374926");
/** Four A Confeitaria Coffee & Bakery, all in Funchal. */
const CONFEITARIA = idx.chains.get("PT:a confeitaria coffee & bakery")!;

/** Brainstorm's search relay, which keeps the reviews and the reviewers' names. */
const SEARCH = "wss://search.brainstorm.world";
/** Where the house's kind 10040 is read, and where Brainstorm's scorers publish each person's circle. */
const SCORES = "wss://scores.brainstorm.world";
/** The house's scorer and its relay, made up: the real one is never written into the app or its tests. */
const HOUSE_SCORER = hex64("5");
const HOUSE_RELAY = "wss://ranks.example.test";
/** The person's own scorer, which Brainstorm made for them: made up. */
const CIRCLE_SCORER = hex64("6");
const CIRCLE_AT = { pubkey: CIRCLE_SCORER, relay: SCORES };

const [ALICE, BOB, CAROL, DAVE, ERIN] = ["a", "b", "c", "d", "e"].map(hex64) as [string, string, string, string, string];

/** The house's kind 10040, naming its scorer. */
const trustList = () => shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", HOUSE_SCORER, HOUSE_RELAY]] });

/** A kind 30382 by `scorer` giving `subject` the rank `rank`. */
const rankBy = (scorer: string) => (subject: string, rank: number) =>
  shapedEvent({ kind: 30382, pubkey: scorer, tags: [["d", subject], ["rank", String(rank)]] });
const houseRank = rankBy(HOUSE_SCORER);
const circleRank = rankBy(CIRCLE_SCORER);

/** `reviewer`'s review of `place`, as the app writes them; `stars` null for one with none. */
const reviewOf = (reviewer: string, place: Place, stars: number | null, text = "") =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    content: text,
    tags: [
      ["d", `place:${place.address}`],
      ["a", place.address],
      ["m", "place"],
      ...(stars === null ? [] : [["s", String(stars)]]),
    ],
  });

const profileOf = (pubkey: string, name: string) => shapedEvent({ kind: 0, pubkey, content: JSON.stringify({ name }) });
const PROFILES = [profileOf(ALICE, "Alice Bento"), profileOf(BOB, "Bob"), profileOf(CAROL, "Carol"), profileOf(DAVE, "Dave")];

/**
 * Jacafé, rated by Alice (5), Bob (4) and Carol (2). The house trusts Alice (80) and Bob (60), not
 * Carol (4): 4.6 from 2 people. The circle has Bob (90) and Carol (50), not Alice (3): 3.3 from 2.
 */
const jacafeReviews = () => [
  reviewOf(ALICE, JACAFE, 5, "Get the bolo."),
  reviewOf(BOB, JACAFE, 4, "Busy at noon."),
  reviewOf(CAROL, JACAFE, 2, "Too sweet."),
];
const HOUSE_RANKS = [houseRank(ALICE, 80), houseRank(BOB, 60), houseRank(CAROL, 4)];
const CIRCLE_RANKS = [circleRank(BOB, 90), circleRank(CAROL, 50), circleRank(ALICE, 3)];

/** What the relays hold, and every request made of them, in order. */
interface Network {
  readers: (url: string) => RelayReader;
  log: { url: string; filter: NostrFilter }[];
  /** While true, the circle's relay fails every read of ranks (the look that finds the scorer still answers). */
  circleDown: boolean;
}

function network({
  reviews = [],
  house = [],
  circle = [],
}: {
  reviews?: NostrEvent[];
  house?: NostrEvent[];
  circle?: NostrEvent[];
} = {}): Network {
  const relays: Record<string, RelayReader> = {
    [SEARCH]: createMemoryReader([...reviews, ...PROFILES]),
    [SCORES]: createMemoryReader([trustList(), ...circle]),
    [HOUSE_RELAY]: createMemoryReader(house),
  };
  const net: Network = {
    log: [],
    circleDown: false,
    readers: (url) => ({
      async *req(filter, signal) {
        net.log.push({ url, filter });
        if (net.circleDown && url === SCORES && filter["#d"] !== undefined) throw new Error("The relay answered 503");
        yield* (relays[url] ?? createMemoryReader([])).req(filter, signal);
      },
    }),
  };
  return net;
}

/** The reads of the circle's ranks for reviewers: by its scorer, naming people. */
const circleRankReads = (net: Network) =>
  net.log.filter(({ url, filter }) => url === SCORES && filter.authors?.includes(CIRCLE_SCORER) && filter["#d"] !== undefined);

/** Signs a person in to the tab with a browser add-on, as a reload of a signed-in tab finds them. */
function signedIn(): string {
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
  return pubkey;
}

/**
 * Earlier in this session, the circle of the person with `pubkey` was ready, and they chose My circle:
 * a reload of the tab finds both, and asks Brainstorm nothing.
 */
function choseMyCircle(pubkey: string): void {
  window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "ready", scorer: CIRCLE_AT, notice: false }));
  window.sessionStorage.setItem(VIEW_STORAGE_KEY, "circle");
}

const toggle = () => screen.getByRole("group", { name: copy.view.label });
const housePicks = () => within(toggle()).getByRole("button", { name: /^House picks/ });
const myCircle = () => within(toggle()).getByRole("button", { name: /^My circle/ });
const card = (name: string) => screen.getByRole("link", { name });
const placePath = (place: Place) => `/place/${encodeURIComponent(place.d)}`;

/** Lets what is queued run: effects, the store's window for gathering asks, and reads that answer at once. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, FLUSH_WINDOW_MS + 10)));
  for (let i = 0; i < 5; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** The look that found the person's scorer: one rank by it, any, asked of its relay. */
const circleLooks = (net: Network) =>
  net.log.filter(({ url, filter }) => url === SCORES && filter.authors?.includes(CIRCLE_SCORER) && filter["#d"] === undefined);

/**
 * The app at `path`, for the person signed in, once their circle is ready: as the tab kept it, or
 * once the returning visitor's look has found their scorer, and its relay answered.
 */
async function openReady(net: Network, path = "/", px?: number) {
  const kept = window.sessionStorage.getItem(CIRCLE_KEY) !== null;
  const opened = await openApp(path, { events: places, readers: net.readers, ...(px === undefined ? {} : { px }) });
  if (!kept) await waitFor(() => expect(circleLooks(net).length).toBeGreaterThan(0));
  await settle();
  return opened;
}

/** Waits until the circle's scorer has been asked about the reviewers, and has answered. */
async function circleRanksIn(net: Network): Promise<void> {
  await waitFor(() => expect(circleRankReads(net).length).toBeGreaterThan(0));
  await settle();
}

beforeEach(() => {
  config.features.circle = true;
  config.reviewRelays = [SEARCH];
  brainstorm.scorerOf.mockReset().mockResolvedValue(CIRCLE_AT);
  for (const call of [brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) call.mockReset();
});

afterEach(() => {
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
  // Only the returning visitor's look: no sign-in to Brainstorm, no run.
  for (const call of [brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) expect(call).not.toHaveBeenCalled();
});

describe("the scores store: ranks per point of view", () => {
  const OWNER = hex64("f");

  /** A store reading `net`, started, with the places in, and the circle of `OWNER` when `circle`. */
  function storeOf(net: Network, { circle = true } = {}) {
    const store = new ScoresStore(net.readers);
    store.start();
    store.setPlaces(parsePlaces(places));
    if (circle) store.setCircle({ owner: OWNER, scorer: CIRCLE_AT });
    return store;
  }

  it("scores the same reviews from each view, the house's ranks and the circle's", async () => {
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const store = storeOf(net);
    store.want([JACAFE.address]);
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "circle")).toBeDefined());
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "house")).toBeDefined());

    const house = store.scoreOf(JACAFE.address, "house")!;
    const circle = store.scoreOf(JACAFE.address, "circle")!;
    expect(house.score).toBeCloseTo((0.8 * 5 + 0.6 * 4) / 1.4);
    expect(house.inside.map((review) => review.reviewer).sort()).toEqual([ALICE, BOB]);
    expect(circle.score).toBeCloseTo((0.9 * 4 + 0.5 * 2) / 1.4);
    expect(circle.inside.map((review) => review.reviewer).sort()).toEqual([BOB, CAROL]);
    expect(circle.folded.map((review) => review.reviewer)).toEqual([ALICE]);
    // The house's view is what a page gets when it names none.
    expect(store.scoreOf(JACAFE.address)).toBe(house);
    // The reviews are the same for both.
    expect(store.reviewsOf(JACAFE.address)).toHaveLength(3);
    expect(store.stateOf("house")).toBe("ready");
    expect(store.stateOf("circle")).toBe("ready");
    store.stop();
  });

  it("keeps each view's place score, and what it shows, the same object while what it is made of is the same", async () => {
    const net = network({ reviews: [...jacafeReviews(), reviewOf(DAVE, MAIA, 3)], house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const store = storeOf(net);
    store.want([JACAFE.address]);
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "circle")).toBeDefined());
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "house")).toBeDefined());
    const house = store.scoreOf(JACAFE.address, "house")!;
    const circle = store.scoreOf(JACAFE.address, "circle")!;
    const shownHouse = shownScore(house, true, "ready", "read", "house");
    const shownCircle = shownScore(circle, true, "ready", "read", "circle");
    expect(shownHouse).toMatchObject({ kind: "scored", counted: 2 });
    expect(shownHouse).not.toHaveProperty("circle");
    expect(shownCircle).toMatchObject({ kind: "scored", counted: 2, circle: true });

    // Another place's reviews, and a new reviewer for both views to rank: Jacafé's scores stay as they were.
    const version = store.scoresVersion();
    store.want([MAIA.address]);
    await vi.waitFor(() => expect(store.scoreOf(MAIA.address, "circle")).toBeDefined());
    expect(store.scoresVersion()).not.toBe(version);
    expect(store.scoreOf(JACAFE.address, "house")).toBe(house);
    expect(store.scoreOf(JACAFE.address, "circle")).toBe(circle);
    expect(shownScore(store.scoreOf(JACAFE.address, "house"), true, "ready", "read", "house")).toBe(shownHouse);
    expect(shownScore(store.scoreOf(JACAFE.address, "circle"), true, "ready", "read", "circle")).toBe(shownCircle);
    store.stop();
  });

  it("asks the circle's scorer about the reviewers seen before it was ready, then only about new ones, and never about the person", async () => {
    const net = network({
      reviews: [...jacafeReviews(), reviewOf(OWNER, JACAFE, 4), reviewOf(DAVE, MAIA, 3)],
      house: HOUSE_RANKS,
      circle: CIRCLE_RANKS,
    });
    const store = storeOf(net, { circle: false });
    store.want([JACAFE.address]);
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "house")).toBeDefined());
    expect(circleRankReads(net)).toEqual([]);
    // Without a circle, My circle has no score to give.
    expect(store.scoreOf(JACAFE.address, "circle")).toBeUndefined();

    store.setCircle({ owner: OWNER, scorer: CIRCLE_AT });
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "circle")).toBeDefined());
    expect(circleRankReads(net).map(({ filter }) => [...filter["#d"]!].sort())).toEqual([[ALICE, BOB, CAROL]]);
    expect(circleRankReads(net)[0]!.filter).toMatchObject({ kinds: [30382], authors: [CIRCLE_SCORER] });

    store.want([MAIA.address]);
    await vi.waitFor(() => expect(store.scoreOf(MAIA.address, "circle")).toBeDefined());
    expect(circleRankReads(net).map(({ filter }) => filter["#d"])).toEqual([expect.any(Array), [DAVE]]);
    expect(circleRankReads(net).flatMap(({ filter }) => filter["#d"])).not.toContain(OWNER);
    store.stop();
  });

  it("counts the person's own review at full weight in My circle, and in House picks only as the house ranks them", async () => {
    const net = network({ reviews: [reviewOf(OWNER, MAIA, 5), reviewOf(DAVE, MAIA, 3)], house: [houseRank(DAVE, 70)], circle: [circleRank(DAVE, 50)] });
    const store = storeOf(net);
    store.want([MAIA.address]);
    await vi.waitFor(() => expect(store.scoreOf(MAIA.address, "circle")).toBeDefined());
    await vi.waitFor(() => expect(store.scoreOf(MAIA.address, "house")).toBeDefined());
    expect(store.scoreOf(MAIA.address, "circle")).toMatchObject({ score: expect.closeTo((1 * 5 + 0.5 * 3) / 1.5), counted: 2 });
    expect(store.scoreOf(MAIA.address, "house")).toMatchObject({ score: expect.closeTo(3), counted: 1, outside: 1 });
    store.stop();
  });

  it("lets go of the circle's ranks when the circle goes, or is another person's", async () => {
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const store = storeOf(net);
    store.want([JACAFE.address]);
    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address, "circle")).toBeDefined());
    store.setCircle(undefined);
    expect(store.scoreOf(JACAFE.address, "circle")).toBeUndefined();
    expect(store.stateOf("circle")).toBe("idle");
    // The house's view is untouched.
    expect(store.scoreOf(JACAFE.address, "house")?.counted).toBe(2);
    store.stop();
  });

  it("is ready but empty when nobody but the person is in the circle among the reviewers seen", async () => {
    const net = network({
      reviews: [...jacafeReviews(), reviewOf(OWNER, MAIA, 5)],
      house: HOUSE_RANKS,
      // Ranks under the line, and one for someone who has reviewed nothing here.
      circle: [circleRank(ALICE, 3), circleRank(BOB, 4), circleRank(ERIN, 90)],
    });
    const store = storeOf(net);
    expect(store.circleEmpty()).toBe(false);
    store.want([JACAFE.address, MAIA.address]);
    await vi.waitFor(() => expect(store.circleEmpty()).toBe(true));
    // Their own review still counts, at full weight.
    expect(store.scoreOf(MAIA.address, "circle")).toMatchObject({ score: 5, counted: 1 });
    expect(store.scoreOf(JACAFE.address, "circle")).toMatchObject({ score: null, counted: 0, outside: 3 });
    store.stop();
  });
});

describe("toggling the view (Review Focus 5)", () => {
  it("shows the same place with each view's score on Explore, at once, asking for nothing", async () => {
    signedIn();
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const user = userEvent.setup();
    await openReady(net);
    await waitFor(() => expect(card("Jacafé")).toHaveAccessibleDescription(/4\.6 out of 5 Rated by 2 people the house trusts$/));
    await circleRanksIn(net);
    const asked = net.log.length;

    await user.click(myCircle());
    // At once, from the reviews and the ranks already read.
    expect(card("Jacafé")).toHaveAccessibleDescription(/3\.3 out of 5 Rated by 2 people in your circle$/);
    await user.click(housePicks());
    expect(card("Jacafé")).toHaveAccessibleDescription(/4\.6 out of 5 Rated by 2 people the house trusts$/);
    await user.click(myCircle());
    expect(card("Jacafé")).toHaveAccessibleDescription(/3\.3 out of 5 Rated by 2 people in your circle$/);

    // No review, rank or name was read for any of it.
    await settle();
    expect(net.log.length).toBe(asked);
  });

  it("words the place page for the view, from the top bar's toggle, asking for nothing", async () => {
    signedIn();
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const user = userEvent.setup();
    await openReady(net, placePath(JACAFE), DESKTOP);
    expect(await screen.findByText(copy.score.fromHouse(2))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.reviews.heading })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.reviews.foldedMore(1) })).toBeInTheDocument();
    expect(await screen.findByText("Alice Bento")).toBeInTheDocument();
    await circleRanksIn(net);
    const asked = net.log.length;

    await user.click(myCircle());
    expect(screen.getByText(copy.score.fromCircle(2))).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "3.3 out of 5" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.reviews.headingCircle })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.reviews.foldedMoreCircle(1) })).toBeInTheDocument();
    expect(screen.getByText(copy.reviews.foldedNote)).toBeInTheDocument();
    // Alice is outside the circle: folded away, until asked for. Carol is inside it.
    expect(screen.queryByText("Alice Bento")).toBeNull();
    expect(screen.getByText("Carol")).toBeInTheDocument();
    expect(screen.queryByText(copy.score.fromHouse(2))).toBeNull();

    await settle();
    expect(net.log.length).toBe(asked);
  });
});

describe("the person's own review", () => {
  it("counts at full weight in My circle, and in House picks only as the house ranks them", async () => {
    const me = signedIn();
    const net = network({ reviews: [reviewOf(me, MAIA, 5), reviewOf(DAVE, MAIA, 3)], house: [houseRank(DAVE, 70)], circle: [circleRank(DAVE, 50)] });
    const user = userEvent.setup();
    await openReady(net);
    await waitFor(() => expect(card("Maia")).toHaveAccessibleDescription(/ 3 out of 5 Rated by 1 person the house trusts$/));
    await circleRanksIn(net);
    await user.click(myCircle());
    // (1 × 5 + 0.5 × 3) / 1.5.
    expect(card("Maia")).toHaveAccessibleDescription(/4\.3 out of 5 Rated by 2 people in your circle$/);
  });
});

describe("the wording follows the view", () => {
  it("has the circle's words, in plain language (DRAFT)", () => {
    expect(copy.score.ratedByCircle(3)).toBe("Rated by 3 people in your circle");
    expect(copy.score.ratedByCircle(1)).toBe("Rated by 1 person in your circle");
    expect(copy.score.fromCircle(3)).toBe("From 3 people in your circle");
    expect(copy.reviews.foldedMoreCircle(4)).toBe("4 more reviews from outside your circle");
    expect(copy.reviews.foldedMoreCircle(1)).toBe("1 more review from outside your circle");
    expect(copy.reviews.foldedAllCircle(4)).toBe("4 reviews from outside your circle");
    expect(copy.reviews.foldedNote).toBe("Shown on request, never removed.");
    expect(copy.filters.sort.circleScore).toBe("My circle's score");
    expect(copy.deskExplore.sort.circleScore).toBe("Sort: My circle's score");
    expect(copy.search.sortedBy.circleScore).toBe("Best in My circle first");
    expect(copy.explore.circleLine).toBe("Scores from your circle: the people you trust, and the people they trust.");
    expect(copy.explore.circleEmpty).toBe("Nobody in your circle has rated places here yet. House picks still has scores for you.");
    expect(copy.score.outsideCircle(1)).toBe("1 person outside your circle has rated it");
    expect(copy.score.outsideCircle(2)).toBe("2 people outside your circle have rated it");
    expect(copy.score.noneInCircle).toBe("Nobody in your circle has rated it yet");
    expect(copy.score.circleUnavailable).toBe("My circle can't be worked out right now.");
  });

  it("says whose scores the list shows under the toggle, with How this works", async () => {
    signedIn();
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const user = userEvent.setup();
    await openReady(net);
    const line = () => screen.getByRole("link", { name: copy.explore.howThisWorks }).parentElement!;
    expect(line()).toHaveTextContent(`${copy.explore.houseLine} ${copy.explore.howThisWorks}`);
    await user.click(myCircle());
    expect(line()).toHaveTextContent(`${copy.explore.circleLine} ${copy.explore.howThisWorks}`);
    expect(line()).not.toHaveTextContent(copy.house.name);
  });

  it("names the circle in the line of a place nobody in it has rated, on its card and its page", async () => {
    choseMyCircle(signedIn());
    const net = network({ reviews: [...jacafeReviews(), reviewOf(ALICE, MAIA, 2)], house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const { router } = await openReady(net);
    await waitFor(() => expect(card("Maia")).toHaveTextContent(copy.score.outsideCircle(1)));
    expect(card("Maia")).toHaveTextContent(copy.score.noScoreYet);

    await act(() => router.navigate(placePath(MAIA)));
    const panel = (await screen.findByRole("heading", { name: copy.score.noScoreYet })).closest("section")!;
    expect(panel).toHaveTextContent(copy.common.sentence(copy.score.noneInCircle));
    expect(panel).toHaveTextContent(copy.common.sentence(copy.score.othersRated(1)));
    expect(screen.getByRole("heading", { name: copy.reviews.foldedAllCircle(1) })).toBeInTheDocument();
  });

  it("names the sort by score for the view: on the filters page, the desktop's menu and the search's line", async () => {
    choseMyCircle(signedIn());
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const filters = await openReady(net, "/filters");
    const sort = screen.getByRole("group", { name: copy.filters.sortBy });
    expect(within(sort).getAllByRole("button").map((button) => button.textContent)).toEqual(["My circle's score", "Distance", "Name"]);
    filters.unmount();

    const desk = await openReady(net, "/?sort=score", DESKTOP);
    expect(screen.getByRole("button", { name: copy.deskExplore.sort.circleScore })).toBeInTheDocument();
    desk.unmount();

    await openReady(net, "/search?q=cafe&sort=score");
    expect(await screen.findByText(copy.search.sortedBy.circleScore, { exact: false })).toBeInTheDocument();
  });

  it("puts the best by My circle first when the list is sorted by score", async () => {
    choseMyCircle(signedIn());
    // Carol's five stars count in My circle only: Maia leads there, and has no score in House picks.
    const net = network({ reviews: [...jacafeReviews(), reviewOf(CAROL, MAIA, 5)], house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    const user = userEvent.setup();
    await openReady(net, "/?sort=score", DESKTOP);
    const firstTwo = () =>
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href")?.startsWith("/place/"))
        .slice(0, 2)
        .map((link) => link.getAttribute("href"));
    await waitFor(() => expect(firstTwo()).toEqual([placePath(MAIA), placePath(JACAFE)]));
    await user.click(housePicks());
    expect(firstTwo()[0]).toBe(placePath(JACAFE));
  });

  it("says the chain's range from the circle", async () => {
    choseMyCircle(signedIn());
    const location = CONFEITARIA.places[0]!;
    const net = network({ reviews: [reviewOf(BOB, location, 4)], house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    await openReady(net, `/chain/${chainSlug(CONFEITARIA)}`);
    expect(await screen.findByText(copy.chain.circleOne("4.0"), { exact: false })).toBeInTheDocument();
    expect(copy.chain.circleOne("4.0")).toBe("Near you, your circle rates one 4.0.");
    expect(copy.chain.circleRange("3.0", "4.5")).toBe("Near you, your circle rates them from 3.0 to 4.5.");
  });
});

describe("a circle with nobody in it yet (brief § 6, ruling R7)", () => {
  it("is ready, not offered Personalize again, when the scorer has no ranks at all; it says so plainly, and House picks is a tap away", async () => {
    signedIn();
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: [] });
    const user = userEvent.setup();
    await openReady(net);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    await circleRanksIn(net);
    // The view stays where the person put it, and on House picks nothing is said about the circle.
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(copy.explore.circleEmpty)).toBeNull();

    await user.click(myCircle());
    expect(screen.getByText(copy.explore.circleEmpty)).toBeInTheDocument();
    expect(card("Jacafé")).toHaveTextContent(copy.score.outsideCircle(3));
    expect(housePicks()).toBeEnabled();
    await settle();
    // Never switched for them.
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");

    await user.click(housePicks());
    expect(card("Jacafé")).toHaveTextContent("4.6");
    expect(screen.queryByText(copy.explore.circleEmpty)).toBeNull();
  });

  it("says so when the circle's ranks are all under the line among the reviewers seen, whatever the person rated", async () => {
    const me = signedIn();
    choseMyCircle(me);
    const net = network({
      reviews: [...jacafeReviews(), reviewOf(me, MAIA, 5)],
      house: HOUSE_RANKS,
      circle: [circleRank(ALICE, 3), circleRank(BOB, 4), circleRank(ERIN, 90)],
    });
    await openReady(net);
    expect(await screen.findByText(copy.explore.circleEmpty)).toBeInTheDocument();
    // Their own review counts.
    expect(card("Maia")).toHaveAccessibleDescription(/ 5 out of 5 Rated by 1 person in your circle$/);
  });

  it("is said in the list's column on a desktop, under the top bar's toggle", async () => {
    choseMyCircle(signedIn());
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: [] });
    await openReady(net, "/", DESKTOP);
    const line = await screen.findByText(copy.explore.circleEmpty);
    const column = screen.getByRole("heading", { level: 1, name: copy.pages.explore }).closest("section");
    expect(column).toContainElement(line);
  });

  it("is said under the toggle on the phone's map", async () => {
    choseMyCircle(signedIn());
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: [] });
    await openReady(net, "/map");
    expect(await screen.findByText(copy.explore.circleEmpty)).toBeInTheDocument();
  });

  it("says nothing when someone in the circle has rated places here", async () => {
    choseMyCircle(signedIn());
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    await openReady(net);
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("3.3"));
    await settle();
    expect(screen.queryByText(copy.explore.circleEmpty)).toBeNull();
  });
});

describe("when the circle's ranks can't be read", () => {
  it("says My circle can't be worked out, with Try again, folds every review, and House picks keeps working", async () => {
    signedIn();
    const net = network({ reviews: jacafeReviews(), house: HOUSE_RANKS, circle: CIRCLE_RANKS });
    net.circleDown = true;
    const user = userEvent.setup();
    await openReady(net);
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    await circleRanksIn(net);
    await user.click(myCircle());
    expect(await screen.findByText(copy.score.circleUnavailable)).toBeInTheDocument();
    expect(card("Jacafé")).toHaveTextContent(copy.score.peopleRated(3));
    expect(screen.queryByText(copy.score.houseUnavailable)).toBeNull();

    net.circleDown = false;
    await user.click(screen.getByRole("button", { name: copy.load.retry }));
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("3.3"));
    expect(screen.queryByText(copy.score.circleUnavailable)).toBeNull();

    await user.click(housePicks());
    expect(card("Jacafé")).toHaveTextContent("4.6");
  });
});

describe("no numbers about people, in either view (decision 19)", () => {
  /** Ranks easy to spot, from both scorers: none of them, nor their weights or roundings, is ever shown. */
  const NUMBERS = [87.37, 63.41, 4.38, 77.13, 58.29, 3.71];
  const reviews = () => [
    ...jacafeReviews(),
    reviewOf(ALICE, CONFEITARIA.places[0]!, 4),
    reviewOf(CAROL, CONFEITARIA.places[0]!, 3),
  ];
  const house = [houseRank(ALICE, 87.37), houseRank(BOB, 63.41), houseRank(CAROL, 4.38)];
  const circle = [circleRank(BOB, 77.13), circleRank(CAROL, 58.29), circleRank(ALICE, 3.71)];

  it.each(["house", "circle"] as const)("never shows one on the place page, its folded reviews open, in %s", async (view) => {
    const me = signedIn();
    if (view === "circle") choseMyCircle(me);
    const net = network({ reviews: reviews(), house, circle });
    const user = userEvent.setup();
    await openReady(net, placePath(JACAFE));
    await circleRanksIn(net);
    await screen.findByText(view === "circle" ? copy.score.fromCircle(2) : copy.score.fromHouse(2));
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));
    await screen.findByText(view === "circle" ? "Get the bolo." : "Too sweet.");
    expectNoNumbersAboutPeople(NUMBERS);
  });

  it.each([
    ["Explore's cards", "/", DESKTOP],
    ["the map's pins", "/map", undefined],
    ["a chain's rows", `/chain/${chainSlug(CONFEITARIA)}`, undefined],
  ])("never shows one in %s, in My circle", async (_, path, px) => {
    choseMyCircle(signedIn());
    const net = network({ reviews: reviews(), house, circle });
    await openReady(net, path, px);
    await circleRanksIn(net);
    if (path === "/map") await screen.findByRole("button", { name: /^Jacafé, .*rated by 2 people in your circle/ });
    else if (path === "/") await waitFor(() => expect(card("Jacafé")).toHaveTextContent(copy.score.ratedByCircle(2)));
    else await screen.findByText(copy.score.ratedByCircle(1));
    expectNoNumbersAboutPeople(NUMBERS);
  });
});
