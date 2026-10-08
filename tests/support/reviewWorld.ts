import type { NostrEvent } from "@nostrify/nostrify";
import { screen, waitFor, within } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, vi } from "vitest";

import { SESSION_KEY } from "../../src/account/session";
import { config } from "../../src/config";
import { copy } from "../../src/copy/en";
import type { RelayReader, RelayWriter } from "../../src/nostr/events";
import { parsePlaces } from "../../src/places/load";
import { REVIEW_KIND } from "../../src/reviews/review";
import { HELD_REVIEWS_KEY } from "../../src/score/store";
import raw from "../fixtures/funchal-items.json";
import { openApp, PHONE } from "./app";
import { hex64, shapedEvent } from "./events";
import { createMemoryReader } from "./memoryReader";
import { createMemoryWriter, type MemoryWriter } from "./memoryWriter";

/*
 * A small world of relays for the tests that rate a place and remove a review (M2b Tasks 6 and 7):
 * Brainstorm's search relay, the house's trust relay and a made-up scorer, the relay-list directory,
 * and the relays reviews are sent to, all held in memory. Nothing opens a socket.
 */

export const places: NostrEvent[] = raw;
export const JACAFE = parsePlaces(places).find((place) => place.d === "osm-node-11330857543")!;
export const PLACE_PATH = `/place/${JACAFE.d}`;
export const REVIEW_PATH = `${PLACE_PATH}/review`;

/** Brainstorm's search relay (reviews, names), the house's trust relay, the relay-list directory, and relays the person writes to. */
export const SEARCH = "wss://search.brainstorm.world";
export const TRUST = "wss://scores.brainstorm.world";
export const DIRECTORY = "wss://purplepag.es";
export const OWN = "wss://nos.example.test";
export const ANOTHER = "wss://another.example.test";
/** A made-up scorer and its relay: the house's real one is never written into the app or its tests. */
export const SCORER = hex64("5");
export const SCORER_RELAY = "wss://ranks.example.test";

/** Thursday 8 October 2026, 12:00 UTC, in seconds: the time the tests' reviews are posted at. */
export const NOW_S = 1_791_460_800;

/** The house's kind 10040, naming `SCORER` at `SCORER_RELAY`. */
const trustList = () => shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", SCORER, SCORER_RELAY]] });

/** `SCORER`'s kind 30382 giving `subject` the rank `rank`. */
export const rankOf = (subject: string, rank: number) =>
  shapedEvent({ kind: 30382, pubkey: SCORER, tags: [["d", subject], ["rank", String(rank)]] });

/** `pubkey`'s profile (kind 0) naming them `name`. */
export const profileOf = (pubkey: string, name: string) => shapedEvent({ kind: 0, pubkey, content: JSON.stringify({ name }) });

/** `pubkey`'s relay list (kind 10002), writing to `urls`. */
export const listOf = (pubkey: string, urls: string[]) => shapedEvent({ kind: 10002, pubkey, tags: urls.map((url) => ["r", url]) });

/** `reviewer`'s review of Jacafé, as the app writes them; `stars` null for one with none. */
export const reviewBy = (reviewer: string, stars: number | null, text: string, createdAt = NOW_S - 86_400) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    created_at: createdAt,
    content: text,
    tags: [
      ["d", `place:${JACAFE.address}`],
      ["a", JACAFE.address],
      ["m", "place"],
      ...(stars === null ? [] : [["s", String(stars)]]),
    ],
  });

/**
 * What the relays hold, each a list the test may change between reads: the search relay's reviews
 * and profiles, the directory's relay lists, and the scorer's ranks. Each reader reads its list as
 * it is at the time of the request.
 */
export interface World {
  search: NostrEvent[];
  directory: NostrEvent[];
  ranks: NostrEvent[];
  /** The relays that are sent reviews, by URL. One not here refuses. */
  writers: Record<string, MemoryWriter>;
  /** How many times the search relay has been asked for reviews. */
  reviewReads: number;
  /** Whether the house's trust relay answers; when it does not, House picks can't be worked out. */
  houseDown?: boolean;
}

export function newWorld(): World {
  return { search: [], directory: [], ranks: [], writers: {}, reviewReads: 0 };
}

export const readersOf =
  (world: World) =>
  (url: string): RelayReader => {
    if (url === SEARCH) {
      const reader = createMemoryReader(world.search);
      return {
        req(filter, signal) {
          if (filter.kinds?.includes(REVIEW_KIND)) world.reviewReads += 1;
          return reader.req(filter, signal);
        },
      };
    }
    if (url === TRUST) {
      return world.houseDown ? createMemoryReader([], { failWith: new Error("down") }) : createMemoryReader([trustList()]);
    }
    if (url === SCORER_RELAY) return createMemoryReader(world.ranks);
    if (url === DIRECTORY) return createMemoryReader(world.directory);
    return createMemoryReader([]);
  };

export const writersOf =
  (world: World) =>
  (url: string): RelayWriter =>
    world.writers[url] ?? createMemoryWriter({ refuse: "not in this test" });

/** What the relay at `url` was sent. */
export const sentTo = (world: World, url: string): NostrEvent[] => world.writers[url]?.published ?? [];

/** The browser add-on (NIP-07) as a page sees it, signing with `key`. */
export function installAddOn(key: Uint8Array) {
  const addOn = {
    getPublicKey: vi.fn(async () => getPublicKey(key)),
    signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, key)),
  };
  Object.defineProperty(window, "nostr", { configurable: true, writable: true, value: addOn });
  return addOn;
}

/**
 * The person, signed in with this browser in this tab before the page was opened, named `name` on
 * the search relay. `signsWith` is the key their add-on signs with now: another person's when it
 * has changed accounts since.
 */
export function signedIn(world: World, { name = "Maya", signsWith }: { name?: string; signsWith?: Uint8Array } = {}) {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const addOn = installAddOn(signsWith ?? key);
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
  world.search.push(profileOf(pubkey, name));
  return { key, pubkey, addOn, name };
}

/** The history of a person who opened the place from Explore and is now at `path`. */
export const fromExplore = (...paths: string[]) => ["/", ...paths];

/** The app at the end of `entries`, reading and writing `world`. */
export const open = (world: World, entries: Parameters<typeof openApp>[1]["entries"], px = PHONE) =>
  openApp(String(entries?.at(-1)), { events: places, entries, px, readers: readersOf(world), writers: writersOf(world) });

/**
 * The first "Rate this place" on the page (on a desktop, the one in the rail), once the place's panel
 * has settled. A phone's panel goes from its reviews being read, to their being counted, to its
 * score, each with its own button, or none: the one to press is the one it settles on. The search
 * relay must have been asked for the place's reviews in `world`.
 */
export const rateLink = async (world: World) => {
  await waitFor(() => {
    expect(world.reviewReads).toBeGreaterThan(0);
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText(copy.score.counting)).toBeNull();
  });
  const rail = screen.queryByRole("complementary", { name: copy.place.railLabel });
  return (await within(rail ?? document.body).findAllByRole("link", { name: copy.place.rate }))[0]!;
};

/** The stars, one to five: the radios of "How was it?". */
export const starButtons = async () => within(await screen.findByRole("radiogroup", { name: copy.review.howWasIt })).getAllByRole("radio");

/** The Post button, by its name before posting. */
export const postButton = () => screen.getByRole("button", { name: copy.review.post });

/** The same button once a post has failed: Try again. */
export const tryAgainButton = () => screen.getByRole("button", { name: copy.review.tryAgain });

/**
 * The element whose whole text is `text`, and none of whose children's is: a line with a name in it,
 * which the name's own element (a `<bdi>`) splits into several text nodes.
 */
export const wholeText = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text && ![...element.children].some((child) => child.textContent === text);

/** "Reviewing as <name>", once the form knows who is signed in. */
export const reviewingAs = (name: string, inside: Pick<typeof screen, "findByText"> = screen) =>
  inside.findByText(wholeText(copy.review.reviewingAs(name)));

/**
 * A review's words as the place's page lists them. Not the form's text box, which holds the same words
 * (React keeps a text box's value as its text too) until the form has gone.
 */
export const reviewWords = (text: string) => screen.findByText(text, { selector: "article p" });
export const noReviewWords = (text: string) => screen.queryByText(text, { selector: "article p" });

/** What the tab holds of the person's own reviews, before the relays send them back. */
export const heldText = () => window.sessionStorage.getItem(HELD_REVIEWS_KEY);

/** The relays the tab says its one held review went to, in any order. */
export const heldRelays = () => new Set((JSON.parse(heldText() ?? "[]") as { relays: string[] }[])[0]?.relays ?? []);
