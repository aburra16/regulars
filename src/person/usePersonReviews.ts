import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { type ReviewedPlace, reviewsOfListedPlaces } from "../reviews/ofPlaces.ts";
import { latestReviews } from "../reviews/review.ts";
import { useRelays, useScoresStore } from "../score/ScoresProvider.tsx";
import { ReviewsRead } from "./reviewsRead.ts";

/*
 * What a person's page lists: their reviews of the places on the list, one of each place, newest
 * first. The reviews come from the page's own reading of the review relays (./reviewsRead.ts), with
 * the person's own that the scores store holds; which of them count is as a place's page and
 * Trending have it. Nothing here writes.
 */

/**
 * The most pages read for one ask (the page opened, or Show more pressed): the page asked for, and
 * then the next ones by themselves while none has brought a review to show, as when a run of the
 * person's reviews is of places that are no longer on the list. Then the page waits for Show more.
 */
export const PERSON_PAGES_PER_ASK = 3;

/** One review on a person's page, with the place it is of. */
export type PersonEntry = ReviewedPlace;

/** A person's reviews, as their page shows them, and where the reading of them stands. */
export interface PersonReviews {
  /** Their reviews of places on the list, one of each place, newest first. */
  entries: PersonEntry[];
  /**
   * Where the list stands:
   * - `loading`: the first page is being read, or the pages after it that are read by themselves
   *   while none has brought a review to show;
   * - `failed`: the reviews could not be had. No review relay answered for the first page; or
   *   nothing is listed, no relay is left to ask, and one of them was left, as it did not answer a
   *   page (rulings R37 and R42): what it holds was not read, so the list is not known to be empty;
   * - `ready`: the list is what it is, perhaps empty, perhaps with more to read.
   */
  state: "loading" | "failed" | "ready";
  /**
   * The next page back in time: not asked for, being read, or failed (no relay asked answered: Try
   * again asks the same relays again, as often as the person asks, and nothing reads by itself
   * after it).
   */
  more: "idle" | "reading" | "failed";
  /**
   * Whether no review relay is left to ask: each has sent every review it has, or did not answer a
   * page another relay answered and is left for the visit (ruling R38). Until then more may exist,
   * though none is listed. An empty list is "none yet" only once this is so and the state is
   * `ready`: every review relay has answered in full (ruling R42).
   */
  end: boolean;
  /** Reads the next page back in time, and those after it while none brings a review to show (`PERSON_PAGES_PER_ASK`). */
  showMore(): void;
  /**
   * Reads again what could not be read, for the person's Try again. When the state is `failed`, the
   * visit begins again, with every relay asked from its newest page; otherwise, the next page, from
   * the relays it was asked of.
   */
  retry(): void;
}

/**
 * The reviews of the person whose key is `pubkey` (64 hex digits, in lower case), for their page, and
 * where the reading of them stands. They are read from the review relays, a page at a time
 * (`PERSON_PAGE`, ./reviewsRead.ts), for as long as the component is on screen; another `pubkey`
 * starts afresh.
 *
 * Which reviews count is as a place's page and Trending have it, by the same code: each of the
 * person's reviews is the newest at its `d`, none is dated more than a day ahead, and none is taken
 * down by a removal read from the relays, by this page or by the scores store (`latestReviews`); none
 * is one the person signed in removed in this tab, while their own that the tab holds until the
 * relays send them back are there (`ScoresStore.withOwn`). Of those, the ones of places on the
 * list, one of each place, the newest: a place filed twice is one place (`reviewsOfListedPlaces`,
 * which Trending lists by too). A review of a place that is not on the list is left out, and nothing
 * says so.
 *
 * A page of reviews may bring none to show. Then the next is read by itself, `PERSON_PAGES_PER_ASK`
 * pages at most for each ask, and never after a page no relay answered; after that Show more reads
 * on. The list is never said to be empty while more may exist (`end`), nor when any relay was left
 * (`state`, rulings R37 and R42): only when every review relay has sent everything it has.
 */
export function usePersonReviews(pubkey: string): PersonReviews {
  const { readers } = useRelays();
  const store = useScoresStore("usePersonReviews");
  const version = useSyncExternalStore(store.subscribe, store.scoresVersion);
  const me = useOwnPubkey();
  const indexes = useIndexes();

  const [made, setMade] = useState(() => new ReviewsRead(pubkey, readers));
  let read = made;
  if (read.pubkey !== pubkey) {
    // React's way to update state from props: this render is thrown away and done again at once.
    read = new ReviewsRead(pubkey, readers);
    setMade(read);
  }
  const snapshot = useSyncExternalStore(read.subscribe, read.snapshot);

  useEffect(() => {
    read.start();
    return () => read.stop();
  }, [read]);

  // Each entry the same object for as long as it is the same review of the same place: an event never
  // changes, so a review drawn once need not be drawn again when more are listed.
  const drawn = useRef(new Map<string, PersonEntry>());
  const entries = useMemo(() => {
    void version; // The person's own reviews held, and those they removed, change with it.
    if (indexes === undefined) return [];
    // The person signed in's own reviews that the tab holds are theirs alone: only those held, as the
    // relays are read for the rest. On anyone else's page they are not this person's, and are left out.
    const values = [...snapshot.events, ...snapshot.removals];
    const theirs = latestReviews(store.withOwn(values, me, Number.POSITIVE_INFINITY)).filter((review) => review.reviewer === pubkey);
    return reviewsOfListedPlaces(theirs, indexes.byAddress).map((listed) => {
      const id = `${listed.review.id} ${listed.place.address}`;
      const kept = drawn.current.get(id);
      // A list of places read afresh has the place anew, perhaps under another name.
      if (kept !== undefined && kept.place === listed.place) return kept;
      drawn.current.set(id, listed);
      return listed;
    });
  }, [store, snapshot.events, snapshot.removals, version, me, indexes, pubkey]);

  const { first, more, end, missed, sinceAsk } = snapshot;
  // How many reviews were listed when the person last asked for a page; none before they have.
  const [asked, setAsked] = useState<{ read: ReviewsRead; listed: number } | null>(null);
  const listedAtAsk = asked?.read === read ? asked.listed : null;
  // The last ask has brought nothing to show yet, and may still: the next page, by itself.
  const readOn =
    first === "read" && !end && more === "idle" && indexes !== undefined && entries.length <= (listedAtAsk ?? 0) && sinceAsk < PERSON_PAGES_PER_ASK;
  useEffect(() => {
    if (readOn) void read.readMore();
  }, [readOn, read]);

  let state: PersonReviews["state"];
  if (first === "failed") state = "failed";
  else if (first !== "read") state = "loading";
  // Before the person has asked for anything: reading on by itself is still the page loading.
  else if (entries.length === 0 && listedAtAsk === null && (readOn || more === "reading")) state = "loading";
  // Nothing is listed and no relay is left to ask, yet one of them was left: not every relay answered in full, so not "none yet".
  else if (end && missed && entries.length === 0) state = "failed";
  else state = "ready";

  return {
    entries,
    state,
    // Between two pages read for one ask, it is reading still.
    more: readOn ? "reading" : more,
    end,
    showMore: () => {
      setAsked({ read, listed: entries.length });
      void read.readMore(true);
    },
    retry: () => {
      if (state === "failed") {
        // The visit begins again, as when the page was opened: nothing the person asked for before stands.
        setAsked(null);
        read.restart();
      } else {
        setAsked({ read, listed: entries.length });
        read.retry();
      }
    },
  };
}
