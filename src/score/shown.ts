import type { Review } from "../reviews/review.ts";
import type { PlaceScore } from "./score.ts";
import type { HouseState, ReadState } from "./store.ts";

/**
 * What a place's score slot shows from the house's view: on a card, a row, a pin or its own page.
 * It says how many people a score is made of, and never anything about one of them (decision 19).
 *
 * - `none`: nobody has reviewed the place, or there are no review relays to read: M1's "No reviews yet".
 * - `reading`: its reviews are being read. Nothing is said yet, and never "No reviews yet".
 * - `failed`: no review relay answered for it: one quiet line, and a way to try again on its page.
 * - `pending`: it has reviews, and the house is still being asked about their reviewers. It has no
 *   score yet, and nobody is folded: nobody is outside House picks before the house has said so.
 * - `scored`: `counted` people inside House picks gave it stars; `score` is theirs, weighted.
 * - `unscored`: it has reviews, and no score: `starless` people inside House picks reviewed it with
 *   no stars, and `others` people outside House picks rated it (the page folds theirs).
 * - `unavailable`: it has reviews by `reviewers` people, and House picks can't be worked out: every
 *   review is folded, and nothing is scored from unweighted stars.
 *
 * On the place's own page, for the person signed in who has reviewed it (`seenBy`), `yours` says so,
 * and they are not counted among `others`, `starless` or `reviewers` (ruling R15).
 */
export type ShownScore =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "failed" }
  | { kind: "pending" }
  | { kind: "scored"; score: number; counted: number }
  | { kind: "unscored"; others: number; starless: number; yours?: true }
  | { kind: "unavailable"; reviewers: number; yours?: true };

const NONE: ShownScore = { kind: "none" };
const READING: ShownScore = { kind: "reading" };
const FAILED: ShownScore = { kind: "failed" };
const PENDING: ShownScore = { kind: "pending" };

/**
 * What each score has shown, by the house's state: the same object for the same score (the store
 * keeps a place's score the same object while nothing it is made of changes), so a card given it
 * need not be drawn again.
 */
const shownFor = new WeakMap<PlaceScore, Map<HouseState, ShownScore>>();

function fromScore(score: PlaceScore, house: HouseState): ShownScore {
  const reviewers = score.inside.length + score.folded.length;
  if (reviewers === 0) return NONE;
  if (house === "unavailable") return { kind: "unavailable", reviewers };
  if (score.score !== null && score.counted > 0) return { kind: "scored", score: score.score, counted: score.counted };
  return { kind: "unscored", others: score.outside, starless: score.inside.length };
}

/**
 * What the slot of a place shows, from its score as the store gives it (undefined until its reviews
 * are read, and while its reviewers are ranked), whether it has reviews, where the house's view
 * stands, and where the reading of its reviews stands. The same object each time for the same score
 * and house, and for each state with no score.
 */
export function shownScore(
  score: PlaceScore | undefined,
  hasReviews: boolean,
  house: HouseState,
  read?: ReadState,
): ShownScore {
  if (score === undefined) {
    if (hasReviews) return PENDING;
    if (read === "reading") return READING;
    if (read === "failed") return FAILED;
    return NONE;
  }
  let byHouse = shownFor.get(score);
  if (byHouse === undefined) {
    byHouse = new Map();
    shownFor.set(score, byHouse);
  }
  let shown = byHouse.get(house);
  if (shown === undefined) {
    shown = fromScore(score, house);
    byHouse.set(house, shown);
  }
  return shown;
}

/** What each slot has shown each person who wrote one of the place's reviews, by the review's id: the same object each time. */
const seenFor = new WeakMap<ShownScore, Map<string, ShownScore>>();

/** The review of `pubkey` among `score`'s, inside House picks or folded; undefined for nobody, or none. */
export function reviewOf(score: PlaceScore | undefined, pubkey: string | undefined): Review | undefined {
  if (score === undefined || pubkey === undefined) return undefined;
  return score.inside.find((review) => review.reviewer === pubkey) ?? score.folded.find((review) => review.reviewer === pubkey);
}

/**
 * What the slot shows the person who wrote `mine`, one of the place's reviews (`score`'s), on its own
 * page and on every list's card: "You've rated it" (`yours`), and the others counted without them
 * (rulings R15, R16). Not whether the house counts their review: they come off the count they are in,
 * inside House picks with no stars, or outside, and the line says the same either way. As it was, with
 * no review of theirs, and for a place with a score, whose line counts no one as "other". The same
 * object each time for the same slot and review, so a card given it need not be drawn again.
 */
export function seenBy(shown: ShownScore, score: PlaceScore | undefined, mine: Review | undefined): ShownScore {
  if (mine === undefined || score === undefined || (shown.kind !== "unscored" && shown.kind !== "unavailable")) return shown;
  let byReview = seenFor.get(shown);
  if (byReview === undefined) {
    byReview = new Map();
    seenFor.set(shown, byReview);
  }
  let seen = byReview.get(mine.id);
  if (seen === undefined) {
    const isMine = (review: Review) => review.id === mine.id;
    seen =
      shown.kind === "unscored"
        ? {
            kind: "unscored",
            others: shown.others - (score.folded.some(isMine) ? 1 : 0),
            starless: shown.starless - (score.inside.some(isMine) ? 1 : 0),
            yours: true,
          }
        : { kind: "unavailable", reviewers: shown.reviewers - 1, yours: true };
    byReview.set(mine.id, seen);
  }
  return seen;
}
