/**
 * Where Explore is in the history, for the search page's back arrow to go back to.
 *
 * The router keeps the position of each entry of the history as `idx` in `window.history.state`.
 * Explore records its own whenever it is on screen, so when it is left for the search (its field,
 * or anything else) the last one recorded is the entry that was left, with its chip, its depth and
 * its scroll position as they were. The arrow jumps back to that entry in one step, however many
 * steps the search has taken since (the filters, a chip taken off, words searched for).
 *
 * It is a variable of the page and no more: a page that is reloaded has none, and its arrow goes to
 * Explore as a new step.
 */
let exploreIdx: number | undefined;

/** Records the position of the entry Explore is at. Anything but a number (a router that keeps none) is no position. */
export function setExploreIdx(idx: unknown): void {
  exploreIdx = typeof idx === "number" ? idx : undefined;
}

/** Forgets it, as a reload does. */
export function forgetExploreIdx(): void {
  exploreIdx = undefined;
}

/**
 * How many steps back from the entry the history is at now (a negative number, for `navigate`) is the
 * Explore that was recorded; nothing when none was, or when it is not behind this entry.
 */
export function stepsBackToExplore(): number | undefined {
  const current: unknown = window.history.state?.idx;
  if (exploreIdx === undefined || typeof current !== "number" || exploreIdx >= current) return undefined;
  return exploreIdx - current;
}
