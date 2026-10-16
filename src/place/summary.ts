import { isHttpsUrl, PAID_WAYS, type Paid, type Price, type Review } from "../reviews/review.ts";

/*
 * What a place's page sums from the reviews it is given, the reviews inside the view: the price most
 * of them give, the ways they say people paid, and the photos of the strip under the place's name.
 * Which reviews those are is the page's to say.
 */

/** How many times each value among `values` is given, leaving out null. */
function tally<T>(values: readonly (T | null)[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * The price most of `reviews` give, and how many of them give one (`from`), as Brainstorm-UI's
 * `priceSummary` (`client/src/lib/placeReviews.ts`) sums it, so both apps show the same: of two prices
 * given as often, the lower. Null when none gives a price.
 */
export function priceOf(reviews: readonly Review[]): { price: Price; from: number } | null {
  const counts = tally(reviews.map((review) => review.price));
  const [top] = [...counts].sort(([a, m], [b, n]) => n - m || a - b);
  if (top === undefined) return null;
  return { price: top[0], from: [...counts.values()].reduce((sum, n) => sum + n, 0) };
}

/**
 * The ways `reviews` say people paid, each once, the commonest first; of two said as often, the one
 * first in `PAID_WAYS` (Lightning, On-chain, Card, Cash). Empty when none says.
 */
export function paidWays(reviews: readonly Review[]): Paid[] {
  const counts = tally(reviews.map((review) => review.paid));
  // A sort keeps the order of two that compare the same, which is PAID_WAYS'.
  return PAID_WAYS.filter((way) => counts.has(way)).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}

/** The most photos the strip under a place's name shows. */
export const STRIP_MAX = 12;

/** Newest first; at the same time, the lowest id first, as `isNewer` orders them. */
const newestFirst = (a: Review, b: Review) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The photos of the strip under a place's name: the place's own `placeImage` first, when it is at an
 * `https:` address (`isHttpsUrl`), then the photos of `reviews`, the newest review's first and each
 * review's in its order. Each address once, and at most `STRIP_MAX`. Empty when there are none.
 */
export function stripPhotos(placeImage: string | undefined, reviews: readonly Review[]): string[] {
  const photos = new Set<string>();
  if (placeImage !== undefined && isHttpsUrl(placeImage)) photos.add(placeImage);
  for (const review of [...reviews].sort(newestFirst)) for (const photo of review.photos) photos.add(photo);
  return [...photos].slice(0, STRIP_MAX);
}
