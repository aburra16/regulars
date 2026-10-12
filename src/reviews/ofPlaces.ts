import type { Place } from "../places/place.ts";
import { newestPerReviewer, type Review } from "./review.ts";

/*
 * The reviews a page lists with their places: Trending (src/recent/useRecent.ts) and a person's page
 * (src/person/usePersonReviews.ts). One home for the rule that a place the list has twice is one
 * place, and for the order such a list is in.
 */

/** One review, with the place on the list it is of. */
export interface ReviewedPlace {
  review: Review;
  place: Place;
}

/** Newest first; at the same time, the lowest id first. */
export const newestFirst = (a: { review: Review }, b: { review: Review }): number =>
  b.review.createdAt - a.review.createdAt || (a.review.id < b.review.id ? -1 : a.review.id > b.review.id ? 1 : 0);

/**
 * Those of `reviews` that are of places on the list, each with its place (`byAddress`, the places by
 * their addresses), newest first: one per reviewer per place, a reviewer's newest winning. One place
 * filed twice (the same OSM id under two addresses, brief § 4.3) is one place, and gives each reviewer
 * one review, with the filing that review was written for. A review of a place that is not on the
 * list is left out.
 */
export function reviewsOfListedPlaces(reviews: readonly Review[], byAddress: ReadonlyMap<string, Place>): ReviewedPlace[] {
  const byPlace = new Map<string, ReviewedPlace[]>();
  for (const review of reviews) {
    const place = byAddress.get(review.address);
    if (place === undefined) continue;
    const key = place.osmId === undefined ? place.address : `osm ${place.osmId}`;
    const reviewed = byPlace.get(key);
    if (reviewed === undefined) byPlace.set(key, [{ review, place }]);
    else reviewed.push({ review, place });
  }
  const kept: ReviewedPlace[] = [];
  for (const reviewed of byPlace.values()) {
    const placeOf = new Map(reviewed.map(({ review, place }) => [review.id, place]));
    for (const review of newestPerReviewer(reviewed.map(({ review }) => review))) {
      kept.push({ review, place: placeOf.get(review.id)! });
    }
  }
  return kept.sort(newestFirst);
}
