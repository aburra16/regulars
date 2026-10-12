import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import type { Review } from "../src/reviews/review";
import { formatScore, scorePlace } from "../src/score/score";
import { hex64 } from "./support/events";

const PLACE = `39999:${hex64("4")}:osm-way-993221389`;
const [ANA, BEN, CAT, DAN, EVA] = ["a", "b", "c", "d", "e"].map(hex64) as [string, string, string, string, string];

let made = 0;

/** `reviewer`'s review of `PLACE` with `stars`. */
function reviewBy(reviewer: string, stars: number | null): Review {
  made += 1;
  return {
    id: made.toString(16).padStart(64, "0"),
    reviewer,
    address: PLACE,
    d: `place:${PLACE}`,
    stars,
    text: stars === null ? "Lovely terrace." : "",
    createdAt: 1_700_000_000 + made,
  };
}

/** A point of view: the given weights, and 0 for everyone else. */
const weights =
  (byReviewer: Record<string, number>) =>
  (pubkey: string): number =>
    byReviewer[pubkey] ?? 0;

/** The house's prior: 1.5 votes of 3.5 stars. */
const prior = config.scoring;

describe("scorePlace", () => {
  it("weighs each person's stars by how much they count: 0.8 for 5 and 0.2 for 3 is 4.6", () => {
    const ana = reviewBy(ANA, 5);
    const ben = reviewBy(BEN, 3);
    const result = scorePlace([ana, ben], weights({ [ANA]: 0.8, [BEN]: 0.2 }), prior);
    expect(result.score).toBeCloseTo(4.6, 10);
    expect(result.counted).toBe(2);
    expect(result.outside).toBe(0);
    expect(result.inside).toEqual([ana, ben]);
    expect(result.folded).toEqual([]);
  });

  it("lists a review with no stars by someone inside the view, but leaves it out of the score", () => {
    const ana = reviewBy(ANA, 5);
    const ben = reviewBy(BEN, null);
    const result = scorePlace([ana, ben], weights({ [ANA]: 0.8, [BEN]: 0.5 }), prior);
    expect(result.score).toBe(5);
    expect(result.counted).toBe(1);
    expect(result.inside).toEqual([ana, ben]);
    expect(result.folded).toEqual([]);
  });

  it("has no score when the only reviews inside the view have no stars", () => {
    const result = scorePlace([reviewBy(ANA, null)], weights({ [ANA]: 0.8 }), prior);
    expect(result.score).toBeNull();
    expect(result.counted).toBe(0);
    expect(result.inside).toHaveLength(1);
    expect(result.orderKey).toBe(3.5);
  });

  it("folds away the reviews of people who count for nothing, and keeps them", () => {
    const ana = reviewBy(ANA, 5);
    const ben = reviewBy(BEN, 1);
    const cat = reviewBy(CAT, 2);
    const result = scorePlace([ana, ben, cat], weights({ [ANA]: 0.8, [BEN]: 0 }), prior);
    expect(result.score).toBe(5);
    expect(result.counted).toBe(1);
    expect(result.inside).toEqual([ana]);
    expect(result.folded).toEqual([ben, cat]);
    expect(result.outside).toBe(2);
  });

  it("has no score, and folds every review, when nobody counts (the ranks have not come)", () => {
    const reviews = [reviewBy(ANA, 5), reviewBy(BEN, 4)];
    const result = scorePlace(reviews, () => 0, prior);
    expect(result).toEqual({ score: null, counted: 0, outside: 2, orderKey: 3.5, inside: [], folded: reviews });
  });

  it("folds a review whose weight is not a positive number, with no NaN anywhere", () => {
    const reviews = [reviewBy(ANA, 5), reviewBy(BEN, 4), reviewBy(CAT, 3)];
    const result = scorePlace(reviews, weights({ [ANA]: Number.NaN, [BEN]: -0.5, [CAT]: Infinity }), prior);
    expect(result.folded).toEqual(reviews);
    expect(result.score).toBeNull();
    expect(result.orderKey).toBe(3.5);
  });

  it("has no score, nothing counted, nothing outside and the prior's 3.5 to order by, with no reviews", () => {
    expect(scorePlace([], weights({}), prior)).toEqual({
      score: null,
      counted: 0,
      outside: 0,
      orderKey: 3.5,
      inside: [],
      folded: [],
    });
  });

  it("orders one 5 from one person below 4.4 from five people", () => {
    const one = scorePlace([reviewBy(ANA, 5)], weights({ [ANA]: 1 }), prior);
    expect(one.score).toBe(5);
    expect(one.orderKey).toBeCloseTo((5 + 1.5 * 3.5) / (1 + 1.5), 10);
    expect(one.orderKey).toBeCloseTo(4.1, 10);

    const everyone = weights({ [ANA]: 1, [BEN]: 1, [CAT]: 1, [DAN]: 1, [EVA]: 1 });
    const stars = [5, 5, 4, 4, 4];
    const five = scorePlace(
      [ANA, BEN, CAT, DAN, EVA].map((who, i) => reviewBy(who, stars[i]!)),
      everyone,
      prior,
    );
    expect(five.score).toBeCloseTo(4.4, 10);
    expect(one.orderKey).toBeLessThan(five.orderKey);
  });

  it("orders by the reviews inside the view alone", () => {
    const counted = [reviewBy(ANA, 4)];
    const view = weights({ [ANA]: 0.6 });
    const without = scorePlace(counted, view, prior);
    const withOutsiders = scorePlace([...counted, reviewBy(BEN, 1), reviewBy(CAT, 1)], view, prior);
    expect(withOutsiders.orderKey).toBe(without.orderKey);
  });

  it("orders by the plain score, and an unreviewed place by the prior's mean, when the prior weighs nothing", () => {
    const noPrior = { priorWeight: 0, priorMean: 3.5 };
    expect(scorePlace([reviewBy(ANA, 4)], weights({ [ANA]: 0.6 }), noPrior).orderKey).toBeCloseTo(4, 10);
    expect(scorePlace([], weights({}), noPrior).orderKey).toBe(3.5);
  });
});

describe("formatScore", () => {
  it("writes a score with one decimal, in Latin digits", () => {
    expect(formatScore(4.4545)).toBe("4.5");
    expect(formatScore(4)).toBe("4.0");
    expect(formatScore(5)).toBe("5.0");
    expect(formatScore(4.6000000000000005)).toBe("4.6");
    expect(formatScore((0.8 * 5 + 0.3 * 3) / 1.1)).toBe("4.5");
  });
});
