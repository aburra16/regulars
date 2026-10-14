import type { EventTemplate } from "nostr-tools/core";
import { EventDeletion } from "nostr-tools/kinds";

import type { Place } from "../places/place.ts";
import { photosOf, placeInD, REVIEW_KIND, reviewD } from "./review.ts";

/*
 * The events a person signs to review a place or take a review back. They are templates, unsigned:
 * the person's signer adds the public key, the id and the signature, so their key is never in the app.
 */

/** The stars a person gives in a review: whole stars from 1 to 5 (brief § 4). */
export type WholeStars = 1 | 2 | 3 | 4 | 5;

/**
 * The most characters a review's words hold, as the review form takes them: counted as a field's
 * `maxlength` counts them (UTF-16 code units), which is what Brainstorm's composer counts too. The
 * template does not hold the words to it: a longer review written elsewhere may be posted as it is.
 */
export const REVIEW_WORDS_MAX = 1_200;

/**
 * The tags an edit does not carry over from the review it is built on: those `reviewTemplate` sets
 * itself (every `rating`, one with an aspect too, as Brainstorm drops them), and `client` and `nonce`,
 * which tell of one signing (the app that signed that version, NIP-89; its proof of work, NIP-13),
 * not of the review.
 */
const NOT_CARRIED = new Set(["d", "a", "m", "rating", "s", "alt", "client", "nonce"]);

/**
 * A review of `place` with `stars` and the words `text` (which may be empty, and is used as given),
 * made at `now`, in seconds since the epoch. Its shape is decision 17's: `d` names the place after
 * `place:`, so a person's next review of it replaces this one; `a` is the place's address; `rating`
 * is the stars out of 5 as a fraction to three decimals, and `s` the whole stars, which `starsOf`
 * reads first; `alt` says what it is to an app that does not know the kind (NIP-31).
 *
 * An edit is built on the person's review of the place, `previous`, and loses nothing it does not
 * set. Both apps replace the one record a person has of a place, and each carries over what it does
 * not set, so that neither strips what the other gave: here a price, how they paid, photos, and tags
 * from apps neither knows. So after its own tags come every other tag of `previous`, unchanged and in
 * their order, but `client` and `nonce`, which tell of the signing of that version, not of the review
 * (`NOT_CARRIED`); and after the words, each photo's address that a kept `imeta` names, on a line of
 * its own, as other apps read photos from the words. It keeps `previous`'s `d` when that names this
 * place, the bare address or after `place:`, so that it replaces it there; one at another filing
 * is left to stand beside it, the newer of the two showing.
 */
export function reviewTemplate(
  place: Place,
  stars: WholeStars,
  text: string,
  now: number,
  previous?: { tags: readonly (readonly string[])[] },
): EventTemplate {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new RangeError(`A review gives 1 to 5 whole stars, not ${stars}`);
  }
  const d = previous?.tags.find((tag) => tag[0] === "d")?.[1];
  const carried = (previous?.tags ?? []).filter(([name]) => !NOT_CARRIED.has(name ?? "")).map((tag) => [...tag]);
  return {
    kind: REVIEW_KIND,
    created_at: now,
    content: [text, ...photosOf(carried)].filter((part) => part !== "").join("\n"),
    tags: [
      ["d", d !== undefined && placeInD(d) === place.address ? d : reviewD(place.address)],
      ["a", place.address],
      ["m", "place"],
      ["rating", (stars / 5).toFixed(3)],
      ["s", String(stars)],
      ["alt", `Review of ${place.name}: ${stars} of 5 stars`],
      ...carried,
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
