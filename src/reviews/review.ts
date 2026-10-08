import type { NostrEvent } from "@nostrify/nostrify";

import { isHex64 } from "../nostr/shapes.ts";
import { asEvent, isNewer } from "../places/load.ts";
import { PLACE_KIND } from "../places/place.ts";

/** The event kind of a review: a rating of a thing, from nostr-protocol/nips PR #1914 (brief § 4). */
export const REVIEW_KIND = 34259;

/** One person's review of one place. */
export interface Review {
  /** The event's id. It changes each time the reviewer edits the review. */
  id: string;
  /** The reviewer's public key. */
  reviewer: string;
  /** The reviewed place's address, `39999:<pubkey>:<d>`. */
  address: string;
  /**
   * More than 0 and up to 5, not always whole (a rating of 0.9 is 4.5); null when the review gives
   * no stars it can be scored by.
   */
  stars: number | null;
  /** The written review. Empty for a review that is stars alone. */
  text: string;
  createdAt: number;
}

/**
 * Whether `text` is a place's address, as `parsePlace` makes them: `39999:<pubkey>:<d>`. The `d` may
 * hold colons of its own. A place's `d` is never blank (`parsePlace`), so here neither.
 */
function isPlaceAddress(text: string | undefined): text is string {
  const [kind, pubkey, ...d] = text?.split(":") ?? [];
  return kind === String(PLACE_KIND) && pubkey !== undefined && isHex64(pubkey) && d.join(":").trim() !== "";
}

/** The value of an event's first tag called `name`. */
const firstTag = (ev: NostrEvent, name: string) => ev.tags.find((tag) => tag[0] === name)?.[1];

/**
 * The stars in a review's tags, as Brainstorm-UI's `starsOf` reads them, so a review shows the same
 * stars here as there. An `s` tag of a whole number from 1 to 5 wins. Else the first `rating` with
 * no aspect (no third element), or failing that the first `rating`: from 0 to 1 it is a fraction of
 * five stars (so "1" is five stars), above 1 and up to 5 it is stars, and anything else is none.
 *
 * Numbers are read with `Number()`, as Brainstorm-UI reads them, so space around one is ignored:
 * an `s` of " 4 " is 4 stars.
 *
 * One departure: Brainstorm-UI reads a rating of 0 as 0 stars. A review is 1 to 5 stars (brief § 4),
 * so here 0 is no stars, and the review does not pull a score down.
 */
export function starsOf(tags: readonly string[][]): number | null {
  const s = Number(tags.find((tag) => tag[0] === "s")?.[1]);
  if (Number.isInteger(s) && s >= 1 && s <= 5) return s;

  const overall =
    tags.find((tag) => tag[0] === "rating" && tag[1] && !tag[2]) ?? tags.find((tag) => tag[0] === "rating");
  const raw = Number(overall?.[1]);
  if (!overall?.[1] || !Number.isFinite(raw) || raw < 0) return null;
  const stars = raw <= 1 ? raw * 5 : raw <= 5 ? raw : null;
  return stars === 0 ? null : stars;
}

/**
 * The review in `ev`, a well-formed event of the review kind, or null when it reviews no place. The
 * place is the `a` tag when that is a place's address, else the `d` tag (brief § 4.1).
 */
function reviewIn(ev: NostrEvent): Review | null {
  const a = firstTag(ev, "a");
  const address = isPlaceAddress(a) ? a : firstTag(ev, "d");
  if (!isPlaceAddress(address)) return null;
  return {
    id: ev.id,
    reviewer: ev.pubkey,
    address,
    stars: starsOf(ev.tags),
    text: ev.content,
    createdAt: ev.created_at,
  };
}

/** Reads a review from a relay's value, or returns null when it is not a well-formed review of a place. */
export function parseReview(value: unknown): Review | null {
  const ev = asEvent(value);
  return ev === null || ev.kind !== REVIEW_KIND ? null : reviewIn(ev);
}

/** A review's id and time, which `isNewer` compares. */
const stamp = (review: Review) => ({ id: review.id, created_at: review.createdAt });

/**
 * The reviews among `values`, which may come from several relays and be malformed: each person's
 * newest review of each place, and nothing else. A review a relay no longer sends is not here.
 *
 * First NIP-01's replacement: of a person's events at one `d`, only the newest stands (on a tie,
 * the lowest id), whatever it says. A relay that lags may still send the ones it replaced, such as
 * an older review of another place. Then each person's newest review of each place, for someone
 * who has reviewed one place under two `d` tags.
 */
export function latestReviews(values: readonly unknown[]): Review[] {
  const standing = new Map<string, NostrEvent>();
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || ev.kind !== REVIEW_KIND) continue;
    // A public key is 64 characters, so no two (pubkey, d) pairs make the same key.
    const key = `${ev.pubkey}${firstTag(ev, "d") ?? ""}`;
    const current = standing.get(key);
    if (current === undefined || isNewer(ev, current)) standing.set(key, ev);
  }

  const kept = new Map<string, Review>();
  for (const ev of standing.values()) {
    const review = reviewIn(ev);
    if (review === null) continue;
    const key = `${review.reviewer} ${review.address}`;
    const current = kept.get(key);
    if (current === undefined || isNewer(stamp(review), stamp(current))) kept.set(key, review);
  }
  return [...kept.values()];
}
