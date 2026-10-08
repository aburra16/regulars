import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { config } from "../config.ts";
import { asEvent, isNewer, type RelayReader, readAll, withReadExtras } from "../nostr/events.ts";
import { fetchNames } from "../nostr/profiles.ts";
import { isHex64 } from "../nostr/shapes.ts";
import type { Place } from "../places/place.ts";
import { latestReviews, newestPerReviewer, parseReview, REVIEW_KIND, type Review } from "../reviews/review.ts";
import { fetchRanks, resolveScorer, type Scorer, weightOf } from "../trust/houseWeights.ts";
import { type PlaceScore, scorePlace } from "./score.ts";

/*
 * The reviews of the places that pages ask about, the house's ranks for their reviewers, and the
 * reviewers' names, read once a session and held in memory. Scores are worked out from them when
 * asked for, and never stored (brief § 5). What it holds about people stays here: a page gets
 * reviews, place scores and names, never a person's rank or weight (decision 19).
 *
 * Nothing here loads the relay code: the app's readers import it when they first read
 * (src/nostr/relayReader.ts says why), so the store can be on the first screen.
 */

/** Where the house's view stands: not needed yet, being read, read, or not to be had. */
export type HouseState = "idle" | "loading" | "ready" | "unavailable";

/** The most places one request for reviews names. */
const REVIEW_BATCH = 100;

/**
 * The most reviews one request asks for, for its 100 places (Brainstorm reads at most 500 items at
 * a time). A relay sends no more than its own limit either: reviews past it are not read.
 */
const REVIEW_LIMIT = 500;

/** The most people one request for profiles names. */
const NAME_BATCH = 100;

/** A reader for each relay, by its URL. */
type Readers = (url: string) => RelayReader;

/**
 * The app's readers. Each loads the relay code when it first reads, so that neither it nor Nostrify
 * is in the first screen's code, and a session in which no page asks for reviews never loads it.
 * `readerFor` checks each event's signature.
 */
const appReaders: Readers = (url) => ({
  async *req(filter, signal) {
    signal.throwIfAborted();
    const { readerFor } = await import("../nostr/relayReader.ts");
    yield* readerFor(url).req(filter, signal);
  },
});

/** Prints a note for developers. Never shown to a person, and not in the production build. */
function debug(message: string, ...details: unknown[]): void {
  if (import.meta.env.DEV) console.debug(`[scores] ${message}`, ...details);
}

/** `items` in runs of at most `size`, in order. */
function runsOf<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) runs.push(items.slice(start, start + size));
  return runs;
}

/** Newest first; at the same time, the lowest id first, as `isNewer` orders them. */
const newestFirst = (a: Review, b: Review) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The key of a reviewer's review at one `d`: what a review's address (`34259:<pubkey>:<d>`) names.
 * A public key is 64 characters, so no two (pubkey, d) pairs make the same key.
 */
const keyOf = (pubkey: string, d: string) => `${pubkey}${d}`;

/** An event's key, as `keyOf` makes them. An event with no `d` is at the empty `d` (NIP-01). */
const eventKey = (ev: NostrEvent) => keyOf(ev.pubkey, ev.tags.find((tag) => tag[0] === "d")?.[1] ?? "");

/** The key of the review at `address`, `34259:<pubkey>:<d>`; undefined for anything else. */
function reviewKey(address: string): string | undefined {
  const first = address.indexOf(":");
  const second = address.indexOf(":", first + 1);
  if (first < 0 || second < 0 || address.slice(0, first) !== String(REVIEW_KIND)) return undefined;
  const pubkey = address.slice(first + 1, second);
  return isHex64(pubkey) ? keyOf(pubkey, address.slice(second + 1)) : undefined;
}

/** One place's reviews, one per person, newest first, and its score from the house's view. */
interface PlaceView {
  score: PlaceScore;
  reviews: Review[];
}

/**
 * The session's store, which ScoresProvider holds. Pages ask for places (`want`) and names
 * (`wantNames`); what they ask for in one go is read together, in batches, once the code that asked
 * has run (a microtask later). Reads happen between `start` and `stop`, which abort them.
 */
export class ScoresStore {
  readonly #readers: Readers;
  readonly #listeners = new Set<() => void>();
  #version = 0;

  /** Aborts every read when the provider unmounts. Null while it is not mounted. */
  #life: AbortController | null = null;
  /** Aborts the review reads of one round: `refresh` starts the next. */
  #round = new AbortController();
  /** Aborts when the round or the store's life does; null while it is not mounted. */
  #roundSignal: AbortSignal | null = null;
  #flushQueued = false;

  /** For a place filed more than once (the same OSM id under two addresses): each address → all of them. */
  #filings = new Map<string, readonly string[]>();

  /** The places pages have asked for, and the other filings of each. */
  readonly #wanted = new Set<string>();
  /** The places asked of the relays this round, answered or not. */
  #asked = new Set<string>();
  /** The review events of each place, from the latest read of it that a relay answered. */
  readonly #read = new Map<string, NostrEvent[]>();
  /** The person's own reviews, by `keyOf`: shown before the relays send them back (`noteOwnReview`). */
  readonly #own = new Map<string, NostrEvent>();
  /** The reviews the person removed, by `keyOf`: hidden up to the removal's time (`noteRemoval`). */
  readonly #removed = new Map<string, number>();
  /** Each place address's reviews, worked out from the above; null when they have changed since. */
  #reviews: Map<string, Review[]> | null = null;
  /** Each place's view, as worked out since the last change. */
  #views = new Map<string, PlaceView | undefined>();

  #house: HouseState = "idle";
  /** The read of the house's scorer, once started. */
  #scorerRead: Promise<Scorer | null> | undefined;
  /** The house's scorer once read: null when it names none, or could not be read. */
  #scorer: Scorer | null | undefined;
  /** The house's ranks. Kept here: nothing outside the store sees a person's rank (decision 19). */
  readonly #ranks = new Map<string, number>();
  /** The reviewers whose ranks have been asked for, answered or not. */
  #ranksAsked = new Set<string>();
  /** The reviewers whose ranks the scorer has answered for: someone it does not rank is outside. */
  readonly #ranksKnown = new Set<string>();

  readonly #namesWanted = new Set<string>();
  #namesAsked = new Set<string>();
  /** The people whose profiles a relay has answered for, with a name or not. */
  readonly #namesKnown = new Set<string>();
  readonly #names = new Map<string, string>();

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

  /** A number that changes with each change, for `useSyncExternalStore`. */
  readonly version = (): number => this.#version;

  get house(): HouseState {
    return this.#house;
  }

  /** Starts reading what is asked for. */
  start(): void {
    this.#life = new AbortController();
    this.#newRound();
    this.#queueFlush();
    this.#weigh();
  }

  /** Aborts every read. What was being read is read again if the store starts again. */
  stop(): void {
    this.#life?.abort();
    this.#life = null;
    this.#roundSignal = null;
    this.#asked = new Set([...this.#asked].filter((address) => this.#read.has(address)));
    this.#namesAsked = new Set(this.#namesKnown);
    this.#ranksAsked = new Set(this.#ranksKnown);
    if (this.#scorer === undefined) this.#scorerRead = undefined;
    if (this.#house === "loading") this.#house = "idle";
  }

  /** The places of the list, from which it knows the places filed more than once. */
  setPlaces(places: readonly Place[]): void {
    const byOsmId = new Map<string, string[]>();
    for (const place of places) {
      if (place.osmId === undefined) continue;
      const addresses = byOsmId.get(place.osmId);
      if (addresses === undefined) byOsmId.set(place.osmId, [place.address]);
      else addresses.push(place.address);
    }
    const filings = new Map<string, readonly string[]>();
    for (const addresses of byOsmId.values()) {
      if (addresses.length > 1) for (const address of addresses) filings.set(address, addresses);
    }
    this.#filings = filings;
    // The other filings of the places asked for so far are wanted too.
    this.want([...this.#wanted]);
    this.#changed();
  }

  /** Asks for the reviews of the places at `addresses`, and of the other filings of each. */
  want(addresses: Iterable<string>): void {
    let added = false;
    for (const address of addresses) {
      for (const filing of this.#filings.get(address) ?? [address]) {
        if (this.#wanted.has(filing)) continue;
        this.#wanted.add(filing);
        added = true;
      }
    }
    if (added) this.#queueFlush();
  }

  /** Asks for the names of the people with `pubkeys`. */
  wantNames(pubkeys: Iterable<string>): void {
    let added = false;
    for (const pubkey of pubkeys) {
      if (!isHex64(pubkey) || this.#namesWanted.has(pubkey)) continue;
      this.#namesWanted.add(pubkey);
      added = true;
    }
    if (added) this.#queueFlush();
  }

  /**
   * The place at `address`'s score from the house's view: across all its filings, one review per
   * person. Undefined until its reviews have been read.
   */
  scoreOf(address: string): PlaceScore | undefined {
    return this.#viewOf(address)?.score;
  }

  /** The place at `address`'s reviews, as `scoreOf` takes them, newest first. Empty until read. */
  reviewsOf(address: string): Review[] {
    return this.#viewOf(address)?.reviews ?? [];
  }

  /** The person's name, from their profile; undefined when it has none, or it has not been read. */
  nameOf(pubkey: string): string | undefined {
    return this.#names.get(pubkey);
  }

  /**
   * Reads the reviews of every place asked for again, and puts what comes in place of what was read:
   * a review the relays no longer send is gone (it may have been deleted). Names that could not be
   * read are asked for again, and so is the house's view if it was unavailable.
   */
  readonly refresh = (): void => {
    this.#newRound();
    this.#asked = new Set();
    this.#namesAsked = new Set(this.#namesKnown);
    if (this.#house === "unavailable") {
      // Its scorer again if it named none or could not be read; the ranks the scorer did not give.
      if (this.#scorer === null) {
        this.#scorer = undefined;
        this.#scorerRead = undefined;
      }
      this.#ranksAsked = new Set(this.#ranksKnown);
      this.#house = this.#ranksKnown.size > 0 ? "ready" : "idle";
      this.#changed();
    }
    this.#queueFlush();
    this.#weigh();
  };

  /**
   * Shows `event`, the person's own review just posted, before the relays send it back. It is held
   * until a read returns it (or a newer review at its `d`), or it is removed.
   */
  readonly noteOwnReview = (event: NostrEvent): void => {
    const ev = asEvent(event);
    if (ev === null || parseReview(ev) === null) return;
    const key = eventKey(ev);
    const held = this.#own.get(key);
    if (held !== undefined && !isNewer(ev, held)) return;
    this.#own.set(key, ev);
    this.#changed({ reviews: true });
    this.#weigh();
  };

  /**
   * Hides the review at `address` (`34259:<pubkey>:<d>`), which the person removed at `createdAt`,
   * and every version of it up to that time, as NIP-09 deletes them: a relay that lags may still
   * send one. A review written after the removal shows.
   */
  readonly noteRemoval = (address: string, createdAt: number): void => {
    const key = reviewKey(address);
    if (key === undefined || !Number.isSafeInteger(createdAt) || createdAt < 0) return;
    const before = this.#removed.get(key);
    if (before !== undefined && before >= createdAt) return;
    this.#removed.set(key, createdAt);
    const held = this.#own.get(key);
    if (held !== undefined && held.created_at <= createdAt) this.#own.delete(key);
    this.#changed({ reviews: true });
  };

  /** Aborts the review reads of this round, and starts the next. */
  #newRound(): void {
    this.#round.abort();
    this.#round = new AbortController();
    this.#roundSignal = this.#life === null ? null : AbortSignal.any([this.#life.signal, this.#round.signal]);
  }

  /** Notes a change, and tells the listeners. */
  #changed({ reviews = false }: { reviews?: boolean } = {}): void {
    if (reviews) this.#reviews = null;
    this.#views = new Map();
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  /** Reads what has been asked for since, once the code that asked has run. */
  #queueFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      this.#flush();
    });
  }

  #flush(): void {
    const life = this.#life;
    const round = this.#roundSignal;
    // With no review relays (development, unless set), nothing is read at all.
    if (life === null || round === null || config.reviewRelays.length === 0) return;

    const places = [...this.#wanted].filter((address) => !this.#asked.has(address));
    for (const batch of runsOf(places, REVIEW_BATCH)) {
      for (const address of batch) this.#asked.add(address);
      void this.#readReviews(batch, round);
    }

    const people = [...this.#namesWanted].filter((pubkey) => !this.#namesAsked.has(pubkey));
    for (const batch of runsOf(people, NAME_BATCH)) {
      for (const pubkey of batch) this.#namesAsked.add(pubkey);
      void this.#readNames(batch, life.signal);
    }
  }

  /**
   * Reads the reviews of the places at `batch` from every review relay, side by side, by their `a`
   * tags, and puts them in place of what was read of those places before. A place no relay
   * answered for keeps what it had: `refresh` asks again.
   */
  async #readReviews(batch: readonly string[], signal: AbortSignal): Promise<void> {
    const filter: NostrFilter = { kinds: [REVIEW_KIND], "#a": [...batch], limit: REVIEW_LIMIT };
    // A reader that cannot be made fails its relay's read, as a read that fails does.
    const reads = await Promise.allSettled(
      config.reviewRelays.map(async (url) => readAll(this.#readers(url), filter, signal)),
    );
    if (signal.aborted) return;
    const answered = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
    if (answered.length === 0) {
      debug("no review relay answered", reads);
      return;
    }

    const byPlace = new Map(batch.map((address) => [address, [] as NostrEvent[]]));
    const events = new Map<string, NostrEvent>();
    for (const value of answered.flat()) {
      const ev = asEvent(value);
      if (ev === null || ev.kind !== REVIEW_KIND || events.has(ev.id)) continue;
      events.set(ev.id, ev);
      const places = new Set(ev.tags.flatMap((tag) => (tag[0] === "a" && tag[1] !== undefined ? [tag[1]] : [])));
      for (const address of places) byPlace.get(address)?.push(ev);
    }
    for (const [address, read] of byPlace) this.#read.set(address, read);
    this.#release(events.values());
    this.#changed({ reviews: true });
    this.#weigh();
  }

  /** Lets go of each own review that `events` hold, or hold a newer review at the same `d` than. */
  #release(events: Iterable<NostrEvent>): void {
    for (const ev of events) {
      const key = eventKey(ev);
      const held = this.#own.get(key);
      if (held !== undefined && (held.id === ev.id || isNewer(ev, held))) this.#own.delete(key);
    }
  }

  /**
   * Asks the house about the reviewers it has not been asked about. Nothing is asked of it until a
   * place has a review: then its scorer is read, once a session, and the ranks the scorer gives.
   */
  #weigh(): void {
    const life = this.#life;
    if (life === null || this.#house === "unavailable") return;
    const unknown = new Set<string>();
    for (const reviews of this.#reviewsByAddress().values()) {
      for (const review of reviews) if (!this.#ranksAsked.has(review.reviewer)) unknown.add(review.reviewer);
    }
    if (unknown.size === 0) return;
    for (const pubkey of unknown) this.#ranksAsked.add(pubkey);
    if (this.#house === "idle") {
      this.#house = "loading";
      this.#changed();
    }
    void this.#readRanks([...unknown], life.signal);
  }

  async #readRanks(people: readonly string[], signal: AbortSignal): Promise<void> {
    try {
      this.#scorerRead ??= resolveScorer(this.#readers, signal).then((scorer) => {
        this.#scorer = scorer;
        return scorer;
      });
      const scorer = await this.#scorerRead;
      if (scorer === null) {
        debug("the house names no scorer, or its list could not be read");
        this.#unavailable();
        return;
      }
      const ranks = await fetchRanks(this.#readers(scorer.relay), scorer.pubkey, people, signal);
      for (const pubkey of people) {
        this.#ranksKnown.add(pubkey);
        const rank = ranks.get(pubkey);
        if (rank !== undefined) this.#ranks.set(pubkey, rank);
      }
      if (this.#house === "loading") this.#house = "ready";
      this.#changed();
    } catch (error) {
      if (signal.aborted) return;
      debug("the house's ranks could not be read", error);
      this.#unavailable();
    }
  }

  /** The house's view is not to be had: every review is folded until `refresh` tries again. */
  #unavailable(): void {
    if (this.#house === "unavailable") return;
    this.#house = "unavailable";
    this.#changed();
  }

  async #readNames(people: readonly string[], signal: AbortSignal): Promise<void> {
    let names: Map<string, string> | null;
    try {
      names = await fetchNames(this.#readers, config.reviewRelays, people, signal);
    } catch {
      return; // Aborted: asked again if the store starts again.
    }
    if (names === null) {
      debug("no review relay answered for profiles");
      return;
    }
    for (const pubkey of people) {
      this.#namesKnown.add(pubkey);
      const name = names.get(pubkey);
      if (name !== undefined) this.#names.set(pubkey, name);
    }
    this.#changed();
  }

  /**
   * Each place address's reviews: of every review event read and held, minus the removed ones,
   * each person's newest at each `d`, then of each place (`latestReviews`).
   */
  #reviewsByAddress(): Map<string, Review[]> {
    if (this.#reviews !== null) return this.#reviews;
    const events: NostrEvent[] = [];
    for (const read of this.#read.values()) events.push(...read);
    events.push(...this.#own.values());
    const shown = events.filter((ev) => {
      const removedAt = this.#removed.get(eventKey(ev));
      return removedAt === undefined || ev.created_at > removedAt;
    });

    const byAddress = new Map<string, Review[]>();
    for (const review of latestReviews(shown)) {
      const reviews = byAddress.get(review.address);
      if (reviews === undefined) byAddress.set(review.address, [review]);
      else reviews.push(review);
    }
    this.#reviews = byAddress;
    return byAddress;
  }

  #viewOf(address: string): PlaceView | undefined {
    if (this.#views.has(address)) return this.#views.get(address);
    const view = this.#workOut(address);
    this.#views.set(address, view);
    return view;
  }

  /**
   * The place's reviews across its filings, one per person, the newest winning (brief § 4.3), and
   * its score. Undefined until every filing has been read, unless the person's own review is there.
   */
  #workOut(address: string): PlaceView | undefined {
    const filings = this.#filings.get(address) ?? [address];
    const byAddress = this.#reviewsByAddress();
    const reviews = newestPerReviewer(filings.flatMap((filing) => byAddress.get(filing) ?? [])).sort(newestFirst);
    const read = filings.every((filing) => this.#read.has(filing));
    const own = reviews.some((review) => this.#own.get(keyOf(review.reviewer, review.d))?.id === review.id);
    if (!read && !own) return undefined;
    return { score: scorePlace(reviews, this.#weightFor(reviews), config.scoring), reviews };
  }

  /**
   * How much each of `reviews`' reviewers counts in House picks. Until the house's view is ready and
   * every one of them has been ranked, nobody counts: no score from unweighted or partial ranks.
   */
  #weightFor(reviews: readonly Review[]): (pubkey: string) => number {
    if (this.#house !== "ready" || reviews.some((review) => !this.#ranksKnown.has(review.reviewer))) return () => 0;
    const { line } = config.scoring;
    return (pubkey) => weightOf(this.#ranks.get(pubkey), line);
  }
}
