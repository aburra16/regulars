import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { pinsFor, scorePins } from "../src/map/pins";
import * as distanceModule from "../src/places/distance";
import { distanceKm } from "../src/places/distance";
import * as hoursModule from "../src/places/hours";
import { openLine, openState } from "../src/places/hours";
import { buildIndexes, chainSlug, groupForList, type PlaceDistance } from "../src/places/indexes";
import { placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { REVIEW_KIND } from "../src/reviews/review";
import { whenWritten, writtenOn } from "../src/reviews/when";
import type { ShownScore } from "../src/score/shown";
import { ScoresStore } from "../src/score/store";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { FakeMap } from "./support/fakeMaplibre";
import { createMemoryReader, type MemoryReader } from "./support/memoryReader";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";

/*
 * House scores and reviews on screen (M2b Task 3): the cards, rows and pins of every list, the place
 * page's score panel and reviews, the chain's line, and the sort by House picks' score. The scores
 * store reads from memory readers; nothing opens a socket.
 */

const places: NostrEvent[] = raw;
const idx = buildIndexes(parsePlaces(places));
const FILER = places[0]!.pubkey;

const placeAt = (d: string): Place => {
  const found = idx.byD.get(d);
  if (found === undefined) throw new Error(`No fixture place has d ${d}`);
  return found;
};

const JACAFE = placeAt("osm-node-11330857543");
const MAIA = placeAt("osm-node-10169374926");
const MUSEU = placeAt("osm-node-1782789982");
/** Four A Confeitaria Coffee & Bakery, all in Funchal, nearest first from the middle of town. */
const CONFEITARIA = idx.chains.get("PT:a confeitaria coffee & bakery")!;

/** Brainstorm's search relay, which keeps the reviews and the reviewers' names. */
const SEARCH = "wss://search.brainstorm.world";
/** Where the house's kind 10040 is read. */
const TRUST = "wss://scores.brainstorm.world";
/** A made-up scorer and its relay: the house's real one is never written into the app or its tests. */
const SCORER = hex64("5");
const SCORER_RELAY = "wss://ranks.example.test";

const [ALICE, BOB, CAROL, DAVE] = ["a", "b", "c", "d"].map(hex64) as [string, string, string, string];

/** Wednesday 7 October 2026, 15:00 on the clock of Funchal. */
const AFTERNOON = new Date("2026-10-07T14:00:00Z");
const NOW_S = AFTERNOON.getTime() / 1000;
const DAY = 86_400;

/** The house's kind 10040, naming `SCORER` at `SCORER_RELAY`. */
const trustList = () =>
  shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", SCORER, SCORER_RELAY]] });

/** `SCORER`'s kind 30382 giving `subject` the rank `rank`. */
const rankOf = (subject: string, rank: number) =>
  shapedEvent({ kind: 30382, pubkey: SCORER, tags: [["d", subject], ["rank", String(rank)]] });

/** `reviewer`'s review of `place` with `stars` and `text`, written `daysAgo` days before the afternoon. */
const reviewOf = (reviewer: string, place: Place, stars: number, text = "", daysAgo = 14) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    created_at: NOW_S - daysAgo * DAY,
    content: text,
    tags: [
      ["d", `place:${place.address}`],
      ["a", place.address],
      ["m", "place"],
      ["s", String(stars)],
    ],
  });

/** `reviewer`'s review of `place` with words and no stars: no `s`, no `rating`. */
const starlessReviewOf = (reviewer: string, place: Place, text: string) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    created_at: NOW_S - 2 * DAY,
    content: text,
    tags: [
      ["d", `place:${place.address}`],
      ["a", place.address],
      ["m", "place"],
    ],
  });

/** A review relay that fails every read until it is brought up (`bringUp`), and then answers from `events`. */
function flakyReader(events: NostrEvent[]): MemoryReader & { bringUp(): void } {
  const memory = createMemoryReader(events);
  let up = false;
  return {
    requests: memory.requests,
    bringUp() {
      up = true;
    },
    async *req(filter, signal) {
      if (!up) throw new Error("The relay is down");
      yield* memory.req(filter, signal);
    },
  };
}

/** `pubkey`'s profile (kind 0), naming them `name`. */
const profileOf = (pubkey: string, name: string) =>
  shapedEvent({ kind: 0, pubkey, content: JSON.stringify({ name }) });

/** The names the reviewers go by. Dave has no profile at all. */
const PROFILES = [profileOf(ALICE, "Alice Bento"), profileOf(BOB, "Bob"), profileOf(CAROL, "Carol")];

/** A reader that answers nothing until it is opened. */
interface HeldReader extends MemoryReader {
  open(): void;
}

function heldReader(events: NostrEvent[]): HeldReader {
  const memory = createMemoryReader(events);
  // Each request as it comes, before it is held.
  const requests: NostrFilter[] = [];
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    requests,
    open,
    async *req(filter, signal) {
      requests.push(filter);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        void opened.then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      yield* memory.req(filter, signal);
    },
  };
}

/** A relay that fails every read. */
const downReader: RelayReader = {
  async *req() {
    throw new Error("This relay is down");
  },
};

/** The relays read that the test did not set up. Each test must read none (checked after it). */
const unexpectedReads: string[] = [];

/**
 * The house's relays: its 10040 on `TRUST`, `ranks` on `SCORER_RELAY`, and `reviews` with the
 * reviewers' profiles on `SEARCH`. `extra` takes the place of any of them.
 */
function houseNetwork(reviews: NostrEvent[], ranks: NostrEvent[], extra: Record<string, RelayReader> = {}) {
  const search = createMemoryReader([...reviews, ...PROFILES]);
  const relays: Record<string, RelayReader> = {
    [SEARCH]: search,
    [TRUST]: createMemoryReader([trustList()]),
    [SCORER_RELAY]: createMemoryReader(ranks),
    ...extra,
  };
  const readers = (url: string): RelayReader => {
    const reader = relays[url];
    if (reader !== undefined) return reader;
    unexpectedReads.push(url);
    return downReader;
  };
  return { search, readers };
}

/** Alice (rank 80) gives Jacafé 5 stars and Bob (rank 60) 4: 4.6 from the house's view. */
const jacafeScored = () => [reviewOf(ALICE, JACAFE, 5, "Get the bolo."), reviewOf(BOB, JACAFE, 4, "Busy at noon.", 3)];
const HOUSE_RANKS = [rankOf(ALICE, 80), rankOf(BOB, 60), rankOf(CAROL, 4), rankOf(DAVE, 70)];

// ---- Reading the page ----

/** A place's card or row, by the place's name. */
const card = (name: string) => screen.getByRole("link", { name });
/** The links to places, in the order the page lists them. */
const placeLinks = () => screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/place/"));
/** The address of the place a link opens. */
const addressOfLink = (link: HTMLElement) =>
  `39999:${FILER}:${decodeURIComponent(link.getAttribute("href")!.slice("/place/".length))}`;
const placePath = (place: Place) => `/place/${encodeURIComponent(place.d)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AFTERNOON);
  config.reviewRelays = [SEARCH];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidth();
  expect(unexpectedReads.splice(0)).toEqual([]);
});

// ---- Cards, rows and pins ----

describe("a place's card", () => {
  it("shows a scored place's score at the top right, and who it comes from under the hours", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    const link = card("Jacafé");
    // Beside the name, where the design puts the score (Main.dc.html), with the accent star.
    const top = within(link).getByText("Jacafé").parentElement!;
    expect(top).toHaveTextContent("4.6");
    // The star is for the eye: a screen reader hears the score in words.
    expect(top.querySelector("svg")!.closest("[aria-hidden='true']")).not.toBeNull();
    const who = within(link).getByText(copy.score.ratedByHouse(2));
    expect(who).toHaveClass("text-secondary", "font-semibold", "text-trust");
    expect(link).toHaveAccessibleDescription(/ 4\.6 out of 5 Rated by 2 people the house trusts$/);
    expect(link).not.toHaveTextContent(copy.score.noReviewsYet);
    expect(link).not.toHaveClass("border-dashed");

    expect(copy.score.ratedByHouse(2)).toBe("Rated by 2 people the house trusts");
    expect(copy.score.ratedByHouse(1)).toBe("Rated by 1 person the house trusts");
  });

  it("is dashed, with 'No rating yet', for a place only others have rated, in a list with a scored place", async () => {
    const { readers } = houseNetwork([...jacafeScored(), reviewOf(CAROL, MAIA, 2)], HOUSE_RANKS);
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Maia")).toHaveTextContent(copy.score.noScoreYet));
    const maia = card("Maia");
    expect(maia).toHaveClass("border-dashed", "border-line-dashed");
    expect(within(maia).getByText(copy.score.noScoreYet).parentElement).toBe(within(maia).getByText("Maia").parentElement);
    expect(within(maia).getByText(copy.score.othersRated(1))).toHaveClass("text-muted");
    expect(maia).not.toHaveTextContent(copy.score.noReviewsYet);

    // A place nobody has reviewed keeps M1's card in the same list.
    expect(card("Museu Café")).toHaveTextContent(copy.score.noReviewsYet);
    expect(card("Museu Café")).not.toHaveClass("border-dashed");

    expect(copy.score.othersRated(1)).toBe("1 other person has rated it");
    expect(copy.score.othersRated(2)).toBe("2 other people have rated it");
  });

  it("is not dashed for a place only others have rated when no place in the list has a score", async () => {
    const { readers } = houseNetwork([reviewOf(CAROL, MAIA, 2)], HOUSE_RANKS);
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Maia")).toHaveTextContent(copy.score.othersRated(1)));
    expect(card("Maia")).toHaveClass("border-line");
    expect(card("Maia")).not.toHaveClass("border-dashed");
    expect(card("Maia")).not.toHaveTextContent(copy.score.noReviewsYet);
  });

  it("says the reviews are being counted, never 'No reviews yet' nor dashed, while their reviewers are ranked", async () => {
    const scorer = heldReader(HOUSE_RANKS);
    const { readers } = houseNetwork([...jacafeScored(), reviewOf(CAROL, MAIA, 2)], [], { [SCORER_RELAY]: scorer });
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Jacafé")).toHaveTextContent(copy.score.counting));
    for (const name of ["Jacafé", "Maia"]) {
      const link = card(name);
      expect(within(link).getByText(copy.score.counting)).toHaveClass("text-muted");
      expect(link).not.toHaveTextContent(copy.score.noReviewsYet);
      expect(link).not.toHaveTextContent(copy.score.noScoreYet);
      expect(link).not.toHaveClass("border-dashed");
    }
    expect(card("Jacafé")).not.toHaveTextContent("4.6");
    expect(copy.score.counting).toBe("Loading reviews…");

    scorer.open();
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    expect(card("Maia")).toHaveClass("border-dashed");
  });
});

describe("a place's card while its reviews are read, and when they can't be", () => {
  it("has no line about reviews while they are being read, never 'No reviews yet', then the score", async () => {
    const search = heldReader([...jacafeScored(), ...PROFILES]);
    const { readers } = houseNetwork([], HOUSE_RANKS, { [SEARCH]: search });
    await openApp("/", { events: places, readers });
    await waitFor(() => expect(search.requests.length).toBeGreaterThan(0));

    for (const name of ["Jacafé", "Museu Café"]) {
      const link = card(name);
      expect(link).not.toHaveTextContent(copy.score.noReviewsYet);
      expect(link).not.toHaveTextContent(copy.score.counting);
      // What it is, how far, and its hours: nothing about reviews.
      expect(link.getAttribute("aria-describedby")!.split(" ")).toHaveLength(2);
    }

    search.open();
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    expect(card("Museu Café")).toHaveTextContent(copy.score.noReviewsYet);
  });

  it("says quietly that the reviews couldn't be loaded when no review relay answers", async () => {
    const search = flakyReader(jacafeScored());
    const { readers } = houseNetwork([], HOUSE_RANKS, { [SEARCH]: search });
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Jacafé")).toHaveTextContent(copy.score.failed));
    expect(within(card("Jacafé")).getByText(copy.score.failed)).toHaveClass("text-muted");
    expect(card("Jacafé")).not.toHaveTextContent(copy.score.noReviewsYet);
    expect(card("Museu Café")).toHaveTextContent(copy.score.failed);
    expect(copy.score.failed).toBe("Reviews couldn't be loaded");
  });

  it("says 'No rating yet' for reviews by people the house trusts that give no stars, and never leaves the line empty", async () => {
    const { readers } = houseNetwork([...jacafeScored(), starlessReviewOf(ALICE, MAIA, "Lovely terrace.")], HOUSE_RANKS);
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Maia")).toHaveTextContent(copy.score.starless(1)));
    expect(card("Maia")).toHaveTextContent(copy.score.noScoreYet);
    expect(card("Maia")).toHaveClass("border-dashed");
    expect(copy.score.starless(1)).toBe("1 person the house trusts wrote about it, no stars yet");
    expect(copy.score.starless(2)).toBe("2 people the house trusts wrote about it, no stars yet");
  });

  it("draws a card again only when its own score changes", async () => {
    const scorer = heldReader(HOUSE_RANKS);
    const { readers } = houseNetwork(jacafeScored(), [], { [SCORER_RELAY]: scorer });
    await openApp("/", { events: places, readers });
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent(copy.score.counting));

    // Explore lists the places near the middle of Funchal, each with how far it is: a card draws its distance each time it is drawn.
    const { lat, lon, radiusKm } = config.defaultCity;
    const kmOf = (place: Place) => idx.near(lat, lon, radiusKm).find((row) => row.place.address === place.address)!.km;
    const drawn = vi.spyOn(distanceModule, "formatDistance");
    scorer.open();
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));

    const drawnAt = (place: Place) => drawn.mock.calls.filter(([km]) => km === kmOf(place)).length;
    expect(drawnAt(JACAFE)).toBeGreaterThan(0);
    for (const other of [MUSEU, MAIA]) expect(drawnAt(other)).toBe(0);
  });

  it("draws a search row again only when its own score changes", async () => {
    const scorer = heldReader(HOUSE_RANKS);
    const { readers } = houseNetwork(jacafeScored(), [], { [SCORER_RELAY]: scorer });
    await openApp("/search?q=cafe", { events: places, readers });
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent(copy.score.counting));

    // The search lists the cafes within the widest distance (15 miles, 24 km), each row with how far it is.
    const { lat, lon } = config.defaultCity;
    const kmOf = (place: Place) => idx.search("cafe", { lat, lon, radiusKm: 24 }).find((row) => row.place.address === place.address)!.km;
    const drawn = vi.spyOn(distanceModule, "formatDistance");
    scorer.open();
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));

    const drawnAt = (place: Place) => drawn.mock.calls.filter(([km]) => km === kmOf(place)).length;
    expect(drawnAt(JACAFE)).toBeGreaterThan(0);
    for (const other of [MUSEU, MAIA]) expect(drawnAt(other)).toBe(0);
  });
});

describe("Explore, when House picks can't be worked out", () => {
  it.each([
    ["a phone", undefined],
    ["a desktop", DESKTOP],
  ])("offers Try again beside the line on %s, which gets House picks back, with the focus kept on the line", async (_, px) => {
    const user = userEvent.setup();
    const trust = flakyReader([trustList()]);
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS, { [TRUST]: trust });
    await openApp("/", { events: places, readers, px });

    const quiet = await screen.findByText(copy.score.houseUnavailable);
    const retry = screen.getByRole("button", { name: copy.load.retry });
    expect(retry).toHaveAccessibleDescription(copy.score.houseUnavailable);
    expect(screen.getAllByRole("button", { name: copy.load.retry })).toHaveLength(1);
    const line = quiet.closest("[tabindex='-1']");
    expect(line).not.toBeNull();

    trust.bringUp();
    await user.click(retry);
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    expect(screen.queryByText(copy.score.houseUnavailable)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.load.retry })).not.toBeInTheDocument();
    // The focus stays on the line about whose scores they are, not on the page.
    expect(line).toHaveFocus();
    expect(line).toHaveTextContent(copy.explore.houseLine);
  });

  it("says so once, under the line about whose scores they are, and each card says how many have rated it", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS, { [TRUST]: downReader });
    await openApp("/", { events: places, readers });

    await waitFor(() => expect(card("Jacafé")).toHaveTextContent(copy.score.peopleRated(2)));
    expect(screen.getAllByText(copy.score.houseUnavailable)).toHaveLength(1);
    expect(copy.score.peopleRated(2)).toBe("2 people have rated it");
    const jacafe = card("Jacafé");
    expect(jacafe).not.toHaveTextContent("4.6");
    expect(jacafe).not.toHaveTextContent(copy.score.noScoreYet);
    expect(jacafe).not.toHaveClass("border-dashed");
  });
});

describe("a place's row in the search results", () => {
  it("has the score at the top right and who it comes from under the line", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp("/search?q=cafe", { events: places, readers });

    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    const row = card("Jacafé");
    expect(within(row).getByText("Jacafé").parentElement).toHaveTextContent("4.6");
    expect(within(row).getByText(copy.score.ratedByHouse(2))).toHaveClass("text-trust");
    expect(row).not.toHaveTextContent(copy.score.noReviewsYet);
    expect(row).toHaveAccessibleDescription(/4\.6 out of 5 Rated by 2 people the house trusts$/);
  });
});

describe("the pins", () => {
  const near = (...list: Place[]): PlaceDistance[] => list.map((place, i) => ({ place, km: 0.1 * (i + 1) }));
  const hoursOf = (place: Place) => openLine(openState(place, AFTERNOON), "en-US", "card");
  const kindOf = (place: Place) => placeKindLabel(place.category, place.cuisine);

  it("are a score pill for a scored place, and a ring for any other, each said in words", () => {
    const shown = new Map<string, ShownScore>([
      [JACAFE.address, { kind: "scored", score: 4.571, counted: 2 }],
      [MAIA.address, { kind: "unscored", others: 1, starless: 0 }],
      [MUSEU.address, { kind: "pending" }],
    ]);
    const pins = pinsFor(near(JACAFE, MAIA, MUSEU, CONFEITARIA.places[0]!), "en-US", AFTERNOON, (address) =>
      shown.get(address) ?? { kind: "none" },
    );
    expect(pins[0]!.label).toBe("4.6");
    expect(pins[0]!.name).toBe(`Jacafé, ${kindOf(JACAFE)}, ${hoursOf(JACAFE)}, 4.6 out of 5, rated by 2 people the house trusts`);
    expect(pins[1]).not.toHaveProperty("label");
    expect(pins[1]!.name).toBe(`Maia, ${kindOf(MAIA)}, ${hoursOf(MAIA)}, no rating yet`);
    expect(pins[2]).not.toHaveProperty("label");
    expect(pins[2]!.name).toBe(`Museu Café, ${kindOf(MUSEU)}, ${hoursOf(MUSEU)}, loading reviews`);
    expect(pins[3]).not.toHaveProperty("label");
    expect(pins[3]!.name).toMatch(/, no reviews yet$/);
  });

  it("say nothing of reviews while they are read, and that they couldn't be loaded when that failed", () => {
    const shown = new Map<string, ShownScore>([
      [JACAFE.address, { kind: "reading" }],
      [MAIA.address, { kind: "failed" }],
    ]);
    const pins = pinsFor(near(JACAFE, MAIA), "en-US", AFTERNOON, (address) => shown.get(address) ?? { kind: "none" });
    expect(pins[0]!.name).toBe(`Jacafé, ${kindOf(JACAFE)}, ${hoursOf(JACAFE)}`);
    expect(pins[1]!.name).toBe(`Maia, ${kindOf(MAIA)}, ${hoursOf(MAIA)}, reviews couldn't be loaded`);
    expect(pins.map((pin) => pin.label)).toEqual([undefined, undefined]);
  });

  it("take their scores without working out their hours again, and keep the pins whose score is the same", () => {
    const base = pinsFor(near(JACAFE, MAIA), "en-US", AFTERNOON);
    const none: ShownScore = { kind: "none" };
    const pending: ShownScore = { kind: "pending" };
    const scored: ShownScore = { kind: "scored", score: 4.571, counted: 2 };
    const hours = vi.spyOn(hoursModule, "openLine");
    const state = vi.spyOn(hoursModule, "openState");

    const before = scorePins(base, (address) => (address === JACAFE.address ? pending : none));
    const after = scorePins(base, (address) => (address === JACAFE.address ? scored : none));
    expect(hours).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(after[1]).toBe(before[1]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]!.label).toBe("4.6");
    // The same scores again: the same pins.
    expect(scorePins(base, (address) => (address === JACAFE.address ? scored : none))[0]).toBe(after[0]);
  });

  it("are a ring for every place when no scores are given, as in M1", () => {
    const pins = pinsFor(near(JACAFE, MAIA), "en-US", AFTERNOON);
    expect(pins.map((pin) => pin.label)).toEqual([undefined, undefined]);
    expect(pins[0]!.name).toBe(`Jacafé, ${kindOf(JACAFE)}, ${hoursOf(JACAFE)}, no reviews yet`);
  });

  it("show the score on the map's pin of a scored place", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp("/map", { events: places, readers });
    const pin = await screen.findByRole("button", { name: /^Jacafé, .*, 4\.6 out of 5, rated by 2 people the house trusts$/ });
    expect(pin).toHaveTextContent("4.6");
  });
});

describe("one ask of the store per list", () => {
  /** The addresses each `want` of the store was asked, in order. */
  const asks = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([addresses]) => [...(addresses as Iterable<string>)]).filter((addresses) => addresses.length > 0);

  it("asks for every place of Explore's list in one go, not a card at a time", async () => {
    const want = vi.spyOn(ScoresStore.prototype, "want");
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp("/", { events: places, readers });
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));

    const shown = placeLinks().map(addressOfLink);
    expect(shown.length).toBeGreaterThan(20);
    const calls = asks(want);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.length).toBeGreaterThanOrEqual(shown.length);
    expect(calls.at(-1)).toEqual(expect.arrayContaining(shown));
  });

  it("asks for the desktop's cards in one go, and the pins the map draws in one go", async () => {
    const want = vi.spyOn(ScoresStore.prototype, "want");
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp("/", { events: places, readers, px: DESKTOP });
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    await screen.findByRole("button", { name: /^Jacafé, .*4\.6 out of 5/ });

    // The list's places, all of them in one ask, never a card at a time: each place of the list (a
    // chain's card is not scored as one), shown yet or not.
    const sorted = (addresses: readonly string[]) => [...addresses].sort();
    const { lat, lon, radiusKm } = config.defaultCity;
    const listed = groupForList(idx.near(lat, lon, radiusKm), idx).flatMap((entry) => ("chain" in entry ? [] : [entry.place.address]));
    expect(listed.length).toBeGreaterThan(placeLinks().length);
    expect(asks(want).map(sorted)).toContainEqual(sorted(listed));

    // The map draws a bubble and two pins on their own: it asks for those two, together, and no more.
    const map = FakeMap.instances.at(-1)!;
    want.mockClear();
    const point = (place: Place) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [place.lon, place.lat] },
      properties: { address: place.address },
    });
    map.features = [
      { type: "Feature", geometry: { type: "Point", coordinates: [-16.92, 32.65] }, properties: { cluster: true, cluster_id: 2, point_count: 41 } },
      point(JACAFE),
      point(MAIA),
    ];
    act(() => map.fire("render"));
    await waitFor(() => expect(asks(want)).toEqual([sorted([JACAFE.address, MAIA.address])]));
  });
});

// ---- The place page ----

/** The reviews listed under the heading of the house's reviews. */
const insideReviews = () =>
  within(screen.getByRole("heading", { level: 2, name: copy.reviews.heading }).closest("section")!).getAllByRole("article");
/** A review's reviewer, as its heading names them. */
const reviewerOf = (article: HTMLElement) => within(article).getByRole("heading", { level: 3 }).textContent;

/**
 * Ranks that would be easy to spot: Alice 87.37 and Bob 63.41 inside House picks, Carol 4.38 below the
 * line. No place, distance, hour or address in the fixtures has these numbers, whole or not. The page
 * must never show any of them, nor their weights or roundings (tests/support/noNumbers.ts).
 */
const NUMBERS = [87.37, 63.41, 4.38];
const NUMBER_RANKS = [rankOf(ALICE, 87.37), rankOf(BOB, 63.41), rankOf(CAROL, 4.38)];
/** Jacafé reviewed by all three; a location of A Confeitaria by Alice and Carol. */
const numbersReviews = () => [
  ...jacafeScored(),
  reviewOf(CAROL, JACAFE, 2, "Too sweet.", 5),
  reviewOf(ALICE, CONFEITARIA.places[0]!, 4),
  reviewOf(CAROL, CONFEITARIA.places[0]!, 3),
];

describe("the place page, scored", () => {
  it("has the score panel: the big number, its stars, and who it comes from", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });

    const line = await screen.findByText(copy.score.fromHouse(2));
    const panel = line.closest("section")!;
    expect(panel).toHaveClass("bg-surface", "rounded-panel");
    expect(within(panel).getByText("4.6")).toHaveClass("font-display", "text-score", "font-extrabold");
    expect(within(panel).getByRole("img", { name: "4.6 out of 5" })).toBeInTheDocument();
    expect(line).toHaveClass("font-semibold", "text-trust");
    // No "Be the first": it has reviews.
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();
    expect(copy.score.fromHouse(2)).toBe("From 2 people the house trusts");
    expect(copy.score.fromHouse(1)).toBe("From 1 person the house trusts");
  });

  it("lists the reviews inside House picks, newest first: the name, the stars, when, and the words", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });

    await screen.findByText("Alice Bento");
    expect(copy.reviews.heading).toBe("Rated by people the house trusts");
    const [bob, alice] = insideReviews() as [HTMLElement, HTMLElement];
    expect(insideReviews()).toHaveLength(2);
    expect(reviewerOf(bob)).toBe("Bob");
    expect(within(bob).getByRole("img", { name: "4 out of 5" })).toBeInTheDocument();
    expect(within(bob).getByText("3 days ago")).toHaveAttribute("datetime", new Date((NOW_S - 3 * DAY) * 1000).toISOString());
    expect(within(bob).getByText("Busy at noon.")).toBeInTheDocument();
    expect(reviewerOf(alice)).toBe("Alice Bento");
    expect(within(alice).getByRole("img", { name: "5 out of 5" })).toBeInTheDocument();
    expect(within(alice).getByText("2 weeks ago")).toBeInTheDocument();
    expect(within(alice).getByText("Get the bolo.")).toBeInTheDocument();
    // Nothing is folded: both are inside House picks.
    expect(screen.queryByRole("button", { name: copy.reviews.show })).not.toBeInTheDocument();
  });

  it("puts every reviewer's name in a <bdi>, kept apart from the text around it", async () => {
    const { readers } = houseNetwork([...jacafeScored(), reviewOf(DAVE, JACAFE, 3, "Fine.", 1)], HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });

    await screen.findByText("Alice Bento");
    const reviews = insideReviews();
    expect(reviews).toHaveLength(3);
    for (const article of reviews) {
      const name = within(article).getByRole("heading", { level: 3 });
      const bdi = name.querySelector("bdi");
      expect(bdi).not.toBeNull();
      expect(bdi!.textContent).toBe(name.textContent);
    }
  });

  it("calls a reviewer with no name 'Someone', never a code or a key (Review Focus 4)", async () => {
    const { readers } = houseNetwork([...jacafeScored(), reviewOf(DAVE, JACAFE, 3, "Fine.", 1)], HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });

    // The names come in one read: once Alice has hers, Dave has none to come.
    await screen.findByText("Alice Bento");
    const dave = insideReviews().find((article) => within(article).queryByText("Fine.") !== null)!;
    expect(reviewerOf(dave)).toBe(copy.reviews.someone);
    expect(copy.reviews.someone).toBe("Someone");
    expect(document.body.textContent).not.toContain(DAVE);
    expect(document.body.textContent).not.toMatch(/npub1/i);
  });

  it("folds the reviews from outside House picks, says so, and shows them dimmed on request", async () => {
    const user = userEvent.setup();
    const { readers } = houseNetwork([...jacafeScored(), reviewOf(CAROL, JACAFE, 2, "Too sweet.", 5)], HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });

    const title = await screen.findByText(copy.reviews.foldedMore(1));
    expect(copy.reviews.foldedMore(1)).toBe("1 more review from outside House picks");
    expect(copy.reviews.foldedMore(4)).toBe("4 more reviews from outside House picks");
    expect(copy.reviews.foldedNote).toBe("Folded away, never deleted.");
    const box = title.closest("section")!;
    expect(box).toHaveClass("border-dashed", "border-line-dashed");
    expect(within(box).getByText(copy.reviews.foldedNote)).toBeInTheDocument();
    expect(screen.queryByText("Too sweet.")).not.toBeInTheDocument();
    // Not counted in the score, which stays 4.6.
    expect(screen.getByText(copy.score.fromHouse(2))).toBeInTheDocument();

    const show = within(box).getByRole("button", { name: copy.reviews.show });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(show).toHaveAccessibleDescription(copy.reviews.foldedMore(1));
    expect(copy.reviews.show).toBe("Show them");
    await user.click(show);

    const carol = (await screen.findByText("Too sweet.")).closest("article")!;
    await waitFor(() => expect(reviewerOf(carol)).toBe("Carol"));
    // One label: whether they are shown is the button's state, not its words.
    expect(show).toHaveAttribute("aria-expanded", "true");
    expect(show).toHaveAccessibleName(copy.reviews.show);
    expect(document.getElementById(show.getAttribute("aria-controls")!)).toContainElement(carol);
    expect(reviewerOf(carol)).toBe("Carol");
    expect(within(carol).getByRole("img", { name: "2 out of 5" })).toBeInTheDocument();
    expect(within(carol).getByText("5 days ago")).toBeInTheDocument();
    // Dimmed: in the muted colour, stars and all; and with nothing about the person but their name.
    expect(carol).toHaveAttribute("data-folded", "true");
    expect(within(carol).getByText("Too sweet.")).toHaveClass("text-muted");
    const filled = within(carol).getByRole("img", { name: "2 out of 5" }).querySelectorAll("[data-fill='full'] > span.absolute");
    expect([...filled].map((star) => star.classList.contains("text-muted"))).toEqual([true, true]);
    expect(insideReviews()).not.toContain(carol);

    await user.click(show);
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Too sweet.")).not.toBeInTheDocument();
  });

  it("does not name a person's rank in a sentence about the reviews", () => {
    // The lines that name people say how many, and that the house trusts them: never by how much.
    for (const n of [1, 2, 12]) {
      for (const line of [copy.score.ratedByHouse(n), copy.score.fromHouse(n), copy.score.starless(n), copy.map.pinScored("4.6", n)]) {
        expect(line).not.toMatch(/%|\brank|\bweight|\bcounts? for|trust score/i);
      }
    }
  });

  it("never shows a number about a person on the place page: no rank, weight or share, in the text or in what a screen reader hears", async () => {
    const user = userEvent.setup();
    const { readers } = houseNetwork(numbersReviews(), NUMBER_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });
    await screen.findByText("Alice Bento");
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));
    await screen.findByText("Too sweet.");

    expectNoNumbersAboutPeople(NUMBERS);
    // The place's own rating is there: (0.8737 × 5 + 0.6341 × 4) / 1.5078.
    expect(screen.getByRole("img", { name: "4.6 out of 5" })).toBeInTheDocument();
  });

  it.each([
    ["Explore's cards", "/", DESKTOP],
    ["the map's pins", "/map", undefined],
  ])("never shows a number about a person in %s", async (_, path, px) => {
    const { readers } = houseNetwork(numbersReviews(), NUMBER_RANKS);
    await openApp(path, { events: places, readers, ...(px === undefined ? {} : { px }) });
    if (path === "/") await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    await screen.findByRole("button", { name: /^Jacafé, .*4\.6 out of 5/ });
    expectNoNumbersAboutPeople(NUMBERS);
  });

  it("never shows a number about a person in a chain's rows", async () => {
    const { readers } = houseNetwork(numbersReviews(), NUMBER_RANKS);
    const location = CONFEITARIA.places[0]!;
    await openApp(`/chain/${chainSlug(CONFEITARIA)}`, { events: places, readers });
    const row = await waitFor(() => {
      const found = screen.getAllByRole("link").find((link) => link.getAttribute("href") === placePath(location))!;
      expect(found).toHaveTextContent(copy.score.ratedByHouse(1));
      return found;
    });
    expect(row).toHaveTextContent("4.0");
    expectNoNumbersAboutPeople(NUMBERS);
  });

  it("on a desktop, has the panel in the column and Rate this place heading the rail", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers, px: DESKTOP });

    const panel = (await screen.findByText(copy.score.fromHouse(2))).closest("section")!;
    expect(panel).toHaveClass("rounded-panel-desktop", "p-panel-desktop");
    expect(within(panel).getByText("4.6")).toHaveClass("text-[64px]");
    expect(within(panel).queryByRole("link", { name: copy.place.rate })).not.toBeInTheDocument();
    const rail = screen.getByRole("complementary", { name: copy.place.railLabel });
    expect(within(rail).getByRole("link", { name: copy.place.rate })).toBeInTheDocument();
    expect(insideReviews()).toHaveLength(2);
  });

  it("on a phone, has Rate this place beside the heading of the reviews", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });
    const heading = await screen.findByRole("heading", { level: 2, name: copy.reviews.heading });
    expect(within(heading.parentElement!).getByRole("link", { name: copy.place.rate })).toHaveAttribute("href", "/signin");
    expect(screen.getAllByRole("link", { name: copy.place.rate })).toHaveLength(1);
  });
});

describe("the reviewers' pictures on the place page", () => {
  const ALICE_PICTURE = "https://img.example.test/alice.jpg";
  const BOB_PICTURE = "https://img.example.test/bob.jpg";
  const CAROL_PICTURE = "https://img.example.test/carol.jpg";

  /** `pubkey`'s profile (kind 0), naming them `name`, with `picture` in it when one is given. */
  const pictured = (pubkey: string, name: string, picture?: string) =>
    shapedEvent({ kind: 0, pubkey, content: JSON.stringify(picture === undefined ? { name } : { name, picture }) });

  /** Jacafé's reviews, Alice's and Bob's inside House picks and Carol's folded, with `profiles` on the review relay. */
  function jacafeWith(profiles: NostrEvent[]) {
    const reviews = [...jacafeScored(), reviewOf(CAROL, JACAFE, 2, "Too sweet.", 5)];
    return houseNetwork(reviews, HOUSE_RANKS, { [SEARCH]: createMemoryReader([...reviews, ...profiles]) });
  }

  /** The circle beside a review's name: the reviewer's picture in it, or their initial. */
  const faceOf = (article: HTMLElement) => within(article).getByRole("heading", { level: 3 }).previousElementSibling as HTMLElement;
  /** The review whose reviewer is named `name`, inside House picks. */
  const reviewBy = (name: string) => insideReviews().find((article) => reviewerOf(article) === name)!;

  it("fills each reviewer's circle with the picture their profile gives: no referrer, loaded lazily, the name beside it", async () => {
    const { readers } = jacafeWith([pictured(ALICE, "Alice Bento", ALICE_PICTURE), pictured(BOB, "Bob", BOB_PICTURE)]);
    await openApp(placePath(JACAFE), { events: places, readers });

    await screen.findByText("Alice Bento");
    for (const [name, address] of [["Alice Bento", ALICE_PICTURE], ["Bob", BOB_PICTURE]] as const) {
      const face = faceOf(reviewBy(name));
      const picture = await waitFor(() => {
        const found = face.querySelector("img");
        expect(found).not.toBeNull();
        return found!;
      });
      expect(picture).toHaveAttribute("src", address);
      // The name is beside it: the picture says nothing more.
      expect(picture).toHaveAttribute("alt", "");
      expect(picture).toHaveAttribute("referrerpolicy", "no-referrer");
      expect(picture).toHaveAttribute("loading", "lazy");
      expect(picture).toHaveAttribute("decoding", "async");
      // Filling the circle, cut to it, its ground showing while it loads, and a ring that keeps its edge in either theme.
      expect(picture).toHaveClass("size-full", "rounded-full", "object-cover", "bg-surface", "ring-1", "ring-line");
      expect(picture).not.toHaveClass("opacity-60");
      expect(face).toHaveAttribute("aria-hidden", "true");
      expect(face).toHaveTextContent("");
    }
  });

  it("shows the initial for a reviewer whose profile has no picture, or one that is not https", async () => {
    const { readers } = jacafeWith([pictured(ALICE, "Alice Bento"), pictured(BOB, "Bob", "http://img.example.test/bob.jpg")]);
    await openApp(placePath(JACAFE), { events: places, readers });

    await screen.findByText("Alice Bento");
    expect(faceOf(reviewBy("Alice Bento"))).toHaveTextContent(/^A$/);
    expect(faceOf(reviewBy("Bob"))).toHaveTextContent(/^B$/);
    expect(document.querySelector("article img")).toBeNull();
  });

  it("shows the initial in place of a picture that won't load, and does not ask for it again this session", async () => {
    const { readers } = jacafeWith([pictured(ALICE, "Alice Bento", ALICE_PICTURE), pictured(BOB, "Bob", BOB_PICTURE)]);
    const { router } = await openApp(placePath(JACAFE), { events: places, readers });

    await screen.findByText("Alice Bento");
    const picture = await waitFor(() => {
      const found = faceOf(reviewBy("Alice Bento")).querySelector("img");
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.error(picture);
    expect(faceOf(reviewBy("Alice Bento"))).toHaveTextContent(/^A$/);
    expect(faceOf(reviewBy("Alice Bento")).querySelector("img")).toBeNull();
    // Bob's loads: his stays.
    expect(faceOf(reviewBy("Bob")).querySelector("img")).toHaveAttribute("src", BOB_PICTURE);

    // Back on the place's page later in the session, Alice's is not asked for again.
    await act(() => router.navigate("/"));
    await act(() => router.navigate(placePath(JACAFE)));
    await screen.findByText("Alice Bento");
    expect(faceOf(reviewBy("Alice Bento"))).toHaveTextContent(/^A$/);
    expect(document.querySelector(`img[src="${ALICE_PICTURE}"]`)).toBeNull();
    expect(faceOf(reviewBy("Bob")).querySelector("img")).toHaveAttribute("src", BOB_PICTURE);
  });

  it("dims a folded reviewer's picture, as the words and stars beside it are", async () => {
    const user = userEvent.setup();
    const { readers } = jacafeWith([
      pictured(ALICE, "Alice Bento", ALICE_PICTURE),
      pictured(BOB, "Bob", BOB_PICTURE),
      pictured(CAROL, "Carol", CAROL_PICTURE),
    ]);
    await openApp(placePath(JACAFE), { events: places, readers });
    await screen.findByText("Alice Bento");
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));

    const carol = (await screen.findByText("Too sweet.")).closest("article")!;
    expect(carol).toHaveAttribute("data-folded", "true");
    const picture = faceOf(carol).querySelector("img");
    expect(picture).toHaveAttribute("src", CAROL_PICTURE);
    expect(picture).toHaveClass("opacity-60");
    for (const name of ["Alice Bento", "Bob"]) expect(faceOf(reviewBy(name)).querySelector("img")).not.toHaveClass("opacity-60");
  });

  it("never shows a number about a person with the pictures in", async () => {
    const user = userEvent.setup();
    const reviews = numbersReviews();
    const profiles = [
      pictured(ALICE, "Alice Bento", ALICE_PICTURE),
      pictured(BOB, "Bob", BOB_PICTURE),
      pictured(CAROL, "Carol", CAROL_PICTURE),
    ];
    const { readers } = houseNetwork(reviews, NUMBER_RANKS, { [SEARCH]: createMemoryReader([...reviews, ...profiles]) });
    await openApp(placePath(JACAFE), { events: places, readers });
    await screen.findByText("Alice Bento");
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));
    await screen.findByText("Too sweet.");
    await waitFor(() => expect(document.querySelectorAll("article img")).toHaveLength(3));

    expectNoNumbersAboutPeople(NUMBERS);
  });
});

describe("the place page, not scored", () => {
  it("keeps M1's dashed 'Be the first' panel for a place nobody has reviewed", async () => {
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp(placePath(MUSEU), { events: places, readers });
    // The panel waits while the reviews are read; then it says there are none.
    const panel = (await screen.findByText(copy.place.beFirst)).closest("section")!;
    expect(panel).toHaveClass("border-dashed");
    expect(within(panel).getByRole("link", { name: copy.place.rate })).toBeInTheDocument();
    expect(screen.queryByText(copy.score.noScoreYet)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.reviews.show })).not.toBeInTheDocument();
  });

  it("says 'No rating yet' for a place only others have rated, and folds their reviews", async () => {
    const { readers } = houseNetwork([reviewOf(CAROL, MAIA, 2, "Too sweet.", 5)], HOUSE_RANKS);
    await openApp(placePath(MAIA), { events: places, readers });

    const title = await screen.findByRole("heading", { level: 2, name: copy.score.noScoreYet });
    const panel = title.closest("section")!;
    expect(panel).toHaveClass("border-dashed");
    expect(within(panel).getByText(`${copy.score.othersRated(1)}.`)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: copy.place.rate })).toBeInTheDocument();
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();
    expect(screen.getByText(copy.reviews.foldedAll(1))).toBeInTheDocument();
    expect(copy.reviews.foldedAll(1)).toBe("1 review from outside House picks");
    expect(screen.queryByRole("heading", { name: copy.reviews.heading })).not.toBeInTheDocument();
  });

  it("waits quietly while the reviews are read: no 'Be the first', no score, nothing said", async () => {
    const search = heldReader([...jacafeScored(), ...PROFILES]);
    const { readers } = houseNetwork([], HOUSE_RANKS, { [SEARCH]: search });
    await openApp(placePath(JACAFE), { events: places, readers });
    await waitFor(() => expect(search.requests.length).toBeGreaterThan(0));

    const waiting = document.querySelector("section[aria-busy='true']");
    expect(waiting).not.toBeNull();
    expect(waiting!.textContent).toBe("");
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.score.noReviewsYet)).not.toBeInTheDocument();

    search.open();
    expect(await screen.findByText(copy.score.fromHouse(2))).toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("says the reviews couldn't be loaded, and Try again reads them again", async () => {
    const user = userEvent.setup();
    const search = flakyReader([...jacafeScored(), ...PROFILES]);
    const { readers } = houseNetwork([], HOUSE_RANKS, { [SEARCH]: search });
    await openApp(placePath(JACAFE), { events: places, readers });

    const retry = await screen.findByRole("button", { name: copy.load.retry });
    expect(within(retry.closest("section")!).getByText(copy.score.failed)).toHaveClass("text-muted");
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();

    search.bringUp();
    await user.click(retry);
    expect(await screen.findByText(copy.score.fromHouse(2))).toBeInTheDocument();
    expect(screen.queryByText(copy.score.failed)).not.toBeInTheDocument();
    // The focus goes to the score panel, where the button was, not to the page.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toContainElement(screen.getByText(copy.score.fromHouse(2)));
  });

  it("says 'No rating yet' for reviews by people the house trusts with no stars, and lists them", async () => {
    const { readers } = houseNetwork([starlessReviewOf(ALICE, MAIA, "Lovely terrace.")], HOUSE_RANKS);
    await openApp(placePath(MAIA), { events: places, readers });

    const title = await screen.findByRole("heading", { level: 2, name: copy.score.noScoreYet });
    expect(within(title.closest("section")!).getByText(`${copy.score.starless(1)}.`)).toBeInTheDocument();
    const [alice] = insideReviews() as [HTMLElement];
    expect(insideReviews()).toHaveLength(1);
    expect(within(alice).getByText("Lovely terrace.")).toBeInTheDocument();
    expect(within(alice).queryByRole("img")).not.toBeInTheDocument();
    // One way to rate it: the panel's button. No second one beside the heading.
    expect(screen.getAllByRole("link", { name: copy.place.rate })).toHaveLength(1);
  });

  it("says the reviews are being counted while their reviewers are ranked: no score, nothing folded", async () => {
    const scorer = heldReader(HOUSE_RANKS);
    const { readers } = houseNetwork(jacafeScored(), [], { [SCORER_RELAY]: scorer });
    await openApp(placePath(JACAFE), { events: places, readers });

    const line = await screen.findByText(copy.score.counting);
    expect(line).toHaveClass("text-muted");
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.score.noScoreYet)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.reviews.show })).not.toBeInTheDocument();
    expect(screen.queryByText(/outside House picks/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /out of 5/ })).not.toBeInTheDocument();

    scorer.open();
    expect(await screen.findByText(copy.score.fromHouse(2))).toBeInTheDocument();
    expect(screen.queryByText(copy.score.counting)).not.toBeInTheDocument();
  });

  it("lists the reviews folded, with one quiet line and no score, when the house's scorer cannot be read (Review Focus 5)", async () => {
    const user = userEvent.setup();
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS, { [TRUST]: downReader });
    await openApp(placePath(JACAFE), { events: places, readers });

    const quiet = await screen.findByText(copy.score.houseUnavailable);
    expect(copy.score.houseUnavailable).toBe("House picks aren't available right now.");
    expect(quiet).toHaveClass("text-muted");
    expect(screen.getAllByText(copy.score.houseUnavailable)).toHaveLength(1);
    // No score from unweighted stars: no number, no stars, until the reviews are shown.
    expect(screen.queryByText("4.5")).not.toBeInTheDocument();
    expect(screen.queryByText("4.6")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /out of 5/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: copy.score.noScoreYet })).toBeInTheDocument();
    expect(screen.getByText(`${copy.score.peopleRated(2)}.`)).toBeInTheDocument();

    const box = screen.getByText(copy.reviews.uncounted(2)).closest("section")!;
    expect(copy.reviews.uncounted(2)).toBe("2 reviews, shown without a rating for now");
    await user.click(within(box).getByRole("button", { name: copy.reviews.show }));
    const shown = await screen.findAllByRole("article");
    expect(shown).toHaveLength(2);
    for (const article of shown) expect(article).toHaveAttribute("data-folded", "true");
  });

  it.each([
    ["a phone", undefined],
    ["a desktop", DESKTOP],
  ])("offers Try again beside the quiet line on %s, which gets the score back, with the focus on the score panel", async (_, px) => {
    const user = userEvent.setup();
    const trust = flakyReader([trustList()]);
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS, { [TRUST]: trust });
    await openApp(placePath(JACAFE), { events: places, readers, px });

    await screen.findByText(copy.score.houseUnavailable);
    const retry = screen.getByRole("button", { name: copy.load.retry });
    expect(retry).toHaveAccessibleDescription(copy.score.houseUnavailable);

    trust.bringUp();
    await user.click(retry);
    expect(await screen.findByText(copy.score.fromHouse(2))).toBeInTheDocument();
    expect(screen.queryByText(copy.score.houseUnavailable)).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toContainElement(screen.getByText(copy.score.fromHouse(2)));
  });
});

// ---- The nearby places on a place's page ----

describe("the place page's nearby places", () => {
  it("show their own scores", async () => {
    // The place nearest Museu Café, which its page lists first under Nearby.
    const next = idx.near(MUSEU.lat, MUSEU.lon, 1, 2).find((row) => row.place.address !== MUSEU.address)!.place;
    const { readers } = houseNetwork([reviewOf(ALICE, next, 5)], HOUSE_RANKS);
    await openApp(placePath(MUSEU), { events: places, readers });
    const nearby = screen.getByRole("heading", { level: 2, name: copy.place.nearby }).closest("section")!;
    const row = within(nearby).getAllByRole("link")[0]!;
    expect(row).toHaveAttribute("href", placePath(next));
    await waitFor(() => expect(row).toHaveTextContent("5.0"));
    expect(within(row).getByText(copy.score.ratedByHouse(1))).toHaveClass("text-trust");
    expect(row).not.toHaveTextContent(copy.score.noReviewsYet);
  });
});

// ---- The chain's line ----

describe("the chain page", () => {
  const { lat, lon } = config.defaultCity;
  const nearest = [...CONFEITARIA.places].sort((a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon));
  const path = `/chain/${chainSlug(CONFEITARIA)}`;
  const box = () => screen.getByText(copy.chain.eachScored).closest("section")!;

  it("says the range the house rates the locations near the town, when two or more have scores", async () => {
    const [one, two] = nearest as [Place, Place];
    const reviews = [reviewOf(ALICE, one, 4), reviewOf(BOB, one, 3), reviewOf(ALICE, two, 4), reviewOf(BOB, two, 5)];
    const { readers } = houseNetwork(reviews, HOUSE_RANKS);
    await openApp(path, { events: places, readers });

    // (0.8 × 4 + 0.6 × 3) / 1.4 and (0.8 × 4 + 0.6 × 5) / 1.4.
    await waitFor(() => expect(box()).toHaveTextContent(copy.chain.houseRange("3.6", "4.4", "Funchal")));
    expect(within(box()).getByText(`${copy.chain.eachScoredDetail} ${copy.chain.houseRange("3.6", "4.4", "Funchal")}`)).toBeInTheDocument();
    expect(copy.chain.houseRange("3.6", "4.4", "Funchal")).toBe("Near Funchal, the house rates them from 3.6 to 4.4.");
    expect(copy.chain.houseRange("4.0", "4.0", "Funchal")).toBe("Near Funchal, the house rates them 4.0.");
    expect(copy.chain.houseRange("3.6", "4.4", copy.location.you)).toBe("Near you, the house rates them from 3.6 to 4.4.");

    // Each location has its own score at the top right of its row, and who it comes from.
    const row = screen.getAllByRole("link").find((link) => link.getAttribute("href") === placePath(one))!;
    expect(within(row).getByText(copy.score.ratedByHouse(2))).toBeInTheDocument();
    expect(row).toHaveTextContent("3.6");
    expect(row).not.toHaveTextContent(copy.score.noReviewsYet);
  });

  it("says the one score, when one location near the town has a score", async () => {
    const [one] = nearest as [Place];
    const { readers } = houseNetwork([reviewOf(ALICE, one, 4)], HOUSE_RANKS);
    await openApp(path, { events: places, readers });

    await waitFor(() => expect(box()).toHaveTextContent(copy.chain.houseOne("4.0", "Funchal")));
    expect(copy.chain.houseOne("4.2", "Funchal")).toBe("Near Funchal, the house rates one 4.2.");
  });

  it("says only M1's line when no location near the town has a score", async () => {
    const [one] = nearest as [Place];
    const { search, readers } = houseNetwork([reviewOf(CAROL, one, 2)], HOUSE_RANKS);
    await openApp(path, { events: places, readers });
    await waitFor(() => expect(search.requests.length).toBeGreaterThan(0));
    const row = screen.getAllByRole("link").find((link) => link.getAttribute("href") === placePath(one))!;
    await waitFor(() => expect(row).toHaveTextContent(copy.score.othersRated(1)));

    expect(within(box()).getByText(copy.chain.eachScoredDetail)).toBeInTheDocument();
    expect(box()).not.toHaveTextContent(/the house rates/);
  });
});

// ---- Sorting ----

describe("sorting by House picks' rating", () => {
  it("leaves Explore's list in distance order when places have scores and no sort is chosen", async () => {
    const search = heldReader([reviewOf(ALICE, MAIA, 5), ...PROFILES]);
    const { readers } = houseNetwork([], HOUSE_RANKS, { [SEARCH]: search });
    await openApp("/", { events: places, readers });
    const before = placeLinks().map((link) => link.getAttribute("href"));

    search.open();
    await waitFor(() => expect(card("Maia")).toHaveTextContent("5.0"));
    expect(placeLinks().map((link) => link.getAttribute("href"))).toEqual(before);
    // Maia, the one place with a score, stays where its distance puts it, below nearer places.
    expect(before.indexOf(placePath(MAIA))).toBeGreaterThan(0);
  });

  it("puts the places with a score first, best first by the damped score, then every other place by distance", async () => {
    // Maia: 5 stars from Alice, damped to 4.0. Jacafé: 2 from Bob, damped to 3.1: still above every
    // place with no score. Museu Café has a review only from outside House picks: no score.
    const reviews = [reviewOf(ALICE, MAIA, 5), reviewOf(BOB, JACAFE, 2), reviewOf(CAROL, MUSEU, 5)];
    const { readers } = houseNetwork(reviews, HOUSE_RANKS);
    await openApp("/search?q=cafe&sort=score", { events: places, readers });

    await waitFor(() => expect(placeLinks()[1]).toHaveAttribute("href", placePath(JACAFE)));
    const hrefs = placeLinks().map((link) => link.getAttribute("href"));
    expect(hrefs.slice(0, 2)).toEqual([placePath(MAIA), placePath(JACAFE)]);
    // The rest, nearest first: "cafe" lists cafes, and these rows are the places alone, not chains.
    const { lat, lon } = config.defaultCity;
    const rest = hrefs.slice(2).map((href) => idx.byD.get(decodeURIComponent(href!.slice("/place/".length)))!);
    const kms = rest.map((place) => distanceKm(lat, lon, place.lat, place.lon));
    expect(kms).toEqual([...kms].sort((a, b) => a - b));
    expect(rest).toContain(MUSEU);
    expect(document.body).toHaveTextContent(`${copy.search.sortedBy.score}.`);
    expect(copy.search.sortedBy.score).toBe("Best in House picks first");
  });

  it("is offered on the filters page, and can be chosen before sign in", async () => {
    const user = userEvent.setup();
    const { readers } = houseNetwork([], HOUSE_RANKS);
    const { router } = await openApp("/filters", { events: places, readers });
    const sort = screen.getByRole("group", { name: copy.filters.sortBy });
    const buttons = within(sort).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["House picks' rating", "Distance", "Name"]);
    expect(copy.filters.sort.score).toBe("House picks' rating");
    expect(buttons[0]).toBeEnabled();
    expect(buttons[0]).not.toHaveAccessibleDescription();

    await user.click(buttons[0]!);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /^Show \d+ places?$/ }));
    expect(new URLSearchParams(router.state.location.search).get("sort")).toBe("score");
  });

  it("names the desktop's sort menu for it when it is chosen", async () => {
    const { readers } = houseNetwork([], HOUSE_RANKS);
    await openApp("/?sort=score", { events: places, readers, px: DESKTOP });
    expect(screen.getByRole("button", { name: copy.deskExplore.sort.score })).toBeInTheDocument();
    expect(copy.deskExplore.sort.score).toBe("Sort: House picks' rating");
  });
});

// ---- When a review was written ----

describe("when a review was written", () => {
  /** A moment on the calendar of the machine the test runs on: the review's day and the person's. */
  const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour);
  const NOW = at(2026, 10, 7, 9);
  const written = (when: Date) => whenWritten(Math.floor(when.getTime() / 1000), NOW);

  it.each<[string, string, Date]>([
    ["earlier the same day", "Today", at(2026, 10, 7, 1)],
    ["late the day before, under a day ago", "Yesterday", at(2026, 10, 6, 23)],
    ["two calendar days back", "2 days ago", at(2026, 10, 5, 20)],
    ["six days back", "6 days ago", at(2026, 10, 1)],
    ["a week back", "a week ago", at(2026, 9, 30)],
    ["two weeks back", "2 weeks ago", at(2026, 9, 23)],
    ["29 days back", "4 weeks ago", at(2026, 9, 8)],
    ["a calendar month back", "a month ago", at(2026, 9, 7)],
    ["six months back", "6 months ago", at(2026, 4, 7)],
    ["360 days back", "11 months ago", at(2025, 10, 12)],
    ["364 days back", "11 months ago", at(2025, 10, 8)],
    ["a full year back", "a year ago", at(2025, 10, 7)],
    ["two years back", "2 years ago", at(2024, 10, 1)],
    ["a moment in the future (a clock ahead)", "Today", at(2026, 10, 7, 11)],
  ])("for a review written %s says %s", (_, words, when) => {
    expect(written(when)).toBe(words);
  });

  it("has no date for a time no date can hold, and the date for any other", () => {
    expect(writtenOn(9e12)).toBeUndefined();
    expect(writtenOn(Number.NaN)).toBeUndefined();
    expect(writtenOn(NOW_S)?.toISOString()).toBe(AFTERNOON.toISOString());
  });

  it("leaves out a review from far in the future, and lists the others with their dates", async () => {
    // By Dave, whom the house trusts: it would be listed, dated, and counted.
    const future = shapedEvent({
      kind: REVIEW_KIND,
      pubkey: DAVE,
      created_at: 9e12,
      content: "From the year 287,000.",
      tags: [
        ["d", `place:${JACAFE.address}`],
        ["a", JACAFE.address],
        ["m", "place"],
        ["s", "1"],
      ],
    });
    const { readers } = houseNetwork([...jacafeScored(), future], HOUSE_RANKS);
    await openApp(placePath(JACAFE), { events: places, readers });

    expect(await screen.findByText(copy.score.fromHouse(2))).toBeInTheDocument();
    await screen.findByText("Alice Bento");
    expect(insideReviews()).toHaveLength(2);
    expect(screen.queryByText("From the year 287,000.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.reviews.show })).not.toBeInTheDocument();
    for (const time of document.querySelectorAll("article time")) expect(time.getAttribute("datetime")).toMatch(/^2026-/);
  });

  it("words each age in copy", () => {
    expect(copy.reviews.when(0, 0)).toBe("Today");
    expect(copy.reviews.when(1, 0)).toBe("Yesterday");
    expect(copy.reviews.when(364, 11)).toBe("11 months ago");
    expect(copy.reviews.when(365, 12)).toBe("a year ago");
    expect(copy.reviews.when(800, 26)).toBe("2 years ago");
  });
});
