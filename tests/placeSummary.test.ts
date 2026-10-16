import { describe, expect, it } from "vitest";

import { paidWays, priceOf, STRIP_MAX, stripPhotos } from "../src/place/summary";
import type { Paid, Price, Review } from "../src/reviews/review";
import { hex64 } from "./support/events";

/*
 * What a place's page sums from the reviews inside the view: the price most of them give, the ways
 * they say people paid, and the photos of the strip under the place's name. Which reviews are inside
 * the view is the page's to say; these take the reviews they are given.
 */

const PLACE = `39999:${hex64("4")}:osm-way-993221389`;
const PLACE_IMAGE = "https://place.example/p.jpg";
const photo = (name: string) => `https://blossom.example/${name}.jpg`;

let made = 0;

/** A review of `PLACE` by someone new each time, with `fields` over it, each one newer than the last. */
function reviewWith(fields: Partial<Review> = {}): Review {
  made += 1;
  return {
    id: made.toString(16).padStart(64, "0"),
    reviewer: made.toString(16).padStart(64, "a"),
    address: PLACE,
    d: `place:${PLACE}`,
    stars: 4,
    text: "",
    photos: [],
    price: null,
    paid: null,
    createdAt: 1_700_000_000 + made,
    ...fields,
  };
}

const pricing = (...prices: (Price | null)[]) => prices.map((price) => reviewWith({ price }));
const paying = (...ways: (Paid | null)[]) => ways.map((paid) => reviewWith({ paid }));

describe("priceOf: the price most of the reviews give, as Brainstorm-UI's priceSummary sums it", () => {
  it("gives the price most of them give, and how many give one", () => {
    expect(priceOf(pricing(2, 2, 3))).toEqual({ price: 2, from: 3 });
    expect(priceOf(pricing(4))).toEqual({ price: 4, from: 1 });
  });

  it("gives the lower of two prices given as often", () => {
    expect(priceOf(pricing(1, 3))).toEqual({ price: 1, from: 2 });
    expect(priceOf(pricing(4, 3, 3, 4))).toEqual({ price: 3, from: 4 });
  });

  it("counts only the reviews that give a price", () => {
    expect(priceOf(pricing(null, 3, null, 2, 3))).toEqual({ price: 3, from: 3 });
  });

  it("gives nothing when none of them gives a price", () => {
    expect(priceOf(pricing(null, null))).toBeNull();
    expect(priceOf([])).toBeNull();
  });
});

describe("paidWays: the ways the reviews say people paid", () => {
  it("gives each way once, the commonest first", () => {
    expect(paidWays(paying("cash", "lightning", "lightning", "card", "card", "card"))).toEqual(["card", "lightning", "cash"]);
  });

  it("gives ways said as often in the order Lightning, On-chain, Card, Cash", () => {
    expect(paidWays(paying("card", "onchain"))).toEqual(["onchain", "card"]);
    expect(paidWays(paying("cash", "lightning", "lightning", "card"))).toEqual(["lightning", "card", "cash"]);
    expect(paidWays(paying("cash", "card", "onchain", "lightning"))).toEqual(["lightning", "onchain", "card", "cash"]);
  });

  it("passes over the reviews that do not say, and gives none when none says", () => {
    expect(paidWays(paying(null, "cash", null))).toEqual(["cash"]);
    expect(paidWays(paying(null))).toEqual([]);
    expect(paidWays([])).toEqual([]);
  });
});

describe("stripPhotos: the photos under the place's name", () => {
  it("puts the place's own first, then the newest review's, each address once", () => {
    const [a, b, c] = [photo("a"), photo("b"), photo("c")];
    const older = reviewWith({ photos: [a, b], createdAt: 1_700_000_000 });
    const newer = reviewWith({ photos: [c, a], createdAt: 1_700_000_100 });
    expect(stripPhotos(PLACE_IMAGE, [older, newer])).toEqual([PLACE_IMAGE, c, a, b]);
    expect(stripPhotos(PLACE_IMAGE, [newer, older])).toEqual([PLACE_IMAGE, c, a, b]);
  });

  it("puts the review with the lower id first of two written in the same second", () => {
    const low = reviewWith({ id: hex64("1"), photos: [photo("low")], createdAt: 1_700_000_000 });
    const high = reviewWith({ id: hex64("2"), photos: [photo("high")], createdAt: 1_700_000_000 });
    expect(stripPhotos(undefined, [high, low])).toEqual([photo("low"), photo("high")]);
  });

  it("stops at 12", () => {
    expect(STRIP_MAX).toBe(12);
    const reviews = Array.from({ length: 20 }, (_, i) => reviewWith({ photos: [photo(`${i}-1`), photo(`${i}-2`), photo(`${i}-3`)] }));
    const strip = stripPhotos(undefined, reviews);
    expect(strip).toHaveLength(12);
    // The newest four reviews' photos.
    expect(strip.slice(0, 3)).toEqual([photo("19-1"), photo("19-2"), photo("19-3")]);
    expect(strip.at(-1)).toBe(photo("16-3"));
    expect(stripPhotos(PLACE_IMAGE, reviews)).toHaveLength(12);
    expect(stripPhotos(PLACE_IMAGE, reviews)[0]).toBe(PLACE_IMAGE);
  });

  it("leaves out a place's own image at an address that is not https", () => {
    const review = reviewWith({ photos: [photo("a")] });
    for (const image of ["http://place.example/p.jpg", "javascript:alert(1)", "data:image/png;base64,AA==", "p.jpg"]) {
      expect(stripPhotos(image, [review]), image).toEqual([photo("a")]);
    }
  });

  it("gives the place's own image alone when no review has a photo, and nothing when neither has one", () => {
    expect(stripPhotos(PLACE_IMAGE, [reviewWith()])).toEqual([PLACE_IMAGE]);
    expect(stripPhotos(undefined, [reviewWith(), reviewWith()])).toEqual([]);
    expect(stripPhotos(undefined, [])).toEqual([]);
  });

  it("gives the place's own image once, when a review has the same photo", () => {
    expect(stripPhotos(PLACE_IMAGE, [reviewWith({ photos: [photo("a"), PLACE_IMAGE] })])).toEqual([PLACE_IMAGE, photo("a")]);
  });
});
