import type { NostrEvent } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { pinsFor } from "../src/map/pins";
import { distanceKm } from "../src/places/distance";
import { openLine, openState } from "../src/places/hours";
import { buildIndexes, chainSlug, type PlaceDistance } from "../src/places/indexes";
import { placeKindLabel } from "../src/places/kinds";
import { parsePlaces } from "../src/places/load";
import type { Place } from "../src/places/place";
import { REVIEW_KIND } from "../src/reviews/review";
import type { ShownScore } from "../src/score/shown";
import { ScoresStore } from "../src/score/store";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader, type MemoryReader } from "./support/memoryReader";

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
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    requests: memory.requests,
    open,
    async *req(filter, signal) {
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

  it("is dashed, with 'No score yet', for a place only others have rated, in a list with a scored place", async () => {
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
    expect(copy.score.counting).toBe("Reviews are being counted");

    scorer.open();
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    expect(card("Maia")).toHaveClass("border-dashed");
  });
});

describe("Explore, when House picks can't be worked out", () => {
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
      [MAIA.address, { kind: "unscored", others: 1 }],
      [MUSEU.address, { kind: "pending" }],
    ]);
    const pins = pinsFor(near(JACAFE, MAIA, MUSEU, CONFEITARIA.places[0]!), "en-US", AFTERNOON, (address) =>
      shown.get(address) ?? { kind: "none" },
    );
    expect(pins[0]!.label).toBe("4.6");
    expect(pins[0]!.name).toBe(`Jacafé, ${kindOf(JACAFE)}, ${hoursOf(JACAFE)}, 4.6 out of 5, rated by 2 people the house trusts`);
    expect(pins[1]).not.toHaveProperty("label");
    expect(pins[1]!.name).toBe(`Maia, ${kindOf(MAIA)}, ${hoursOf(MAIA)}, no score yet`);
    expect(pins[2]).not.toHaveProperty("label");
    expect(pins[2]!.name).toBe(`Museu Café, ${kindOf(MUSEU)}, ${hoursOf(MUSEU)}, reviews being counted`);
    expect(pins[3]).not.toHaveProperty("label");
    expect(pins[3]!.name).toMatch(/, no reviews yet$/);
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

  it("asks for the desktop's cards and the map's pins together, in one go", async () => {
    const want = vi.spyOn(ScoresStore.prototype, "want");
    const { readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp("/", { events: places, readers, px: DESKTOP });
    await waitFor(() => expect(card("Jacafé")).toHaveTextContent("4.6"));
    await screen.findByRole("button", { name: /^Jacafé, .*4\.6 out of 5/ });

    const shown = placeLinks().map(addressOfLink);
    const calls = asks(want);
    for (const call of calls) expect(call.length).toBeGreaterThanOrEqual(shown.length);
    expect(calls.at(-1)).toEqual(expect.arrayContaining([...shown, JACAFE.address]));
  });
});

// ---- The place page ----

/** The section the score panel is, found by the words of its line. */
const panelWith = (text: string) => screen.getByText(text).closest("section")!;
/** The reviews listed under the heading of the house's reviews. */
const insideReviews = () =>
  within(screen.getByRole("heading", { level: 2, name: copy.reviews.heading }).closest("section")!).getAllByRole("article");
/** A review's reviewer, as its heading names them. */
const reviewerOf = (article: HTMLElement) => within(article).getByRole("heading", { level: 3 }).textContent;

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
    expect(copy.reviews.foldedNote).toBe("Shown on request, never removed.");
    const box = title.closest("section")!;
    expect(box).toHaveClass("border-dashed", "border-line-dashed");
    expect(within(box).getByText(copy.reviews.foldedNote)).toBeInTheDocument();
    expect(screen.queryByText("Too sweet.")).not.toBeInTheDocument();
    // Not counted in the score, which stays 4.6.
    expect(screen.getByText(copy.score.fromHouse(2))).toBeInTheDocument();

    const show = within(box).getByRole("button", { name: copy.reviews.show });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(copy.reviews.show).toBe("Show them");
    await user.click(show);

    const carol = (await screen.findByText("Too sweet.")).closest("article")!;
    await waitFor(() => expect(reviewerOf(carol)).toBe("Carol"));
    expect(show).toHaveAttribute("aria-expanded", "true");
    expect(show).toHaveAccessibleName(copy.reviews.hide);
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
    expect(screen.queryByText("Too sweet.")).not.toBeInTheDocument();
  });

  it("never shows a number about a person: no rank, weight or share, in the text or in what a screen reader hears", async () => {
    const user = userEvent.setup();
    const ranks = [rankOf(ALICE, 83.17), rankOf(BOB, 56.29), rankOf(CAROL, 4.71)];
    const { readers } = houseNetwork([...jacafeScored(), reviewOf(CAROL, JACAFE, 2, "Too sweet.", 5)], ranks);
    await openApp(placePath(JACAFE), { events: places, readers });
    await screen.findByText("Alice Bento");
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));
    await screen.findByText("Too sweet.");

    // Each rank, its weight, and their roundings; a percentage; and the words for them.
    const aboutPeople =
      /83\.17|56\.29|4\.71|83\.2|56\.3|4\.7|0\.8317|0\.5629|0\.0471|0\.83|0\.56|0\.05|%|\brank|\bweight|\bcounts? for|trust score/i;
    // What the page says: its text, every attribute a screen reader may read, and every name and description it hears.
    expect(document.body.textContent).not.toMatch(aboutPeople);
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of ["aria-label", "aria-description", "title", "alt", "aria-valuetext", "aria-valuenow"]) {
        expect(element.getAttribute(attribute) ?? "").not.toMatch(aboutPeople);
      }
      expect(element).not.toHaveAccessibleName(aboutPeople);
      expect(element).not.toHaveAccessibleDescription(aboutPeople);
    }
    expect(screen.queryAllByRole("meter")).toEqual([]);
    expect(screen.queryAllByRole("progressbar")).toEqual([]);
    // The place's own rating is there: (0.8317 × 5 + 0.5629 × 4) / 1.3946.
    expect(screen.getByRole("img", { name: "4.6 out of 5" })).toBeInTheDocument();
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

describe("the place page, not scored", () => {
  it("keeps M1's dashed 'Be the first' panel for a place nobody has reviewed", async () => {
    const { search, readers } = houseNetwork(jacafeScored(), HOUSE_RANKS);
    await openApp(placePath(MUSEU), { events: places, readers });
    // Its reviews have been asked for and read: there are none.
    await waitFor(() => expect(search.requests.length).toBeGreaterThan(0));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

    const panel = panelWith(copy.place.beFirst);
    expect(panel).toHaveClass("border-dashed");
    expect(within(panel).getByRole("link", { name: copy.place.rate })).toBeInTheDocument();
    expect(screen.queryByText(copy.score.noScoreYet)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.reviews.show })).not.toBeInTheDocument();
  });

  it("says 'No score yet' for a place only others have rated, and folds their reviews", async () => {
    const { readers } = houseNetwork([reviewOf(CAROL, MAIA, 2, "Too sweet.", 5)], HOUSE_RANKS);
    await openApp(placePath(MAIA), { events: places, readers });

    const title = await screen.findByRole("heading", { level: 2, name: copy.score.noScoreYet });
    const panel = title.closest("section")!;
    expect(panel).toHaveClass("border-dashed");
    expect(within(panel).getByText(copy.place.othersRated(1))).toBeInTheDocument();
    expect(copy.place.othersRated(1)).toBe("1 other person has rated it.");
    expect(within(panel).getByRole("link", { name: copy.place.rate })).toBeInTheDocument();
    expect(screen.queryByText(copy.place.beFirst)).not.toBeInTheDocument();
    expect(screen.getByText(copy.reviews.foldedAll(1))).toBeInTheDocument();
    expect(copy.reviews.foldedAll(1)).toBe("1 review from outside House picks");
    expect(screen.queryByRole("heading", { name: copy.reviews.heading })).not.toBeInTheDocument();
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
    expect(copy.score.houseUnavailable).toBe("House picks can't be worked out right now.");
    expect(quiet).toHaveClass("text-muted");
    expect(screen.getAllByText(copy.score.houseUnavailable)).toHaveLength(1);
    // No score from unweighted stars: no number, no stars, until the reviews are shown.
    expect(screen.queryByText("4.5")).not.toBeInTheDocument();
    expect(screen.queryByText("4.6")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /out of 5/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: copy.score.noScoreYet })).toBeInTheDocument();
    expect(screen.getByText(copy.place.peopleRated(2))).toBeInTheDocument();
    expect(copy.place.peopleRated(2)).toBe("2 people have rated it.");

    const box = screen.getByText(copy.reviews.uncounted(2)).closest("section")!;
    expect(copy.reviews.uncounted(2)).toBe("2 reviews, not counted right now");
    await user.click(within(box).getByRole("button", { name: copy.reviews.show }));
    const shown = await screen.findAllByRole("article");
    expect(shown).toHaveLength(2);
    for (const article of shown) expect(article).toHaveAttribute("data-folded", "true");
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

  it("says the range the house rates the locations near you, when two or more have scores", async () => {
    const [one, two] = nearest as [Place, Place];
    const reviews = [reviewOf(ALICE, one, 4), reviewOf(BOB, one, 3), reviewOf(ALICE, two, 4), reviewOf(BOB, two, 5)];
    const { readers } = houseNetwork(reviews, HOUSE_RANKS);
    await openApp(path, { events: places, readers });

    // (0.8 × 4 + 0.6 × 3) / 1.4 and (0.8 × 4 + 0.6 × 5) / 1.4.
    await waitFor(() => expect(box()).toHaveTextContent(copy.chain.houseRange("3.6", "4.4")));
    expect(within(box()).getByText(`${copy.chain.eachScoredDetail} ${copy.chain.houseRange("3.6", "4.4")}`)).toBeInTheDocument();
    expect(copy.chain.houseRange("3.6", "4.4")).toBe("Near you, the house rates them from 3.6 to 4.4.");
    expect(copy.chain.houseRange("4.0", "4.0")).toBe("Near you, the house rates them 4.0.");

    // Each location has its own score at the top right of its row, and who it comes from.
    const row = screen.getAllByRole("link").find((link) => link.getAttribute("href") === placePath(one))!;
    expect(within(row).getByText(copy.score.ratedByHouse(2))).toBeInTheDocument();
    expect(row).toHaveTextContent("3.6");
    expect(row).not.toHaveTextContent(copy.score.noReviewsYet);
  });

  it("says the one score, when one location near you has a score", async () => {
    const [one] = nearest as [Place];
    const { readers } = houseNetwork([reviewOf(ALICE, one, 4)], HOUSE_RANKS);
    await openApp(path, { events: places, readers });

    await waitFor(() => expect(box()).toHaveTextContent(copy.chain.houseOne("4.0")));
    expect(copy.chain.houseOne("4.2")).toBe("Near you, the house rates one 4.2.");
  });

  it("says only M1's line when no location near you has a score", async () => {
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

describe("sorting by House picks' score", () => {
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

  it("puts the best of House picks first when the search asks for it, by the damped score", async () => {
    // Maia: 5 stars from Alice, damped to 4.0. Jacafé: 2 from Bob, damped to 3.1, below the
    // places nobody has reviewed, which sit at the prior's 3.5 in the order they came in.
    const { readers } = houseNetwork([reviewOf(ALICE, MAIA, 5), reviewOf(BOB, JACAFE, 2)], HOUSE_RANKS);
    await openApp("/search?sort=score", { events: places, readers });

    await waitFor(() => expect(placeLinks()[0]).toHaveAttribute("href", placePath(MAIA)));
    await waitFor(() => expect(placeLinks().at(-1)).toHaveAttribute("href", placePath(JACAFE)));
    expect(document.body).toHaveTextContent(`${copy.search.sortedBy.score}.`);
    expect(copy.search.sortedBy.score).toBe("Best in House picks first");
  });

  it("is offered on the filters page, and can be chosen before sign in", async () => {
    const user = userEvent.setup();
    const { readers } = houseNetwork([], HOUSE_RANKS);
    const { router } = await openApp("/filters", { events: places, readers });
    const sort = screen.getByRole("group", { name: copy.filters.sortBy });
    const buttons = within(sort).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["House picks' score", "Distance", "Name"]);
    expect(copy.filters.sort.score).toBe("House picks' score");
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
    expect(copy.deskExplore.sort.score).toBe("Sort: House picks' score");
  });
});

// ---- When a review was written ----

describe("when a review was written", () => {
  it.each<[number, string]>([
    [0, "Today"],
    [DAY - 1, "Today"],
    [DAY, "Yesterday"],
    [2 * DAY, "2 days ago"],
    [6 * DAY, "6 days ago"],
    [7 * DAY, "1 week ago"],
    [14 * DAY, "2 weeks ago"],
    [30 * DAY, "1 month ago"],
    [200 * DAY, "6 months ago"],
    [365 * DAY, "1 year ago"],
    [800 * DAY, "2 years ago"],
    [-3600, "Today"],
  ])("is %i seconds ago: %s", (seconds, words) => {
    expect(copy.reviews.when(seconds)).toBe(words);
  });
});
