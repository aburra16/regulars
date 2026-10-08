import type { PlaceScore } from "./score.ts";
import type { HouseState } from "./store.ts";

/**
 * What a place's score slot shows from the house's view: on a card, a row, a pin or its own page.
 * It says how many people a score is made of, and never anything about one of them (decision 19).
 *
 * - `none`: nobody has reviewed the place, or its reviews have not been read: M1's "No reviews yet".
 * - `pending`: it has reviews, and the house is still being asked about their reviewers. It has no
 *   score yet, and nobody is folded: nobody is outside House picks before the house has said so.
 * - `scored`: `counted` people inside House picks gave it stars; `score` is theirs, weighted.
 * - `unscored`: it has reviews, and none by people inside House picks with stars; `others` of them
 *   are by people outside, which the page folds.
 * - `unavailable`: it has reviews by `reviewers` people, and House picks can't be worked out: every
 *   review is folded, and nothing is scored from unweighted stars.
 */
export type ShownScore =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "scored"; score: number; counted: number }
  | { kind: "unscored"; others: number }
  | { kind: "unavailable"; reviewers: number };

const NONE: ShownScore = { kind: "none" };
const PENDING: ShownScore = { kind: "pending" };

/**
 * What the slot of a place shows, from its score as the store gives it (undefined until its reviews
 * are read, and while its reviewers are ranked), whether it has reviews, and where the house's view
 * stands.
 */
export function shownScore(score: PlaceScore | undefined, hasReviews: boolean, house: HouseState): ShownScore {
  if (score === undefined) return hasReviews ? PENDING : NONE;
  const reviewers = score.inside.length + score.folded.length;
  if (reviewers === 0) return NONE;
  if (house === "unavailable") return { kind: "unavailable", reviewers };
  if (score.score !== null && score.counted > 0) return { kind: "scored", score: score.score, counted: score.counted };
  return { kind: "unscored", others: score.outside };
}
