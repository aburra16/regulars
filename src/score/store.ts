import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { readSession } from "../account/session.ts";
import { publicRelayAddress } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, isNewer, type RelayReader, readAll, withReadExtras } from "../nostr/events.ts";
import { fetchProfiles, type Profile } from "../nostr/profiles.ts";
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
import type { View } from "../view/ViewProvider.tsx";
import { type PlaceScore, scorePlace } from "./score.ts";

/*
 * The reviews of the places that pages ask about, the ranks of their reviewers from each point of view
 * (the house's, and the person's circle once it is ready), and the reviewers' names and pictures, read
 * once a session and held in memory. Scores are worked out from them when asked for, from the view
 * asked for, and never stored (brief § 5): toggling the view reads nothing (Review Focus 5). What it
 * holds about people stays here: a page gets reviews, place scores, names and pictures, and whether a
 * reviewer counts in a view (yes or no, for Recent), never a person's rank or weight (decision 19).
 *
 * Nothing here loads the relay code: the app's readers import it when they first read
 * (src/nostr/relayCode.ts), so the store can be on the first screen.
 */

/** Where a point of view's ranks stand: not needed yet, being read, read, or not to be had. */
export type ViewState = "idle" | "loading" | "ready" | "unavailable";

/** How much the person's own review counts in My circle: in full, whoever ranks them (brief § 5). */
const OWN_WEIGHT = 1;

/**
 * Where the reading of a place's reviews stands: being read (or waiting its turn), read, or failed
 * (no review relay answered; `refresh` reads it again).
 */
export type ReadState = "reading" | "read" | "failed";

/** The most places one request for reviews names. */
const REVIEW_BATCH = 50;

/**
 * The most reviews one request asks for, for its 50 places (Brainstorm reads at most 500 items at a
 * time). A request that comes back full is followed by the next page, back in time (`REVIEW_PAGES`).
 */
const REVIEW_LIMIT = 500;

/**
 * The most pages one batch's request reads from one relay: the first, and the older ones after it.
 * Without paging, one place with hundreds of reviews (spam, say) would fill the request and push the
 * other places' reviews out of it. Past five pages (2,500 reviews), the batch is cut short.
 */
export const REVIEW_PAGES = 5;

/** The most people one request for profiles names. */
const NAME_BATCH = 100;

/**
 * How many batches of reviews are read at once; the rest wait their turn. Each batch is two requests
 * to every review relay, side by side: one by the places' `a`, one by their `d` (decision 16). So a
 * relay has at most four of the store's review requests open at a time, however many places a page asks
 * about. Names are read the same way, two batches at a time; and ranks two reads at a time to each
 * scorer's relay, whichever view they are for: House picks' and My circle's share a relay's turn.
 */
export const BATCHES_IN_FLIGHT = 2;

/**
 * How long after reading everything again (`refresh`) the device being back on line does not do it
 * again: a connection that comes and goes would otherwise keep stopping reads that are doing well.
 */
export const ONLINE_CALM_MS = 5_000;

/** The most people one read of a view's ranks names: one request to its scorer's relay (`fetchRanks`). */
const RANK_BATCH = 500;

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
 * Every value `reader` sends for `filter`, page after page: while a page comes back full (`filter.limit`
 * values), the next asks for those up to the oldest time seen so far (`until`, which includes that
 * second: the values read twice are the same events, which the caller keeps once). A full page that
 * gets no further back in time (a flood within one second) is followed by one from the second before:
 * what else that second holds is not read, and what is older is. At most `pages` pages; it stops
 * sooner at a page that is not full, or one in which no time can be read. Throws as `readAll` does:
 * half a read is no read.
 */
async function readPaged(reader: RelayReader, filter: NostrFilter, pages: number, signal: AbortSignal): Promise<unknown[]> {
  const values: unknown[] = [];
  let until: number | undefined;
  for (let page = 0; page < pages; page++) {
    const read = await readAll(reader, until === undefined ? filter : { ...filter, until }, signal);
    values.push(...read);
    if (filter.limit === undefined || read.length < filter.limit) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const value of read) {
      const ev = asEvent(value);
      if (ev !== null && ev.created_at < oldest) oldest = ev.created_at;
    }
    if (!Number.isFinite(oldest)) break;
    const next = until !== undefined && oldest >= until ? oldest - 1 : oldest;
    // Nothing is older than the first second there is.
    if (next < 0) break;
    until = next;
  }
  return values;
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

/**
 * One point of view's ranks: its scorer, where reading its ranks stands, and the ranks it gave. The
 * house's scorer is read from the house's list (kind 10040) when it is first needed; the circle's is
 * the person's own, given once their circle is ready, and `owner` is that person, whose own review
 * counts in full and who is never asked about. Each view is read the same way: `RANK_BATCH` people to
 * a read, in the turn of its scorer's relay (two reads at a time, shared with any other view whose
 * scorer is there), and the same rules when a read fails (`ScoresStore.#readRanks`).
 */
class RankBook {
  state: ViewState = "idle";
  /** The read of the scorer, once started. */
  scorerRead: Promise<Scorer | null> | undefined;
  /** The scorer once read: null when there is none, or it could not be read. */
  scorer: Scorer | null | undefined;
  /** The ranks it gave. Kept in the store: nothing outside it sees a person's rank (decision 19). */
  readonly ranks = new Map<string, number>();
  /** The reviewers whose ranks have been asked for, answered or not. */
  asked = new Set<string>();
  /** The reviewers the scorer has answered for: someone it does not rank is outside. */
  readonly known = new Set<string>();
  /**
   * Whether a read of ranks failed since its people were last asked about: they are not asked about
   * again until something does (`refresh`, the device back on line, another place's reviews).
   */
  failed = false;
  /** Aborts its reads once it is let go of: the circle went, or is another person's now. */
  readonly #ended = new AbortController();

  constructor(
    /** Reads its scorer: the house's from its list; the circle's is known already. */
    readonly find: (signal: AbortSignal) => Promise<Scorer | null>,
    /** The person whose circle it is; none for the house. */
    readonly owner?: string,
  ) {}

  /** Aborts once it is let go of (`end`). */
  get ended(): AbortSignal {
    return this.#ended.signal;
  }

  /** Lets go of it: its reads stop, and those waiting their turn are skipped when it comes. */
  end(): void {
    this.#ended.abort();
  }

  /** Stops its reads: the people asked about and not answered are asked about again when the store starts again. */
  pause(): void {
    this.asked = new Set(this.known);
    if (this.scorer === undefined) this.scorerRead = undefined;
    if (this.state === "loading") this.state = "idle";
  }

  /**
   * Gets it ready to be read again once it was unavailable: its scorer again if it named none or
   * could not be read, and the ranks the scorer did not give. Whether it was.
   */
  retry(): boolean {
    if (this.state !== "unavailable") return false;
    if (this.scorer === null) {
      this.scorer = undefined;
      this.scorerRead = undefined;
    }
    this.asked = new Set(this.known);
    this.state = this.known.size > 0 ? "ready" : "idle";
    return true;
  }
}

/**
 * The person's circle, as the store holds it: whose it is, its scorer, whether its run is known to be
 * done (`confirmed`), which working-out of it this is (`edition`), and its ranks; and the last answer
 * to whether it is empty (`circleEmpty`), at which version of the scores.
 */
interface Circle {
  owner: string;
  scorer: Scorer;
  confirmed: boolean;
  edition: number;
  book: RankBook;
  empty: boolean;
  emptyAt: number;
}

/** A circle of `owner`'s from `scorer`, with no rank read yet. */
const newCircle = (owner: string, scorer: Scorer, confirmed: boolean, edition: number): Circle => ({
  owner,
  scorer,
  confirmed,
  edition,
  book: new RankBook(async () => scorer, owner),
  empty: false,
  emptyAt: -1,
});

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

/** One place's reviews, one per person, newest first, and its score from one point of view. */
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
  /** When `refresh` last read everything again (`Date.now()`); undefined before it has. */
  #refreshedAt: number | undefined;

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
  /** The rank reads, two at a time to each scorer's relay, by its address: both views take turns in one. */
  readonly #rankLanes = new Map<string, Lane>();
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
   * Each place's reviews across its filings as last worked out, and at which version of the scores:
   * the same reviews as the last are the last, the same array, which both views score.
   */
  readonly #placeReviews = new Map<string, { at: number; reviews: Review[] | undefined }>();
  /**
   * Each place's view from each point of view as last worked out, and at which version of the scores:
   * one made of the same reviews and weights as the last is the last, the same object, so a page
   * holding it need not change, whichever view's ranks came in meanwhile.
   */
  readonly #views: Record<View, Map<string, { at: number; view: PlaceView | undefined }>> = {
    house: new Map(),
    circle: new Map(),
  };

  /**
   * The people whose ranks a page wants from each view beside the reviewers of the places asked for:
   * Recent's reviewers (`wantRanks`), whose reviews it lists once their view has said they count.
   */
  readonly #rankWanted = new Set<string>();

  /** House picks' ranks, from the scorer the house names. */
  readonly #house = new RankBook((signal) => resolveScorer(this.#readers, signal));
  /** My circle's ranks, from the person's own scorer, once their circle is ready (`setCircle`). */
  #circle: Circle | null = null;

  readonly #namesWanted = new Set<string>();
  #namesAsked = new Set<string>();
  /** The people whose profiles a relay has answered for, with a name or not. */
  readonly #namesKnown = new Set<string>();
  readonly #names = new Map<string, string>();
  /**
   * Each person's picture, read with their name, once a session: an https address from their own
   * signed profile (`shownPicture`), for anyone whose profile gives one. Privacy: a picture is an address on a server
   * of the person's choosing, and a page that shows it has the visitor's browser ask that server for
   * it, which sees the visitor's IP address, their browser, and when; with no referrer, not which page
   * (src/ui/ProfilePicture.tsx). Avi asked for reviewers' pictures knowing this (2026-10-09).
   */
  readonly #pictures = new Map<string, string>();

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

  /** A number that changes when names, and the pictures read with them, have, for `useSyncExternalStore`. */
  readonly namesVersion = (): number => this.#namesVersion;

  /** Where House picks' ranks stand. */
  get house(): ViewState {
    return this.#house.state;
  }

  /** Where `view`'s ranks stand. My circle's are "idle" while the person has no circle ready. */
  stateOf(view: View): ViewState {
    return this.#bookOf(view)?.state ?? "idle";
  }

  /**
   * The person's circle, once it is ready: `owner`, whose own reviews count in full in it, the scorer
   * that publishes its ranks, and whether its run is known to be done (`confirmed`, by default yes);
   * undefined when there is none (nobody signed in, or not ready). Its ranks are read for every
   * reviewer seen so far, and for each new one, as the house's are, so that toggling to My circle reads
   * nothing. Another person's circle, another scorer, or none, lets go of the ranks held, and stops
   * their reads. So does the circle being confirmed: its ranks are read afresh, as a run that was not
   * known to be done may have published them since (ruling R10). While it is not confirmed, Try again
   * (`refresh`) reads them afresh too. And so does another `edition` (by default 0): the circle worked
   * out again (Update now), whose scorer has published new ranks in place of the old.
   */
  readonly setCircle = (
    circle: { owner: string; scorer: Scorer; confirmed?: boolean; edition?: number } | undefined,
  ): void => {
    const now = this.#circle;
    const confirmed = circle?.confirmed ?? true;
    const edition = circle?.edition ?? 0;
    const same =
      circle === undefined
        ? now === null
        : now !== null &&
          now.owner === circle.owner &&
          now.scorer.pubkey === circle.scorer.pubkey &&
          now.scorer.relay === circle.scorer.relay &&
          now.confirmed === confirmed &&
          now.edition === edition;
    if (same) return;
    now?.book.end();
    this.#circle =
      circle === undefined
        ? null
        : newCircle(circle.owner, { pubkey: circle.scorer.pubkey, relay: circle.scorer.relay }, confirmed, edition);
    this.#changed("scores");
    this.#weigh();
  };

  /**
   * Whether the person's circle has nobody in it among the reviewers seen this session (brief § 6,
   * rulings R7 and R8): its ranks are in for them, and none of them but the person is at or above the
   * line, which a scorer with no ranks at all gives too. False until a reviewer other than the person
   * is seen. While some are still to be ranked (a page scrolled, a map panned), the last answer stands,
   * unless one already ranked is in the circle: a line that says so does not come and go with each read.
   */
  circleEmpty(): boolean {
    const circle = this.#circle;
    if (circle === null) return false;
    if (circle.emptyAt === this.#scoresVersion) return circle.empty;
    const { book, owner } = circle;
    let answer: boolean | undefined = false;
    if (book.state !== "unavailable") {
      const { line } = config.scoring;
      let seen = false;
      let unknown = false;
      let inside = false;
      for (const reviews of this.#reviewsByAddress().values()) {
        for (const review of reviews) {
          if (review.reviewer === owner) continue;
          if (!book.known.has(review.reviewer)) unknown = true;
          else if (weightOf(book.ranks.get(review.reviewer), line) > 0) inside = true;
          else seen = true;
        }
      }
      answer = inside ? false : unknown ? undefined : seen;
    }
    if (answer !== undefined) circle.empty = answer;
    circle.emptyAt = this.#scoresVersion;
    return circle.empty;
  }

  /** Whether the person whose circle it is has reviewed any place seen this session (ruling R8). */
  circleOwnerRated(): boolean {
    const owner = this.#circle?.owner;
    if (owner === undefined) return false;
    for (const reviews of this.#reviewsByAddress().values()) {
      if (reviews.some((review) => review.reviewer === owner)) return true;
    }
    return false;
  }

  /**
   * Whether the circle of `owner` from the scorer `scorer` has given a rank to anyone yet: that its run
   * has published, so a circle not confirmed before is (ruling R10). False for any other circle.
   */
  readonly circleRanked = (owner: string | undefined, scorer: string | undefined): boolean => {
    const circle = this.#circle;
    return circle !== null && circle.owner === owner && circle.scorer.pubkey === scorer && circle.book.ranks.size > 0;
  };

  /** The ranks of `view`: none for My circle while the person has no circle ready. */
  #bookOf(view: View): RankBook | null {
    return view === "house" ? this.#house : (this.#circle?.book ?? null);
  }

  /** The ranks of every view there is: the house's, and the circle's once it is ready. */
  #books(): RankBook[] {
    return this.#circle === null ? [this.#house] : [this.#house, this.#circle.book];
  }

  /** Starts reading what is asked for, and reading again what could not be read once the device is back on line. */
  start(): void {
    this.#life = new AbortController();
    window.addEventListener("online", this.#onOnline);
    this.#newRound();
    this.#queueFlush();
    this.#weigh();
  }

  /** Aborts every read. What was being read is read again if the store starts again. */
  stop(): void {
    window.removeEventListener("online", this.#onOnline);
    this.#life?.abort();
    this.#life = null;
    this.#roundSignal = null;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#reviewLane.clear();
    this.#nameLane.clear();
    for (const lane of this.#rankLanes.values()) lane.clear();
    for (const book of this.#books()) book.pause();
    this.#failed.clear();
    this.#asked = new Set([...this.#asked].filter((address) => this.#read.has(address)));
    this.#namesAsked = new Set(this.#namesKnown);
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

  /** Asks for the names of the people with `pubkeys`, and the pictures that come with them (`pictureOf`). */
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
   * Asks each view's scorer about the people with `pubkeys`, as it asks about the reviewers of the
   * places pages ask for, in the same turns: Recent's reviewers, whom it lists only once their view has
   * said they count (`countsIn`). Each is asked about once a session from each view, so switching the
   * view asks for nothing new; a circle that is ready later is asked about them too.
   */
  wantRanks(pubkeys: Iterable<string>): void {
    let added = false;
    for (const pubkey of pubkeys) {
      if (!isHex64(pubkey) || this.#rankWanted.has(pubkey)) continue;
      this.#rankWanted.add(pubkey);
      added = true;
    }
    if (added) this.#weigh();
  }

  /**
   * Whether `pubkey`'s reviews count from `view`, as they count in its scores: in My circle, the person
   * whose circle it is always does; anyone else does at or above the line (`config.scoring.line`) from
   * the view's scorer. Undefined while that is not known: they have not been asked about or answered
   * for, the view can't be worked out right now, or there is no circle ready. Nobody is outside a view
   * before its scorer has said so. Yes or no, never how much: a page shows a person by name only
   * (decision 19).
   */
  countsIn(pubkey: string, view: View): boolean | undefined {
    const book = this.#bookOf(view);
    if (book === null || book.state === "unavailable") return undefined;
    if (pubkey === book.owner) return true;
    if (!book.known.has(pubkey)) return undefined;
    return weightOf(book.ranks.get(pubkey), config.scoring.line) > 0;
  }

  /**
   * Whether a read of `view`'s ranks failed, and the people it named have not been asked about again
   * since (`retryRanks`, `refresh` ask them). Yes or no: which people, or how many, is the store's
   * (decision 19).
   */
  rankReadFailed(view: View): boolean {
    return this.#bookOf(view)?.failed === true;
  }

  /**
   * Asks each view's scorer again about the people a failed read of its ranks let go of, and nothing
   * else: unlike `refresh`, no place's reviews are read again, and none being read is stopped.
   */
  readonly retryRanks = (): void => {
    this.#weigh();
  };

  /**
   * `events`, review events a page read on its own (Recent's), with the reviews of `pubkey`'s that the
   * store shows: each one held (posted this session, and not read back yet), and each one read for a
   * place that is no older than `since`, as far back as the page has read, so that it is not shown
   * below reviews the page has not read. Less each review the person removed this session
   * (`noteRemoval`), as the store hides them everywhere. With no `pubkey` (nobody signed in), `events`
   * less those removed.
   */
  readonly withOwn = (events: Iterable<NostrEvent>, pubkey: string | undefined, since: number): NostrEvent[] => {
    const all = [...events].filter(this.#notRemoved);
    if (pubkey === undefined) return all;
    const held = new Set<string>();
    for (const { event } of this.#own.values()) held.add(event.id);
    for (const ev of this.#shownEvents()) {
      if (ev.pubkey === pubkey && (held.has(ev.id) || ev.created_at >= since)) all.push(ev);
    }
    return all;
  };

  /**
   * The place at `address`'s score from `view` (House picks unless named): across all its filings, one
   * review per person. Undefined until its reviews have been read, while any of its reviewers is still
   * to be ranked from that view, and from My circle while the person has no circle ready. The same
   * object for as long as what it is made of is the same: toggling the view and back gives it again.
   */
  scoreOf(address: string, view: View = "house"): PlaceScore | undefined {
    return this.#viewOf(view, address)?.score;
  }

  /** The place at `address`'s reviews, as `scoreOf` takes them from either view, newest first. Empty until read. */
  reviewsOf(address: string): Review[] {
    return this.#reviewsAt(address) ?? [];
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
   * The picture in the person's profile (an https address, `shownPicture`), read with their name
   * (`wantNames`); undefined when it has none that may be loaded, or it has not been read.
   */
  pictureOf(pubkey: string): string | undefined {
    return this.#pictures.get(pubkey);
  }

  /**
   * Reads the reviews of every place asked for again, and puts what comes in place of what was read:
   * a review the relays no longer send is gone (it may have been deleted). Names that could not be
   * read are asked for again, and so is each view (House picks, My circle) that was unavailable; and
   * a circle whose run is not known to be done is read afresh, its ranks perhaps published since.
   */
  readonly refresh = (): void => {
    this.#refreshedAt = Date.now();
    this.#newRound();
    this.#asked = new Set();
    this.#namesAsked = new Set(this.#namesKnown);
    if (this.#failed.size > 0) {
      // They are being read again.
      this.#failed.clear();
      this.#changed("scores");
    }
    let retried = false;
    for (const book of this.#books()) if (book.retry()) retried = true;
    const circle = this.#circle;
    if (circle !== null && !circle.confirmed) {
      circle.book.end();
      this.#circle = newCircle(circle.owner, circle.scorer, false, circle.edition);
      retried = true;
    }
    if (retried) this.#changed("scores");
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

  /**
   * Back on line (the browser says so), as the places' store does: reads again what could not be read,
   * or was being read when the connection went (`refresh`): places no review relay answered for, a
   * view that was unavailable, reads still under way; but not within `ONLINE_CALM_MS` of the last time
   * it read again, so that a connection that comes and goes does not keep stopping reads that are
   * doing well. Otherwise it asks each view's scorer about the reviewers whose rank read failed. With
   * everything read, nothing is asked.
   */
  readonly #onOnline = (): void => {
    const reading = [...this.#asked].some((address) => !this.#read.has(address) && !this.#failed.has(address));
    const recently = this.#refreshedAt !== undefined && Date.now() - this.#refreshedAt < ONLINE_CALM_MS;
    const unavailable = this.#books().some((book) => book.state === "unavailable");
    if ((this.#failed.size > 0 || unavailable || reading) && !recently) this.refresh();
    else this.#weigh();
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
   * places' scores are made of otherwise ("scores": a view's ranks or state, the circle, filings), or
   * to names.
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
   * and by their `d`, bare or after `place:`, for reviews other apps wrote with no `a` (decision 16),
   * each page after page while the pages come back full (`readPaged`, `REVIEW_PAGES`). What comes is
   * put in place of what was read of those places before. A place no relay answered for keeps what it
   * had: `refresh` asks again.
   */
  async #readReviews(batch: readonly string[], signal: AbortSignal): Promise<void> {
    const byA: NostrFilter = { kinds: [REVIEW_KIND], "#a": [...batch], limit: REVIEW_LIMIT };
    const byD: NostrFilter = { kinds: [REVIEW_KIND], "#d": [...batch, ...batch.map(reviewD)], limit: REVIEW_LIMIT };
    const reads = await Promise.allSettled(
      // A reader that cannot be made fails its relay's read, as a read that fails does. A relay
      // answers both requests or neither: half its answer must not replace what was read before.
      config.reviewRelays.map(async (url) => {
        const reader = this.#readers(url);
        const [named, filed] = await Promise.all([
          readPaged(reader, byA, REVIEW_PAGES, signal),
          readPaged(reader, byD, REVIEW_PAGES, signal),
        ]);
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
   * Asks each view's scorer about the reviewers it has not been asked about, `RANK_BATCH` to a read:
   * House picks', and My circle's once the person's circle is ready, whose own reviews need no rank.
   * The reviewers are those of the places asked for, and the people a page wants ranked (`wantRanks`).
   * Nothing is asked of a scorer until there is someone to ask about: then the house's scorer is read,
   * once a session, and the ranks each scorer gives (`#rank`). People a failed read let go of are asked
   * about again here, and their view's `rankReadFailed` is no longer so. A view that is unavailable is
   * asked nothing until it is tried again (`refresh`, back on line).
   */
  #weigh(): void {
    const life = this.#life;
    if (life === null) return;
    let notify = false;
    for (const book of this.#books()) {
      if (book.state === "unavailable") continue;
      const unknown = new Set<string>();
      const consider = (pubkey: string) => {
        if (pubkey !== book.owner && !book.asked.has(pubkey)) unknown.add(pubkey);
      };
      for (const reviews of this.#reviewsByAddress().values()) {
        for (const review of reviews) consider(review.reviewer);
      }
      for (const pubkey of this.#rankWanted) consider(pubkey);
      if (unknown.size === 0) continue;
      // Those a failed read let go of are among them: being asked again, they are no longer failed.
      if (book.failed) {
        book.failed = false;
        notify = true;
      }
      for (const pubkey of unknown) book.asked.add(pubkey);
      if (book.state === "idle") {
        book.state = "loading";
        notify = true;
      }
      void this.#rank(book, [...unknown], AbortSignal.any([life.signal, book.ended]));
    }
    if (notify) this.#changed("scores");
  }

  /**
   * The turn of the scorers' relay at `relay`: two rank reads at a time (`BATCHES_IN_FLIGHT`), whichever
   * view they are for. One relay is one turn however its address is written (the house's list may name
   * it "WSS://Scores.Brainstorm.World/", Brainstorm's setup "wss://scores.brainstorm.world"): it is
   * keyed by the address written one way (`publicRelayAddress`), else as it is (ruling R13).
   */
  #rankLaneFor(relay: string): Lane {
    const key = publicRelayAddress(relay) ?? relay;
    let lane = this.#rankLanes.get(key);
    if (lane === undefined) {
      lane = new Lane(BATCHES_IN_FLIGHT);
      this.#rankLanes.set(key, lane);
    }
    return lane;
  }

  /**
   * Finds `book`'s scorer (the house's is read once a session), then queues the reads of the ranks of
   * `people`, `RANK_BATCH` to a read, in the turn of the scorer's relay. When the house names no scorer,
   * or its list can't be read, House picks is unavailable.
   */
  async #rank(book: RankBook, people: readonly string[], signal: AbortSignal): Promise<void> {
    let scorer: Scorer | null;
    try {
      book.scorerRead ??= book.find(signal).then((found) => {
        book.scorer = found;
        return found;
      });
      scorer = await book.scorerRead;
    } catch {
      // Aborted: the people are asked about again if the store starts again.
      return;
    }
    if (signal.aborted) return;
    if (scorer === null) {
      debug("the house names no scorer, or its list could not be read");
      this.#unavailable(book);
      return;
    }
    const lane = this.#rankLaneFor(scorer.relay);
    for (const batch of runsOf(people, RANK_BATCH)) lane.add(signal, () => this.#readRanks(book, scorer, batch, signal));
  }

  /**
   * Reads the ranks of `people` from `book`'s `scorer`. When they can't be read, only `people` are let
   * go of: they are asked about again at the next try (another place's reviews, the device back on
   * line, `refresh`), and the ranks known stay, with the places they score. Only before any rank has
   * come is the view unavailable then: there is none to keep. A book let go of meanwhile takes nothing.
   */
  async #readRanks(book: RankBook, scorer: Scorer, people: readonly string[], signal: AbortSignal): Promise<void> {
    try {
      const ranks = await fetchRanks(this.#readers(scorer.relay), scorer.pubkey, people, signal);
      if (signal.aborted) return;
      for (const pubkey of people) {
        book.known.add(pubkey);
        const rank = ranks.get(pubkey);
        if (rank !== undefined) book.ranks.set(pubkey, rank);
      }
      // A read that comes after one failed before any rank had come gets the view back.
      const recovered = book.state === "unavailable";
      if (book.state === "loading" || recovered) book.state = "ready";
      this.#changed("scores");
      if (recovered) this.#weigh();
    } catch (error) {
      if (signal.aborted) return;
      debug(book === this.#house ? "the house's ranks could not be read" : "the circle's ranks could not be read", error);
      for (const pubkey of people) book.asked.delete(pubkey);
      // Pages that wait on these people say so, with Try again (`rankReadFailed`).
      book.failed = true;
      if (book.known.size === 0) this.#unavailable(book);
      else this.#changed("scores");
    }
  }

  /** `book`'s view is not to be had: every review is folded in it until it is tried again (`refresh`, back on line). */
  #unavailable(book: RankBook): void {
    if (book.state === "unavailable") return;
    book.state = "unavailable";
    this.#changed("scores");
  }

  async #readNames(people: readonly string[], signal: AbortSignal): Promise<void> {
    let profiles: Map<string, Profile> | null;
    try {
      profiles = await fetchProfiles(this.#readers, config.reviewRelays, people, signal);
    } catch {
      return; // Aborted: asked again if the store starts again.
    }
    if (profiles === null) {
      debug("no review relay answered for profiles");
      return;
    }
    for (const pubkey of people) {
      this.#namesKnown.add(pubkey);
      const { name, picture } = profiles.get(pubkey) ?? {};
      if (name !== undefined) this.#names.set(pubkey, name);
      if (picture !== undefined) this.#pictures.set(pubkey, picture);
    }
    this.#changed("names");
  }

  /** Whether `ev` is not a review the person removed: written after the removal, or never removed. */
  readonly #notRemoved = (ev: NostrEvent): boolean => {
    const removedAt = this.#removed.get(eventKey(ev));
    return removedAt === undefined || ev.created_at > removedAt;
  };

  /** Every review event read or held, but those the person removed. */
  #shownEvents(): NostrEvent[] {
    const events: NostrEvent[] = [];
    for (const read of this.#read.values()) events.push(...read);
    for (const held of this.#own.values()) events.push(held.event);
    return events.filter(this.#notRemoved);
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

  #viewOf(view: View, address: string): PlaceView | undefined {
    const views = this.#views[view];
    const last = views.get(address);
    if (last !== undefined && last.at === this.#scoresVersion) return last.view;
    const worked = this.#workOut(view, address, last?.view);
    views.set(address, { at: this.#scoresVersion, view: worked });
    return worked;
  }

  /**
   * The place's reviews across its filings, one per person, the newest winning (brief § 4.3), newest
   * first: the last array when they are the same reviews. Undefined until every filing has been read,
   * unless the person's own review is there.
   */
  #reviewsAt(address: string): Review[] | undefined {
    const last = this.#placeReviews.get(address);
    if (last !== undefined && last.at === this.#scoresVersion) return last.reviews;
    const filings = this.#filings.get(address) ?? [address];
    const byAddress = this.#reviewsByAddress();
    const reviews = newestPerReviewer(filings.flatMap((filing) => byAddress.get(filing) ?? [])).sort(newestFirst);
    const read = filings.every((filing) => this.#read.has(filing));
    const own = reviews.some((review) => this.#own.get(keyOf(review.reviewer, review.d))?.event.id === review.id);
    let kept: Review[] | undefined;
    if (read || own) kept = last?.reviews !== undefined && sameReviews(last.reviews, reviews) ? last.reviews : reviews;
    this.#placeReviews.set(address, { at: this.#scoresVersion, reviews: kept });
    return kept;
  }

  /**
   * The place's reviews (`#reviewsAt`) and its score from `view`; `last` when it is made of the same.
   * Undefined until its reviews are there. The score is undefined while any of its reviewers is still
   * to be ranked from that view (nobody is shown as outside it before its scorer has said so), and
   * from My circle while the person has no circle ready. In My circle the person's own review counts
   * in full (brief § 5); in House picks it counts as the house ranks them. When the view is
   * unavailable, every review is folded, and the page says why.
   */
  #workOut(view: View, address: string, last: PlaceView | undefined): PlaceView | undefined {
    const reviews = this.#reviewsAt(address);
    if (reviews === undefined) return undefined;
    const book = this.#bookOf(view);

    let weights: number[] | undefined;
    if (book?.state === "unavailable") {
      weights = reviews.map(() => 0);
    } else if (book !== null && reviews.every((review) => review.reviewer === book.owner || book.known.has(review.reviewer))) {
      const { line } = config.scoring;
      weights = reviews.map((review) =>
        review.reviewer === book.owner ? OWN_WEIGHT : weightOf(book.ranks.get(review.reviewer), line),
      );
    }

    if (last !== undefined && last.reviews === reviews && sameWeights(last.weights, weights)) return last;
    if (weights === undefined) return { reviews, score: undefined, weights };
    const weightOfReviewer = new Map(reviews.map((review, i) => [review.reviewer, weights[i] ?? 0]));
    const score = scorePlace(reviews, (pubkey) => weightOfReviewer.get(pubkey) ?? 0, config.scoring);
    return { reviews, score, weights };
  }
}
