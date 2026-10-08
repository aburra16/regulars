import type { NostrEvent } from "@nostrify/nostrify";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { copy } from "../copy/en.ts";
import type { Review } from "../reviews/review.ts";
import type { PlaceScore } from "./score.ts";
import { type HouseState, useScoresStore } from "./ScoresProvider.tsx";
import type { ReadState, ReviewCoordinate, ScoresStore } from "./store.ts";

/*
 * What pages ask the scores store for: places' scores and reviews, and reviewers' names. They give
 * reviews, place scores and names, and never a number about a person (decision 19).
 */

/** Re-renders the component when places' reviews or scores may have changed; their version, for memos. */
function useScoresVersion(store: ScoresStore): number {
  return useSyncExternalStore(store.subscribe, store.scoresVersion);
}

/** Re-renders the component when names have changed; their version, for memos. */
function useNamesVersion(store: ScoresStore): number {
  return useSyncExternalStore(store.subscribe, store.namesVersion);
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
 * The scores of the places at `addresses` from the house's view, by address, and where the house's
 * view stands. Asks for their reviews the first time each is asked for, all of them in one go: a
 * page asks for its whole list at once, not a card at a time. A place is missing from `scores` until
 * its reviews have been read, and always when there are no review relays. `pending` holds the
 * places that have reviews and no score yet, while the house is asked about their reviewers. `reads`
 * says where the reading of each place stands (`ScoresStore.readStateOf`); a place is missing from it
 * when there are no review relays.
 */
export function useScores(addresses: readonly string[]): {
  scores: Map<string, PlaceScore>;
  pending: ReadonlySet<string>;
  reads: ReadonlyMap<string, ReadState>;
  house: HouseState;
} {
  const store = useScoresStore("useScores");
  const version = useScoresVersion(store);
  const asked = useSameList(addresses);

  useEffect(() => store.want(asked), [store, asked]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    const scores = new Map<string, PlaceScore>();
    const pending = new Set<string>();
    const reads = new Map<string, ReadState>();
    for (const address of asked) {
      const score = store.scoreOf(address);
      if (score !== undefined) scores.set(address, score);
      else if (store.reviewsOf(address).length > 0) pending.add(address);
      const read = store.readStateOf(address);
      if (read !== undefined) reads.set(address, read);
    }
    return { scores, pending, reads, house: store.house };
  }, [store, asked, version]);
}

/**
 * One place's score, as `useScores` gives it, and its reviews: one per person, across all its
 * filings, newest first, whether they count in the score or are folded. Empty until read. `read`
 * says where the reading of them stands; undefined when there are no review relays.
 */
export function useScore(address: string): {
  score: PlaceScore | undefined;
  reviews: Review[];
  read: ReadState | undefined;
  house: HouseState;
} {
  const store = useScoresStore("useScore");
  const version = useScoresVersion(store);

  useEffect(() => store.want([address]), [store, address]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    return {
      score: store.scoreOf(address),
      reviews: store.reviewsOf(address),
      read: store.readStateOf(address),
      house: store.house,
    };
  }, [store, address, version]);
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

/** What the person's own actions tell the store. */
export interface ScoreActions {
  /** Reads the reviews of the places asked for again, in place of what was read (`ScoresStore.refresh`). */
  refresh(): void;
  /** Shows the person's own review, just posted, until a read returns it (`ScoresStore.noteOwnReview`). */
  noteOwnReview(event: NostrEvent): void;
  /** Hides the person's review at `address`, removed at `createdAt` (`ScoresStore.noteRemoval`). */
  noteRemoval(address: string, createdAt: number): void;
  /**
   * Every review `pubkey` has of the place at `address`, under any `d` and in any filing, newest
   * first: what a removal of their review of it must name (`ScoresStore.ownCoordinates`). It reads
   * the store as it is when called.
   */
  ownCoordinates(pubkey: string, address: string): ReviewCoordinate[];
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
    }),
    [store],
  );
}
