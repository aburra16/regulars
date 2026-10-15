import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { asEvent, type ReadOptions, type RelayReader, readAll, withReadExtras } from "../nostr/events.ts";
import { appReaders } from "../nostr/relayCode.ts";
import { holdRemovals, removalFilters, removalsFrom } from "../reviews/removals.ts";
import { REVIEW_KIND } from "../reviews/review.ts";

/*
 * The newest reviews of places, wherever the places are (Recent): read from the review relays
 * (`config.reviewRelays`) a page at a time, newest first, and held in memory for the session, so
 * that Back to Recent finds the same list, with the removals of them (NIP-09) those relays send. The
 * feed holds review events, removals and where the reading of the reviews stands; which of them the
 * page shows, and whose they are, it works out with the scores store (src/recent/useRecent.ts).
 * Switching the view reads nothing here.
 *
 * Nothing here loads the relay code: the app's readers import it when they first read
 * (src/nostr/relayCode.ts), so the feed can be on the first screen.
 */

/** The most reviews one page asks for. */
export const FEED_PAGE = 100;

/** How many reviews that count in the view are enough: with fewer, Recent reads older pages by itself. */
export const FEED_ENOUGH = 20;

/**
 * Recent's budget of pages read by itself, for the session and across both views (ruling R1): while
 * fewer than this many pages back in time have been read (`FeedSnapshot.pages`, the first among them),
 * a view with fewer than `FEED_ENOUGH` reviews reads the next by itself; then it waits for "Show older
 * reviews". Switching the view never reads again a page already read.
 */
export const FEED_AUTO_PAGES = 3;

/**
 * How the reviews, and the removals of them, are read from each relay: not waiting on one that is out
 * (ruling R40), which fails at once, so that it holds up no page the others have answered. A relay
 * that is slow to send, once it has said anything, is waited for under its limits, as before.
 */
const REVIEW_READS: ReadOptions = { failFast: true };

/** How long the newest page read stays the newest: a visit to Recent after that reads it again. */
export const FEED_FRESH_MS = 120_000;

/** A reader for each relay, by its URL. */
type Readers = (url: string) => RelayReader;

/** Prints a note for developers. Never shown to a person, and not in the production build. */
function debug(message: string, ...details: unknown[]): void {
  if (import.meta.env.DEV) console.debug(`[recent] ${message}`, ...details);
}

/**
 * Where a read of the feed stands: not under way, under way, or failed (no review relay answered).
 * `first` has `read` too: once it is, there is a list.
 */
export type FeedRead = "idle" | "reading" | "failed";

/** The feed as a page draws it: one object for as long as nothing in it changes. */
export interface FeedSnapshot {
  /** Every review event read, in no order. */
  events: readonly NostrEvent[];
  /**
   * Every removal read that counts (`countsAsRemoval`), in no order, each once, held for the session:
   * read after each page, of the reviews it brought, and held apart from them, so that no page, time
   * or pruning sees one.
   */
  removals: readonly NostrEvent[];
  /** The first page: not asked for yet, being read, read, or failed with nothing read. */
  first: FeedRead | "read";
  /** The next page back in time ("Show older reviews", or read by itself). */
  older: FeedRead;
  /** The newest page again, read on a visit once the last one is no longer fresh (`FEED_FRESH_MS`). */
  newer: FeedRead;
  /**
   * How many pages back in time have been read this session: the first, and each older one, whoever
   * asked for it. A fresh start from the newest page (`FEED_FRESH_MS`) counts none, and takes none back:
   * it is the budget of pages read by itself (`FEED_AUTO_PAGES`).
   */
  pages: number;
  /**
   * How far back the reviews held reach for every review relay (`Page.reach`): the next page back asks
   * for what is older. Undefined until there is a review.
   */
  oldest: number | undefined;
  /** Whether the relays have sent every review there is: no relay came back full. */
  end: boolean;
}

/** One page, as the relays that answered sent it. */
interface Page {
  /** What every relay sent, a review sent by two of them twice. */
  events: NostrEvent[];
  /** The relays that answered: where the removals of its reviews are asked for. */
  answered: string[];
  /** Whether a relay sent as many as were asked for: there may be more, further back. */
  full: boolean;
  /** Whether every review relay answered. */
  complete: boolean;
  /**
   * How far back the page holds every review of every relay that answered: a relay that came back
   * full may hold more below its own oldest review, so it is the newest of those relays' oldest; when
   * none came back full, the oldest review of all. Undefined for a page with no review.
   */
  reach: number | undefined;
}

/** The oldest time among `events`; undefined for none. */
const oldestOf = (events: readonly NostrEvent[]) =>
  events.length === 0 ? undefined : Math.min(...events.map((ev) => ev.created_at));

/** The newest time among `events`; undefined for none. */
const newestOf = (events: Iterable<NostrEvent>) => {
  let newest: number | undefined;
  for (const ev of events) if (newest === undefined || ev.created_at > newest) newest = ev.created_at;
  return newest;
};

/**
 * The session's feed, which ScoresProvider holds beside the scores store. Recent asks for it when it
 * is shown (`open`); reads happen between `start` and `stop`, which aborts them.
 */
export class RecentFeed {
  readonly #readers: Readers;
  readonly #listeners = new Set<() => void>();
  /** Aborts every read when the provider unmounts. Null while it is not mounted. */
  #life: AbortController | null = null;
  /** Whether Recent has been shown: the first page is read once the feed is started, if it was asked before. */
  #wanted = false;

  readonly #events = new Map<string, NostrEvent>();
  /** The removals read, by id (`FeedSnapshot.removals`). */
  readonly #removals = new Map<string, NostrEvent>();
  /**
   * The reading of the removals of the pages kept, one page's after another's (`#keep`): pages read by
   * themselves come one on another, and a relay is sent no more than `REMOVAL_REQUESTS_AT_ONCE`
   * requests for removals at once.
   */
  #removalReads: Promise<void> = Promise.resolve();
  #first: FeedSnapshot["first"] = "idle";
  #older: FeedRead = "idle";
  #newer: FeedRead = "idle";
  #pages = 0;
  /** How far back what is held reaches for every relay (`Page.reach`); the next page asks for what is older. */
  #oldest: number | undefined;
  #end = false;
  /**
   * Which run of reading back this is: a fresh start from the newest page begins another, and an older
   * page asked for before it, read after, is not this run's, and is let go of.
   */
  #epoch = 0;
  /** When the newest page was last read (`Date.now()`). */
  #readAt: number | undefined;
  #snapshot: FeedSnapshot | null = null;

  /** `readers` gives each relay's reader; by default the app's. Each relay's read extras are added to it. */
  constructor(readers: Readers = appReaders) {
    this.#readers = (url) => withReadExtras(readers(url), config.relayReadExtras[url]);
  }

  /** Calls `listener` after each change. Returns what stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The feed as it is now, for `useSyncExternalStore`: the same object until something changes. */
  readonly snapshot = (): FeedSnapshot => {
    this.#snapshot ??= {
      events: [...this.#events.values()],
      removals: [...this.#removals.values()],
      first: this.#first,
      older: this.#older,
      newer: this.#newer,
      pages: this.#pages,
      oldest: this.#oldest,
      end: this.#end,
    };
    return this.#snapshot;
  };

  /** Starts reading what Recent has asked for. */
  start(): void {
    this.#life = new AbortController();
    if (this.#wanted) this.open();
  }

  /** Aborts every read. What was being read is read again when Recent asks next. */
  stop(): void {
    this.#life?.abort();
    this.#life = null;
    const reading = this.#first === "reading" || this.#older === "reading" || this.#newer === "reading";
    if (this.#first === "reading") this.#first = "idle";
    if (this.#older === "reading") this.#older = "idle";
    if (this.#newer === "reading") this.#newer = "idle";
    if (reading) this.#changed();
  }

  /**
   * Recent is shown: the first page is read if none has been (or the last try failed), and the newest
   * page again if it was read more than `FEED_FRESH_MS` ago, to go at the top of what is held. A Back
   * to Recent within that time reads nothing, and finds the list as it was.
   */
  readonly open = (): void => {
    this.#wanted = true;
    if (this.#first === "idle" || this.#first === "failed") void this.#readFirst();
    else if (this.#first === "read" && this.#readAt !== undefined && Date.now() - this.#readAt > FEED_FRESH_MS) {
      void this.#readNewer();
    }
  };

  /** Reads again what failed: the first page, the newest page, or the next page back. */
  readonly retry = (): void => {
    if (this.#first === "failed") void this.#readFirst();
    if (this.#newer === "failed") void this.#readNewer();
    if (this.#older === "failed") void this.readOlder();
  };

  /**
   * Reads the next page back in time: the reviews older than what is held reaches back to for every
   * relay (`until` is that time less a second). Nothing once the relays have sent every review there
   * is. A page that comes after the feed has started again from the newest page is let go of.
   */
  readonly readOlder = async (): Promise<void> => {
    const signal = this.#life?.signal;
    if (signal === undefined || this.#first !== "read" || this.#older === "reading" || this.#end) return;
    if (this.#oldest === undefined || this.#oldest - 1 < 0) {
      // Nothing is older than the first second there is.
      this.#end = true;
      this.#changed();
      return;
    }
    const epoch = this.#epoch;
    this.#older = "reading";
    this.#changed();
    const page = await this.#page(this.#oldest - 1, signal);
    if (signal.aborted) return;
    if (epoch !== this.#epoch) {
      // The feed started again meanwhile: this page is not below what it holds now.
      this.#older = "idle";
      this.#changed();
      return;
    }
    if (page === null) {
      this.#older = "failed";
      this.#changed();
      return;
    }
    this.#keep(page, signal);
    this.#pages += 1;
    this.#oldest = page.reach ?? this.#oldest;
    this.#end = !page.full && page.complete;
    this.#older = "idle";
    this.#changed();
  };

  /**
   * Reads the first page: the newest reviews there are. With no relays to read reviews from there are
   * none to read.
   */
  async #readFirst(): Promise<void> {
    const signal = this.#life?.signal;
    if (signal === undefined || this.#first === "reading") return;
    if (config.reviewRelays.length === 0) {
      this.#first = "read";
      this.#end = true;
      this.#changed();
      return;
    }
    this.#first = "reading";
    this.#changed();
    const page = await this.#page(undefined, signal);
    if (signal.aborted) return;
    if (page === null) {
      this.#first = "failed";
      this.#changed();
      return;
    }
    this.#keep(page, signal);
    this.#pages = 1;
    this.#oldest = page.reach;
    this.#end = !page.full && page.complete;
    this.#readAt = Date.now();
    this.#first = "read";
    this.#changed();
  }

  /**
   * Reads the newest page again, for the top of the list. Where every review relay answered, what the
   * page reaches back to for every relay (`Page.reach`) is as it says: a review held from after that
   * time that it no longer sends is gone (removed since). One from that very second stays: a relay that
   * came back full may have had more of that second than the page had room for. A page with no relay full holds every review there
   * is. A full page that does not reach back to the newest review held would leave a gap below it: the
   * feed starts again from it. Starting again, or holding every review, an older page on its way is let
   * go of. Neither counts a page against the budget of pages read by itself, nor takes one back.
   */
  async #readNewer(): Promise<void> {
    const signal = this.#life?.signal;
    if (signal === undefined || this.#first !== "read" || this.#newer === "reading") return;
    this.#newer = "reading";
    this.#changed();
    const page = await this.#page(undefined, signal);
    if (signal.aborted) return;
    if (page === null) {
      this.#newer = "failed";
      this.#changed();
      return;
    }
    if (page.complete) {
      const from = page.reach;
      const newestHeld = newestOf(this.#events.values());
      if (!page.full) {
        this.#events.clear();
        this.#epoch += 1;
        this.#oldest = from;
        this.#end = true;
      } else if (from !== undefined && newestHeld !== undefined && from > newestHeld) {
        this.#events.clear();
        this.#epoch += 1;
        this.#oldest = from;
        this.#end = false;
      } else if (from !== undefined) {
        // After `from`, not at it: a full relay may have cut that second short.
        for (const [id, ev] of this.#events) if (ev.created_at > from) this.#events.delete(id);
      }
    }
    this.#keep(page, signal);
    this.#readAt = Date.now();
    this.#newer = "idle";
    this.#changed();
  }

  /**
   * One page from every relay reviews are read from, side by side, a relay that is out failing at once
   * (`REVIEW_READS`): the reviews of places (`m` is `place`, decision 17), newest first, at most
   * `FEED_PAGE` from each, those up to `until` (that second included) when it is given. Null when no
   * relay answered, or `signal` aborted.
   */
  async #page(until: number | undefined, signal: AbortSignal): Promise<Page | null> {
    const filter: NostrFilter = {
      kinds: [REVIEW_KIND],
      "#m": ["place"],
      limit: FEED_PAGE,
      ...(until === undefined ? {} : { until }),
    };
    const relays = [...config.reviewRelays];
    const reads = await Promise.allSettled(
      // A reader that cannot be made fails its relay's read, as a read that fails does.
      relays.map(async (url) => readAll(this.#readers(url), filter, signal, REVIEW_READS)),
    );
    if (signal.aborted) return null;
    const answered = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
    if (answered.length === 0) return null;
    const events: NostrEvent[] = [];
    // The newest of the oldest reviews of the relays that came back full.
    let fullReach: number | undefined;
    for (const values of answered) {
      const sent: NostrEvent[] = [];
      for (const value of values) {
        const ev = asEvent(value);
        if (ev !== null && ev.kind === REVIEW_KIND) sent.push(ev);
      }
      events.push(...sent);
      const oldest = oldestOf(sent);
      if (values.length >= FEED_PAGE && oldest !== undefined && (fullReach === undefined || oldest > fullReach)) fullReach = oldest;
    }
    const full = answered.some((values) => values.length >= FEED_PAGE);
    return {
      events,
      answered: relays.filter((_, at) => reads[at]?.status === "fulfilled"),
      full,
      complete: answered.length === reads.length,
      reach: (full ? fullReach : undefined) ?? oldestOf(events),
    };
  }

  /**
   * Holds the reviews of `page`, once each; then, without waiting, asks the relays that answered it
   * for their removals (`#readRemovals`), once the removals of the pages kept before it are read.
   */
  #keep(page: Page, signal: AbortSignal): void {
    for (const ev of page.events) this.#events.set(ev.id, ev);
    const filters = removalFilters(page.events);
    this.#removalReads = this.#removalReads
      .then(() => this.#readRemovals(page.answered, filters, signal))
      // One page's removals that could not be taken in stop none of the next pages'.
      .catch((error: unknown) => debug("a page's removals could not be taken in", error));
  }

  /**
   * Asks each of `relays` for the removals `filters` name (`removalFilters`), side by side, the
   * requests to one relay `REMOVAL_REQUESTS_AT_ONCE` at a time (`removalsFrom`), as a page is read
   * (`REVIEW_READS`).
   * Each removal that counts is held for the session (`holdRemovals`), apart from the reviews, and the
   * page is told when one is new. A relay that fails gives none, and the reviews show as they did;
   * nothing is taken once the feed is stopped.
   */
  async #readRemovals(relays: readonly string[], filters: readonly NostrFilter[], signal: AbortSignal): Promise<void> {
    if (relays.length === 0 || filters.length === 0 || signal.aborted) return;
    const reads = await Promise.allSettled(
      relays.map(async (url) => {
        const reader = this.#readers(url);
        return removalsFrom(filters, (filter) => readAll(reader, filter, signal, REVIEW_READS));
      }),
    );
    if (signal.aborted) return;
    const values = reads.flatMap((read) => (read.status === "fulfilled" ? read.value : []));
    if (holdRemovals(this.#removals, values, Date.now() / 1000)) this.#changed();
  }

  /** Notes a change, and tells the listeners. */
  #changed(): void {
    this.#snapshot = null;
    for (const listener of this.#listeners) listener();
  }
}
