import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { readSession } from "../account/session.ts";
import { config } from "../config.ts";
import { asEvent, isNewer, type RelayReader, readAll, withReadExtras } from "../nostr/events.ts";
import { fetchNames } from "../nostr/profiles.ts";
import { appReaders } from "../nostr/relayCode.ts";
import { isHex64 } from "../nostr/shapes.ts";
import type { Place } from "../places/place.ts";
import {
  latestReviews,
  newestPerReviewer,
  parseReview,
  placeInD,
  REVIEW_KIND,
  type Review,
  reviewD,
} from "../reviews/review.ts";
import { fetchRanks, resolveScorer, type Scorer, weightOf } from "../trust/houseWeights.ts";
import { type PlaceScore, scorePlace } from "./score.ts";

/*
 * The reviews of the places that pages ask about, the house's ranks for their reviewers, and the
 * reviewers' names, read once a session and held in memory. Scores are worked out from them when
 * asked for, and never stored (brief § 5). What it holds about people stays here: a page gets
 * reviews, place scores and names, never a person's rank or weight (decision 19).
 *
 * Nothing here loads the relay code: the app's readers import it when they first read
 * (src/nostr/relayCode.ts), so the store can be on the first screen.
 */

/** Where the house's view stands: not needed yet, being read, read, or not to be had. */
export type HouseState = "idle" | "loading" | "ready" | "unavailable";

/**
 * Where the reading of a place's reviews stands: being read (or waiting its turn), read, or failed
 * (no review relay answered; `refresh` reads it again).
 */
export type ReadState = "reading" | "read" | "failed";

/** The most places one request for reviews names. */
const REVIEW_BATCH = 100;

/**
 * The most reviews one request asks for, for its 100 places (Brainstorm reads at most 500 items at
 * a time). A relay sends no more than its own limit either: reviews past it are not read.
 */
const REVIEW_LIMIT = 500;

/** The most people one request for profiles names. */
const NAME_BATCH = 100;

/**
 * How many batches of reviews are read at once; the rest wait their turn. Each batch is two requests
 * to every review relay, side by side: one by the places' `a`, one by their `d` (decision 16). So a
 * relay has at most four of the store's review requests open at a time, however many places a page asks
 * about. Names are read the same way, two batches at a time.
 */
export const BATCHES_IN_FLIGHT = 2;

/**
 * How long the store gathers what pages ask for before it reads it, from the first ask: a list shown
 * a few cards at a time, or a map panned, asks in one go rather than a request each time.
 */
export const FLUSH_WINDOW_MS = 50;

/** A reader for each relay, by its URL. */
type Readers = (url: string) => RelayReader;

/**
 * Where this tab keeps the person's own reviews that the store holds until a read returns them
 * (`noteOwnReview`), so that a reload before then still shows them (Review Focus 1): in
 * `sessionStorage`, gone when the tab closes. A review is a public, signed record, not a secret.
 */
export const HELD_REVIEWS_KEY = "regulars.heldReviews";

/** One of the person's own reviews, held: the signed event, and the relays it was sent to. */
interface Held {
  event: NostrEvent;
  relays: readonly string[];
}

/**
 * The own reviews of `pubkey` that this tab keeps (`HELD_REVIEWS_KEY`): each a well-formed review of a
 * place by them, with the relays it went to, and nothing else. None for nobody (no one is signed in in
 * the tab), when what is kept is not the app's own, or when storage is blocked: one person's held
 * reviews are never another's.
 */
function readHeld(pubkey: string | undefined): Held[] {
  if (pubkey === undefined) return [];
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(HELD_REVIEWS_KEY) ?? "[]");
    if (!Array.isArray(kept)) return [];
    return kept.flatMap((value: unknown) => {
      if (typeof value !== "object" || value === null) return [];
      const { event, relays } = value as Record<string, unknown>;
      const ev = asEvent(event);
      if (ev === null || ev.pubkey !== pubkey || parseReview(ev) === null) return [];
      if (!Array.isArray(relays) || !relays.every((relay) => typeof relay === "string")) return [];
      return [{ event: ev, relays: [...(relays as string[])] }];
    });
  } catch {
    return [];
  }
}

/** Keeps `held` for this tab; with none, forgets what it kept. Where storage is blocked or full, they last until a reload. */
function keepHeld(held: Iterable<Held>): void {
  const kept = [...held].map(({ event, relays }) => ({ event, relays }));
  try {
    if (kept.length === 0) window.sessionStorage.removeItem(HELD_REVIEWS_KEY);
    else window.sessionStorage.setItem(HELD_REVIEWS_KEY, JSON.stringify(kept));
  } catch {
    // Blocked or full: what is held still shows until the page is reloaded.
  }
}

/**
 * Where this tab keeps the reviews the person removed (`noteRemoval`), each by its address with the
 * removal's time, so that a reload still hides them while a relay that lags sends them (Review Focus
 * 2): in `sessionStorage`, gone when the tab closes. A removal is public, not a secret; and the review
 * it names is deleted for anyone (NIP-09), so it stays hidden whoever is signed in in the tab.
 */
export const REMOVED_REVIEWS_KEY = "regulars.removedReviews";

/**
 * The removals this tab keeps (`REMOVED_REVIEWS_KEY`), by `keyOf`, as `[address, time]` pairs: each a
 * review's address and a time it could have been removed at, and nothing else. None when what is kept
 * is not the app's own, or when storage is blocked.
 */
function readRemoved(): Map<string, number> {
  const removed = new Map<string, number>();
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(REMOVED_REVIEWS_KEY) ?? "[]");
    if (!Array.isArray(kept)) return removed;
    for (const pair of kept) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [address, createdAt] = pair as unknown[];
      const key = typeof address === "string" ? reviewKey(address) : undefined;
      if (key === undefined || !isTime(createdAt)) continue;
      if ((removed.get(key) ?? -1) < createdAt) removed.set(key, createdAt);
    }
  } catch {
    // Not the app's own, or blocked: nothing kept.
  }
  return removed;
}

/** Keeps `removed`, the removals by key, for this tab. Where storage is blocked or full, they last until a reload. */
function keepRemoved(removed: ReadonlyMap<string, number>): void {
  const kept = [...removed].map(([key, createdAt]) => [addressOfKey(key), createdAt]);
  try {
    window.sessionStorage.setItem(REMOVED_REVIEWS_KEY, JSON.stringify(kept));
  } catch {
    // Blocked or full: what was removed stays hidden until the page is reloaded.
  }
}

/** Whether `value` is a time an event can have: whole seconds since the epoch, from 0. */
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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

/**
 * Runs reads at most `capacity` at a time, in the order they are queued. A read whose signal has
 * aborted by its turn is skipped; its places are read again in the next round.
 */
class Lane {
  readonly #capacity: number;
  #running = 0;
  readonly #queue: { signal: AbortSignal; read: () => Promise<void> }[] = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /** Queues `read`, which starts once fewer than `capacity` reads are running. */
  add(signal: AbortSignal, read: () => Promise<void>): void {
    this.#queue.push({ signal, read });
    this.#next();
  }

  /** Forgets every read that has not started. */
  clear(): void {
    this.#queue.length = 0;
  }

  #next(): void {
    while (this.#running < this.#capacity && this.#queue.length > 0) {
      const { signal, read } = this.#queue.shift()!;
      if (signal.aborted) continue;
      this.#running += 1;
      void read().finally(() => {
        this.#running -= 1;
        this.#next();
      });
    }
  }
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

/** The address of the review with the key `key`, as `reviewKey` reads it: the public key is its first 64 characters. */
const addressOfKey = (key: string) => `${REVIEW_KIND}:${key.slice(0, 64)}:${key.slice(64)}`;

/** A review as its removal names it (`34259:<reviewer>:<d>`, NIP-09), with its id and its time. */
export interface ReviewCoordinate {
  id: string;
  d: string;
  createdAt: number;
  /**
   * Where it was sent, for a review the person posted this session that the relays have not sent back
   * yet: every relay it was sent to, those that took it and those that did not say (one may have kept
   * it all the same), which its removal goes to too (Task 7, ruling R17). Absent for one read.
   */
  relays?: readonly string[];
}

/** One place's reviews, one per person, newest first, and its score from the house's view. */
interface PlaceView {
  reviews: Review[];
  /** Undefined while any of its reviewers is still to be ranked. */
  score: PlaceScore | undefined;
  /** Each reviewer's weight, in the order of `reviews`: what the score was made of. Kept in the store. */
  weights: number[] | undefined;
}

/** Whether `a` and `b` are the same reviews (by id), in the same order. */
const sameReviews = (a: readonly Review[], b: readonly Review[]) =>
  a.length === b.length && a.every((review, i) => review.id === b[i]?.id);

/** Whether `a` and `b` are the same weights, or both none. */
const sameWeights = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((weight, i) => Object.is(weight, b[i]));

/** Whether two indexes of places filed more than once hold the same filings. */
function sameFilings(a: ReadonlyMap<string, readonly string[]>, b: ReadonlyMap<string, readonly string[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [address, filings] of a) {
    const other = b.get(address);
    if (other?.length !== filings.length || filings.some((filing, i) => filing !== other[i])) return false;
  }
  return true;
}

/**
 * The session's store, which ScoresProvider holds. Pages ask for places (`want`) and names
 * (`wantNames`); what they ask for within `FLUSH_WINDOW_MS` is read together, in batches. Reads
 * happen between `start` and `stop`, which abort them.
 */
export class ScoresStore {
  readonly #readers: Readers;
  readonly #listeners = new Set<() => void>();
  /** Changes when places' reviews or scores may have. */
  #scoresVersion = 0;
  /** Changes when names have. */
  #namesVersion = 0;

  /** Aborts every read when the provider unmounts. Null while it is not mounted. */
  #life: AbortController | null = null;
  /** Aborts the review reads of one round: `refresh` starts the next. */
  #round = new AbortController();
  /** Aborts when the round or the store's life does; null while it is not mounted. */
  #roundSignal: AbortSignal | null = null;
  /** The read of what has been asked for, waiting out its window. */
  #flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** For a place filed more than once (the same OSM id under two addresses): each address → all of them. */
  #filings = new Map<string, readonly string[]>();

  /** The places pages have asked for, and the other filings of each. */
  readonly #wanted = new Set<string>();
  /** The places asked of the relays this round, answered or not, and those waiting their turn. */
  #asked = new Set<string>();
  /** The review events of each place, from the latest read of it that a relay answered. */
  readonly #read = new Map<string, NostrEvent[]>();
  /** The places no review relay answered for, since the last `refresh`. */
  readonly #failed = new Set<string>();
  /** The review reads, two batches at a time. */
  readonly #reviewLane = new Lane(BATCHES_IN_FLIGHT);
  /** The name reads, two batches at a time. */
  readonly #nameLane = new Lane(BATCHES_IN_FLIGHT);
  /**
   * The person's own reviews, by `keyOf`, with the relays that took each: shown before the relays send
   * them back (`noteOwnReview`), and kept for this tab (`HELD_REVIEWS_KEY`) until then, so that a
   * reload shows them too.
   */
  readonly #own = new Map<string, Held>();
  /**
   * The reviews the person removed, by `keyOf`: hidden up to the removal's time (`noteRemoval`), and
   * kept for this tab (`REMOVED_REVIEWS_KEY`), so that a reload hides them too.
   */
  readonly #removed = readRemoved();
  /** Each place address's reviews, worked out from the above; null when they have changed since. */
  #reviews: Map<string, Review[]> | null = null;
  /**
   * Each place's view as last worked out, and at which version of the scores: one made of the same
   * reviews and weights as the last is the last, the same object, so a page holding it need not change.
   */
  readonly #views = new Map<string, { at: number; view: PlaceView | undefined }>();

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

  /**
   * `readers` gives each relay's reader; by default the app's. Each relay's read extras are added to
   * it. The own reviews this tab keeps for the person signed in in it are held from the start, as
   * before the reload, and the reviews removed in it are hidden from the start (`REMOVED_REVIEWS_KEY`).
   */
  constructor(readers: Readers = appReaders) {
    this.#readers = (url) => withReadExtras(readers(url), config.relayReadExtras[url]);
    for (const kept of readHeld(readSession()?.pubkey)) {
      const key = eventKey(kept.event);
      const held = this.#own.get(key);
      if (held === undefined || isNewer(kept.event, held.event)) this.#own.set(key, kept);
    }
  }

  /** Calls `listener` after each change. Returns what stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A number that changes when places' reviews or scores may have, for `useSyncExternalStore`. */
  readonly scoresVersion = (): number => this.#scoresVersion;

  /** A number that changes when names have, for `useSyncExternalStore`. */
  readonly namesVersion = (): number => this.#namesVersion;

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
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#reviewLane.clear();
    this.#nameLane.clear();
    this.#failed.clear();
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
    if (sameFilings(filings, this.#filings)) return;
    this.#filings = filings;
    // The other filings of the places asked for so far are wanted too.
    this.want([...this.#wanted]);
    this.#changed("scores");
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
    if (!added) return;
    this.#queueFlush();
    // The places asked for are being read now: pages say so (`readStateOf`), when there is anything to read.
    if (config.reviewRelays.length > 0) this.#changed("scores");
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
   * person. Undefined until its reviews have been read, and while any of its reviewers is still to
   * be ranked. The same object for as long as what it is made of is the same.
   */
  scoreOf(address: string): PlaceScore | undefined {
    return this.#viewOf(address)?.score;
  }

  /** The place at `address`'s reviews, as `scoreOf` takes them, newest first. Empty until read. */
  reviewsOf(address: string): Review[] {
    return this.#viewOf(address)?.reviews ?? [];
  }

  /**
   * Where the reading of the place at `address` stands, across all its filings: read once every
   * filing has been; failed when no review relay answered for one of them; reading while it is asked
   * for, or waits its turn. Undefined for a place no page has asked about, and always when there are
   * no review relays: nothing is read, so nothing is being read either.
   */
  readStateOf(address: string): ReadState | undefined {
    if (config.reviewRelays.length === 0) return undefined;
    const filings = this.#filings.get(address) ?? [address];
    if (filings.every((filing) => this.#read.has(filing))) return "read";
    if (filings.some((filing) => this.#failed.has(filing))) return "failed";
    return filings.some((filing) => this.#wanted.has(filing)) ? "reading" : undefined;
  }

  /**
   * Every review `pubkey` has of the place at `address`, under any `d` and in any of its filings
   * (brief § 4.3), newest first: what removing their review of it must name, all of it (Task 7).
   * The page shows one of them (`reviewsOf`); a removed one is not here; a held own review is.
   */
  readonly ownCoordinates = (pubkey: string, address: string): ReviewCoordinate[] => {
    const filings = new Set(this.#filings.get(address) ?? [address]);
    const standing = new Map<string, NostrEvent>();
    for (const ev of this.#shownEvents()) {
      if (ev.pubkey !== pubkey) continue;
      const key = eventKey(ev);
      const kept = standing.get(key);
      if (kept === undefined || isNewer(ev, kept)) standing.set(key, ev);
    }
    const coordinates: ReviewCoordinate[] = [];
    for (const ev of standing.values()) {
      const review = parseReview(ev);
      if (review === null || !filings.has(review.address)) continue;
      const held = this.#own.get(eventKey(ev));
      const relays = held?.event.id === ev.id ? { relays: [...held.relays] } : {};
      coordinates.push({ id: review.id, d: review.d, createdAt: review.createdAt, ...relays });
    }
    return coordinates.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  /**
   * When `pubkey` last removed a review of the place at `address`, under any `d` and in any of its
   * filings: a review they write next must be later, or the removal would take it too (NIP-09).
   * Undefined when they have removed none this session.
   */
  readonly ownRemovedAt = (pubkey: string, address: string): number | undefined => {
    const filings = new Set(this.#filings.get(address) ?? [address]);
    let latest: number | undefined;
    for (const [key, removedAt] of this.#removed) {
      if (!key.startsWith(pubkey)) continue;
      const place = placeInD(key.slice(pubkey.length));
      if (place !== undefined && filings.has(place) && (latest === undefined || removedAt > latest)) latest = removedAt;
    }
    return latest;
  };

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
    if (this.#failed.size > 0) {
      // They are being read again.
      this.#failed.clear();
      this.#changed("scores");
    }
    if (this.#house === "unavailable") {
      // Its scorer again if it named none or could not be read; the ranks the scorer did not give.
      if (this.#scorer === null) {
        this.#scorer = undefined;
        this.#scorerRead = undefined;
      }
      this.#ranksAsked = new Set(this.#ranksKnown);
      this.#house = this.#ranksKnown.size > 0 ? "ready" : "idle";
      this.#changed("scores");
    }
    this.#queueFlush();
    this.#weigh();
  };

  /**
   * Shows `event`, the person's own review just posted, before the relays send it back, with the
   * `relays` it was sent to. It is held, and kept for this tab, until a read returns it (or a newer
   * review at its `d`), until it is removed, or until the person signs out (`forgetHeld`).
   */
  readonly noteOwnReview = (event: NostrEvent, relays: readonly string[] = []): void => {
    const ev = asEvent(event);
    if (ev === null || parseReview(ev) === null) return;
    const key = eventKey(ev);
    const held = this.#own.get(key);
    if (held !== undefined && !isNewer(ev, held.event)) return;
    this.#own.set(key, { event: ev, relays: [...relays] });
    keepHeld(this.#own.values());
    this.#changed("reviews");
    this.#weigh();
  };

  /**
   * Lets go of every own review held, here and in the tab: the person signed out, or their add-on or
   * phone app now signs as someone else. Held reviews are one person's, never the next one's. Their
   * reviews on the relays stay, and show as anyone's do.
   */
  readonly forgetHeld = (): void => {
    keepHeld([]);
    if (this.#own.size === 0) return;
    this.#own.clear();
    this.#changed("reviews");
  };

  /**
   * Hides the review at `address` (`34259:<pubkey>:<d>`), which the person removed at `createdAt`,
   * and every version of it up to that time, as NIP-09 deletes them: a relay that lags may still
   * send one, now or after a reload (kept for the tab). A review written after the removal shows.
   */
  readonly noteRemoval = (address: string, createdAt: number): void => {
    const key = reviewKey(address);
    if (key === undefined || !isTime(createdAt)) return;
    const before = this.#removed.get(key);
    if (before !== undefined && before >= createdAt) return;
    this.#removed.set(key, createdAt);
    keepRemoved(this.#removed);
    const held = this.#own.get(key);
    if (held !== undefined && held.event.created_at <= createdAt) {
      this.#own.delete(key);
      keepHeld(this.#own.values());
    }
    this.#changed("reviews");
  };

  /** Aborts the review reads of this round, forgets those waiting their turn, and starts the next. */
  #newRound(): void {
    this.#reviewLane.clear();
    this.#round.abort();
    this.#round = new AbortController();
    this.#roundSignal = this.#life === null ? null : AbortSignal.any([this.#life.signal, this.#round.signal]);
  }

  /**
   * Notes a change, and tells the listeners: to the review events read or held ("reviews"), to what
   * places' scores are made of otherwise ("scores": the house, ranks, filings), or to names.
   */
  #changed(what: "reviews" | "scores" | "names"): void {
    if (what === "reviews") this.#reviews = null;
    if (what === "names") this.#namesVersion += 1;
    else this.#scoresVersion += 1;
    for (const listener of this.#listeners) listener();
  }

  /** Reads what has been asked for, at the end of the window that the first ask since opens. */
  #queueFlush(): void {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flush();
    }, FLUSH_WINDOW_MS);
  }

  #flush(): void {
    const life = this.#life;
    const round = this.#roundSignal;
    // With no review relays (development, unless set), nothing is read at all.
    if (life === null || round === null || config.reviewRelays.length === 0) return;

    // Each batch is read from every review relay, by a and by d: two requests each. Two batches are
    // read at a time (`BATCHES_IN_FLIGHT`); the rest wait their turn, and count as asked meanwhile.
    const places = [...this.#wanted].filter((address) => !this.#asked.has(address));
    for (const batch of runsOf(places, REVIEW_BATCH)) {
      for (const address of batch) this.#asked.add(address);
      this.#reviewLane.add(round, () => this.#readReviews(batch, round));
    }

    const people = [...this.#namesWanted].filter((pubkey) => !this.#namesAsked.has(pubkey));
    for (const batch of runsOf(people, NAME_BATCH)) {
      for (const pubkey of batch) this.#namesAsked.add(pubkey);
      this.#nameLane.add(life.signal, () => this.#readNames(batch, life.signal));
    }
  }

  /**
   * Reads the reviews of the places at `batch` from every review relay, side by side: by their `a`,
   * and by their `d`, bare or after `place:`, for reviews other apps wrote with no `a` (decision 16).
   * What comes is put in place of what was read of those places before. A place no relay answered
   * for keeps what it had: `refresh` asks again.
   */
  async #readReviews(batch: readonly string[], signal: AbortSignal): Promise<void> {
    const byA: NostrFilter = { kinds: [REVIEW_KIND], "#a": [...batch], limit: REVIEW_LIMIT };
    const byD: NostrFilter = { kinds: [REVIEW_KIND], "#d": [...batch, ...batch.map(reviewD)], limit: REVIEW_LIMIT };
    const reads = await Promise.allSettled(
      // A reader that cannot be made fails its relay's read, as a read that fails does. A relay
      // answers both requests or neither: half its answer must not replace what was read before.
      config.reviewRelays.map(async (url) => {
        const reader = this.#readers(url);
        const [named, filed] = await Promise.all([readAll(reader, byA, signal), readAll(reader, byD, signal)]);
        return [...named, ...filed];
      }),
    );
    if (signal.aborted) return;
    const answered = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
    if (answered.length === 0) {
      debug("no review relay answered", reads);
      // What these places had stays; they say their reading failed until `refresh` tries again.
      for (const address of batch) this.#failed.add(address);
      this.#changed("scores");
      return;
    }
    for (const address of batch) this.#failed.delete(address);

    const byPlace = new Map(batch.map((address) => [address, [] as NostrEvent[]]));
    const events = new Map<string, NostrEvent>();
    for (const value of answered.flat()) {
      const ev = asEvent(value);
      if (ev === null || ev.kind !== REVIEW_KIND || events.has(ev.id)) continue;
      events.set(ev.id, ev);
      // The places it was sent for: those its a tags name, or its d.
      const named = new Set<string | undefined>();
      for (const [name, value] of ev.tags) {
        if (name === "a") named.add(value);
        else if (name === "d") named.add(placeInD(value));
      }
      for (const address of named) if (address !== undefined) byPlace.get(address)?.push(ev);
    }
    for (const [address, read] of byPlace) this.#read.set(address, read);
    this.#release(events.values());
    this.#changed("reviews");
    this.#weigh();
  }

  /**
   * Lets go of each own review that `events` hold, or hold a newer review at the same `d` than: the
   * relays have it now. The tab keeps it no longer.
   */
  #release(events: Iterable<NostrEvent>): void {
    let released = false;
    for (const ev of events) {
      const key = eventKey(ev);
      const held = this.#own.get(key);
      if (held !== undefined && (held.event.id === ev.id || isNewer(ev, held.event))) {
        this.#own.delete(key);
        released = true;
      }
    }
    if (released) keepHeld(this.#own.values());
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
      this.#changed("scores");
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
      this.#changed("scores");
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
    this.#changed("scores");
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
    this.#changed("names");
  }

  /** Every review event read or held, but those the person removed. */
  #shownEvents(): NostrEvent[] {
    const events: NostrEvent[] = [];
    for (const read of this.#read.values()) events.push(...read);
    for (const held of this.#own.values()) events.push(held.event);
    return events.filter((ev) => {
      const removedAt = this.#removed.get(eventKey(ev));
      return removedAt === undefined || ev.created_at > removedAt;
    });
  }

  /**
   * Each place address's reviews: of every review event shown, each person's newest at each `d`,
   * then of each place (`latestReviews`).
   */
  #reviewsByAddress(): Map<string, Review[]> {
    if (this.#reviews !== null) return this.#reviews;
    const byAddress = new Map<string, Review[]>();
    for (const review of latestReviews(this.#shownEvents())) {
      const reviews = byAddress.get(review.address);
      if (reviews === undefined) byAddress.set(review.address, [review]);
      else reviews.push(review);
    }
    this.#reviews = byAddress;
    return byAddress;
  }

  #viewOf(address: string): PlaceView | undefined {
    const last = this.#views.get(address);
    if (last !== undefined && last.at === this.#scoresVersion) return last.view;
    const view = this.#workOut(address, last?.view);
    this.#views.set(address, { at: this.#scoresVersion, view });
    return view;
  }

  /**
   * The place's reviews across its filings, one per person, the newest winning (brief § 4.3), and
   * its score; `last`, or its reviews, when they are made of the same. Undefined until every filing
   * has been read, unless the person's own review is there. The score is undefined while any of its
   * reviewers is still to be ranked: nobody is shown as outside House picks before the house has
   * said so. When the house's view is unavailable, every review is folded, and the page says why.
   */
  #workOut(address: string, last: PlaceView | undefined): PlaceView | undefined {
    const filings = this.#filings.get(address) ?? [address];
    const byAddress = this.#reviewsByAddress();
    const reviews = newestPerReviewer(filings.flatMap((filing) => byAddress.get(filing) ?? [])).sort(newestFirst);
    const read = filings.every((filing) => this.#read.has(filing));
    const own = reviews.some((review) => this.#own.get(keyOf(review.reviewer, review.d))?.event.id === review.id);
    if (!read && !own) return undefined;

    let weights: number[] | undefined;
    if (this.#house === "unavailable") {
      weights = reviews.map(() => 0);
    } else if (reviews.every((review) => this.#ranksKnown.has(review.reviewer))) {
      const { line } = config.scoring;
      weights = reviews.map((review) => weightOf(this.#ranks.get(review.reviewer), line));
    }

    const same = last !== undefined && sameReviews(last.reviews, reviews);
    if (same && sameWeights(last.weights, weights)) return last;
    const shown = same ? last.reviews : reviews;
    if (weights === undefined) return { reviews: shown, score: undefined, weights };
    const weightOfReviewer = new Map(shown.map((review, i) => [review.reviewer, weights[i] ?? 0]));
    const score = scorePlace(shown, (pubkey) => weightOfReviewer.get(pubkey) ?? 0, config.scoring);
    return { reviews: shown, score, weights };
  }
}
