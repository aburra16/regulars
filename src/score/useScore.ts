import type { NostrEvent } from "@nostrify/nostrify";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import type { Review } from "../reviews/review.ts";
import { useCurrentView, type View } from "../view/ViewProvider.tsx";
import type { PlaceScore } from "./score.ts";
import { useScoresStore, type ViewState } from "./ScoresProvider.tsx";
import type { ReadState, ReviewCoordinate, ScoresStore } from "./store.ts";

/*
 * What pages ask the scores store for: places' scores from the view on screen (House picks, or My
 * circle), their reviews, reviewers' names, and the person's own picture. They give reviews, place
 * scores, names and that picture, and never a number about a person (decision 19). Toggling the view
 * asks the store for nothing new: the scores are worked out again from what it holds (Review Focus 5).
 */

/** Re-renders the component when places' reviews or scores may have changed; their version, for memos. */
function useScoresVersion(store: ScoresStore): number {
  return useSyncExternalStore(store.subscribe, store.scoresVersion);
}

/** Re-renders the component when names have changed; their version, for memos. */
function useNamesVersion(store: ScoresStore): number {
  return useSyncExternalStore(store.subscribe, store.namesVersion);
}

/**
 * Where the reading of the place at `address` stands, for a page that asks for it: as the store says,
 * and "reading" before the page's ask has reached it. A page asks once it is drawn (an effect), so
 * the first drawing of it comes before: without this, it would say "Be the first", or "No reviews
 * yet", for that moment (ruling R15). Undefined when there are no review relays, as the store has it.
 */
function readStateFor(store: ScoresStore, address: string): ReadState | undefined {
  return store.readStateOf(address) ?? (config.reviewRelays.length > 0 ? "reading" : undefined);
}

/** Whether `a` and `b` hold the same items in the same order. */
function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * `items` as one array for as long as they are the same, item by item, whatever array they come in,
 * so that effects and memos keyed on it run when the list changes, not when the array does.
 */
function useSameList(items: readonly string[]): readonly string[] {
  const [kept, keep] = useState<readonly string[]>(() => [...items]);
  if (sameItems(kept, items)) return kept;
  // React's way to update state from props: this render is thrown away and done again at once.
  const fresh = [...items];
  keep(fresh);
  return fresh;
}

/**
 * The scores of the places at `addresses` from the view on screen (`view`), by address, and where
 * that view's ranks stand (`state`); `house` is where House picks' stand. Asks for their reviews the
 * first time each is asked for, all of them in one go: a page asks for its whole list at once, not a
 * card at a time. A place is missing from `scores` until its reviews have been read, and always when
 * there are no review relays. `pending` holds the places that have reviews and no score yet, while
 * the view's scorer is asked about their reviewers. `reads` says where the reading of each place
 * stands (`ScoresStore.readStateOf`), "reading" from the first drawing; a place is missing from it
 * when there are no review relays.
 */
export function useScores(addresses: readonly string[]): {
  scores: Map<string, PlaceScore>;
  pending: ReadonlySet<string>;
  reads: ReadonlyMap<string, ReadState>;
  house: ViewState;
  view: View;
  state: ViewState;
} {
  const store = useScoresStore("useScores");
  const version = useScoresVersion(store);
  const view = useCurrentView();
  const asked = useSameList(addresses);

  useEffect(() => store.want(asked), [store, asked]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    const scores = new Map<string, PlaceScore>();
    const pending = new Set<string>();
    const reads = new Map<string, ReadState>();
    for (const address of asked) {
      const score = store.scoreOf(address, view);
      if (score !== undefined) scores.set(address, score);
      else if (store.reviewsOf(address).length > 0) pending.add(address);
      const read = readStateFor(store, address);
      if (read !== undefined) reads.set(address, read);
    }
    return { scores, pending, reads, house: store.house, view, state: store.stateOf(view) };
  }, [store, asked, version, view]);
}

/**
 * One place's score, as `useScores` gives it, and its reviews: one per person, across all its
 * filings, newest first, whether they count in the score or are folded. Empty until read. `read`
 * says where the reading of them stands, "reading" from the first drawing; undefined when there are
 * no review relays.
 */
export function useScore(address: string): {
  score: PlaceScore | undefined;
  reviews: Review[];
  read: ReadState | undefined;
  house: ViewState;
  view: View;
  state: ViewState;
} {
  const store = useScoresStore("useScore");
  const version = useScoresVersion(store);
  const view = useCurrentView();

  useEffect(() => store.want([address]), [store, address]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    return {
      score: store.scoreOf(address, view),
      reviews: store.reviewsOf(address),
      read: readStateFor(store, address),
      house: store.house,
      view,
      state: store.stateOf(view),
    };
  }, [store, address, version, view]);
}

/**
 * For the line that says the person's circle has nobody in it yet (brief § 6, rulings R7, R8): whether
 * that is so among the reviewers seen this session (`ScoresStore.circleEmpty`, which keeps its last
 * answer while new reviewers are ranked), and whether the person has rated places themselves
 * (`ScoresStore.circleOwnerRated`), which the line says. Yes or no, never a number about anyone.
 */
export function useCircleEmptiness(): { empty: boolean; youRated: boolean } {
  const store = useScoresStore("useCircleEmptiness");
  const version = useScoresVersion(store);
  return useMemo(() => {
    void version; // What the store gives changes with it.
    return { empty: store.circleEmpty(), youRated: store.circleOwnerRated() };
  }, [store, version]);
}

/**
 * Each person's name, by public key: their profile's `display_name`, else its `name`, read from the
 * review relays once a session. Someone whose name is not known, or not read yet, is "Someone":
 * never a code or a key.
 */
export function useNames(pubkeys: readonly string[]): Map<string, string> {
  const store = useScoresStore("useNames");
  const version = useNamesVersion(store);
  const asked = useSameList(pubkeys);

  useEffect(() => store.wantNames(asked), [store, asked]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    return new Map(asked.map((pubkey) => [pubkey, store.nameOf(pubkey) ?? copy.reviews.someone]));
  }, [store, asked, version]);
}

/**
 * The picture in the profile of the person signed in as `pubkey`, read with their name
 * (`ScoresStore.pictureOf`): an https address, or undefined until it is read, or when their profile
 * has none that may be loaded. For the person's own account button only: the app loads no one
 * else's picture.
 */
export function useOwnPicture(pubkey: string): string | undefined {
  const store = useScoresStore("useOwnPicture");
  useEffect(() => store.wantOwnPicture(pubkey), [store, pubkey]);
  return useSyncExternalStore(store.subscribe, () => store.pictureOf(pubkey));
}

/** What the person's own actions tell the store. */
export interface ScoreActions {
  /** Reads the reviews of the places asked for again, in place of what was read (`ScoresStore.refresh`). */
  refresh(): void;
  /**
   * Shows the person's own review, just posted, with the relays it was sent to, until a read returns
   * it (`ScoresStore.noteOwnReview`).
   */
  noteOwnReview(event: NostrEvent, relays?: readonly string[]): void;
  /** Hides the person's review at `address`, removed at `createdAt` (`ScoresStore.noteRemoval`). */
  noteRemoval(address: string, createdAt: number): void;
  /**
   * Every review `pubkey` has of the place at `address`, under any `d` and in any filing, newest
   * first: what a removal of their review of it must name (`ScoresStore.ownCoordinates`). It reads
   * the store as it is when called.
   */
  ownCoordinates(pubkey: string, address: string): ReviewCoordinate[];
  /**
   * When `pubkey` last removed a review of the place at `address`, in any filing, this session: what
   * their next review of it must be later than (`ScoresStore.ownRemovedAt`). Undefined when never.
   */
  ownRemovedAt(pubkey: string, address: string): number | undefined;
}

/** The store's actions, the same functions for the whole session. */
export function useScoreActions(): ScoreActions {
  const store = useScoresStore("useScoreActions");
  return useMemo(
    () => ({
      refresh: store.refresh,
      noteOwnReview: store.noteOwnReview,
      noteRemoval: store.noteRemoval,
      ownCoordinates: store.ownCoordinates,
      ownRemovedAt: store.ownRemovedAt,
    }),
    [store],
  );
}
