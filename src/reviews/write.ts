import type { EventTemplate } from "nostr-tools/core";
import { EventDeletion } from "nostr-tools/kinds";

import type { Place } from "../places/place.ts";
import { REVIEW_KIND, reviewD } from "./review.ts";

/*
 * The events a person signs to review a place or take a review back. They are templates, unsigned:
 * the person's signer adds the public key, the id and the signature, so their key is never in the app.
 */

/** The stars a person gives in a review: whole stars from 1 to 5 (brief § 4). */
export type WholeStars = 1 | 2 | 3 | 4 | 5;

/**
 * A review of `place` with `stars` and the words `text` (which may be empty), made at `now`, in
 * seconds since the epoch. Its shape is decision 17's: `d` names the place after `place:`, so a
 * person's next review of it replaces this one; `a` is the place's address; `rating` is the stars
 * out of 5 as a fraction to three decimals, and `s` the whole stars, which `starsOf` reads first;
 * `alt` says what it is to an app that does not know the kind (NIP-31).
 */
export function reviewTemplate(place: Place, stars: WholeStars, text: string, now: number): EventTemplate {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new RangeError(`A review gives 1 to 5 whole stars, not ${stars}`);
  }
  return {
    kind: REVIEW_KIND,
    created_at: now,
    content: text,
    tags: [
      ["d", reviewD(place.address)],
      ["a", place.address],
      ["m", "place"],
      ["rating", (stars / 5).toFixed(3)],
      ["s", String(stars)],
      ["alt", `Review of ${place.name}: ${stars} of 5 stars`],
    ],
  };
}

/** A review as its removal names it: its id, its reviewer, and its `d`. */
export interface RemovedReview {
  id: string;
  pubkey: string;
  d: string;
}

/**
 * A request to delete `reviews` (NIP-09), one or several in one, made at `now`, in seconds since the
 * epoch: each by its id (`e`), and by its address (`a`, `34259:<pubkey>:<d>`), which also covers any
 * version of it a relay holds from up to that time. `k` names the kind deleted, once.
 */
export function removalTemplate(reviews: RemovedReview | readonly RemovedReview[], now: number): EventTemplate {
  const each = Array.isArray(reviews) ? (reviews as readonly RemovedReview[]) : [reviews as RemovedReview];
  return {
    kind: EventDeletion,
    created_at: now,
    content: "",
    tags: [
      ...each.flatMap((review) => [
        ["e", review.id],
        ["a", `${REVIEW_KIND}:${review.pubkey}:${review.d}`],
      ]),
      ["k", String(REVIEW_KIND)],
    ],
  };
}
