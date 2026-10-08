import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type JSX, memo, type ReactNode, StrictMode, useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForgetOnSignOut } from "../src/account/forgetOnSignOut";
import { SESSION_KEY } from "../src/account/session";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import type { Place } from "../src/places/place";
import { PlacesProvider } from "../src/places/store";
import { REVIEW_KIND } from "../src/reviews/review";
import { ScoresProvider, useScoresStore } from "../src/score/ScoresProvider";
import { FLUSH_WINDOW_MS, HELD_REVIEWS_KEY, REMOVED_REVIEWS_KEY } from "../src/score/store";
import { useListScores } from "../src/score/useListScores";
import { useNames, useOwnPicture, useScore, useScoreActions, useScores } from "../src/score/useScore";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, PHONE, resetWidth } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader, type MemoryReader } from "./support/memoryReader";

const places: NostrEvent[] = raw;
const FILER = places[0]!.pubkey;
const JACAFE = `39999:${FILER}:osm-node-11330857543`;
/** Jacafé filed a second time, under another d, with the same OSM id (brief § 4.3). */
const JACAFE_AGAIN = `39999:${FILER}:jacafe-again`;
const OTHER = `39999:${FILER}:${places[1]!.tags.find((tag) => tag[0] === "d")![1]}`;

/** Brainstorm's search relay, which keeps the reviews, and another review relay that is not a search relay. */
const SEARCH = "wss://search.brainstorm.world";
const MIRROR = "wss://reviews.example.test";
/** Where the house's kind 10040 is read. */
const TRUST = "wss://scores.brainstorm.world";
/** A made-up scorer and its relay: the house's real one is never written into the app or its tests. */
const SCORER = hex64("5");
const SCORER_RELAY = "wss://ranks.example.test";

const [ALICE, BOB, CAROL, DAVE, ERIN] = ["a", "b", "c", "d", "e"].map(hex64) as [string, string, string, string, string];

/** A synthetic place address, one of many: none of them is a place in the list, so none has another filing. */
const placeNo = (n: number) => `39999:${FILER}:osm-node-${1_000_000 + n}`;

/** The house's kind 10040, naming `SCORER` at `SCORER_RELAY`. */
const trustList = () =>
  shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", SCORER, SCORER_RELAY]] });

/** `SCORER`'s kind 30382 giving `subject` the rank `rank`. */
const rankOf = (subject: string, rank: number) =>
  shapedEvent({ kind: 30382, pubkey: SCORER, tags: [["d", subject], ["rank", String(rank)]] });

/** `reviewer`'s review of the place at `address` with `stars`, as the app writes them (decision 17). */
const reviewOf = (reviewer: string, address: string, stars: number, fields: Partial<NostrEvent> = {}) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    tags: [
      ["d", `place:${address}`],
      ["a", address],
      ["m", "place"],
      ["s", String(stars)],
    ],
    ...fields,
  });

/** `pubkey`'s profile (kind 0) with `content`, as JSON unless it is text already. */
const profileOf = (pubkey: string, content: object | string, fields: Partial<NostrEvent> = {}) =>
  shapedEvent({ kind: 0, pubkey, content: typeof content === "string" ? content : JSON.stringify(content), ...fields });

/** Jacafé's place event under another d: the same place, filed twice. */
const jacafeAgain = (): NostrEvent => {
  const jacafe = places[0]!;
  return {
    ...jacafe,
    id: hex64("9"),
    tags: jacafe.tags.map((tag) => (tag[0] === "d" ? ["d", "jacafe-again"] : tag)),
  };
};

/** A reader that answers nothing until it is opened, and keeps each request's signal. */
interface HeldReader extends MemoryReader {
  readonly signals: AbortSignal[];
  open(): void;
}

/** Holds every request from the `from`th on (counting from 0); the ones before it answer at once. */
function heldReader(events: NostrEvent[], { from = 0 }: { from?: number } = {}): HeldReader {
  const memory = createMemoryReader(events);
  const signals: AbortSignal[] = [];
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    requests: memory.requests,
    signals,
    open,
    async *req(filter, signal) {
      signals.push(signal);
      if (signals.length <= from) {
        yield* memory.req(filter, signal);
        return;
      }
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

/** A reader that fails every request while `down`, counting the failures, and answers from `events` otherwise. */
interface SwitchedReader extends MemoryReader {
  down: boolean;
  readonly failed: number;
}

function switchedReader(events: NostrEvent[]): SwitchedReader {
  const memory = createMemoryReader(events);
  let failed = 0;
  let down = false;
  return {
    requests: memory.requests,
    get down() {
      return down;
    },
    set down(value: boolean) {
      down = value;
    },
    get failed() {
      return failed;
    },
    async *req(filter, signal) {
      if (down) {
        memory.requests.push(filter);
        failed += 1;
        throw new Error("The relay answered 503");
      }
      yield* memory.req(filter, signal);
    },
  };
}

/**
 * A reader whose every request waits until the test lets it go (`release`), and which counts how
 * many requests `counts` picks (by default, for reviews by place address, `#a`) were waiting or being
 * answered at once: the batches it had in flight.
 */
interface GatedReader extends MemoryReader {
  /** Lets go of every request waiting now. Returns how many there were. */
  release(): number;
  /** The most requests that `counts` picks in flight at one time. */
  readonly mostBatches: number;
  /** The `#a` of every request, in the order they were sent. */
  readonly sent: (string[] | undefined)[];
}

function gatedReader(
  events: NostrEvent[],
  counts: (filter: NostrFilter) => boolean = (filter) => filter["#a"] !== undefined,
): GatedReader {
  const memory = createMemoryReader(events);
  const waiting: (() => void)[] = [];
  const sent: (string[] | undefined)[] = [];
  let inFlight = 0;
  let most = 0;
  return {
    requests: memory.requests,
    sent,
    get mostBatches() {
      return most;
    },
    release() {
      const now = waiting.splice(0);
      for (const go of now) go();
      return now.length;
    },
    async *req(filter, signal) {
      const batch = counts(filter);
      sent.push(filter["#a"]);
      if (batch) {
        inFlight += 1;
        most = Math.max(most, inFlight);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          waiting.push(resolve);
        });
        yield* memory.req(filter, signal);
      } finally {
        if (batch) inFlight -= 1;
      }
    },
  };
}

/** The relays read that the test did not set up. Each test must read none (checked after it). */
const unexpectedReads: string[] = [];

/**
 * The relays of a test, by URL: `readers` gives the reader of each. A relay the test did not set up
 * fails its read, and is noted in `unexpectedReads`.
 */
function network(relays: Record<string, RelayReader>) {
  const readers = vi.fn((url: string): RelayReader => {
    const reader = relays[url];
    if (reader !== undefined) return reader;
    unexpectedReads.push(url);
    return {
      async *req() {
        throw new Error(`No relay at ${url} in this test`);
      },
    };
  });
  return { readers };
}

/** The usual relays: the house's 10040 on `TRUST`, `ranks` on `SCORER_RELAY`, and `reviews` on `SEARCH`. */
function houseNetwork(reviews: NostrEvent[], ranks: NostrEvent[], extra: Record<string, RelayReader> = {}) {
  const search = createMemoryReader(reviews);
  const trust = createMemoryReader([trustList()]);
  const scorer = createMemoryReader(ranks);
  return { search, trust, scorer, ...network({ [SEARCH]: search, [TRUST]: trust, [SCORER_RELAY]: scorer, ...extra }) };
}

/** Renders `hook` inside the places (read from `placeEvents`) and the scores store, reading from `readers`. */
function renderStore<P, T>(
  hook: (props: P) => T,
  opts: { readers?: (url: string) => RelayReader; initialProps?: P; strict?: boolean; placeEvents?: NostrEvent[] } = {},
) {
  const placesReader = createMemoryReader(opts.placeEvents ?? places);
  return renderHook(hook, {
    initialProps: opts.initialProps as P,
    wrapper: ({ children }: { children: ReactNode }) => {
      const tree = (
        <PlacesProvider reader={placesReader}>
          <ScoresProvider readers={opts.readers}>{children}</ScoresProvider>
        </PlacesProvider>
      );
      return opts.strict ? <StrictMode>{tree}</StrictMode> : tree;
    },
  });
}

/**
 * Lets every queued step run: effects, the store's window for gathering what pages ask (so that a
 * check that nothing was asked for means something), and reads that answer at once.
 */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, FLUSH_WINDOW_MS + 10)));
  for (let i = 0; i < 5; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** The requests a review relay was sent for reviews by place address (`#a`), in order. */
const byA = (reader: MemoryReader) => reader.requests.filter((filter) => filter["#a"] !== undefined);
/** The requests a review relay was sent for reviews by their `d`, in order. */
const byD = (reader: MemoryReader) => reader.requests.filter((filter) => filter["#d"] !== undefined);
/** The `#a` of every request for reviews by place address, in order. */
const batchesOf = (reader: MemoryReader) => byA(reader).map((filter) => filter["#a"]);
/** The `d` a review of each of `batch` may have: the bare address, or after `place:` (decision 16). */
const dsOf = (batch: readonly string[]) => [...batch, ...batch.map((address) => `place:${address}`)];
/** The ids of `reviews`, in order. */
const idsOf = (reviews: readonly { id: string }[]) => reviews.map((review) => review.id);

afterEach(() => {
  vi.doUnmock("../src/nostr/relayReader");
  vi.resetModules();
  resetWidth();
  expect(unexpectedReads.splice(0)).toEqual([]);
});

describe("ScoresProvider: what it reads", () => {
  it("sends no request at all when there are no review relays, and gives no score", async () => {
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 4)], [rankOf(ALICE, 80)]);
    const addresses = Array.from({ length: 50 }, (_, n) => placeNo(n)).concat(JACAFE);
    const { result } = renderStore(() => useScores(addresses), { readers });

    await settle();
    expect(readers).not.toHaveBeenCalled();
    expect(result.current.scores.size).toBe(0);
    expect(result.current.house).toBe("idle");
  });

  it("asks for reviews by #a and by #d, 50 places to a request, with include:spam on the search relay only", async () => {
    config.reviewRelays = [SEARCH, MIRROR];
    const mirror = createMemoryReader([]);
    const { readers, search } = houseNetwork([], [], { [MIRROR]: mirror });
    const addresses = Array.from({ length: 120 }, (_, n) => placeNo(n));
    renderStore(() => useScores(addresses), { readers });

    await waitFor(() => expect(search.requests).toHaveLength(6));
    expect(batchesOf(search).map((batch) => batch?.length)).toEqual([50, 50, 20]);
    expect(batchesOf(search).flat()).toEqual(addresses);
    // The same places by the d of their reviews: the bare address and place: (decision 16).
    expect(byD(search).map((filter) => filter["#d"])).toEqual(batchesOf(search).map((batch) => dsOf(batch ?? [])));
    for (const filter of search.requests) {
      expect(filter).toMatchObject({ kinds: [REVIEW_KIND], limit: 500, search: "include:spam" });
      expect(filter["#a"] === undefined).not.toBe(filter["#d"] === undefined);
    }

    await waitFor(() => expect(mirror.requests).toHaveLength(6));
    expect(batchesOf(mirror)).toEqual(batchesOf(search));
    expect(byD(mirror).map((filter) => filter["#d"])).toEqual(byD(search).map((filter) => filter["#d"]));
    for (const filter of mirror.requests) {
      expect(filter).toMatchObject({ kinds: [REVIEW_KIND] });
      expect(filter).not.toHaveProperty("search");
    }
  });

  it("finds reviews that name the place by their d alone, bare or after place: (decision 16)", async () => {
    config.reviewRelays = [SEARCH];
    // Reviews written by other apps, with no a tag.
    const bare = shapedEvent({ kind: REVIEW_KIND, pubkey: ALICE, tags: [["d", JACAFE], ["s", "5"]] });
    const prefixed = shapedEvent({ kind: REVIEW_KIND, pubkey: BOB, tags: [["d", `place:${JACAFE}`], ["s", "3"]] });
    const { readers, search } = houseNetwork([bare, prefixed], [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result } = renderStore(() => useScore(JACAFE), { readers });

    await waitFor(() => expect(result.current.score?.counted).toBe(2));
    expect(result.current.score?.score).toBeCloseTo((0.8 * 5 + 0.3 * 3) / 1.1, 10);
    expect(byD(search)).toEqual([
      { kinds: [REVIEW_KIND], "#d": [JACAFE, `place:${JACAFE}`], limit: 500, search: "include:spam" },
    ]);
    expect(byA(search)).toEqual([{ kinds: [REVIEW_KIND], "#a": [JACAFE], limit: 500, search: "include:spam" }]);
  });

  it("asks in one go for what pages ask within 50 ms, and for what they ask later in the next", async () => {
    config.reviewRelays = [SEARCH];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { readers, search } = houseNetwork([], []);
      const { rerender } = renderStore(({ addresses }: { addresses: string[] }) => useScores(addresses), {
        readers,
        initialProps: { addresses: [placeNo(1)] },
      });
      const pass = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });

      // A list shown a few cards at a time, and a map panned: three asks inside the window.
      await pass(20);
      rerender({ addresses: [placeNo(1), placeNo(2)] });
      await pass(20);
      rerender({ addresses: [placeNo(1), placeNo(2), placeNo(3)] });
      await pass(9);
      expect(search.requests).toEqual([]);
      await pass(1);
      expect(batchesOf(search)).toEqual([[placeNo(1), placeNo(2), placeNo(3)]]);

      rerender({ addresses: [placeNo(1), placeNo(4)] });
      await pass(49);
      expect(batchesOf(search)).toHaveLength(1);
      await pass(1);
      expect(batchesOf(search)).toEqual([[placeNo(1), placeNo(2), placeNo(3)], [placeNo(4)]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for each place once a session, however many times and places ask", async () => {
    config.reviewRelays = [SEARCH];
    const { readers, search } = houseNetwork([], []);
    const { result, rerender } = renderStore(({ addresses }: { addresses: string[] }) => useScores(addresses), {
      readers,
      initialProps: { addresses: [placeNo(1), placeNo(2)] },
    });
    await waitFor(() => expect(result.current.scores.size).toBe(2));

    rerender({ addresses: [placeNo(2), placeNo(1)] });
    rerender({ addresses: [placeNo(1), placeNo(2), placeNo(3)] });
    await waitFor(() => expect(result.current.scores.size).toBe(3));
    await settle();
    expect(batchesOf(search)).toEqual([[placeNo(1), placeNo(2)], [placeNo(3)]]);
  });

  it("sends one request a batch under StrictMode, which mounts twice", async () => {
    config.reviewRelays = [SEARCH];
    const { readers, search } = houseNetwork([], []);
    const { result } = renderStore(() => useScores([placeNo(1)]), { readers, strict: true });

    await waitFor(() => expect(result.current.scores.size).toBe(1));
    await settle();
    expect(byA(search)).toHaveLength(1);
    expect(byD(search)).toHaveLength(1);
  });

  it("asks nothing of the house while no place it asked for has a review", async () => {
    config.reviewRelays = [SEARCH];
    const { readers, search, trust, scorer } = houseNetwork([], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => useScores([JACAFE]), { readers });

    await waitFor(() => expect(result.current.scores.get(JACAFE)).toMatchObject({ score: null, counted: 0, outside: 0 }));
    await settle();
    expect(byA(search)).toHaveLength(1);
    expect(trust.requests).toEqual([]);
    expect(scorer.requests).toEqual([]);
    expect(result.current.house).toBe("idle");
  });

  it("reads the house's 10040 once, then the ranks of only the reviewers it does not know yet", async () => {
    config.reviewRelays = [SEARCH];
    const reviews = [
      reviewOf(ALICE, JACAFE, 5),
      reviewOf(BOB, JACAFE, 3),
      reviewOf(BOB, OTHER, 4),
      reviewOf(CAROL, OTHER, 2),
    ];
    const { readers, trust, scorer } = houseNetwork(reviews, [rankOf(ALICE, 80), rankOf(BOB, 30), rankOf(CAROL, 4)]);
    const { result, rerender } = renderStore(({ addresses }: { addresses: string[] }) => useScores(addresses), {
      readers,
      initialProps: { addresses: [JACAFE] },
    });
    await waitFor(() => expect(result.current.scores.get(JACAFE)?.counted).toBe(2));
    expect(result.current.house).toBe("ready");

    rerender({ addresses: [JACAFE, OTHER] });
    await waitFor(() => expect(result.current.scores.get(OTHER)?.counted).toBe(1));

    expect(trust.requests).toEqual([{ kinds: [10040], authors: [config.houseHex], limit: 1 }]);
    expect(scorer.requests.map((filter) => [...(filter["#d"] ?? [])].sort())).toEqual([[ALICE, BOB], [CAROL]]);
    for (const filter of scorer.requests) expect(filter).toMatchObject({ kinds: [30382], authors: [SCORER] });

    // Carol's rank, 4, is under the line of 5 (decision 18): her review is folded, not counted.
    const other = result.current.scores.get(OTHER)!;
    expect(other.score).toBe(4);
    expect(other.folded.map((review) => review.reviewer)).toEqual([CAROL]);
    expect(result.current.scores.get(JACAFE)?.score).toBeCloseTo((0.8 * 5 + 0.3 * 3) / 1.1, 10);
  });

  it("does not ask again about a reviewer the scorer gave no rank", async () => {
    config.reviewRelays = [SEARCH];
    const reviews = [reviewOf(DAVE, JACAFE, 4), reviewOf(DAVE, OTHER, 2), reviewOf(ALICE, OTHER, 5)];
    const { readers, scorer } = houseNetwork(reviews, [rankOf(ALICE, 80)]);
    const { result, rerender } = renderStore(({ addresses }: { addresses: string[] }) => useScores(addresses), {
      readers,
      initialProps: { addresses: [JACAFE] },
    });
    // Dave has no rank: he is outside, and his review is folded.
    await waitFor(() => expect(result.current.scores.get(JACAFE)).toMatchObject({ score: null, counted: 0, outside: 1 }));

    rerender({ addresses: [JACAFE, OTHER] });
    await waitFor(() => expect(result.current.scores.get(OTHER)).toMatchObject({ score: 5, counted: 1, outside: 1 }));
    expect(scorer.requests.map((filter) => filter["#d"])).toEqual([[DAVE], [ALICE]]);
  });

  it("adds a relay's read extras to every filter sent to it, and only to it", async () => {
    config.reviewRelays = [SEARCH];
    config.relayReadExtras = { ...config.relayReadExtras, [TRUST]: { search: "trust-extra" } };
    const { readers, search, trust, scorer } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => useScores([JACAFE]), { readers });

    await waitFor(() => expect(result.current.house).toBe("ready"));
    expect(search.requests[0]).toMatchObject({ search: "include:spam" });
    expect(trust.requests[0]).toMatchObject({ kinds: [10040], search: "trust-extra" });
    expect(scorer.requests[0]).not.toHaveProperty("search");
  });
});

describe("ScoresProvider: how much it reads at once", () => {
  it("has at most two batches in flight to each relay, and sends the rest as those finish (a and d count as one)", async () => {
    config.reviewRelays = [SEARCH, MIRROR];
    const search = gatedReader([]);
    const mirror = gatedReader([]);
    const { readers } = network({ [SEARCH]: search, [MIRROR]: mirror });
    const addresses = Array.from({ length: 250 }, (_, n) => placeNo(n));
    const { result } = renderStore(() => useScores(addresses), { readers });

    // Two batches go out to each relay, by a and by d; the other three wait.
    await waitFor(() => expect(search.sent).toHaveLength(4));
    await settle();
    expect(search.sent).toHaveLength(4);
    expect(mirror.sent).toHaveLength(4);
    // Let each relay answer what it has, until every batch has been sent and answered.
    for (let round = 0; round < 10 && (search.sent.length < 10 || result.current.scores.size < 250); round++) {
      search.release();
      mirror.release();
      await settle();
    }
    expect(search.sent.filter((batch) => batch !== undefined)).toHaveLength(5);
    expect(mirror.sent.filter((batch) => batch !== undefined)).toHaveLength(5);
    expect(search.mostBatches).toBe(2);
    expect(mirror.mostBatches).toBe(2);
    expect(result.current.scores.size).toBe(250);
  });
});

describe("ScoresProvider: the house's ranks, two reads at a time", () => {
  it("has at most two rank reads in flight, and sends the rest as those finish", async () => {
    config.reviewRelays = [SEARCH];
    // Three places in batches of their own, each with a reviewer of its own: three rank reads, one per batch read.
    const addresses = Array.from({ length: 250 }, (_, n) => placeNo(n));
    const reviews = [reviewOf(ALICE, placeNo(0), 5), reviewOf(BOB, placeNo(100), 4), reviewOf(CAROL, placeNo(200), 3)];
    const scorer = gatedReader([rankOf(ALICE, 80), rankOf(BOB, 60), rankOf(CAROL, 40)], (filter) => filter.kinds?.includes(30382) === true);
    const { readers } = houseNetwork(reviews, [], { [SCORER_RELAY]: scorer });
    const { result } = renderStore(() => useScores(addresses), { readers });

    // Two are sent; the third waits its turn.
    await waitFor(() => expect(scorer.sent).toHaveLength(2));
    await settle();
    expect(scorer.sent).toHaveLength(2);
    for (let round = 0; round < 10 && result.current.scores.size < 250; round++) {
      scorer.release();
      await settle();
    }
    expect(scorer.requests.map((filter) => filter["#d"]).flat().sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(scorer.mostBatches).toBe(2);
    expect(result.current.house).toBe("ready");
    expect(result.current.scores.get(placeNo(200))).toMatchObject({ counted: 1, outside: 0 });
  });
});

describe("ScoresProvider: back on line, and Try again", () => {
  it("reads the house's view again when the device is back on line, once it was unavailable", async () => {
    config.reviewRelays = [SEARCH];
    const trust = switchedReader([trustList()]);
    trust.down = true;
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], [rankOf(ALICE, 80)], { [TRUST]: trust });
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(result.current.house).toBe("unavailable"));
    expect(result.current.score).toMatchObject({ score: null, counted: 0, outside: 1 });

    trust.down = false;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.house).toBe("ready"));
    await waitFor(() => expect(result.current.score).toMatchObject({ score: 5, counted: 1, outside: 0 }));
  });

  it("reads the reviews again when the device is back on line, once no relay answered", async () => {
    config.reviewRelays = [SEARCH];
    const search = switchedReader([reviewOf(ALICE, JACAFE, 5)]);
    search.down = true;
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(result.current.read).toBe("failed"));

    search.down = false;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.score).toMatchObject({ score: 5, counted: 1 }));
    expect(result.current.read).toBe("read");
  });

  it("reads nothing again when the device is back on line and everything was read", async () => {
    config.reviewRelays = [SEARCH];
    const { readers, search, scorer, trust } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(result.current.score?.counted).toBe(1));
    const sent = [search.requests.length, scorer.requests.length, trust.requests.length];

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect([search.requests.length, scorer.requests.length, trust.requests.length]).toEqual(sent);
  });

  it("reads again at most once in 5 seconds however often the device says it is back on line", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    try {
      config.reviewRelays = [SEARCH];
      const search = switchedReader([reviewOf(ALICE, JACAFE, 5)]);
      search.down = true;
      const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
      const { result } = renderStore(() => useScore(JACAFE), { readers });
      await waitFor(() => expect(result.current.read).toBe("failed"));
      const online = async () => {
        act(() => {
          window.dispatchEvent(new Event("online"));
        });
        await settle();
      };

      // The first time it is back, it reads again: still down.
      await online();
      await waitFor(() => expect(result.current.read).toBe("failed"));
      const once = search.requests.length;
      expect(once).toBeGreaterThan(0);

      // A connection that flaps: nothing is read again for 5 seconds after.
      vi.setSystemTime(1_700_000_004_999);
      await online();
      await online();
      expect(search.requests).toHaveLength(once);
      expect(result.current.read).toBe("failed");

      // Then it reads again.
      search.down = false;
      vi.setSystemTime(1_700_000_005_000);
      await online();
      await waitFor(() => expect(result.current.score).toMatchObject({ score: 5, counted: 1 }));
      expect(search.requests.length).toBeGreaterThan(once);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops hearing that the device is back on line when it unmounts", async () => {
    config.reviewRelays = [SEARCH];
    const search = switchedReader([reviewOf(ALICE, JACAFE, 5)]);
    search.down = true;
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    const { result, unmount } = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(result.current.read).toBe("failed"));
    const sent = search.requests.length;

    unmount();
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(search.requests).toHaveLength(sent);
  });

  it("gets the house's view back with refresh (Try again) once it was unavailable", async () => {
    config.reviewRelays = [SEARCH];
    const scorer = switchedReader([rankOf(ALICE, 80)]);
    scorer.down = true;
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], [], { [SCORER_RELAY]: scorer });
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    // The scorer's relay fails before it has given any rank: the house's view can't be had.
    await waitFor(() => expect(result.current.house).toBe("unavailable"));

    scorer.down = false;
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(result.current.score).toMatchObject({ score: 5, counted: 1, outside: 0 }));
    expect(result.current.house).toBe("ready");
  });
});

describe("ScoresProvider: a place with more reviews than a request returns", () => {
  /** A distinct reviewer for each `n`: none is Alice, Bob, Carol, Dave or Erin. */
  const spammer = (n: number) => `f${n.toString(16).padStart(63, "0")}`;
  /** `count` reviews of `address`, each by its own reviewer, one second apart, the newest from `newest` back. */
  const spamOf = (address: string, count: number, newest = 1_700_100_000) =>
    Array.from({ length: count }, (_, n) => reviewOf(spammer(n), address, 5, { created_at: newest - n }));

  it("pages back by time, so 600 reviews of one place leave the other places' reviews in its batch read", async () => {
    config.reviewRelays = [SEARCH];
    const spam = spamOf(JACAFE, 600);
    const alice = reviewOf(ALICE, OTHER, 4, { created_at: 1_700_000_000 });
    const { readers, search } = houseNetwork([...spam, alice], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => useScores([JACAFE, OTHER]), { readers });

    await waitFor(() => expect(result.current.scores.get(OTHER)).toMatchObject({ score: 4, counted: 1 }));
    // A full page (500) is followed by the next, until the oldest review seen; a short one ends it.
    const oldestOfFirstPage = 1_700_100_000 - 499;
    expect(byA(search).map((filter) => filter.until)).toEqual([undefined, oldestOfFirstPage]);
    expect(byD(search).map((filter) => filter.until)).toEqual([undefined, oldestOfFirstPage]);
    for (const filter of search.requests.filter((each) => each.kinds?.includes(REVIEW_KIND))) {
      expect(filter).toMatchObject({ limit: 500, search: "include:spam" });
    }
  });

  it("reads at most five pages for one batch's request, then stops", async () => {
    config.reviewRelays = [SEARCH];
    const { readers, search } = houseNetwork(spamOf(JACAFE, 3_000), []);
    const { result } = renderStore(() => useScore(JACAFE), { readers });

    await waitFor(() => expect(result.current.read).toBe("read"));
    expect(byA(search)).toHaveLength(5);
    expect(byD(search)).toHaveLength(5);
    const untils = byA(search).map((filter) => filter.until);
    expect(untils).toEqual([undefined, ...[1, 2, 3, 4].map((page) => 1_700_100_000 - 499 * page)]);
    // Five pages of 500, the first and last second of each page shared with the next: 2,496 reviews.
    expect(result.current.reviews).toHaveLength(2_496);
  });

  it("pages past a full page of one second, so a flood in one second still leaves older reviews in its batch read", async () => {
    config.reviewRelays = [SEARCH];
    const second = 1_700_100_000;
    const sameSecond = Array.from({ length: 600 }, (_, n) => reviewOf(spammer(n), JACAFE, 5, { created_at: second }));
    const alice = reviewOf(ALICE, OTHER, 4, { created_at: second - 3_600 });
    const { readers, search } = houseNetwork([...sameSecond, alice], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => useScores([JACAFE, OTHER]), { readers });

    await waitFor(() => expect(result.current.scores.get(OTHER)).toMatchObject({ score: 4, counted: 1 }));
    // The second page gets no further back than the first: the next starts a second before it.
    expect(byA(search).map((filter) => filter.until)).toEqual([undefined, second, second - 1]);
    expect(byD(search).map((filter) => filter.until)).toEqual([undefined, second, second - 1]);
  });
});

describe("ScoresProvider: where each place's reading stands", () => {
  it("says a place is reading, then read; failed when no relay answers; and reading again on refresh", async () => {
    config.reviewRelays = [SEARCH];
    const memory = createMemoryReader([reviewOf(ALICE, JACAFE, 5)]);
    let answer: "hold" | "fail" | "answer" = "hold";
    let letGo: () => void = () => {};
    const search: RelayReader = {
      async *req(filter, signal) {
        if (answer === "hold") {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            letGo = resolve;
          });
        }
        if (answer === "fail") throw new Error("The relay is down");
        yield* memory.req(filter, signal);
      },
    };
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    const { result } = renderStore(
      () => ({ list: useScores([JACAFE, OTHER]), one: useScore(JACAFE), actions: useScoreActions() }),
      { readers },
    );

    await waitFor(() => expect(result.current.one.read).toBe("reading"));
    expect(result.current.list.reads.get(OTHER)).toBe("reading");
    answer = "fail";
    act(() => letGo());
    await waitFor(() => expect(result.current.one.read).toBe("failed"));
    expect(result.current.list.reads.get(OTHER)).toBe("failed");
    expect(result.current.one.score).toBeUndefined();

    answer = "answer";
    act(() => result.current.actions.refresh());
    expect(result.current.one.read).toBe("reading");
    await waitFor(() => expect(result.current.one.read).toBe("read"));
    expect(result.current.list.reads.get(OTHER)).toBe("read");
    await waitFor(() => expect(result.current.one.score?.counted).toBe(1));
  });

  it("is failed only when no relay answers: one that answers is enough", async () => {
    config.reviewRelays = [SEARCH, MIRROR];
    const down: RelayReader = {
      async *req() {
        throw new Error("The relay is down");
      },
    };
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], [rankOf(ALICE, 80)], { [MIRROR]: down });
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(result.current.read).toBe("read"));
  });

  it("has no reading to say anything about when there are no review relays", async () => {
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], []);
    const { result } = renderStore(() => ({ list: useScores([JACAFE]), one: useScore(JACAFE) }), { readers });
    await settle();
    expect(result.current.one.read).toBeUndefined();
    expect(result.current.list.reads.size).toBe(0);
  });
});

describe("ScoresProvider: scores", () => {
  it("gives no score, and folds nobody, until the ranks arrive; then it scores the place", async () => {
    config.reviewRelays = [SEARCH];
    const scorer = heldReader([rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5), reviewOf(BOB, JACAFE, 3)], [], {
      [SCORER_RELAY]: scorer,
    });
    const { result } = renderStore(() => useScore(JACAFE), { readers });

    await waitFor(() => expect(scorer.signals).toHaveLength(1));
    expect(result.current.house).toBe("loading");
    // Not a score with both folded: nobody is shown as outside House picks before the house has said so.
    expect(result.current.score).toBeUndefined();
    expect(result.current.reviews).toHaveLength(2);

    act(() => scorer.open());
    await waitFor(() => expect(result.current.house).toBe("ready"));
    expect(result.current.score).toMatchObject({ counted: 2, outside: 0 });
    expect(result.current.score?.score).toBeCloseTo((0.8 * 5 + 0.3 * 3) / 1.1, 10);
  });

  it("gives no score for a place while one of its reviewers' rank is being read, and folds nobody", async () => {
    config.reviewRelays = [SEARCH];
    // The first rank request (Alice's) answers; the second (Carol's) waits.
    const scorer = heldReader([rankOf(ALICE, 80), rankOf(CAROL, 60)], { from: 1 });
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5), reviewOf(ALICE, OTHER, 5), reviewOf(CAROL, OTHER, 1)], [], {
      [SCORER_RELAY]: scorer,
    });
    const { result, rerender } = renderStore(({ addresses }: { addresses: string[] }) => useScores(addresses), {
      readers,
      initialProps: { addresses: [JACAFE] },
    });
    await waitFor(() => expect(result.current.scores.get(JACAFE)?.score).toBe(5));

    rerender({ addresses: [JACAFE, OTHER] });
    await waitFor(() => expect(scorer.signals).toHaveLength(2));
    expect(result.current.house).toBe("ready");
    expect(result.current.scores.has(OTHER)).toBe(false);
    expect(result.current.scores.get(JACAFE)?.score).toBe(5);

    act(() => scorer.open());
    await waitFor(() => expect(result.current.scores.get(OTHER)?.counted).toBe(2));
    expect(result.current.scores.get(OTHER)?.score).toBeCloseTo((0.8 * 5 + 0.6 * 1) / 1.4, 10);
  });

  it("gives no score for a place while a reviewer new to it is ranked, after the house is ready, then the right one", async () => {
    config.reviewRelays = [SEARCH];
    // The first rank request (Alice's) answers; the second (Carol's) waits.
    const scorer = heldReader([rankOf(ALICE, 80), rankOf(CAROL, 60)], { from: 1 });
    const reviews = [reviewOf(ALICE, JACAFE, 5)];
    const { readers } = houseNetwork(reviews, [], { [SCORER_RELAY]: scorer });
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(result.current.score).toMatchObject({ score: 5, counted: 1, outside: 0 }));

    // Carol reviews it; the place is read again, and her rank is asked for.
    const carol = reviewOf(CAROL, JACAFE, 1);
    reviews.push(carol);
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(scorer.signals).toHaveLength(2));
    expect(result.current.house).toBe("ready");
    expect(result.current.score).toBeUndefined();
    expect(idsOf(result.current.reviews).sort()).toEqual([carol.id, reviews[0]!.id].sort());

    act(() => scorer.open());
    await waitFor(() => expect(result.current.score?.counted).toBe(2));
    expect(result.current.score?.score).toBeCloseTo((0.8 * 5 + 0.6 * 1) / 1.4, 10);
    expect(result.current.score?.outside).toBe(0);
  });

  it("keeps the house's view when a later rank read fails: the places it ranked stay scored, and only that read's reviewers are asked again", async () => {
    config.reviewRelays = [SEARCH];
    // Alice's rank is read; then the scorer's relay goes down for Carol's, and comes back.
    const scorer = switchedReader([rankOf(ALICE, 80), rankOf(CAROL, 60)]);
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5), reviewOf(CAROL, OTHER, 1)], [], {
      [SCORER_RELAY]: scorer,
    });
    const { result, rerender } = renderStore(({ addresses }: { addresses: string[] }) => useScores(addresses), {
      readers,
      initialProps: { addresses: [JACAFE] },
    });
    await waitFor(() => expect(result.current.scores.get(JACAFE)?.score).toBe(5));

    scorer.down = true;
    rerender({ addresses: [JACAFE, OTHER] });
    await waitFor(() => expect(scorer.failed).toBe(1));
    await settle();
    // Not unavailable: Jacafé keeps its score; Other waits for Carol's rank, with nobody folded.
    expect(result.current.house).toBe("ready");
    expect(result.current.scores.get(JACAFE)).toMatchObject({ score: 5, counted: 1, outside: 0 });
    expect(result.current.scores.has(OTHER)).toBe(false);
    expect(result.current.pending.has(OTHER)).toBe(true);
    expect(scorer.requests.map((filter) => filter["#d"])).toEqual([[ALICE], [CAROL]]);

    // The next try asks for Carol again, and only her.
    scorer.down = false;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.scores.get(OTHER)).toMatchObject({ counted: 1, outside: 0 }));
    expect(scorer.requests.map((filter) => filter["#d"])).toEqual([[ALICE], [CAROL], [CAROL]]);
    expect(result.current.scores.get(JACAFE)?.score).toBe(5);
  });

  it.each<[string, Record<string, RelayReader>]>([
    ["the house's 10040 cannot be read", { [TRUST]: createMemoryReader([], { failWith: new Error("503") }) }],
    ["the house has no 10040", { [TRUST]: createMemoryReader([]) }],
    ["the scorer's relay is down", { [SCORER_RELAY]: createMemoryReader([], { failWith: new Error("503") }) }],
  ])("says the house is unavailable when %s, and still lists the reviews, folded", async (_, broken) => {
    config.reviewRelays = [SEARCH];
    const { readers } = houseNetwork(
      [reviewOf(ALICE, JACAFE, 5), reviewOf(BOB, JACAFE, 3)],
      [rankOf(ALICE, 80), rankOf(BOB, 30)],
      broken,
    );
    const { result } = renderStore(() => useScore(JACAFE), { readers });

    await waitFor(() => expect(result.current.house).toBe("unavailable"));
    expect(result.current.score).toMatchObject({ score: null, counted: 0, outside: 2 });
    expect(result.current.reviews.map((review) => review.reviewer).sort()).toEqual([ALICE, BOB]);
  });

  it("gives two filings of one place one voice per reviewer, the newest review winning", async () => {
    config.reviewRelays = [SEARCH];
    const aliceOlder = reviewOf(ALICE, JACAFE, 2, { created_at: 1_700_000_000 });
    const aliceNewer = reviewOf(ALICE, JACAFE_AGAIN, 5, { created_at: 1_700_000_200 });
    const bob = reviewOf(BOB, JACAFE, 3, { created_at: 1_700_000_100 });
    const { readers, search } = houseNetwork([aliceOlder, aliceNewer, bob], [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const placeEvents = [...places, jacafeAgain()];
    const { result } = renderStore(() => ({ first: useScore(JACAFE), again: useScore(JACAFE_AGAIN) }), {
      readers,
      placeEvents,
    });

    // Alice counts once, with her newer review's 5 stars, not twice and not with 2.
    const expected = (0.8 * 5 + 0.3 * 3) / 1.1;
    await waitFor(() => expect(result.current.first.score?.score).toBeCloseTo(expected, 10));
    expect(result.current.first.score?.counted).toBe(2);
    expect(result.current.first.reviews.map((review) => review.id)).toEqual([aliceNewer.id, bob.id]);
    await waitFor(() => expect(result.current.again.score?.score).toBeCloseTo(expected, 10));
    expect(result.current.again.reviews.map((review) => review.id)).toEqual([aliceNewer.id, bob.id]);
    // Both filings were asked for, whichever a page named.
    expect(new Set(batchesOf(search).flat())).toEqual(new Set([JACAFE, JACAFE_AGAIN]));
  });

  it("refresh() reads the places again and replaces what it had: a review the relay no longer sends is gone", async () => {
    config.reviewRelays = [SEARCH];
    const kept = reviewOf(ALICE, JACAFE, 5);
    const deleted = reviewOf(BOB, JACAFE, 3);
    const reviews = [kept, deleted];
    const { readers, search } = houseNetwork(reviews, [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(result.current.score?.counted).toBe(2));

    reviews.splice(reviews.indexOf(deleted), 1);
    act(() => result.current.actions.refresh());

    await waitFor(() => expect(result.current.reviews.map((review) => review.id)).toEqual([kept.id]));
    expect(result.current.score).toMatchObject({ score: 5, counted: 1 });
    expect(batchesOf(search)).toEqual([[JACAFE], [JACAFE]]);
  });

  it("aborts its review reads when it unmounts", async () => {
    config.reviewRelays = [SEARCH];
    const search = heldReader([reviewOf(ALICE, JACAFE, 5)]);
    const { readers } = network({ [SEARCH]: search });
    const { unmount } = renderStore(() => useScores([JACAFE]), { readers });

    await waitFor(() => expect(search.signals).toHaveLength(2));
    expect(search.signals.map((signal) => signal.aborted)).toEqual([false, false]);
    unmount();
    expect(search.signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("aborts its rank reads when it unmounts", async () => {
    config.reviewRelays = [SEARCH];
    const scorer = heldReader([rankOf(ALICE, 80)]);
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 5)], [], { [SCORER_RELAY]: scorer });
    const { unmount } = renderStore(() => useScores([JACAFE]), { readers });

    await waitFor(() => expect(scorer.signals).toHaveLength(1));
    unmount();
    expect(scorer.signals[0]!.aborted).toBe(true);
  });

  it("gives a place's reviews and its score, and no number about any person", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = houseNetwork([reviewOf(ALICE, JACAFE, 4), reviewOf(BOB, JACAFE, 2)], [rankOf(ALICE, 73.25)]);
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(result.current.score?.counted).toBe(1));

    for (const review of result.current.reviews) {
      expect(Object.keys(review).sort()).toEqual(["address", "createdAt", "d", "id", "reviewer", "stars", "text"]);
    }
    const shown = JSON.stringify(result.current);
    for (const number of ["73.25", "0.7325", "7325"]) expect(shown).not.toContain(number);
    // The person's own picture is an address, no number: useOwnPicture.
    expect(Object.keys(await import("../src/score/useScore")).sort()).toEqual([
      "useNames",
      "useOwnPicture",
      "useScore",
      "useScoreActions",
      "useScores",
    ]);
  });

  it("keeps each place's score the same object while nothing it is made of changes", async () => {
    config.reviewRelays = [SEARCH];
    const events: NostrEvent[] = [reviewOf(ALICE, JACAFE, 5), reviewOf(BOB, OTHER, 3), profileOf(ALICE, { name: "Alice" })];
    const { readers } = houseNetwork(events, [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result, rerender } = renderStore(
      ({ people }: { people: string[] }) => ({
        ...useScores([JACAFE, OTHER]),
        names: useNames(people),
        actions: useScoreActions(),
      }),
      { readers, initialProps: { people: [] as string[] } },
    );
    const scoreOf = (address: string) => result.current.scores.get(address);
    await waitFor(() => expect(scoreOf(JACAFE)?.counted).toBe(1));
    await waitFor(() => expect(scoreOf(OTHER)?.counted).toBe(1));
    const [jacafe, other] = [scoreOf(JACAFE), scoreOf(OTHER)];

    // Names come in: no place's score is new.
    rerender({ people: [ALICE, BOB] });
    await waitFor(() => expect(result.current.names.get(ALICE)).toBe("Alice"));
    expect(scoreOf(JACAFE)).toBe(jacafe);
    expect(scoreOf(OTHER)).toBe(other);

    // A new review of Jacafé, by someone ranked already. Both places are read again; only Jacafé's score is new.
    events.push(reviewOf(BOB, JACAFE, 1));
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(scoreOf(JACAFE)?.counted).toBe(2));
    expect(scoreOf(OTHER)).toBe(other);
  });

  it("gives a list's place the same thing to show while its score is the same, when another place's score changes", async () => {
    config.reviewRelays = [SEARCH];
    const events: NostrEvent[] = [reviewOf(ALICE, JACAFE, 5), reviewOf(BOB, OTHER, 3)];
    const { readers } = houseNetwork(events, [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    // Only the places' addresses are read from a list's entries.
    const entries = [JACAFE, OTHER].map((address, i) => ({ place: { address } as Place, km: i + 1 }));
    const { result } = renderStore(() => ({ ...useListScores(entries), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(result.current.scores.of(JACAFE).kind).toBe("scored"));
    await waitFor(() => expect(result.current.scores.of(OTHER).kind).toBe("scored"));
    const other = result.current.scores.of(OTHER);

    // A new review of Jacafé: its score changes, Other's does not, and nor does what Other shows.
    events.push(reviewOf(BOB, JACAFE, 1));
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(result.current.scores.of(JACAFE)).toMatchObject({ kind: "scored", counted: 2 }));
    expect(result.current.scores.of(OTHER)).toBe(other);
  });

  it("does not render what shows scores again when only names come in", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = houseNetwork(
      [reviewOf(ALICE, JACAFE, 5), profileOf(ALICE, { name: "Alice" })],
      [rankOf(ALICE, 80)],
    );
    let renders = 0;
    const Score = memo(function Score() {
      renders += 1;
      const { scores } = useScores([JACAFE]);
      return <p>{`Score ${scores.get(JACAFE)?.score ?? "none"}`}</p>;
    });
    function Names({ people }: { people: string[] }) {
      const names = useNames(people);
      return <p>{people.map((pubkey) => names.get(pubkey)).join(", ")}</p>;
    }
    const placesReader = createMemoryReader(places);
    const app = (people: string[]) => (
      <PlacesProvider reader={placesReader}>
        <ScoresProvider readers={readers}>
          <Score />
          <Names people={people} />
        </ScoresProvider>
      </PlacesProvider>
    );
    const { rerender } = render(app([]));
    await screen.findByText("Score 5");
    await settle();
    const before = renders;

    rerender(app([ALICE]));
    await screen.findByText("Alice");
    expect(renders).toBe(before);
  });
});

describe("ScoresProvider: the person's own reviews (for writing and removing them)", () => {
  it("shows an own review at once, and holds it until a read returns it", async () => {
    config.reviewRelays = [SEARCH];
    const events: NostrEvent[] = [reviewOf(BOB, JACAFE, 3, { created_at: 1_700_000_000 })];
    const { readers } = houseNetwork(events, [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(result.current.score?.counted).toBe(1));

    const own = reviewOf(ALICE, JACAFE, 5, { created_at: 1_700_000_500 });
    act(() => result.current.actions.noteOwnReview(own));
    expect(idsOf(result.current.reviews)).toContain(own.id);
    await waitFor(() => expect(result.current.score?.counted).toBe(2));

    /** Bob edits his review and the place is read again: once his edit shows, that read has landed. */
    const readAgainWithBobsEdit = async (createdAt: number) => {
      const edit = reviewOf(BOB, JACAFE, 4, { created_at: createdAt });
      events.push(edit);
      act(() => result.current.actions.refresh());
      await waitFor(() => expect(idsOf(result.current.reviews)).toContain(edit.id));
      return edit;
    };

    // A read that does not return it yet (the relay lags): still shown.
    await readAgainWithBobsEdit(1_700_000_010);
    expect(idsOf(result.current.reviews)).toContain(own.id);

    // A read returns it: it is the relay's now, and goes when the relay drops it.
    events.push(own);
    const bob = await readAgainWithBobsEdit(1_700_000_020);
    events.splice(events.indexOf(own), 1);
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(idsOf(result.current.reviews)).toEqual([bob.id]));
  });

  it("shows an own review for a place it has not read yet", async () => {
    config.reviewRelays = [SEARCH];
    const search = heldReader([]);
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(search.signals).toHaveLength(2));

    const own = reviewOf(ALICE, JACAFE, 4);
    act(() => result.current.actions.noteOwnReview(own));
    expect(result.current.reviews.map((review) => review.id)).toEqual([own.id]);
    await waitFor(() => expect(result.current.score).toMatchObject({ score: 4, counted: 1 }));
  });

  it("hides a removed review at once, and any older copy a lagging relay sends later", async () => {
    config.reviewRelays = [SEARCH];
    const older = reviewOf(ALICE, JACAFE, 2, { created_at: 1_700_000_000 });
    const removed = reviewOf(ALICE, JACAFE, 4, { created_at: 1_700_000_100 });
    const bob = reviewOf(BOB, JACAFE, 3, { created_at: 1_700_000_000 });
    const reviews = [removed, bob];
    const { readers } = houseNetwork(reviews, [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(result.current.score?.counted).toBe(2));

    act(() => result.current.actions.noteRemoval(`${REVIEW_KIND}:${ALICE}:place:${JACAFE}`, 1_700_000_200));
    expect(result.current.reviews.map((review) => review.id)).toEqual([bob.id]);
    expect(result.current.score).toMatchObject({ score: 3, counted: 1 });

    // A lagging relay still sends the removed review, and the older one it replaced. Bob's edit,
    // read in the same go, shows when that read has landed.
    const bobEdited = reviewOf(BOB, JACAFE, 2, { created_at: 1_700_000_050 });
    reviews.push(older, bobEdited);
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(idsOf(result.current.reviews)).toEqual([bobEdited.id]));
    expect(result.current.score).toMatchObject({ score: 2, counted: 1 });

    // A review written after the removal shows.
    const again = reviewOf(ALICE, JACAFE, 5, { created_at: 1_700_000_300 });
    reviews.push(again);
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(idsOf(result.current.reviews)).toEqual([again.id, bobEdited.id]));
  });

  it("drops a held own review when it is removed", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(result.current.score).toBeDefined());

    const own = reviewOf(ALICE, JACAFE, 4, { created_at: 1_700_000_000 });
    act(() => result.current.actions.noteOwnReview(own));
    expect(result.current.reviews).toHaveLength(1);
    act(() => result.current.actions.noteRemoval(`${REVIEW_KIND}:${ALICE}:place:${JACAFE}`, 1_700_000_000));
    expect(result.current.reviews).toEqual([]);
  });

  it("leaves other reviewers and other places alone when one review is removed", async () => {
    config.reviewRelays = [SEARCH];
    const alice = reviewOf(ALICE, JACAFE, 4);
    const aliceElsewhere = reviewOf(ALICE, OTHER, 4);
    const bob = reviewOf(BOB, JACAFE, 3);
    const { readers } = houseNetwork([alice, aliceElsewhere, bob], [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result } = renderStore(
      () => ({ here: useScore(JACAFE), there: useScore(OTHER), actions: useScoreActions() }),
      { readers },
    );
    await waitFor(() => expect(result.current.there.score?.counted).toBe(1));

    act(() => result.current.actions.noteRemoval(`${REVIEW_KIND}:${BOB}:place:${JACAFE}`, 1_800_000_000));
    expect(result.current.here.reviews.map((review) => review.id)).toEqual([alice.id]);
    expect(result.current.there.reviews.map((review) => review.id)).toEqual([aliceElsewhere.id]);
  });

  it("lists every review a person has of a place, under any d and any filing, for removing them all", async () => {
    config.reviewRelays = [SEARCH];
    const placeD = reviewOf(ALICE, JACAFE, 5, { created_at: 1_700_000_300 });
    // Written by another app: the bare address as its d, and no a.
    const bareD = shapedEvent({ kind: REVIEW_KIND, pubkey: ALICE, created_at: 1_700_000_200, tags: [["d", JACAFE], ["s", "2"]] });
    const otherFiling = reviewOf(ALICE, JACAFE_AGAIN, 4, { created_at: 1_700_000_100 });
    const elsewhere = reviewOf(ALICE, OTHER, 3);
    const bob = reviewOf(BOB, JACAFE, 3);
    const { readers } = houseNetwork([placeD, bareD, otherFiling, elsewhere, bob], [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), {
      readers,
      placeEvents: [...places, jacafeAgain()],
    });
    const coordinates = (pubkey: string, address: string) => result.current.actions.ownCoordinates(pubkey, address);

    const all = [
      { id: placeD.id, d: `place:${JACAFE}`, createdAt: 1_700_000_300 },
      { id: bareD.id, d: JACAFE, createdAt: 1_700_000_200 },
      { id: otherFiling.id, d: `place:${JACAFE_AGAIN}`, createdAt: 1_700_000_100 },
    ];
    await waitFor(() => expect(coordinates(ALICE, JACAFE)).toEqual(all));
    // The page shows one voice for her; the list has all three, whichever filing is asked about.
    expect(idsOf(result.current.reviews)).toEqual([placeD.id, bob.id]);
    expect(coordinates(ALICE, JACAFE_AGAIN)).toEqual(all);
    expect(coordinates(BOB, JACAFE)).toEqual([{ id: bob.id, d: `place:${JACAFE}`, createdAt: bob.created_at }]);
    expect(coordinates(CAROL, JACAFE)).toEqual([]);

    // A removed one is not listed; an own review held, newer at its d, is, in place of the one it replaces.
    act(() => result.current.actions.noteRemoval(`${REVIEW_KIND}:${ALICE}:${JACAFE}`, 1_700_000_250));
    expect(coordinates(ALICE, JACAFE)).toEqual([all[0], all[2]]);
    const own = reviewOf(ALICE, JACAFE_AGAIN, 1, { created_at: 1_700_000_400 });
    act(() => result.current.actions.noteOwnReview(own));
    expect(coordinates(ALICE, JACAFE)).toEqual([
      // Held, so it says where it went: nowhere it was told of, here.
      { id: own.id, d: `place:${JACAFE_AGAIN}`, createdAt: 1_700_000_400, relays: [] },
      all[0],
    ]);
  });
});

describe("ScoresProvider: the person's own reviews, held through a reload (Review Focus 1)", () => {
  /** What this tab keeps of the reviews held, as JSON. */
  const heldText = () => window.sessionStorage.getItem(HELD_REVIEWS_KEY);
  /** What this tab keeps of the reviews held, read. */
  const heldKept = () => JSON.parse(heldText() ?? "[]") as unknown;
  /** `pubkey` signed in with this browser in this tab, as the account provider keeps it. */
  const signedInAs = (pubkey: string) => window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));

  it("keeps a held own review in this tab, with where it went, and a new store (a reload) shows it before any read returns it", async () => {
    config.reviewRelays = [SEARCH];
    signedInAs(ALICE);
    const reviews: NostrEvent[] = [];
    const { readers } = houseNetwork(reviews, [rankOf(ALICE, 80)]);
    const first = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(first.result.current.read).toBe("read"));

    const own = reviewOf(ALICE, JACAFE, 4, { created_at: 1_700_000_500 });
    act(() => first.result.current.actions.noteOwnReview(own, [SEARCH, MIRROR]));
    expect(heldKept()).toEqual([{ event: own, relays: [SEARCH, MIRROR] }]);
    expect(window.localStorage.length).toBe(0);
    first.unmount();

    // The page is reloaded, and the relay still lags: the review shows, from what the tab kept, and
    // where it went is known, for removing it from there (Task 7).
    const search = heldReader(reviews);
    const again = houseNetwork(reviews, [rankOf(ALICE, 80)], { [SEARCH]: search });
    const second = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers: again.readers });
    expect(idsOf(second.result.current.reviews)).toEqual([own.id]);
    expect(second.result.current.actions.ownCoordinates(ALICE, JACAFE)).toEqual([
      { id: own.id, d: `place:${JACAFE}`, createdAt: 1_700_000_500, relays: [SEARCH, MIRROR] },
    ]);
    await waitFor(() => expect(second.result.current.score).toMatchObject({ score: 4, counted: 1 }));

    // A read returns it: it is the relay's now, and the tab keeps it no longer.
    reviews.push(own);
    search.open();
    await waitFor(() => expect(heldText()).toBeNull());
    expect(idsOf(second.result.current.reviews)).toEqual([own.id]);
    expect(second.result.current.actions.ownCoordinates(ALICE, JACAFE)).toEqual([
      { id: own.id, d: `place:${JACAFE}`, createdAt: 1_700_000_500 },
    ]);
  });

  it("lets go of a held review in this tab when it is removed", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    const own = reviewOf(ALICE, JACAFE, 4, { created_at: 1_700_000_000 });
    act(() => result.current.actions.noteOwnReview(own));
    expect(heldText()).not.toBeNull();
    act(() => result.current.actions.noteRemoval(`${REVIEW_KIND}:${ALICE}:place:${JACAFE}`, 1_700_000_000));
    expect(heldText()).toBeNull();
  });

  it("forgets every held review at once when the person signs out, in the store and in the tab", async () => {
    config.reviewRelays = [SEARCH];
    const search = heldReader([]);
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    // What the account provider, inside this one, calls at Sign out.
    const { result } = renderStore(
      () => ({ ...useScore(JACAFE), actions: useScoreActions(), forget: useContext(ForgetOnSignOut) }),
      { readers },
    );
    const own = reviewOf(ALICE, JACAFE, 4);
    act(() => result.current.actions.noteOwnReview(own));
    expect(idsOf(result.current.reviews)).toEqual([own.id]);

    act(() => result.current.forget());
    expect(result.current.reviews).toEqual([]);
    expect(heldText()).toBeNull();
  });

  it("gives signing out nothing to forget outside the provider", () => {
    const { result } = renderHook(() => useContext(ForgetOnSignOut));
    expect(() => result.current()).not.toThrow();
  });

  it("holds, after a reload, only the reviews of the person signed in in this tab", async () => {
    config.reviewRelays = [SEARCH];
    signedInAs(ALICE);
    const alices = reviewOf(ALICE, JACAFE, 4);
    const bobs = reviewOf(BOB, OTHER, 2);
    window.sessionStorage.setItem(HELD_REVIEWS_KEY, JSON.stringify([{ event: alices, relays: [] }, { event: bobs, relays: [] }]));
    const search = heldReader([]);
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    const { result } = renderStore(() => ({ here: useScore(JACAFE), there: useScore(OTHER) }), { readers });
    expect(idsOf(result.current.here.reviews)).toEqual([alices.id]);
    expect(result.current.there.reviews).toEqual([]);
  });

  it("holds nothing after a reload when nobody is signed in in this tab", async () => {
    config.reviewRelays = [SEARCH];
    window.sessionStorage.setItem(HELD_REVIEWS_KEY, JSON.stringify([{ event: reviewOf(ALICE, JACAFE, 4), relays: [] }]));
    const search = heldReader([]);
    const { readers } = houseNetwork([], [], { [SEARCH]: search });
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    expect(result.current.reviews).toEqual([]);
  });

  it("keeps only the newest held review at each d, and ignores what is not a review", async () => {
    config.reviewRelays = [SEARCH];
    signedInAs(ALICE);
    const older = reviewOf(ALICE, JACAFE, 2, { created_at: 1_700_000_000 });
    const newer = reviewOf(ALICE, JACAFE, 5, { created_at: 1_700_000_100 });
    window.sessionStorage.setItem(
      HELD_REVIEWS_KEY,
      JSON.stringify([
        { event: older, relays: [SEARCH] },
        { event: { kind: REVIEW_KIND, pubkey: "not a key" }, relays: [] },
        { event: profileOf(ALICE, { name: "Alice" }), relays: [] },
        newer,
        { event: newer, relays: [SEARCH, 7] },
        { event: newer, relays: [MIRROR] },
      ]),
    );
    const search = heldReader([]);
    const { readers } = houseNetwork([], [rankOf(ALICE, 80)], { [SEARCH]: search });
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    expect(idsOf(result.current.reviews)).toEqual([newer.id]);
    expect(result.current.actions.ownCoordinates(ALICE, JACAFE)).toEqual([
      { id: newer.id, d: `place:${JACAFE}`, createdAt: 1_700_000_100, relays: [MIRROR] },
    ]);
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", JSON.stringify({ id: "x" })],
  ])("starts with nothing held when what the tab kept is %s", async (_, text) => {
    config.reviewRelays = [SEARCH];
    signedInAs(ALICE);
    window.sessionStorage.setItem(HELD_REVIEWS_KEY, text);
    const search = heldReader([]);
    const { readers } = houseNetwork([], [], { [SEARCH]: search });
    const { result } = renderStore(() => useScore(JACAFE), { readers });
    expect(result.current.reviews).toEqual([]);
  });

  it("says when the person last removed a review of a place, across its filings, for the next review's time", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = houseNetwork([], []);
    const { result } = renderStore(() => useScoreActions(), { readers, placeEvents: [...places, jacafeAgain()] });
    await waitFor(() => expect(result.current.ownRemovedAt(ALICE, JACAFE)).toBeUndefined());

    act(() => result.current.noteRemoval(`${REVIEW_KIND}:${ALICE}:place:${JACAFE}`, 1_700_000_100));
    act(() => result.current.noteRemoval(`${REVIEW_KIND}:${ALICE}:${JACAFE_AGAIN}`, 1_700_000_300));
    act(() => result.current.noteRemoval(`${REVIEW_KIND}:${ALICE}:place:${OTHER}`, 1_700_000_900));
    act(() => result.current.noteRemoval(`${REVIEW_KIND}:${BOB}:place:${JACAFE}`, 1_700_000_800));
    await waitFor(() => expect(result.current.ownRemovedAt(ALICE, JACAFE)).toBe(1_700_000_300));
    expect(result.current.ownRemovedAt(ALICE, JACAFE_AGAIN)).toBe(1_700_000_300);
    expect(result.current.ownRemovedAt(BOB, JACAFE)).toBe(1_700_000_800);
    expect(result.current.ownRemovedAt(CAROL, JACAFE)).toBeUndefined();
  });
});

describe("ScoresProvider: the person's removals, kept for the tab (Review Focus 2)", () => {
  const ALICE_HERE = `${REVIEW_KIND}:${ALICE}:place:${JACAFE}`;

  it("keeps what was removed for this tab: a new store (a reload) hides an older copy a lagging relay sends, and shows a later review", async () => {
    config.reviewRelays = [SEARCH];
    const removed = reviewOf(ALICE, JACAFE, 4, { created_at: 1_700_000_100 });
    const bob = reviewOf(BOB, JACAFE, 3);
    const reviews = [removed, bob];
    const { readers } = houseNetwork(reviews, [rankOf(ALICE, 80), rankOf(BOB, 30)]);
    const first = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(first.result.current.score?.counted).toBe(2));

    act(() => first.result.current.actions.noteRemoval(ALICE_HERE, 1_700_000_200));
    expect(JSON.parse(window.sessionStorage.getItem(REMOVED_REVIEWS_KEY) ?? "null")).toEqual([[ALICE_HERE, 1_700_000_200]]);
    expect(window.localStorage.length).toBe(0);
    first.unmount();

    const second = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(second.result.current.read).toBe("read"));
    expect(idsOf(second.result.current.reviews)).toEqual([bob.id]);
    expect(second.result.current.actions.ownRemovedAt(ALICE, JACAFE)).toBe(1_700_000_200);
    second.unmount();

    // Rated again after: the new review shows.
    const again = reviewOf(ALICE, JACAFE, 5, { created_at: 1_700_000_201 });
    reviews.push(again);
    const third = renderStore(() => useScore(JACAFE), { readers });
    await waitFor(() => expect(idsOf(third.result.current.reviews)).toEqual([again.id, bob.id]));
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", "{}"],
    ["not the app's own", JSON.stringify([["1:nope:x", 5], [ALICE_HERE, -1], [ALICE_HERE, "5"], 7, [ALICE_HERE]])],
  ])("ignores what the tab keeps of removals when it is %s", async (_, kept) => {
    config.reviewRelays = [SEARCH];
    window.sessionStorage.setItem(REMOVED_REVIEWS_KEY, kept);
    const alice = reviewOf(ALICE, JACAFE, 4);
    const { readers } = houseNetwork([alice], [rankOf(ALICE, 80)]);
    const { result } = renderStore(() => ({ ...useScore(JACAFE), actions: useScoreActions() }), { readers });
    await waitFor(() => expect(idsOf(result.current.reviews)).toEqual([alice.id]));
    expect(result.current.actions.ownRemovedAt(ALICE, JACAFE)).toBeUndefined();
  });

  it("keeps the latest removal of each review, beside what it kept before", async () => {
    config.reviewRelays = [SEARCH];
    const BOB_HERE = `${REVIEW_KIND}:${BOB}:place:${JACAFE}`;
    window.sessionStorage.setItem(REMOVED_REVIEWS_KEY, JSON.stringify([[BOB_HERE, 1_700_000_050]]));
    const { readers } = houseNetwork([], []);
    const { result } = renderStore(() => useScoreActions(), { readers });
    act(() => result.current.noteRemoval(ALICE_HERE, 1_700_000_100));
    act(() => result.current.noteRemoval(ALICE_HERE, 1_700_000_090));
    expect(JSON.parse(window.sessionStorage.getItem(REMOVED_REVIEWS_KEY) ?? "null")).toEqual([
      [BOB_HERE, 1_700_000_050],
      [ALICE_HERE, 1_700_000_100],
    ]);
  });
});

describe("useNames", () => {
  it("asks for each reviewer's profile once, 100 to a request, and names them by display_name, else name", async () => {
    config.reviewRelays = [SEARCH, MIRROR];
    const search = createMemoryReader([
      profileOf(ALICE, { display_name: "Alice Bento", name: "alice" }),
      profileOf(BOB, { name: "bob" }, { created_at: 1_700_000_000 }),
      profileOf(CAROL, { display_name: "  ", name: "Carol" }),
    ]);
    // Bob's newer profile is on the other relay.
    const mirror = createMemoryReader([profileOf(BOB, { name: "Bob Ferreira" }, { created_at: 1_700_000_100 })]);
    const { readers } = network({ [SEARCH]: search, [MIRROR]: mirror });
    const many = Array.from({ length: 145 }, (_, n) => (n + 1).toString(16).padStart(64, "f"));
    const pubkeys = [ALICE, BOB, CAROL, DAVE, ERIN, ...many];
    const { result, rerender } = renderStore(({ asked }: { asked: string[] }) => useNames(asked), {
      readers,
      initialProps: { asked: pubkeys },
    });

    await waitFor(() => expect(result.current.get(BOB)).toBe("Bob Ferreira"));
    expect(result.current.get(ALICE)).toBe("Alice Bento");
    expect(result.current.get(CAROL)).toBe("Carol");
    expect(result.current.get(DAVE)).toBe(copy.reviews.someone);
    expect(result.current.get(many[0]!)).toBe(copy.reviews.someone);

    expect(search.requests.map((filter) => filter.authors?.length)).toEqual([100, 50]);
    expect(search.requests.flatMap((filter) => filter.authors)).toEqual(pubkeys);
    for (const filter of search.requests) expect(filter).toMatchObject({ kinds: [0], search: "include:spam" });
    for (const filter of mirror.requests) expect(filter).not.toHaveProperty("search");

    rerender({ asked: [BOB, ALICE] });
    rerender({ asked: [ALICE, hex64("7")] });
    await waitFor(() => expect(search.requests).toHaveLength(3));
    await settle();
    expect(search.requests[2]?.authors).toEqual([hex64("7")]);
    expect(result.current.get(hex64("7"))).toBe(copy.reviews.someone);
  });

  it("says Someone, never a code or a key, for a profile with no usable name", async () => {
    config.reviewRelays = [SEARCH];
    const search = createMemoryReader([
      profileOf(ALICE, "{not json"),
      profileOf(BOB, { name: "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8" }),
      profileOf(CAROL, { display_name: hex64("c") }),
      profileOf(DAVE, { name: 7, display_name: ["Dave"] }),
      profileOf(ERIN, { name: "Erin" }),
    ]);
    const { readers } = network({ [SEARCH]: search });
    const { result } = renderStore(() => useNames([ALICE, BOB, CAROL, DAVE, ERIN]), { readers });

    await waitFor(() => expect(result.current.get(ERIN)).toBe("Erin"));
    for (const pubkey of [ALICE, BOB, CAROL, DAVE]) expect(result.current.get(pubkey)).toBe(copy.reviews.someone);
  });

  it("sends no request with no review relays, and says Someone", async () => {
    const { readers } = network({});
    const { result } = renderStore(() => useNames([ALICE]), { readers });
    await settle();
    expect(readers).not.toHaveBeenCalled();
    expect(result.current.get(ALICE)).toBe(copy.reviews.someone);
  });
});

describe("useOwnPicture: only the picture of the person signed in is kept", () => {
  const ALICE_PICTURE = "https://img.example.test/alice.jpg";
  const BOB_PICTURE = "https://img.example.test/bob.jpg";

  /** Signs `pubkey` in in this tab, as the sign-in code does before the account is shown. */
  const signInAs = (pubkey: string) => window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
  const signOut = () => window.sessionStorage.removeItem(SESSION_KEY);

  /** The profiles of Alice and Bob on the review relay, both with a picture. */
  const bothPictured = () => [
    profileOf(ALICE, { name: "Alice", picture: ALICE_PICTURE }),
    profileOf(BOB, { name: "Bob", picture: BOB_PICTURE }),
  ];

  it("keeps the picture of the person signed in, and of no one else whose profile was read with it", async () => {
    config.reviewRelays = [SEARCH];
    signInAs(ALICE);
    const { readers } = network({ [SEARCH]: createMemoryReader(bothPictured()) });
    const { result } = renderStore(() => ({ names: useNames([ALICE, BOB]), store: useScoresStore("the test") }), { readers });
    await waitFor(() => expect(result.current.names.get(BOB)).toBe("Bob"));
    expect(result.current.names.get(ALICE)).toBe("Alice");

    expect(result.current.store.pictureOf(ALICE)).toBe(ALICE_PICTURE);
    expect(result.current.store.pictureOf(BOB)).toBeUndefined();

    // Bob's was not kept for a time he signs in: nothing shows of it until his own profile is read for him.
    signInAs(BOB);
    expect(result.current.store.pictureOf(BOB)).toBeUndefined();
    // And the store answers for the person signed in alone: Alice's, read while she was, is not shown to Bob.
    expect(result.current.store.pictureOf(ALICE)).toBeUndefined();
  });

  it("answers for no one when no one is signed in, and again for the person once they are", async () => {
    config.reviewRelays = [SEARCH];
    signInAs(ALICE);
    const { readers } = network({ [SEARCH]: createMemoryReader(bothPictured()) });
    const { result } = renderStore(() => ({ names: useNames([ALICE]), store: useScoresStore("the test") }), { readers });
    await waitFor(() => expect(result.current.names.get(ALICE)).toBe("Alice"));
    expect(result.current.store.pictureOf(ALICE)).toBe(ALICE_PICTURE);

    signOut();
    expect(result.current.store.pictureOf(ALICE)).toBeUndefined();
    signInAs(ALICE);
    expect(result.current.store.pictureOf(ALICE)).toBe(ALICE_PICTURE);
  });

  /**
   * A page that asks for Alice's name, as every page does for a reviewer, and, once `signedIn`, has her
   * account button: the one thing that asks for her picture.
   */
  function Page({ signedIn }: { signedIn: boolean }): JSX.Element {
    const name = useNames([ALICE]).get(ALICE);
    return (
      <>
        <p data-testid="name">{name}</p>
        {signedIn && <Button />}
      </>
    );
  }
  function Button(): JSX.Element {
    return <p data-testid="own">{useOwnPicture(ALICE) ?? "none"}</p>;
  }
  const treeOf = (readers: (url: string) => RelayReader, signedIn: boolean) => (
    <PlacesProvider reader={createMemoryReader(places)}>
      <ScoresProvider readers={readers}>
        <Page signedIn={signedIn} />
      </ScoresProvider>
    </PlacesProvider>
  );

  it("gives the picture of someone who signs in after their profile was read as a reviewer's, with one more read of it", async () => {
    config.reviewRelays = [SEARCH];
    const search = createMemoryReader(bothPictured());
    const { readers } = network({ [SEARCH]: search });
    const { rerender } = render(treeOf(readers, false));
    await waitFor(() => expect(screen.getByTestId("name")).toHaveTextContent("Alice"));
    await settle();
    expect(search.requests).toHaveLength(1);

    signInAs(ALICE);
    rerender(treeOf(readers, true));
    await waitFor(() => expect(screen.getByTestId("own")).toHaveTextContent(ALICE_PICTURE));
    expect(search.requests).toHaveLength(2);
    expect(search.requests[1]).toMatchObject({ kinds: [0], authors: [ALICE] });
  });

  it("reads the profile of the person signed in once, whether or not it gives a picture, however often the button is drawn", async () => {
    config.reviewRelays = [SEARCH];
    signInAs(ALICE);
    const search = createMemoryReader([profileOf(ALICE, { name: "Alice" })]);
    const { readers } = network({ [SEARCH]: search });
    const { rerender } = render(treeOf(readers, true));
    await waitFor(() => expect(screen.getByTestId("name")).toHaveTextContent("Alice"));
    await settle();
    expect(screen.getByTestId("own")).toHaveTextContent("none");
    // Explore's top is drawn again on the way back from Map.
    for (let draws = 0; draws < 2; draws++) {
      rerender(treeOf(readers, false));
      rerender(treeOf(readers, true));
      await settle();
    }
    expect(screen.getByTestId("own")).toHaveTextContent("none");
    expect(search.requests).toHaveLength(1);
  });
});

describe("the relay code, kept out of the first screen", () => {
  /**
   * Stands in for src/nostr/relayReader.ts, counting how often it is loaded and asked for a reader,
   * and gives fresh copies of the app's modules, which load it. A module that has loaded it once
   * keeps what it loaded, whatever a later test mocks, so each test needs copies of its own. Their
   * config is set as tests/setup.ts sets the shared one, with the production review relay.
   */
  async function withRelayCode(relays: Record<string, RelayReader>, { failFirst = false } = {}) {
    const loaded = vi.fn();
    const opened = vi.fn((url: string) => relays[url] ?? createMemoryReader([]));
    vi.resetModules();
    vi.doMock("../src/nostr/relayReader", () => {
      loaded();
      // As a chunk that does not come (the connection dropped) fails its import.
      if (failFirst && loaded.mock.calls.length === 1) throw new Error("Failed to fetch the relay chunk");
      return { readerFor: opened };
    });
    const { config: fresh } = await import("../src/config");
    Object.assign(fresh, { mapTilerKey: undefined, devScorer: undefined, reviewRelays: [SEARCH] });
    return { loaded, opened };
  }

  it("is loaded only once a page asks for places' reviews", async () => {
    const search = createMemoryReader([reviewOf(ALICE, JACAFE, 4)]);
    const { loaded, opened } = await withRelayCode({ [SEARCH]: search });
    const { PlacesProvider: Places } = await import("../src/places/store");
    const { ScoresProvider: Scores } = await import("../src/score/ScoresProvider");
    const { useScores: use } = await import("../src/score/useScore");
    const placesReader = createMemoryReader(places);
    const { result, rerender } = renderHook(({ addresses }: { addresses: string[] }) => use(addresses), {
      initialProps: { addresses: [] as string[] },
      wrapper: ({ children }: { children: ReactNode }) => (
        <Places reader={placesReader}>
          <Scores>{children}</Scores>
        </Places>
      ),
    });

    await settle();
    expect(loaded).not.toHaveBeenCalled();

    rerender({ addresses: [JACAFE] });
    await waitFor(() => expect(result.current.scores.get(JACAFE)?.outside).toBe(1));
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(SEARCH);
    expect(byA(search)).toEqual([{ kinds: [REVIEW_KIND], "#a": [JACAFE], limit: 500, search: "include:spam" }]);
  });

  it("is loaded once for reads that start together, and again after a load that failed", async () => {
    const search = createMemoryReader([reviewOf(ALICE, JACAFE, 4)]);
    const { loaded } = await withRelayCode({ [SEARCH]: search }, { failFirst: true });
    const { PlacesProvider: Places } = await import("../src/places/store");
    const { ScoresProvider: Scores } = await import("../src/score/ScoresProvider");
    const { useScore: use, useScoreActions: useActions } = await import("../src/score/useScore");
    const placesReader = createMemoryReader(places);
    const { result } = renderHook(() => ({ ...use(JACAFE), actions: useActions() }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Places reader={placesReader}>
          <Scores>{children}</Scores>
        </Places>
      ),
    });

    // Two reads of the place start together (by a and by d); the one load fails, and so do both.
    await waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    await settle();
    expect(search.requests).toEqual([]);
    expect(result.current.reviews).toEqual([]);

    act(() => result.current.actions.refresh());
    await waitFor(() => expect(result.current.reviews).toHaveLength(1));
    expect(loaded).toHaveBeenCalledTimes(2);
    expect(search.requests).toHaveLength(2);
  });

  it("is loaded once Explore's list is on a phone, which asks for its places' reviews in one go", async () => {
    const search = createMemoryReader([]);
    const { loaded, opened } = await withRelayCode({ [SEARCH]: search });
    const { openApp: open } = await import("./support/app");
    await open("/", { px: PHONE, events: places });

    expect((await screen.findAllByText("Jacafé")).length).toBeGreaterThan(0);
    await waitFor(() => expect(byA(search).length).toBeGreaterThan(0));
    await settle();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls.map(([url]) => url)).toEqual([SEARCH, SEARCH]);
    // One request by place address for the list: Jacafé among its places.
    expect(batchesOf(search)).toHaveLength(1);
    expect(batchesOf(search)[0]).toContain(JACAFE);
  });

  it("is loaded once Explore is on a desktop: one request for the list's places, then at most one for the map's own", async () => {
    const search = createMemoryReader([]);
    const { loaded, opened } = await withRelayCode({ [SEARCH]: search });
    const { openApp: open } = await import("./support/app");
    const { parsePlaces } = await import("../src/places/load");
    const { buildIndexes, groupForList } = await import("../src/places/indexes");
    const { config: fresh } = await import("../src/config");
    await open("/", { px: DESKTOP, events: places });

    expect((await screen.findAllByText("Jacafé")).length).toBeGreaterThan(0);
    // The list's places (a chain's card is not scored as one), and the map's pins, every place it draws
    // on its own (here all of them, each of a chain's places too: decision 25), once it has drawn them.
    const all = parsePlaces(places);
    const idx = buildIndexes(all);
    const { lat, lon, radiusKm } = fresh.defaultCity;
    const listed = new Set(groupForList(idx.near(lat, lon, radiusKm), idx).flatMap((entry) => ("chain" in entry ? [] : [entry.place.address])));
    const every = all.map((place) => place.address).sort();
    await waitFor(() => expect(batchesOf(search).flat().sort()).toEqual(every));
    await settle();
    expect(loaded).toHaveBeenCalledTimes(1);

    // The list asks as it is drawn; the map's pins are known only once the map has drawn its tiles, which
    // comes later (its library and its style load over the network), so the store's 50 ms of gathering
    // seldom has both. Holding the list's reviews back for the map would make the list wait. So: the
    // first request has every place of the list; a second, when there is one, has only the map's pins
    // the list did not ask about (a chain's places, places beyond the list), at most MAX_MARKERS. None
    // is asked twice, and never a card or a pin at a time.
    const batches = batchesOf(search);
    expect(batches.length).toBeLessThanOrEqual(2);
    for (const address of listed) expect(batches[0]).toContain(address);
    for (const address of batches[1] ?? []) expect(listed.has(address)).toBe(false);
    expect(batches.flat()).toHaveLength(every.length);
    expect(opened.mock.calls.map(([url]) => url)).toEqual(batches.flatMap(() => [SEARCH, SEARCH]));
  });

  it.each([
    ["a phone", PHONE],
    ["a desktop", DESKTOP],
  ])("is not loaded, and no review is asked for, when Explore opens on %s with no review relays", async (_, px) => {
    const { loaded, opened } = await withRelayCode({});
    const { config: fresh } = await import("../src/config");
    fresh.reviewRelays = [];
    const { openApp: open } = await import("./support/app");
    await open("/", { px, events: places });

    expect((await screen.findAllByText("Jacafé")).length).toBeGreaterThan(0);
    await settle();
    expect(loaded).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });
});
