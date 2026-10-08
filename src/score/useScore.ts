import type { NostrEvent } from "@nostrify/nostrify";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { copy } from "../copy/en.ts";
import type { Review } from "../reviews/review.ts";
import type { PlaceScore } from "./score.ts";
import { type HouseState, useScoresStore } from "./ScoresProvider.tsx";
import type { ScoresStore } from "./store.ts";

/*
 * What pages ask the scores store for: places' scores and reviews, and reviewers' names. They give
 * reviews, place scores and names, and never a number about a person (decision 19).
 */

/** Re-renders the component when the store changes, and gives the store's version for memos. */
function useVersion(store: ScoresStore): number {
  return useSyncExternalStore(store.subscribe, store.version);
}

/** `items` as one array for as long as they are the same, whatever array they come in. */
function useSameList(items: readonly string[]): readonly string[] {
  const key = JSON.stringify(items);
  return useMemo(() => JSON.parse(key) as string[], [key]);
}

/**
 * The scores of the places at `addresses` from the house's view, by address, and where the house's
 * view stands. Asks for their reviews the first time each is asked for. A place is missing from the
 * map until its reviews have been read, and always when there are no review relays.
 */
export function useScores(addresses: readonly string[]): { scores: Map<string, PlaceScore>; house: HouseState } {
  const store = useScoresStore("useScores");
  const version = useVersion(store);
  const asked = useSameList(addresses);

  useEffect(() => store.want(asked), [store, asked]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    const scores = new Map<string, PlaceScore>();
    for (const address of asked) {
      const score = store.scoreOf(address);
      if (score !== undefined) scores.set(address, score);
    }
    return { scores, house: store.house };
  }, [store, asked, version]);
}

/**
 * One place's score, as `useScores` gives it, and its reviews: one per person, across all its
 * filings, newest first, whether they count in the score or are folded. Empty until read.
 */
export function useScore(address: string): { score: PlaceScore | undefined; reviews: Review[]; house: HouseState } {
  const store = useScoresStore("useScore");
  const version = useVersion(store);

  useEffect(() => store.want([address]), [store, address]);

  return useMemo(() => {
    void version; // What the store gives changes with it.
    return { score: store.scoreOf(address), reviews: store.reviewsOf(address), house: store.house };
  }, [store, address, version]);
}

/**
 * Each person's name, by public key: their profile's `display_name`, else its `name`, read from the
 * review relays once a session. Someone whose name is not known, or not read yet, is "Someone":
 * never a code or a key.
 */
export function useNames(pubkeys: readonly string[]): Map<string, string> {
  const store = useScoresStore("useNames");
  const version = useVersion(store);
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
}

/** The store's actions, the same functions for the whole session. */
export function useScoreActions(): ScoreActions {
  const store = useScoresStore("useScoreActions");
  return useMemo(
    () => ({ refresh: store.refresh, noteOwnReview: store.noteOwnReview, noteRemoval: store.noteRemoval }),
    [store],
  );
}
