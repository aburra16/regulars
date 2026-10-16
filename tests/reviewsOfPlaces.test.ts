import { describe, expect, it } from "vitest";

import type { Place } from "../src/places/place";
import { newestFirst, reviewsOfListedPlaces } from "../src/reviews/ofPlaces";
import type { Review } from "../src/reviews/review";
import { hex64 } from "./support/events";

/*
 * Which reviews a list of them is, for a page that lists reviews with their places: Trending
 * (src/recent/useRecent.ts) and a person's page (src/person/usePersonReviews.ts) share the rule that
 * a place the list has twice is one place (brief § 4.3), and the order.
 */

const FILER = hex64("4");
const [ALICE, BOB] = [hex64("a"), hex64("b")];

let made = 0;
/** A place on the list at `d`, the same place as any other with its `osmId`. */
const place = (d: string, osmId?: string): Place => ({
  address: `39999:${FILER}:${d}`,
  d,
  pubkey: FILER,
  name: d,
  category: "cafe",
  lat: 32.65,
  lon: -16.9,
  geohash: "eswd6m7xd",
  keywords: [],
  createdAt: 1_700_000_000,
  ...(osmId === undefined ? {} : { osmId }),
});
/** `reviewer`'s review of `of`, written at `createdAt`; `id` when the test minds which is lower. */
const review = (reviewer: string, of: Place | string, createdAt: number, id?: string): Review => {
  const address = typeof of === "string" ? of : of.address;
  made += 1;
  return {
    id: id ?? made.toString(16).padStart(64, "0"),
    reviewer,
    address,
    d: `place:${address}`,
    stars: 4,
    text: "",
    photos: [],
    price: null,
    paid: null,
    createdAt,
  };
};
const listOf = (...places: Place[]) => new Map(places.map((each) => [each.address, each]));

describe("the reviews of places on the list", () => {
  it("are each given with their place, and those of places that are not on the list are left out", () => {
    const cafe = place("cafe");
    const bar = place("bar");
    const ofCafe = review(ALICE, cafe, 300);
    const ofBar = review(ALICE, bar, 200);
    const ofGone = review(ALICE, `39999:${FILER}:gone`, 400);

    expect(reviewsOfListedPlaces([ofBar, ofGone, ofCafe], listOf(cafe, bar))).toEqual([
      { review: ofCafe, place: cafe },
      { review: ofBar, place: bar },
    ]);
  });

  it("are one for each reviewer of a place: two people's reviews of it are both there", () => {
    const cafe = place("cafe");
    const alices = review(ALICE, cafe, 300);
    const bobs = review(BOB, cafe, 200);

    expect(reviewsOfListedPlaces([bobs, alices], listOf(cafe)).map(({ review: each }) => each)).toEqual([alices, bobs]);
  });

  it("take a place the list has twice for one place: each reviewer's newest review of it, with the filing it was written for", () => {
    const first = place("cafe", "node/1");
    const again = place("cafe-again", "node/1");
    const other = place("bar", "node/2");
    const alicesOld = review(ALICE, first, 100);
    const alicesNew = review(ALICE, again, 500);
    const bobs = review(BOB, first, 300);
    const alicesBar = review(ALICE, other, 200);

    expect(reviewsOfListedPlaces([alicesOld, bobs, alicesBar, alicesNew], listOf(first, again, other))).toEqual([
      { review: alicesNew, place: again },
      { review: bobs, place: first },
      { review: alicesBar, place: other },
    ]);
  });

  it("keep two places that have no map id apart, whatever else they share", () => {
    const one = place("one");
    const two = place("two");
    const ofOne = review(ALICE, one, 100);
    const ofTwo = review(ALICE, two, 200);

    expect(reviewsOfListedPlaces([ofOne, ofTwo], listOf(one, two)).map(({ place: each }) => each)).toEqual([two, one]);
  });

  it("are newest first, and of two written in the same second the one with the lower id first", () => {
    const [a, b, c] = [place("a"), place("b"), place("c")];
    const high = review(ALICE, a, 200, "f".repeat(64));
    const low = review(ALICE, b, 200, "1".repeat(64));
    const newest = review(ALICE, c, 201);

    const listed = reviewsOfListedPlaces([high, low, newest], listOf(a, b, c));
    expect(listed.map(({ review: each }) => each)).toEqual([newest, low, high]);
    expect([...listed].reverse().sort(newestFirst)).toEqual(listed);
  });

  it("are none when there are no reviews, or no places", () => {
    const cafe = place("cafe");
    expect(reviewsOfListedPlaces([], listOf(cafe))).toEqual([]);
    expect(reviewsOfListedPlaces([review(ALICE, cafe, 100)], new Map())).toEqual([]);
  });
});
