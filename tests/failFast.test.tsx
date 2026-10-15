import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";
import { screen, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRelayList, readWithin, relayListOf, writeRelaysOf } from "../src/account/writeRelays";
import * as client from "../src/circle/brainstorm";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { changeFollow, type FollowOutcome } from "../src/follow/change";
import { accountShowsUse, readFollowList, readOwnList } from "../src/follow/read";
import type { RelayReader } from "../src/nostr/events";
import { CONNECT_TIMEOUT_MS } from "../src/nostr/relayReader";
import { RecentFeed } from "../src/recent/feed";
import { ScoresStore } from "../src/score/store";
import { buildFollowList, FOLLOW_LIST_TIME } from "./fixtures/follow-list";
import { openApp } from "./support/app";
import { signedInAs } from "./support/followPage";
import { endScene, FRIEND, type Logs, OUTSIDER, startScene, STRANGER } from "./support/followScene";
import { BIG, DIRECTORY, everywhere, NOS, REVIEWS } from "./support/followWorld";
import { createMemoryReader } from "./support/memoryReader";
import { type Noted, noted } from "./support/notedReaders";
import {
  ANA,
  at,
  BEN,
  bothHold,
  followButton,
  followedByLine,
  FRIEND_PROFILES,
  JACAFE,
  listBy,
  lists,
  MAYA,
  MAYA_SECRET,
  mayaFollows,
  readersOf as personReaders,
  scene,
  SOL,
  SOL_PATH,
  solOn,
} from "./support/personScene";
import { fromExplore, newWorld, PLACE_PATH, places, profileOf, rankOf, readersOf, reviewBy, SEARCH, signedIn, writersOf } from "./support/reviewWorld";

/*
 * Who asks a relay not to be waited on when it is out (`failFast`, ruling R40), and who does not.
 * The reads for a follow list ask, each of them, as do those of a person's page: who follows them,
 * and their reviews. So does every read of reviews and of their removals, wherever they are read (a
 * place's page and lists, a person's page, Trending): a relay that is out must not hold up the reviews
 * the others have. Nobody else does: places, scores, names, the house's scorer and its ranks, and the
 * relay list read for a review keep the patience they had. What the option does is the reader's (tests/relayReaderSocket.test.ts); here
 * every relay is held in memory and takes no notice of it, and each request is noted with how it was
 * to be read (tests/support/notedReaders.ts).
 *
 * `changeFollow` is mocked around the real one, as the scene the page tests share has it, and is the
 * real one throughout; Brainstorm's client is mocked. The keys are thrown away, and nothing opens a
 * socket.
 */

vi.mock("../src/follow/change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/change")>();
  return { ...actual, changeFollow: vi.fn(actual.changeFollow) };
});
const change = vi.mocked(changeFollow);

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
});

afterEach(() => endScene(logs));

const FAIL_FAST = { failFast: true };
const signal = () => new AbortController().signal;
/** Whether a request asked not to be waited on. */
const asksNotToWait = ({ opts }: Noted) => opts?.failFast === true;
/** The relays of the requests, in order. */
const urlsOf = (requests: Noted[]) => requests.map(({ url }) => url);
/** The requests for reviews (kind 34259) and for the removals of them (kind 5), in order. */
const reviewReadsOf = (relays: ReturnType<typeof noted>) => relays.asked.filter(({ filter }) => filter.kinds?.includes(34259) === true || filter.kinds?.includes(5) === true);

const KEY = generateSecretKey();
const ME = getPublicKey(KEY);

describe("what stands between a caller and a relay's reader passes the option on", () => {
  const FILTER: NostrFilter = { kinds: [3], authors: [ME], limit: 1 };

  it("readWithin passes it on with the relay's read extras, and makes none up", async () => {
    config.relayReadExtras = { [NOS]: { search: "include:spam" } };
    const relays = noted(() => createMemoryReader([]));

    await readWithin(NOS, FILTER, relays.readers, signal(), 1_000, FAIL_FAST);
    await readWithin(BIG, FILTER, relays.readers, signal(), 1_000, FAIL_FAST);
    await readWithin(NOS, FILTER, relays.readers, signal(), 1_000);

    expect(relays.asked.map(({ url, opts }) => [url, opts])).toEqual([
      [NOS, FAIL_FAST],
      [BIG, FAIL_FAST],
      [NOS, undefined],
    ]);
    expect(relays.asked[0]!.filter).toEqual({ ...FILTER, search: "include:spam" });
  });

  it("readRelayList passes it on to every relay it reads, and makes none up", async () => {
    const relays = noted(() => createMemoryReader([]));

    await readRelayList(ME, relays.readers, signal(), 4_000, FAIL_FAST);
    await readRelayList(ME, relays.readers, signal(), 4_000);

    expect(urlsOf(relays.asked)).toEqual([REVIEWS, DIRECTORY, REVIEWS, DIRECTORY]);
    expect(relays.asked.map(({ opts }) => opts)).toEqual([FAIL_FAST, FAIL_FAST, undefined, undefined]);
  });
});

describe("the reads for a follow list", () => {
  it("each ask it of every relay: the list, the signs of an account's use from the relays and from those asked besides, and the whole read of a person's own list, their relay list with it", async () => {
    const relays = noted(() => createMemoryReader([]));

    await readFollowList(ME, [NOS, DIRECTORY, BIG], relays.readers, signal());
    await accountShowsUse(ME, [NOS, DIRECTORY, BIG], relays.readers, signal(), 3, [REVIEWS]);
    await readOwnList(ME, relays.readers, signal());

    // Three relays for the list; two questions of each of four for the signs of use; and for the
    // whole read, two relays for the relay list and three for the list.
    expect(relays.asked).toHaveLength(3 + 8 + 2 + 3);
    expect(relays.ofKind(3)).toHaveLength(3 + 4 + 3);
    expect(relays.ofKind(0)).toHaveLength(4);
    expect(relays.ofKind(10002)).toHaveLength(2);
    expect(relays.asked.filter((request) => !asksNotToWait(request))).toEqual([]);
  });

  it("ask it in every read of a change: the relay list, the list, and the read-back after it is saved", async () => {
    const list = buildFollowList(KEY);
    const w = everywhere([list]);
    const relays = noted(w.readers);
    const signer: NostrSigner = { getPublicKey: async () => ME, signEvent: async (template) => finalizeEvent(template, KEY) };

    const outcome = await changeFollow({ pubkey: ME, signer, how: "browser" }, STRANGER, "follow", { readers: relays.readers, writers: w.writers, now: () => FOLLOW_LIST_TIME + 500 }, signal());

    expect(outcome).toMatchObject({ kind: "saved", confirmed: true } satisfies Partial<FollowOutcome>);
    // The relay list from two relays, the list from three, and the list read back from the three that took it.
    expect(relays.ofKind(10002)).toHaveLength(2);
    expect(relays.ofKind(3)).toHaveLength(6);
    expect(relays.asked).toHaveLength(8);
    expect(relays.asked.filter((request) => !asksNotToWait(request))).toEqual([]);
  });

  it("ask it of the relays that are asked whether a new account has been used, in a change that starts a first list", async () => {
    const w = everywhere([]);
    const relays = noted(w.readers);
    const signer: NostrSigner = { getPublicKey: async () => ME, signEvent: async (template) => finalizeEvent(template, KEY) };

    const outcome = await changeFollow({ pubkey: ME, signer, how: "browser" }, STRANGER, "follow", { readers: relays.readers, writers: w.writers, now: () => FOLLOW_LIST_TIME + 500 }, signal());

    expect(outcome.kind).toBe("saved");
    // A profile and a follower asked of each of the three follow-list relays and of the review relay.
    expect(relays.ofKind(0)).toHaveLength(4);
    expect(relays.ofKind(3).filter(({ filter }) => filter["#p"] !== undefined)).toHaveLength(4);
    expect(relays.asked.filter((request) => !asksNotToWait(request))).toEqual([]);
  });
});

describe("the relay list read for a review", () => {
  it("does not ask it: a review waits for the person's relays as it always has", async () => {
    const relays = noted(() => createMemoryReader([]));
    const signer: NostrSigner = { getPublicKey: async () => ME, signEvent: async () => Promise.reject(new Error("These tests sign nothing here")) };

    await writeRelaysOf(ME, signer, relays.readers, signal());
    await relayListOf(ME, relays.readers, signal());

    expect(relays.ofKind(10002)).toHaveLength(4);
    expect(relays.asked.map(({ opts }) => opts)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("on a person's page", () => {
  it("is asked by the read of the person signed in's own list, by who follows the person among them, by their names, and by the person's reviews and their removals; and by nothing else the page reads", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [mayaFollows([ANA, BEN]), listBy(ANA, [SOL]), listBy(BEN, [SOL])] });
    s.search.held.push(...FRIEND_PROFILES);
    s.house.ranks.push(rankOf(SOL, 80));
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const relays = noted(personReaders(s));

    await openApp(SOL_PATH, { events: places, readers: relays.readers, writers: (url) => s.follows.relays[url]?.writer ?? writersOf(s.house)(url) });
    await screen.findByRole("heading", { level: 1, name: "Sol" });
    await lists([JACAFE]);
    await waitFor(() => expect(followedByLine()).toHaveTextContent("Followed by Ana and Ben, people you follow"));
    await waitFor(() => expect(followButton()).toBeInTheDocument());

    const by = (authors: string) => (request: Noted) => request.filter.authors?.includes(authors) === true;
    // Her own list, and her relay list on the way to it.
    const ownList = relays.ofKind(3).filter(by(MAYA));
    expect(ownList).toHaveLength(3);
    expect(relays.ofKind(10002).length).toBeGreaterThan(0);
    // Who of those on it follows Sol, and their names.
    const followers = relays.ofKind(3).filter(({ filter }) => filter["#p"]?.includes(SOL) === true);
    expect(followers).toHaveLength(3);
    const followersNames = relays.ofKind(0).filter(by(ANA));
    expect(followersNames.length).toBeGreaterThan(0);
    // Sol's reviews, by their author, and then the removals of those the relays sent.
    const reviews = relays.ofKind(34259).filter(by(SOL));
    expect(reviews.length).toBeGreaterThan(0);
    await waitFor(() => expect(relays.ofKind(5)).toHaveLength(4));
    const removals = relays.ofKind(5);
    const asking = [...ownList, ...relays.ofKind(10002), ...followers, ...followersNames, ...reviews, ...removals];
    expect(asking.filter((request) => !asksNotToWait(request))).toEqual([]);

    // Everything else the page read was read as ever: Sol's own name, the house's scorer and its ranks.
    const rest = relays.asked.filter((request) => !asking.includes(request));
    expect(rest.filter(by(SOL)).filter(({ filter }) => filter.kinds?.includes(0)).length).toBeGreaterThan(0);
    expect(rest.map(({ opts }) => opts).filter((opts) => opts !== undefined)).toEqual([]);
    expect(relays.asked.filter(asksNotToWait)).toHaveLength(asking.length);
  });
});

describe("on a place's page, and on Trending", () => {
  /** Jacafé's page, with reviews by Fay, by Sol and by Odile, for a person signed in whose list names Fay, or for nobody. */
  async function openPlace(path: string, signIn: boolean) {
    config.reviewRelays = [SEARCH];
    const reviews = newWorld();
    const me = signIn ? signedIn(reviews, { name: "Maya" }) : undefined;
    const follows = everywhere(me === undefined ? [] : [buildFollowList(me.key)]);
    reviews.search.push(profileOf(FRIEND, "Fay"), profileOf(STRANGER, "Sol"), profileOf(OUTSIDER, "Odile"));
    reviews.ranks.push(rankOf(FRIEND, 80), rankOf(STRANGER, 70));
    reviews.search.push(reviewBy(FRIEND, 5, "Get the bolo"), reviewBy(STRANGER, 4, "Sit outside"), reviewBy(OUTSIDER, 2, "Too loud"));
    const relays = noted((url) => follows.relays[url]?.reader ?? readersOf(reviews)(url));
    await openApp(path, {
      events: places,
      entries: fromExplore(path),
      readers: relays.readers,
      writers: (url) => follows.relays[url]?.writer ?? writersOf(reviews)(url),
    });
    return relays;
  }

  it("is asked by the reads of a place's reviews and their removals for someone signed out, and by none of its others: names, the house's scorer and its ranks", async () => {
    const relays = await openPlace(PLACE_PATH, false);
    await screen.findByRole("heading", { level: 3, name: "Sol" });
    await waitFor(() => expect(relays.ofKind(5).length).toBeGreaterThan(0));

    const reviews = reviewReadsOf(relays);
    expect(relays.ofKind(34259).length).toBeGreaterThan(0);
    expect(reviews.filter((request) => !asksNotToWait(request))).toEqual([]);
    expect(relays.ofKind(0).length).toBeGreaterThan(0);
    expect(relays.ofKind(10040).length).toBeGreaterThan(0);
    expect(relays.ofKind(30382).length).toBeGreaterThan(0);
    const rest = relays.asked.filter((request) => !reviews.includes(request));
    expect(rest.map(({ opts }) => opts).filter((opts) => opts !== undefined)).toEqual([]);
  });

  it("is asked besides only by the read of their follow list for a person signed in: the place's other reads are as they were", async () => {
    const relays = await openPlace(PLACE_PATH, true);
    await waitFor(() => expect(screen.getByRole("button", { name: copy.follow.followNamed("Sol") })).toBeInTheDocument());

    const reviews = reviewReadsOf(relays);
    const forTheList = relays.asked.filter(asksNotToWait).filter((request) => !reviews.includes(request));
    expect(forTheList.length).toBeGreaterThan(0);
    expect(forTheList.every(({ filter }) => filter.kinds?.length === 1 && (filter.kinds[0] === 3 || filter.kinds[0] === 10002))).toBe(true);
    expect([...relays.ofKind(3), ...relays.ofKind(10002)].filter((request) => !asksNotToWait(request))).toEqual([]);
    expect(relays.ofKind(34259).length).toBeGreaterThan(0);
    expect(reviews.filter((request) => !asksNotToWait(request))).toEqual([]);
  });

  it("is asked by Trending's reads of the reviews and their removals, and by none of its others", async () => {
    const relays = await openPlace("/trending", false);
    await screen.findByRole("heading", { level: 1, name: copy.pages.recent });
    await waitFor(() => expect(relays.ofKind(34259).length).toBeGreaterThan(0));
    await screen.findByText("Sit outside");
    await waitFor(() => expect(relays.ofKind(5).length).toBeGreaterThan(0));

    const reviews = reviewReadsOf(relays);
    expect(reviews.filter((request) => !asksNotToWait(request))).toEqual([]);
    const rest = relays.asked.filter((request) => !reviews.includes(request));
    expect(rest.map(({ opts }) => opts).filter((opts) => opts !== undefined)).toEqual([]);
  });
});

describe("a relay reviews are read from that is out", () => {
  /** A review relay that is out, in these tests. */
  const REFUSING = "wss://refusing.example.test";

  /**
   * A relay that refuses every connection, as the app's reader meets one (tests/relayReaderSocket.test.ts):
   * a read that asks not to be waited on fails at once; any other waits out the reader's connect limit first.
   */
  const refusing: RelayReader = {
    async *req(_filter, signal, opts) {
      if (opts?.failFast !== true) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, CONNECT_TIMEOUT_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      }
      throw new DOMException(`${REFUSING} refused the connection`, "NetworkError");
    },
  };

  /** The relays: the search relay holds `events`, the refusing one refuses, and any other has nothing. */
  const relaysWith = (events: NostrEvent[]) => noted((url) => (url === REFUSING ? refusing : createMemoryReader(url === SEARCH ? events : [])));

  // The scene's timers are fake (tests/support/followScene.ts): the connect limit passes only when a test moves them on.
  beforeEach(() => {
    config.reviewRelays = [SEARCH, REFUSING];
  });

  it("holds up no place's reviews: they show from the relay that answers, long before the connect limit", async () => {
    const review = reviewBy(FRIEND, 5, "Get the bolo");
    const relays = relaysWith([review]);
    const store = new ScoresStore(relays.readers);
    store.start();
    try {
      store.want([JACAFE.address]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.readStateOf(JACAFE.address)).toBe("read");
      expect(store.reviewsOf(JACAFE.address).map(({ id }) => id)).toEqual([review.id]);
      expect(CONNECT_TIMEOUT_MS).toBe(20_000);
      // The reviews were asked of both, and their removals of the relay that answered, none to be waited on.
      expect(reviewReadsOf(relays).map(({ url }) => url)).toEqual([SEARCH, SEARCH, REFUSING, REFUSING, SEARCH, SEARCH]);
      expect(reviewReadsOf(relays).filter((request) => !asksNotToWait(request))).toEqual([]);
    } finally {
      store.stop();
    }
  });

  it("holds up no page of Trending: it shows from the relay that answers, long before the connect limit", async () => {
    const review = reviewBy(FRIEND, 5, "Get the bolo");
    const relays = relaysWith([review]);
    const feed = new RecentFeed(relays.readers);
    feed.start();
    try {
      feed.open();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(feed.snapshot().first).toBe("read");
      expect(feed.snapshot().events.map(({ id }) => id)).toEqual([review.id]);
      expect(reviewReadsOf(relays).map(({ url }) => url)).toEqual([SEARCH, REFUSING, SEARCH, SEARCH]);
      expect(reviewReadsOf(relays).filter((request) => !asksNotToWait(request))).toEqual([]);
    } finally {
      feed.stop();
    }
  });
});
