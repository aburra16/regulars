import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { config } from "../../src/config.ts";
import type { RelayReader, RelayWriter } from "../../src/nostr/events.ts";
import { createMemoryReader } from "./memoryReader.ts";
import { createMemoryWriter, type MemoryWriter, type MemoryWriterOptions } from "./memoryWriter.ts";

/*
 * The relays a follow list is read from and saved to, held in memory, for the tests of the change
 * that writes one (tests/followChange.test.ts), of the session's own list (tests/followProvider.test.tsx)
 * and of the pages that show it. Each relay keeps what it is sent, so a list a change saved is the
 * list the next read finds. Nothing opens a socket.
 */

/**
 * A review relay, which is asked for people's relay lists and their profiles, and keeps no follow
 * lists (ruling R12); and the three follow-list relays, one of them the relay that keeps people's
 * relay lists.
 */
export const REVIEWS = "wss://reviews.example.test";
export const NOS = "wss://nos.example.test";
export const DIRECTORY = "wss://directory.example.test";
export const BIG = "wss://big.example.test";
/** The three follow-list relays, in the order the app is set up with them (`setUpRelays`). */
export const FOLLOW_RELAYS = [NOS, DIRECTORY, BIG] as const;
/** A relay the person writes to. */
export const OWN = "wss://own.example.test";

/** The app's relays for these tests: three for follow lists, so that enough can answer for a fresh list (ruling R7). */
export function setUpRelays(app: typeof config): void {
  app.reviewRelays = [REVIEWS];
  app.relayListRelays = [DIRECTORY];
  app.followListRelays = [...FOLLOW_RELAYS];
}

export const asksForList = (filter: NostrFilter) => filter.kinds?.includes(3) === true && filter.authors !== undefined;
export const asksForFollower = (filter: NostrFilter) => filter.kinds?.includes(3) === true && filter["#p"] !== undefined;
export const asksForProfile = (filter: NostrFilter) => filter.kinds?.includes(0) === true;
export const asksForRelayList = (filter: NostrFilter) => filter.kinds?.includes(10002) === true;

/** A relay: what it holds, its reader over that, what that reader was asked, and its writer, which keeps what it takes. */
export interface Relay {
  held: NostrEvent[];
  reader: RelayReader;
  asked: NostrFilter[];
  writer: MemoryWriter;
  /** While true, every read of what it holds fails, as a relay that is down. A test sets it, and unsets it. */
  down: boolean;
  /**
   * While true, it fails every request for a person's own follow list, and answers whatever else it
   * is asked (a relay list, a profile): a relay that cannot send a list just now. So a read of a
   * list is made, and cannot tell. A test sets it, and unsets it.
   */
  listsDown: boolean;
  /** When set, its next answer to a request for a follow list waits for this, and then it is unset. */
  holds: Promise<void> | undefined;
}

export interface RelayOptions {
  /** How it answers what it is sent. Default: it takes it, and holds it. */
  writes?: MemoryWriterOptions;
  /** Its reader, made from the one over what it holds. Default: that one. */
  reads?: (reader: RelayReader) => RelayReader;
  /** Whether it sends back what it takes. Default: it does. */
  lags?: boolean;
}

export function relay(holds: NostrEvent[] = [], opts: RelayOptions = {}): Relay {
  const held = [...holds];
  const memory = createMemoryReader(held);
  const asked: NostrFilter[] = [];
  /** The reader over what it holds: it notes each request as it comes, then fails, waits or answers. */
  const inner: RelayReader = {
    async *req(filter, signal) {
      asked.push(filter);
      if (self.down) throw new Error("this relay is down");
      if (self.listsDown && asksForList(filter) && !asksForFollower(filter)) throw new Error("this relay has no lists to send just now");
      if (asksForList(filter) && self.holds !== undefined) {
        const wait = self.holds;
        self.holds = undefined;
        await wait;
      }
      yield* memory.req(filter, signal);
    },
  };
  const self: Relay = {
    held,
    asked,
    down: false,
    listsDown: false,
    holds: undefined,
    reader: opts.reads?.(inner) ?? inner,
    writer: createMemoryWriter({ ...(opts.lags ? {} : { into: held }), ...opts.writes }),
  };
  return self;
}

/**
 * The addresses a test's code asked for that are no relay of its world, in order. A test that holds
 * its code to its own relays empties this before it starts, and looks at it once it has ended.
 */
export const strangers: string[] = [];

/**
 * The relays of a test: those a follow list may be on, by address, and the review relay, kept apart
 * as no follow list is read from it or sent to it. A relay that is not among them cannot be read or
 * written: it fails, as one that is down, and its address is noted (`strangers`).
 */
export interface World {
  relays: Record<string, Relay>;
  reviews: Relay;
  readers: (url: string) => RelayReader;
  writers: (url: string) => RelayWriter;
  /** Every event any relay was sent, relay by relay, the review relay among them. */
  published(): NostrEvent[];
  /** Every request any relay's reader was sent, relay by relay, the review relay among them. */
  asked(): NostrFilter[];
}

export function world(relays: Record<string, Relay>, reviews: Relay = relay()): World {
  const at = (url: string) => {
    const found = url === REVIEWS ? reviews : relays[url];
    if (found === undefined) {
      strangers.push(url);
      throw new Error(`No relay at ${url} in this test`);
    }
    return found;
  };
  const all = () => [...Object.values(relays), reviews];
  return {
    relays,
    reviews,
    readers: (url) => at(url).reader,
    writers: (url) => at(url).writer,
    published: () => all().flatMap((each) => each.writer.published),
    asked: () => all().flatMap((each) => each.asked),
  };
}

/** The three follow-list relays, each holding `events`, and each as `opts` says. */
export const everywhere = (events: NostrEvent[] = [], opts: RelayOptions = {}): World =>
  world({ [NOS]: relay(events, opts), [DIRECTORY]: relay(events, opts), [BIG]: relay(events, opts) });

/** A reader that never answers, and takes no notice of the signal. */
export const silent: RelayReader = {
  async *req() {
    await new Promise<never>(() => {});
  },
};

/** `reader`, except that it fails a request `when` says to. */
export const failingWhen = (when: (filter: NostrFilter) => boolean) => (reader: RelayReader): RelayReader => ({
  async *req(filter, signal) {
    if (when(filter)) throw new Error("this relay does not take that");
    yield* reader.req(filter, signal);
  },
});

/** `reader`, except that it never answers a request `when` says to, whatever its signal does. */
export const silentWhen = (when: (filter: NostrFilter) => boolean) => (reader: RelayReader): RelayReader => ({
  async *req(filter, signal) {
    if (when(filter)) await new Promise<never>(() => {});
    yield* reader.req(filter, signal);
  },
});
