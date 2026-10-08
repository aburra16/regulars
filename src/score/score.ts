import type { Review } from "../reviews/review.ts";

/** A place's score from one point of view. Worked out when it is shown, and never stored (brief § 5). */
export interface PlaceScore {
  /** Σ weight × stars / Σ weight over the counted reviews; null when none is counted. */
  score: number | null;
  /** How many reviews the score is made of: by people inside the view, with stars. */
  counted: number;
  /** How many reviews are by people outside the view: the length of `folded`. */
  outside: number;
  /**
   * For ordering a list, never shown: the score drawn toward the prior's mean as if the prior's
   * weight of votes had been cast too, so that one five-star review does not top the list.
   */
  orderKey: number;
  /** The reviews by people inside the view, with stars or not, in the order given. */
  inside: Review[];
  /** The reviews by people outside the view, in the order given: folded away, never dropped. */
  folded: Review[];
}

/**
 * Scores one place's `reviews`, one per person (`latestReviews`), from the point of view that
 * `weight` gives: how much each reviewer counts, from 0 to 1. A review by someone who counts for
 * nothing is folded. One with no stars is listed but does not enter the score.
 */
export function scorePlace(
  reviews: readonly Review[],
  weight: (pubkey: string) => number,
  prior: { priorWeight: number; priorMean: number },
): PlaceScore {
  const inside: Review[] = [];
  const folded: Review[] = [];
  let weightedStars = 0;
  let totalWeight = 0;
  let counted = 0;

  for (const review of reviews) {
    const w = weight(review.reviewer);
    // Anything but a positive, finite weight is outside the view, NaN included.
    if (!(Number.isFinite(w) && w > 0)) {
      folded.push(review);
      continue;
    }
    inside.push(review);
    if (review.stars === null) continue;
    weightedStars += w * review.stars;
    totalWeight += w;
    counted += 1;
  }

  // With no prior and nothing counted there is nothing to divide by: order by the prior's mean.
  const orderWeight = totalWeight + prior.priorWeight;
  return {
    score: counted > 0 ? weightedStars / totalWeight : null,
    counted,
    outside: folded.length,
    orderKey:
      orderWeight > 0 ? (weightedStars + prior.priorWeight * prior.priorMean) / orderWeight : prior.priorMean,
    inside,
    folded,
  };
}

/** A score as it is shown: one decimal, in Latin digits whatever the language ("4.5", "4.0"). */
export function formatScore(score: number): string {
  return score.toFixed(1);
}
