import type { NostrEvent } from "@nostrify/nostrify";

import { asEvent, isNewer } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { PLACE_KIND } from "../places/place.ts";
import { FUTURE_SLACK_S, REVIEW_KIND } from "./kind.ts";
import { countsAsRemoval, takesDown } from "./removals.ts";

export { REVIEW_KIND } from "./kind.ts";

/** One person's review of one place. */
export interface Review {
  /** The event's id. It changes each time the reviewer edits the review. */
  id: string;
  /** The reviewer's public key. */
  reviewer: string;
  /** The reviewed place's address, `39999:<pubkey>:<d>`. */
  address: string;
  /**
   * The review's own `d`, which with the reviewer names it (`34259:<reviewer>:<d>`), as a removal
   * must. Usually `place:` and the address (decision 17), but a review written elsewhere may hold the
   * bare address or anything else. Empty when the event has no `d` tag, as NIP-01 reads it.
   */
  d: string;
  /**
   * More than 0 and up to 5, not always whole (a rating of 0.9 is 4.5); null when the review gives
   * no stars it can be scored by.
   */
  stars: number | null;
  /**
   * The written review, without the addresses of the photos another app put after it (`wordsOf`).
   * Empty for a review that is stars alone, or stars and photos.
   */
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

/** What a review's `d` starts with, before the address of the place it reviews (decision 17). */
const PLACE_PREFIX = "place:";

/**
 * The `d` of a review of the place at `address`: `place:39999:<filer>:<d>`, after the existing 34259
 * convention of `<type>:<id>` (decision 17). One `d` per place, so a person's next review of it
 * replaces the last.
 */
export function reviewD(address: string): string {
  return `${PLACE_PREFIX}${address}`;
}

/**
 * The place a review's `d` names, if it names one: what follows `place:`, or the `d` itself. Not
 * checked to be a place's address.
 */
export function placeInD(d: string | undefined): string | undefined {
  return d?.startsWith(PLACE_PREFIX) ? d.slice(PLACE_PREFIX.length) : d;
}

/** The value of an event's first tag called `name`. */
const firstTag = (ev: NostrEvent, name: string) => ev.tags.find((tag) => tag[0] === name)?.[1];

/**
 * Whether `ev` was written more than a day ahead of the device's clock: no clock is that far off, so
 * its time is made up. It is dropped, as if it were not there: it would sort above every real review
 * as the newest, replace the reviewer's real one, and its date can't be shown (one far enough ahead is
 * past what a date can hold).
 */
const fromTheFuture = (ev: NostrEvent) => ev.created_at > Date.now() / 1000 + FUTURE_SLACK_S;

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

/** What a photo's address follows in an `imeta` tag's part that gives it (NIP-92). */
const URL_PART = "url ";

/**
 * The addresses of a review's photos, as Brainstorm-UI's `photosOf` (`client/src/lib/placeReviews.ts`)
 * finds them: of each `imeta` tag (NIP-92), the first part after its name that starts with `url `, the
 * rest of that part trimmed. Each once, in the order the tags give them; none that is empty. Regulars
 * draws no photo: it finds them to keep them out of the words (`wordsOf`), and in an edit (`reviewTemplate`).
 */
export function photosOf(tags: readonly (readonly string[])[]): string[] {
  const photos = new Set<string>();
  for (const [name, ...parts] of tags) {
    if (name !== "imeta") continue;
    const url = parts.find((part) => part.startsWith(URL_PART))?.slice(URL_PART.length).trim();
    if (url) photos.add(url);
  }
  return [...photos];
}

/**
 * A review's words: its `content` with every place each photo's address (`photosOf(tags)`) is in taken
 * out, then the spaces and tabs before a line break, then the space at the ends. Another app puts the
 * addresses after the words, each on a line of its own, as NIP-92 asks; this is how Brainstorm-UI reads
 * the words back (`readReview`), so both apps show the same words.
 */
export function wordsOf(content: string, tags: readonly (readonly string[])[]): string {
  let words = content;
  for (const url of photosOf(tags)) words = words.split(url).join("");
  return words.replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * The review in `ev`, a well-formed event of the review kind, or null when it reviews no place, or
 * was written more than a day ahead of the device's clock (`fromTheFuture`). The place is the `a` tag
 * when that is a place's address, else the `d` tag: the place's address, or `place:` and the address
 * (brief § 4.1, decisions 16 and 17). Reviews written either way are read.
 */
function reviewIn(ev: NostrEvent): Review | null {
  if (fromTheFuture(ev)) return null;
  const a = firstTag(ev, "a");
  const address = isPlaceAddress(a) ? a : placeInD(firstTag(ev, "d"));
  if (!isPlaceAddress(address)) return null;
  return {
    id: ev.id,
    reviewer: ev.pubkey,
    address,
    d: firstTag(ev, "d") ?? "",
    stars: starsOf(ev.tags),
    text: wordsOf(ev.content, ev.tags),
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
 * The reviews among `values`, which may come from several relays and be malformed, and may hold
 * removals (kind 5) beside them: each person's newest review of each place that no removal takes
 * down, and nothing else. A review a relay no longer sends is not here, nor one from the future
 * (`fromTheFuture`).
 *
 * First NIP-01's replacement: of a person's events at one `d`, only the newest stands (on a tie,
 * the lowest id), whatever it says. A relay that lags may still send the ones it replaced, such as
 * an older review of another place. Then each person's newest review of each place, for someone
 * who has reviewed one place under two `d` tags. Then each review a removal among `values` takes
 * down (`countsAsRemoval`, `takesDown`) is left out, as Brainstorm-UI's `standingReviews` leaves
 * them: an older version does not come back in its place, at its `d` or under another.
 */
export function latestReviews(values: readonly unknown[]): Review[] {
  const nowS = Date.now() / 1000;
  // Each author's removals: only a review's own author's can take it down (`takesDown`).
  const removalsBy = new Map<string, NostrEvent[]>();
  const standing = new Map<string, NostrEvent>();
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null) continue;
    if (countsAsRemoval(ev, nowS)) {
      const theirs = removalsBy.get(ev.pubkey);
      if (theirs === undefined) removalsBy.set(ev.pubkey, [ev]);
      else theirs.push(ev);
      continue;
    }
    // One from the future is not there: it must not replace the review it would be newer than.
    if (ev.kind !== REVIEW_KIND || fromTheFuture(ev)) continue;
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
  const reviews = [...kept.values()];
  if (removalsBy.size === 0) return reviews;
  return reviews.filter((review) => !(removalsBy.get(review.reviewer)?.some((removal) => takesDown(removal, review)) ?? false));
}

/**
 * One review per person among `reviews`: each one's newest (at the same time, the lowest id), in the
 * order their first review came. `latestReviews` keeps a person's reviews of two places apart, which
 * a place filed twice (the same OSM id under two addresses, brief § 4.3) needs undone: merged, its
 * reviews give each person one voice, the newest review winning.
 */
export function newestPerReviewer(reviews: readonly Review[]): Review[] {
  const kept = new Map<string, Review>();
  for (const review of reviews) {
    const current = kept.get(review.reviewer);
    if (current === undefined || isNewer(stamp(review), stamp(current))) kept.set(review.reviewer, review);
  }
  return [...kept.values()];
}
