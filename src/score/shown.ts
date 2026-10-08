import type { Review } from "../reviews/review.ts";
import type { View } from "../view/ViewProvider.tsx";
import type { PlaceScore } from "./score.ts";
import type { ReadState, ViewState } from "./store.ts";

/**
 * What a place's score slot shows from the view on screen, House picks or My circle: on a card, a
 * row, a pin or its own page. It says how many people a score is made of, and never anything about
 * one of them (decision 19).
 *
 * - `none`: nobody has reviewed the place, or there are no review relays to read: M1's "No reviews yet".
 * - `reading`: its reviews are being read. Nothing is said yet, and never "No reviews yet".
 * - `failed`: no review relay answered for it: one quiet line, and a way to try again on its page.
 * - `pending`: it has reviews, and the view's scorer is still being asked about their reviewers. It
 *   has no score yet, and nobody is folded: nobody is outside the view before its scorer has said so.
 * - `scored`: `counted` people inside the view gave it stars; `score` is theirs, weighted.
 * - `unscored`: it has reviews, and no score: `starless` people inside the view reviewed it with no
 *   stars, and `others` people outside it rated it (the page folds theirs).
 * - `unavailable`: it has reviews by `reviewers` people, and the view can't be worked out: every
 *   review is folded, and nothing is scored from unweighted stars.
 *
 * The last three are from My circle when `circle` is set, and from House picks otherwise: the words
 * that go with them name the view. For the person signed in who has reviewed it (`seenBy`), `yours`
 * says so: on `unscored` and `unavailable`, they are not counted among `others`, `starless` or
 * `reviewers` (ruling R15); on a `scored` from My circle, they are one of the `counted` (all of them
 * when it is 1), and the words say so: "Rated by you", "You and 2 other people in your circle".
 */
export type ShownScore =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "failed" }
  | { kind: "pending" }
  | { kind: "scored"; score: number; counted: number; yours?: true; circle?: true }
  | { kind: "unscored"; others: number; starless: number; yours?: true; circle?: true }
  | { kind: "unavailable"; reviewers: number; yours?: true; circle?: true };

const NONE: ShownScore = { kind: "none" };
const READING: ShownScore = { kind: "reading" };
const FAILED: ShownScore = { kind: "failed" };
const PENDING: ShownScore = { kind: "pending" };

/**
 * What each score has shown, by its view and where that view stands: the same object for the same
 * score (the store keeps a place's score from each view the same object while nothing it is made of
 * changes), so a card given it need not be drawn again, and a toggle there and back gives it again.
 */
const shownFor = new WeakMap<PlaceScore, Map<`${View}:${ViewState}`, ShownScore>>();

function fromScore(score: PlaceScore, state: ViewState, view: View): ShownScore {
  const reviewers = score.inside.length + score.folded.length;
  if (reviewers === 0) return NONE;
  const circle = view === "circle" ? { circle: true as const } : {};
  if (state === "unavailable") return { kind: "unavailable", reviewers, ...circle };
  if (score.score !== null && score.counted > 0) return { kind: "scored", score: score.score, counted: score.counted, ...circle };
  return { kind: "unscored", others: score.outside, starless: score.inside.length, ...circle };
}

/**
 * What the slot of a place shows, from its score as the store gives it from `view` (undefined until
 * its reviews are read, and while its reviewers are ranked), whether it has reviews, where the view's
 * ranks stand, and where the reading of its reviews stands. The same object each time for the same
 * score, view and state, and for each state with no score.
 */
export function shownScore(
  score: PlaceScore | undefined,
  hasReviews: boolean,
  state: ViewState,
  read?: ReadState,
  view: View = "house",
): ShownScore {
  if (score === undefined) {
    if (hasReviews) return PENDING;
    if (read === "reading") return READING;
    if (read === "failed") return FAILED;
    return NONE;
  }
  let byView = shownFor.get(score);
  if (byView === undefined) {
    byView = new Map();
    shownFor.set(score, byView);
  }
  let shown = byView.get(`${view}:${state}`);
  if (shown === undefined) {
    shown = fromScore(score, state, view);
    byView.set(`${view}:${state}`, shown);
  }
  return shown;
}

/** What each slot has shown each person who wrote one of the place's reviews, by the review's id: the same object each time. */
const seenFor = new WeakMap<ShownScore, Map<string, ShownScore>>();

/** The review of `pubkey` among `score`'s, inside the view or folded; undefined for nobody, or none. */
export function reviewOf(score: PlaceScore | undefined, pubkey: string | undefined): Review | undefined {
  if (score === undefined || pubkey === undefined) return undefined;
  return score.inside.find((review) => review.reviewer === pubkey) ?? score.folded.find((review) => review.reviewer === pubkey);
}

/**
 * Whether `shown` is a score from My circle that counts `mine`: the person's own, which always counts
 * there with its stars (brief § 5), alone or beside others'.
 */
const countsMine = (shown: ShownScore, score: PlaceScore, mine: Review): shown is Extract<ShownScore, { kind: "scored" }> =>
  shown.kind === "scored" && shown.circle === true && mine.stars !== null && score.inside.some((review) => review.id === mine.id);

/**
 * What the slot shows the person who wrote `mine`, one of the place's reviews (`score`'s), on its own
 * page and on every list's card: "You've rated it" (`yours`), and the others counted without them
 * (rulings R15, R16). Not whether the view counts their review: they come off the count they are in,
 * inside the view with no stars, or outside, and the line says the same either way. In My circle,
 * where their review always counts, a score that counts it says so: theirs alone ("Rated by you"),
 * rather than "1 person in your circle", or theirs and others' ("You and 2 other people in your
 * circle"), rather than "3 people" (ruling R13). As it was, with no review of theirs, and for any
 * other place with a score, whose line counts no one as "other". The same object each time for the
 * same slot and review, so a card given it need not be drawn again.
 */
export function seenBy(shown: ShownScore, score: PlaceScore | undefined, mine: Review | undefined): ShownScore {
  if (mine === undefined || score === undefined) return shown;
  const theirs = countsMine(shown, score, mine);
  if (shown.kind !== "unscored" && shown.kind !== "unavailable" && !theirs) return shown;
  let byReview = seenFor.get(shown);
  if (byReview === undefined) {
    byReview = new Map();
    seenFor.set(shown, byReview);
  }
  let seen = byReview.get(mine.id);
  if (seen === undefined) {
    const isMine = (review: Review) => review.id === mine.id;
    if (shown.kind === "unscored") {
      seen = {
        ...shown,
        others: shown.others - (score.folded.some(isMine) ? 1 : 0),
        starless: shown.starless - (score.inside.some(isMine) ? 1 : 0),
        yours: true,
      };
    } else if (shown.kind === "unavailable") {
      seen = { ...shown, reviewers: shown.reviewers - 1, yours: true };
    } else if (shown.kind === "scored") {
      seen = { ...shown, yours: true };
    } else {
      return shown;
    }
    byReview.set(mine.id, seen);
  }
  return seen;
}
