import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import type { Paid, Price } from "../reviews/review.ts";

/**
 * The line under a review's stars that says what it gives of its price and how the reviewer paid:
 * "$$ · Paid with Lightning", "$$", or "Paid with Cash". Nothing when it gives neither. A screen reader
 * hears the price in words ("Price: 2 of 4"), never the signs one by one. `muted` draws it in the
 * folded box's dimmed look.
 */
export function PricePaid({ price, paid, muted = false }: { price: Price | null; paid: Paid | null; muted?: boolean }): JSX.Element | null {
  if (price === null && paid === null) return null;
  return (
    <p className={`m-0 text-secondary ${muted ? "text-muted" : "text-ink-soft"}`}>
      {price !== null && (
        <span role="img" aria-label={copy.price.spoken(price)}>
          {copy.price.signs(price)}
        </span>
      )}
      {price !== null && paid !== null && copy.common.joiner}
      {paid !== null && copy.reviews.paidWith(copy.paid[paid])}
    </p>
  );
}

/**
 * What the same line says, in words, for what a screen reader is told of a link it is inside, where
 * the signs' own words are not read out: "Price: 2 of 4 · Paid with Lightning", "Price: 2 of 4", or
 * "Paid with Cash". Empty when the review gives neither.
 */
export function pricePaidWords(price: Price | null, paid: Paid | null): string {
  const parts: string[] = [];
  if (price !== null) parts.push(copy.price.spoken(price));
  if (paid !== null) parts.push(copy.reviews.paidWith(copy.paid[paid]));
  return parts.join(copy.common.joiner);
}
