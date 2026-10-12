import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { screen, waitFor, within } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect } from "vitest";

import { config } from "../../src/config";
import { copy } from "../../src/copy/en";
import type { RelayReader } from "../../src/nostr/events";
import { personPath } from "../../src/person/npub";
import { parsePlaces } from "../../src/places/load";
import type { Place } from "../../src/places/place";
import { REVIEW_KIND } from "../../src/reviews/review";
import { buildFollowList, FOLLOW_LIST_TIME, pubkeyAt } from "../fixtures/follow-list";
import { openApp } from "./app";
import { shapedEvent } from "./events";
import { signedInAs } from "./followPage";
import { asksForFollower, asksForList, everywhere, FOLLOW_RELAYS, relay, type Relay, type RelayOptions, type World as FollowWorld, world } from "./followWorld";
import { newWorld, NOW_S, places, profileOf, readersOf as houseReadersOf, reviewOfPlace, SEARCH, writersOf } from "./reviewWorld";

/*
 * What the tests of a person's page share (tests/personPage.test.tsx, tests/personReviews.test.tsx,
 * tests/personFollow.test.tsx, tests/personFollowedBy.test.tsx): the people, the places, the relays
 * held in memory, the page opened over them in the app itself, and what a test looks for on it.
 *
 * Each of those files mocks `changeFollow` (around the real one) and Brainstorm's client itself, as a
 * mock must be made in the file that is tested, and starts and ends each test as the Follow button's
 * do (tests/support/followScene.ts). The keys are thrown away, and nothing opens a socket.
 */

// ---------------------------------------------------------------------------------------------
// The people, the places and the relays.
// ---------------------------------------------------------------------------------------------

/** The reviewer whose page it is, Sol, and the person who looks at it, Maya. Their keys are thrown away. */
export const SOL_SECRET = generateSecretKey();
export const SOL = getPublicKey(SOL_SECRET);
export const MAYA_SECRET = generateSecretKey();
export const MAYA = getPublicKey(MAYA_SECRET);
export const SOL_PATH = personPath(SOL);

/** A second review relay, beside Brainstorm's search relay, and a third for the tests that read three. */
export const SECOND = "wss://second.example.test";
export const THIRD = "wss://third.example.test";

/** The places on the list, in the fixture's order. */
export const LISTED = parsePlaces(places);
export const placeAt = (d: string): Place => LISTED.find((place) => place.d === d)!;
export const JACAFE = placeAt("osm-node-11330857543");
export const MAIA = placeAt("osm-node-10169374926");
export const MUSEU = placeAt("osm-node-1782789982");
export const placePath = (place: Place) => `/place/${encodeURIComponent(place.d)}`;
/** A place that is not on the list, the `i`th: it came off it, or never was on it. */
export const unlisted = (i: number) => ({ ...JACAFE, address: `39999:${config.houseHex}:gone-${i}`, d: `gone-${i}`, name: `Gone ${i}` });

/** A minute, in seconds. The `i`th newest of reviews written a minute apart is `at(i)`. */
export const MINUTE = 60;
export const at = (i: number) => NOW_S - MINUTE * (i + 1);

/** Sol's review of `place`. */
export const solOn = (place: Place, stars: number | null, text: string, createdAt: number) => reviewOfPlace(SOL, place, stars, text, createdAt);

/**
 * What the relays hold: the review relays (reviews and profiles: Brainstorm's search relay and a
 * second, and a third when a test asks for one), the follow-list relays, and the house's ranks.
 */
export interface Scene {
  search: Relay;
  second: Relay;
  /** The third review relay; undefined unless the test asked for three. */
  third: Relay | undefined;
  follows: FollowWorld;
  house: ReturnType<typeof newWorld>;
}

export function scene(
  opts: { search?: RelayOptions; second?: RelayOptions; third?: RelayOptions; follows?: NostrEvent[]; followRelays?: Record<string, Relay> } = {},
): Scene {
  config.reviewRelays = opts.third === undefined ? [SEARCH, SECOND] : [SEARCH, SECOND, THIRD];
  return {
    search: relay([profileOf(SOL, "Sol"), profileOf(MAYA, "Maya")], opts.search),
    second: relay([], opts.second),
    third: opts.third === undefined ? undefined : relay([], opts.third),
    follows: opts.followRelays === undefined ? everywhere(opts.follows ?? []) : world(opts.followRelays),
    house: newWorld(),
  };
}

export const readersOf =
  (s: Scene) =>
  (url: string): RelayReader => {
    if (url === SEARCH) return s.search.reader;
    if (url === SECOND) return s.second.reader;
    if (url === THIRD && s.third !== undefined) return s.third.reader;
    return s.follows.relays[url]?.reader ?? houseReadersOf(s.house)(url);
  };

/** Every review relay holds `events`. */
export function bothHold(s: Scene, events: NostrEvent[]): void {
  s.search.held.push(...events);
  s.second.held.push(...events);
  s.third?.held.push(...events);
}

export const asksForReviews = (filter: NostrFilter) => filter.kinds?.includes(REVIEW_KIND) === true;
/** What the relay was asked for reviews, in order. */
export const reviewAsks = (from: Relay) => from.asked.filter(asksForReviews);

/** The app at `path`, over the relays of `s`; `events` are the places on the list, when they are not the fixture's. */
export async function open(s: Scene, path = SOL_PATH, { events = places, ...opts }: { px?: number; entries?: string[]; strict?: boolean; events?: NostrEvent[] } = {}) {
  return openApp(path, {
    events,
    readers: readersOf(s),
    writers: (url) => s.follows.relays[url]?.writer ?? writersOf(s.house)(url),
    ...opts,
  });
}

/** Sol's page, once it is in. */
export async function openSol(s: Scene, opts: Parameters<typeof open>[2] = {}) {
  const app = await open(s, SOL_PATH, opts);
  await screen.findByRole("heading", { level: 1, name: "Sol" });
  return app;
}

// ---------------------------------------------------------------------------------------------
// What the page shows.
// ---------------------------------------------------------------------------------------------

export const main = () => screen.getByRole("main");
/** The page's header: the person's picture and name, and what is about them. */
export const header = () => main().querySelector("header")!;
/**
 * Fails when the page shows or says a word of the network's (decision 12): the person is named in the
 * address bar by their code, and nowhere on the page, in its text or in what a screen reader hears.
 */
export function expectNoProtocolWords(): void {
  const words = /npub|nostr|\brelays?\b|\bkeys?\b|pubkey|\bevents?\b/i;
  expect(main().textContent).not.toMatch(words);
  for (const element of main().querySelectorAll("*")) {
    for (const attribute of ["aria-label", "aria-description", "title", "alt"]) expect(element.getAttribute(attribute) ?? "").not.toMatch(words);
  }
}
/** The part of the page with the person's reviews, under its heading. */
export const reviewsPart = () => within(main()).getByRole("region", { name: copy.person.reviews });
/** Each review's link to its place, in the order the page lists them: the place's name is its heading. */
export const placeLinks = () =>
  within(reviewsPart())
    .queryAllByRole("heading", { level: 3 })
    .map((heading) => within(heading).getByRole("link"));
/** The places reviewed, as the page lists them, in order, each by the address of its page: two places may have one name. */
export const listed = () => placeLinks().map((link) => link.getAttribute("href"));
export const pathsOf = (reviewed: readonly Place[]) => reviewed.map(placePath);
/** The review of `place`. */
export const reviewOf = (place: Place) => placeLinks().find((link) => link.getAttribute("href") === placePath(place))!.closest("article")!;
export const showMore = () => within(reviewsPart()).queryByRole("button", { name: copy.person.showMore });
export const tryAgain = () => within(reviewsPart()).queryByRole("button", { name: copy.person.retry });
/** Waits until the page lists exactly the reviews of `reviewed`, in order. */
export const lists = (reviewed: readonly Place[]) => waitFor(() => expect(listed()).toEqual(pathsOf(reviewed)));

// ---------------------------------------------------------------------------------------------
// The Follow button on the page.
// ---------------------------------------------------------------------------------------------

/** Maya's follow list, of 1,200 entries, which does not name Sol; and one that does, made a minute later. */
export const MAYA_LIST = buildFollowList(MAYA_SECRET);
export const MAYA_LIST_WITH_SOL = finalizeEvent(
  { kind: 3, created_at: FOLLOW_LIST_TIME + 60, content: MAYA_LIST.content, tags: [...MAYA_LIST.tags, ["p", SOL]] },
  MAYA_SECRET,
);

export const followButton = () => within(main()).queryByRole("button", { name: copy.follow.followNamed("Sol") });
export const followingButton = () => within(main()).queryByRole("button", { name: copy.follow.followingNamed("Sol") });
/** The link to sign in that stands for the button while nobody is signed in. */
export const followLink = () => within(main()).queryByRole("link", { name: copy.follow.followNamed("Sol") });
/** Everything on the page that says what the Follow button can say (Follow, Following, Unfollow, Saving…): the button, or the link to sign in. */
export const followControls = () => [...main().querySelectorAll("button, a")].filter((control) => /^(?:Follow|Following|Unfollow|Saving…)$/.test(control.textContent ?? ""));
/** How many times each follow-list relay was asked for a follow list by its author, in their order. */
export const listReads = (follows: FollowWorld) => FOLLOW_RELAYS.map((url) => follows.relays[url]!.asked.filter(asksForList).filter((filter) => filter["#p"] === undefined).length);
/** The newest follow list of Maya's that the relay at `url` holds. */
export const newestOn = (follows: FollowWorld, url: string) =>
  follows.relays[url]!.held.filter((event) => event.kind === 3 && event.pubkey === MAYA).sort((a, b) => b.created_at - a.created_at)[0];
/** The part of the phone's header that `within` is in: the header is a grid, and each of its children is placed in it by its classes. */
export const headerCell = (within: Element) => [...header().children].find((cell) => cell.contains(within)) as HTMLElement;

/** The elements in `part` that have nothing in them, but for a picture: what an absent button would leave behind. */
export const hollow = (part: Element) => [...part.querySelectorAll<HTMLElement>("*")].filter((each) => each.childElementCount === 0 && each.textContent === "" && each.tagName !== "IMG");
/** A class that makes an element take room, or draws a box, though it is empty. */
export const TAKES_ROOM = /(?:^|\s)(?:wide:)?(?:min-h-|h-|size-|p[xytrbl]?-|border|bg-|rounded)/;

// ---------------------------------------------------------------------------------------------
// Who follows them, of the people the person signed in follows.
// ---------------------------------------------------------------------------------------------

/** People Maya may follow: Ana, Ben, Cleo, Dev and Eli, by name; Flo, whose profile gives no name; and Zed, who follows nobody. */
export const [ANA, BEN, CLEO, DEV, ELI, FLO, ZED] = [1, 2, 3, 4, 5, 6, 7].map((i) => pubkeyAt(30_000 + i)) as [string, string, string, string, string, string, string];
export const FRIEND_PROFILES = [profileOf(ANA, "Ana"), profileOf(BEN, "Ben"), profileOf(CLEO, "Cleo"), profileOf(DEV, "Dev"), profileOf(ELI, "Eli"), profileOf(ZED, "Zed")];

/** A follow list by `author` that names `whom`, made `at` seconds after the lists' first. Not signed: nothing here checks. */
export const listBy = (author: string, whom: string[], at = 0) =>
  shapedEvent({ kind: 3, pubkey: author, created_at: FOLLOW_LIST_TIME + at, tags: whom.map((key) => ["p", key]) });
/** Maya's own list, naming `whom` in that order. */
export const mayaFollows = (whom: string[]) =>
  finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: whom.map((key) => ["p", key]) }, MAYA_SECRET);

/** What a follow-list relay was asked about who follows someone, in order. */
export const followerAsks = (from: Relay) => from.asked.filter(asksForFollower);
/** The line that says who follows the page's person, when the page has one. */
export const followedByLine = () => within(main()).queryByText((_, element) => element?.tagName === "P" && /^Followed by /.test(element.textContent ?? ""));

/**
 * How a follow-list relay answers when it is asked who follows someone: each such request is noted as
 * it comes (`asks`, with the signal it came with), and then waits for `until`, fails, or is never
 * answered. Everything else it is asked, it answers as it would.
 */
export function followerReads(then: { until: Promise<void> } | "fails" | "silent") {
  const asks: NostrFilter[] = [];
  const signals: AbortSignal[] = [];
  const reads: RelayOptions["reads"] = (reader) => ({
    async *req(filter, signal) {
      if (asksForFollower(filter)) {
        asks.push(filter);
        signals.push(signal);
        if (then === "fails") throw new Error("this relay does not take that");
        if (then === "silent") await new Promise<never>(() => {});
        else await then.until;
      }
      yield* reader.req(filter, signal);
    },
  });
  return { asks, signals, reads };
}

/** Maya is signed in and follows `follows`; `followers` of them follow Sol; and the page is Sol's. */
export async function openFollowedBy(follows: string[], followers: string[], opts: { px?: number } = {}) {
  signedInAs(MAYA_SECRET);
  const s = scene({ follows: [mayaFollows(follows), ...followers.map((author) => listBy(author, [ZED, SOL]))] });
  s.search.held.push(...FRIEND_PROFILES);
  bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
  const app = await openSol(s, opts);
  return { ...app, s };
}
