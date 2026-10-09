import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import type { Place } from "../places/place.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { latestReviews, newestPerReviewer, type Review } from "../reviews/review.ts";
import { useRecentFeed, useScoresStore } from "../score/ScoresProvider.tsx";
import { useCurrentView, type View } from "../view/ViewProvider.tsx";
import { FEED_AUTO_PAGES, FEED_ENOUGH, type FeedRead } from "./feed.ts";

/*
 * What Recent lists (Avi, 2026-10-08): the newest reviews of the places on the list, wherever they
 * are, one per reviewer per place, newest first, of the reviewers who count in the view on screen, as
 * they count in its scores. The order is by time alone, never by who the reviewer is (decision 19).
 * The reviews come from the session's feed (./feed.ts), with the person's own that the scores store
 * holds; whose they are, from the store's ranks of each view, which it reads for the feed's reviewers
 * as it reads them for the places' (`ScoresStore.wantRanks`). Switching the view reads no review.
 */

/** One review in the list, with its place. */
export interface RecentEntry {
  review: Review;
  place: Place;
  /** Whether it is the person's own: "You". */
  mine: boolean;
}

/**
 * Where the list stands:
 * - `loading`: the first page is being read, or nothing is listed yet while the view's scorer is asked
 *   about the reviewers, or while older pages are read by themselves;
 * - `failed`: no review relay answered for the first page;
 * - `unavailable`: the view can't be worked out right now, so nobody can be listed;
 * - `ready`: the list is what it is, perhaps empty, perhaps with more on its way.
 */
export type RecentState = "loading" | "failed" | "unavailable" | "ready";

export interface Recent {
  entries: RecentEntry[];
  /**
   * The people whose names the list may show, from either view: each reviewer but the person who
   * counts in House picks or My circle. Their names are read before a switch of the view lists them.
   */
  named: string[];
  state: RecentState;
  view: View;
  /** Whether some reviewers are still to be answered for in the view: their reviews are not listed yet. */
  counting: boolean;
  /** The next page back in time: not asked for, being read, or failed. */
  older: FeedRead;
  /** The newest page again, over the list: not asked for, being read, or failed. */
  newer: FeedRead;
  /** Whether every review there is has been read. */
  end: boolean;
  /** Reads the next page back in time. */
  showOlder(): void;
  /** Reads again what failed. */
  retry(): void;
}

/** Newest first; at the same time, the lowest id first. */
const newestFirst = (a: { review: Review }, b: { review: Review }) =>
  b.review.createdAt - a.review.createdAt || (a.review.id < b.review.id ? -1 : a.review.id > b.review.id ? 1 : 0);

/**
 * Recent's list from the view on screen, and where it stands. The page that uses it is Recent: on
 * each visit, the feed is opened (`RecentFeed.open`), which reads the first page, or the newest page
 * again once it is no longer fresh. While fewer than `FEED_ENOUGH` reviews count in the view, and the
 * view's scorer has answered for every reviewer, it reads older pages by itself, up to
 * `FEED_AUTO_PAGES` pages in all; then it waits for `showOlder`.
 */
export function useRecent(): Recent {
  const feed = useRecentFeed();
  const store = useScoresStore("useRecent");
  const snapshot = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const version = useSyncExternalStore(store.subscribe, store.scoresVersion);
  const view = useCurrentView();
  const me = useOwnPubkey();
  const indexes = useIndexes();

  useEffect(() => feed.open(), [feed]);

  // Every review of a place on the list, one per reviewer per place (across a place's filings, the
  // newest winning), newest first. A review of a place not on the list is left out.
  const reviews = useMemo(() => {
    void version; // The person's own reviews, and those they removed, change with it.
    if (indexes === undefined) return [];
    const byPlace = new Map<string, { review: Review; place: Place }[]>();
    for (const review of latestReviews(store.withOwn(snapshot.events, me))) {
      const place = indexes.byAddress.get(review.address);
      if (place === undefined) continue;
      // One place filed twice (the same OSM id under two addresses, brief § 4.3) gives each reviewer one review.
      const key = place.osmId === undefined ? place.address : `osm ${place.osmId}`;
      const reviewed = byPlace.get(key);
      if (reviewed === undefined) byPlace.set(key, [{ review, place }]);
      else reviewed.push({ review, place });
    }
    const kept: { review: Review; place: Place }[] = [];
    for (const reviewed of byPlace.values()) {
      const placeOf = new Map(reviewed.map(({ review, place }) => [review.id, place]));
      for (const review of newestPerReviewer(reviewed.map(({ review }) => review))) {
        kept.push({ review, place: placeOf.get(review.id)! });
      }
    }
    return kept.sort(newestFirst);
  }, [store, snapshot.events, version, me, indexes]);

  const reviewers = useMemo(() => [...new Set(reviews.map(({ review }) => review.reviewer))], [reviews]);
  useEffect(() => store.wantRanks(reviewers), [store, reviewers]);

  // Each entry the same object for as long as it is the same review of the same place, by the same
  // person: an event never changes, so a review drawn once need not be drawn again when another changes.
  const made = useRef(new Map<string, RecentEntry>());
  const { entries, counting } = useMemo(() => {
    void version; // The views' ranks change with it.
    const listed: RecentEntry[] = [];
    let unknown = false;
    for (const { review, place } of reviews) {
      const counts = store.countsIn(review.reviewer, view);
      if (counts === undefined) {
        unknown = true;
        continue;
      }
      if (!counts) continue;
      const mine = review.reviewer === me;
      const key = `${review.id} ${place.address} ${mine ? "mine" : ""}`;
      let entry = made.current.get(key);
      if (entry === undefined) {
        entry = { review, place, mine };
        made.current.set(key, entry);
      }
      listed.push(entry);
    }
    return { entries: listed, counting: unknown };
  }, [store, reviews, version, view, me]);

  const named = useMemo(() => {
    void version; // The views' ranks change with it.
    return reviewers.filter(
      (reviewer) => reviewer !== me && (store.countsIn(reviewer, "house") === true || store.countsIn(reviewer, "circle") === true),
    );
  }, [store, reviewers, version, me]);

  const unavailable = store.stateOf(view) === "unavailable";
  const { first, older, newer, pages, end } = snapshot;
  // Fewer than enough count, and every reviewer read has been answered for: the next page, by itself.
  const readOn =
    first === "read" && !end && older === "idle" && pages < FEED_AUTO_PAGES && !unavailable && !counting && entries.length < FEED_ENOUGH;
  useEffect(() => {
    if (readOn) void feed.readOlder();
  }, [readOn, feed]);

  let state: RecentState;
  if (first === "failed") state = "failed";
  else if (first !== "read") state = "loading";
  else if (unavailable) state = "unavailable";
  else if (entries.length === 0 && (counting || readOn || older === "reading")) state = "loading";
  else state = "ready";

  return {
    entries,
    named,
    state,
    view,
    counting,
    older,
    newer,
    end,
    showOlder: () => void feed.readOlder(),
    retry: feed.retry,
  };
}
