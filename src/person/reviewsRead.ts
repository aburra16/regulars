import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { readWithin } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type Readers } from "../nostr/events.ts";
import { holdRemovals, removalFilters, removalsFrom } from "../reviews/removals.ts";
import { REVIEW_KIND } from "../reviews/review.ts";

/*
 * The reading of one person's reviews of places, for their page: from the relays reviews are read from
 * (`config.reviewReadRelays`) a page at a time, newest first, for as long as the page is open, and
 * held in memory for that long, with the removals of them (NIP-09) those relays send. It holds review
 * events, removals and where the reading of the reviews stands; which of them the page shows, the page
 * works out (./usePersonReviews.ts), as Trending does from its feed (src/recent/feed.ts). Nothing here
 * writes, and nothing is kept once the page is left: its reads are stopped.
 *
 * Each relay is read on its own: how far its reading has got is a cursor, and the step from one page
 * to the next is a function of the cursor, what the relay sent, and whether another relay answered
 * the page (`stepCursor`).
 *
 * Nothing here loads the relay code: the app's readers import it when they first read
 * (src/nostr/relayCode.ts).
 */

/** Prints a note for developers. Never shown to a person, and not in the production build. */
function debug(message: string, ...details: unknown[]): void {
  if (import.meta.env.DEV) console.debug(`[person] ${message}`, ...details);
}

/** How many reviews one page asks each relay for, beyond those it is known to send again. */
export const PERSON_PAGE = 20;

/**
 * The most reviews one request asks a relay for: a page, and the reviews of the second the last page
 * ended in, which the relay sends again (`Cursor.again`). A second with more reviews in it than this
 * leaves room for is not read to its end: the reading goes on from the second before.
 */
export const PERSON_ASK_MAX = 100;

/** How long each review relay has to answer for a page, in milliseconds. One that takes longer is left out of it, as one that fails is. */
export const PERSON_READ_MS = 6_000;

/** How far the reading of one relay has got. */
export interface Cursor {
  /** The next page asks it for the reviews up to this time, that second included; undefined for the newest. */
  readonly until: number | undefined;
  /**
   * How many reviews written in that very second it has sent: it sends them again at the top of the
   * next page, which is asked for that many more, so that each page brings `PERSON_PAGE` new ones.
   */
  readonly again: number;
  /** Whether it has sent every review it has: a page came back short. */
  readonly done: boolean;
  /**
   * Whether it has been left for the rest of the visit: it did not answer a page that another relay
   * answered (ruling R38). It is asked nothing more, so that nothing on the page waits on a relay
   * that is out, or offers what only that relay could send. What it holds was not read to the end,
   * whether it had answered before or never did: a relay that is left has not sent everything.
   */
  readonly left: boolean;
}

/** Where every relay's reading begins: the newest page, and not left. */
export const FIRST_ASK: Cursor = Object.freeze({ until: undefined, again: 0, done: false, left: false });

/**
 * What a relay sent for one page: how many values in all (`count`, which says whether the page came
 * back full), and when each of the person's reviews among them was written (`times`).
 */
export interface Sent {
  count: number;
  times: readonly number[];
}

/** How many reviews the next page asks the relay for: a page, and those it is known to send again. */
export const limitOf = (cursor: Cursor): number => PERSON_PAGE + cursor.again;

/** Whether the relay is asked for its next page: it may have more, and has not been left for the visit. */
export const askedStill = (cursor: Cursor): boolean => !cursor.done && !cursor.left;

/**
 * Where a relay's reading stands after one page: `cursor` is where it stood as the page was asked
 * for; `sent` is what the relay sent for it, or null when it did not answer (it failed, was out, or
 * was out of time); and `anotherAnswered` says whether any other relay asked for the page answered.
 *
 * A relay that did not answer a page another relay answered is left for the visit, at once (ruling
 * R38): the page has what the others sent, and goes on with them. When no relay answered the page,
 * it stands where it stood: the page was not read, the person is told, and their Try again asks
 * every relay for that same page again, as often as they like, with nothing counted against any.
 *
 * A page that came back short is the relay's last; so is one in which no time can be read. A relay
 * that sent all it was asked for may have more: it is asked next for the reviews up to the oldest
 * second it sent, that second included, so that a page that ends inside one second loses none of
 * that second's; and for as many more as it sent from that second, which it sends again. A second
 * with more reviews than one request may ask for (`PERSON_ASK_MAX`) is left there, and the reading
 * goes on from the second before, as the scores store's does (`readPaged`, src/score/store.ts); with
 * no second before it, the relay is done. A relay that gets no further back than it was asked from,
 * with no more of that second than before, does not page: it is done.
 */
export function stepCursor(cursor: Cursor, sent: Sent | null, anotherAnswered: boolean): Cursor {
  if (sent === null) return anotherAnswered ? { ...cursor, left: true } : cursor;
  const done: Cursor = { ...cursor, done: true };
  if (sent.count < limitOf(cursor) || sent.times.length === 0) return done;
  const oldest = Math.min(...sent.times);
  const again = sent.times.filter((time) => time === oldest).length;
  const stuck = cursor.until !== undefined && (oldest > cursor.until || (oldest === cursor.until && again <= cursor.again));
  if (stuck) return done;
  if (PERSON_PAGE + again <= PERSON_ASK_MAX) return { ...cursor, until: oldest, again };
  return oldest - 1 < 0 ? done : { ...cursor, until: oldest - 1, again: 0 };
}

/** Where a read stands: not under way, under way, or failed (no relay asked answered: each stands where it stood). */
type Asked = "idle" | "reading" | "failed";

/** The read as the page draws from it: one object for as long as nothing in it changes. */
export interface ReadSnapshot {
  /** Every review event read, in no order, each once. */
  events: readonly NostrEvent[];
  /**
   * Every removal read that counts (`countsAsRemoval`), in no order, each once: read after each page,
   * of the reviews it brought, and held apart from them, so that no page, cursor or time sees one.
   */
  removals: readonly NostrEvent[];
  /** The first page: not asked for yet, being read, read, or failed with nothing read. */
  first: Asked | "read";
  /** The next page back in time. */
  more: Asked;
  /**
   * Whether there is no relay left to ask: each has sent every review it has, or has been left for
   * the visit (`askedStill`). A relay that is out does not keep the reading open.
   */
  end: boolean;
  /**
   * Whether a relay was left (rulings R37 and R42): one that had more to send, or one that never
   * answered. Not every relay has answered in full, so reviews may not have been read. When nothing
   * is listed at the end, that is "could not be loaded", never "none yet".
   */
  missed: boolean;
  /** How many pages have been read since the person last asked for one: the first, or Show more's, and those read by themselves after it. */
  sinceAsk: number;
}

/**
 * The reading of one person's reviews of places from the review relays, page after page. Each relay
 * is read from where its own last page ended.
 *
 * The reviews are read once any relay has answered the first page, as a place's are (ruling R33,
 * src/score/store.ts). A relay that does not answer a page another relay answered is left for the
 * visit at once (ruling R38), and the reading is at its end when no relay is asked any more: so
 * nothing waits on a relay that is out, and Show more is never offered for what only such a relay
 * could send. A page no relay answered has failed, the first or a later one: nothing of it is held
 * against any relay, nothing reads it again by itself, and the person's Try again asks the same
 * relays for it, as often as they ask. The first page's Try again begins the visit again, and so
 * does `restart`, for a reading that ended with a relay left and nothing to list (`missed`, rulings
 * R37 and R42): only when every relay has answered in full is a person known to have no reviews.
 *
 * Reads happen between `start` and `stop`, which aborts them.
 */
export class ReviewsRead {
  readonly #readers: Readers;
  readonly #listeners = new Set<() => void>();
  /** Aborts every read when the page is left. Null while it is not open. */
  #life: AbortController | null = null;

  readonly #events = new Map<string, NostrEvent>();
  /** The removals read, by id (`ReadSnapshot.removals`). */
  readonly #removals = new Map<string, NostrEvent>();
  /**
   * The reading of the removals of the pages read, one page's after another's (`#page`): pages read by
   * themselves come one on another, and a relay is sent no more than `REMOVAL_REQUESTS_AT_ONCE`
   * requests for removals at once.
   */
  #removalReads: Promise<void> = Promise.resolve();
  /**
   * Each relay reviews are read from, by its address as the app is set up with it, and how far its
   * reading has got.
   */
  readonly #cursors: Map<string, Cursor>;
  #first: ReadSnapshot["first"] = "idle";
  #more: Asked = "idle";
  #sinceAsk = 0;
  #snapshot: ReadSnapshot | null = null;

  /** The reviews of the person whose key is `pubkey`, read through `readers`: each relay's reader, without its read extras, which each read adds. */
  constructor(
    readonly pubkey: string,
    readers: Readers,
  ) {
    this.#readers = readers;
    this.#cursors = new Map(config.reviewReadRelays.map((url) => [url, FIRST_ASK]));
  }

  /** Calls `listener` after each change. Returns what stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The read as it is now, for `useSyncExternalStore`: the same object until something changes. */
  readonly snapshot = (): ReadSnapshot => {
    this.#snapshot ??= {
      events: [...this.#events.values()],
      removals: [...this.#removals.values()],
      first: this.#first,
      more: this.#more,
      end: this.#atEnd(),
      missed: [...this.#cursors.values()].some((cursor) => cursor.left),
      sinceAsk: this.#sinceAsk,
    };
    return this.#snapshot;
  };

  /** The page is open: the first page is read, unless it has been. */
  start(): void {
    this.#life = new AbortController();
    if (this.#first === "idle") void this.#readFirst();
  }

  /** The page is left: every read is aborted, and nothing that comes after is taken. */
  stop(): void {
    this.#life?.abort();
    this.#life = null;
    if (this.#first === "reading") this.#first = "idle";
    if (this.#more === "reading") this.#more = "idle";
    this.#snapshot = null;
  }

  /**
   * Reads again the page that no relay answered, for the person's Try again. The first page: the
   * visit begins again (`restart`). A later page: the same relays are asked for it again. There is
   * no limit to how often, and each time is the person's own tap.
   */
  readonly retry = (): void => {
    if (this.#first === "failed") this.restart();
    else if (this.#more === "failed") void this.readMore(true);
  };

  /**
   * Begins the visit again, for the person's Try again where the reviews could not be had: every
   * relay is asked from its newest page, those left before among them. What was read stays held,
   * each review once. Nothing while a page is being read, or while the page is not open.
   */
  readonly restart = (): void => {
    if (this.#life === null || this.#first === "reading" || this.#more === "reading") return;
    for (const url of this.#cursors.keys()) this.#cursors.set(url, FIRST_ASK);
    this.#more = "idle";
    void this.#readFirst();
  };

  /**
   * Reads the next page back in time, from each relay asked still. `asked` says the person asked for
   * it (Show more, Try again), which begins the count of pages read for one ask again; without it,
   * the page is one read by itself. Nothing while a page is being read, before the first has been, or
   * once no relay is left to ask. It has failed when none of the relays asked answered: each stands
   * where it stood, and is asked again only when the person asks.
   */
  readonly readMore = async (asked = false): Promise<void> => {
    const signal = this.#life?.signal;
    if (signal === undefined || this.#first !== "read" || this.#more === "reading" || this.#atEnd()) return;
    if (asked) this.#sinceAsk = 0;
    this.#more = "reading";
    this.#changed();
    const answered = await this.#page(signal);
    if (signal.aborted) return;
    this.#sinceAsk += 1;
    this.#more = answered ? "idle" : "failed";
    this.#changed();
  };

  /** Reads the first page: the newest reviews each relay has. With no review relays there are none to read. */
  async #readFirst(): Promise<void> {
    const signal = this.#life?.signal;
    if (signal === undefined || this.#first === "reading") return;
    if (this.#cursors.size === 0) {
      this.#first = "read";
      this.#changed();
      return;
    }
    this.#first = "reading";
    this.#changed();
    const answered = await this.#page(signal);
    if (signal.aborted) return;
    this.#sinceAsk = 1;
    this.#first = answered ? "read" : "failed";
    this.#changed();
  }

  /**
   * One page from each relay asked still (`askedStill`), side by side, each within `PERSON_READ_MS`: the
   * person's reviews of places (`m` is `place`, decision 17), newest first, up to where that relay's
   * last page ended (`Cursor`). What comes is held, each event once, whichever relays sent it, and
   * each relay's reading moves on (`stepCursor`): one that did not answer is left when another did,
   * and stands where it stood when none did. Then, without the page waiting, the relays that answered
   * are asked for the removals of the reviews the page brought (`#readRemovals`), once those of the
   * pages before it are read. Whether any relay answered.
   */
  async #page(signal: AbortSignal): Promise<boolean> {
    const asked = [...this.#cursors].filter(([, cursor]) => askedStill(cursor));
    const reads = await Promise.allSettled(
      asked.map(([url, cursor]) => {
        const filter: NostrFilter = {
          kinds: [REVIEW_KIND],
          authors: [this.pubkey],
          "#m": ["place"],
          limit: limitOf(cursor),
          ...(cursor.until === undefined ? {} : { until: cursor.until }),
        };
        // With what a read from this relay adds (`config.relayReadExtras`), as every read of reviews has.
        // A relay that is out fails at once, not after its time (ruling R40): it did not answer this page.
        return readWithin(url, filter, this.#readers, signal, PERSON_READ_MS, { failFast: true });
      }),
    );
    if (signal.aborted) return false;
    const answering = reads.filter((read) => read.status === "fulfilled").length;
    const answered: string[] = [];
    const brought = new Map<string, NostrEvent>();
    reads.forEach((read, at) => {
      const [url, cursor] = asked[at]!;
      if (read.status !== "fulfilled") {
        this.#cursors.set(url, stepCursor(cursor, null, answering > 0));
        return;
      }
      answered.push(url);
      const times: number[] = [];
      for (const value of read.value) {
        const ev = asEvent(value);
        // Only what was asked for: a review, by this person.
        if (ev === null || ev.kind !== REVIEW_KIND || ev.pubkey !== this.pubkey) continue;
        this.#events.set(ev.id, ev);
        brought.set(ev.id, ev);
        times.push(ev.created_at);
      }
      this.#cursors.set(url, stepCursor(cursor, { count: read.value.length, times }, answering > 1));
    });
    const filters = removalFilters([...brought.values()]);
    this.#removalReads = this.#removalReads
      .then(() => this.#readRemovals(answered, filters, signal))
      // One page's removals that could not be taken in stop none of the next pages'.
      .catch((error: unknown) => debug("a page's removals could not be taken in", error));
    return answering > 0;
  }

  /**
   * Asks each of `relays` for the removals `filters` name (`removalFilters`), side by side, the
   * requests to one relay `REMOVAL_REQUESTS_AT_ONCE` at a time (`removalsFrom`), each within
   * `PERSON_READ_MS` and failing at once when it is out, as a page is read. Each removal that counts is
   * held (`holdRemovals`), apart from the reviews, and the page is told when one is new. A relay that
   * fails gives none, and the reviews show as they did; nothing is taken once the page is left.
   */
  async #readRemovals(relays: readonly string[], filters: readonly NostrFilter[], signal: AbortSignal): Promise<void> {
    if (relays.length === 0 || filters.length === 0 || signal.aborted) return;
    const reads = await Promise.allSettled(
      relays.map((url) =>
        removalsFrom(filters, (filter) => readWithin(url, filter, this.#readers, signal, PERSON_READ_MS, { failFast: true })),
      ),
    );
    if (signal.aborted) return;
    const values = reads.flatMap((read) => (read.status === "fulfilled" ? read.value : []));
    if (holdRemovals(this.#removals, values, Date.now() / 1000)) this.#changed();
  }

  /** Whether no relay is left to ask: each is done, or has been left for the visit. */
  #atEnd(): boolean {
    return ![...this.#cursors.values()].some(askedStill);
  }

  /** Notes a change, and tells the listeners. */
  #changed(): void {
    this.#snapshot = null;
    for (const listener of this.#listeners) listener();
  }
}
