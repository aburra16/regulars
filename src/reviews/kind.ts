/*
 * What reviews and their removals both go by: the review's kind, and how far ahead of the device's
 * clock one may be dated. It imports nothing, so ./review.ts and ./removals.ts each read it without
 * reading the other's code.
 */

/** The event kind of a review: a rating of a thing, from nostr-protocol/nips PR #1914 (brief § 4). */
export const REVIEW_KIND = 34259;

/**
 * How far ahead of the device's clock a review may be written, in seconds: a day, for clocks that are
 * off. A removal of one may be too (`countsAsRemoval`, ./removals.ts).
 */
export const FUTURE_SLACK_S = 86_400;
