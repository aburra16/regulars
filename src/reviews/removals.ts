import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { EventDeletion } from "nostr-tools/kinds";

import { asEvent } from "../nostr/events.ts";
import { FUTURE_SLACK_S, REVIEW_KIND } from "./kind.ts";
import type { Review } from "./review.ts";

/*
 * Removals of reviews (NIP-09, kind 5), as both apps read them, as Brainstorm-UI's `removes` reads one
 * (`client/src/lib/placeReviews.ts`): which count, what each takes down, and how to ask a relay for the
 * removals of the reviews it sent. Reading them is the readers' and the pages' (src/score/store.ts,
 * src/person/reviewsRead.ts, src/recent/feed.ts); a review a removal takes down is left out where
 * reviews are worked out (`latestReviews`). The removal Regulars signs is `removalTemplate`
 * (./write.ts).
 */

/** The most review ids, or reviews' addresses, one request for removals names. */
export const REMOVAL_BATCH = 100;

/** The most removals one request asks for. */
export const REMOVAL_LIMIT = 500;

/**
 * How many requests for removals a relay is sent at once by one reader of them (the scores store's
 * batch, a person's page, Trending): two, as a batch's reviews are asked for (by `a` and by `d`). The
 * rest follow as those are answered (`removalsFrom`).
 */
export const REMOVAL_REQUESTS_AT_ONCE = 2;

/**
 * Whether `ev` is a removal that counts, read at `nowS` (seconds since the epoch, the device's clock):
 * kind 5, and not dated more than a day ahead, as a review may not be (`FUTURE_SLACK_S`). One dated a
 * year ahead would otherwise take down every review its author writes until then. Its author, and
 * what it names, are for `takesDown` to say; its signature is checked by the reader that read it.
 */
export function countsAsRemoval(ev: NostrEvent, nowS: number): boolean {
  return ev.kind === EventDeletion && ev.created_at <= nowS + FUTURE_SLACK_S;
}

/**
 * Whether `removal` takes `review` down: it is by the review's own author, and names the review by its
 * id (`e`), even with no `a` beside it, or by its address (`a`, `34259:<reviewer>:<d>`) when the review
 * is dated no later than the removal. A review written after it, at the same `d`, stands.
 */
export function takesDown(removal: NostrEvent, review: Pick<Review, "id" | "reviewer" | "d" | "createdAt">): boolean {
  if (removal.pubkey !== review.reviewer) return false;
  const address = `${REVIEW_KIND}:${review.reviewer}:${review.d}`;
  return removal.tags.some(
    ([name, value]) => (name === "e" && value === review.id) || (name === "a" && value === address && review.createdAt <= removal.created_at),
  );
}

/**
 * Holds in `held`, by id, each removal among `values` (what relays sent, unchecked in shape) that
 * counts at `nowS` (`countsAsRemoval`). Whether any was not held before.
 */
export function holdRemovals(held: Map<string, NostrEvent>, values: Iterable<unknown>, nowS: number): boolean {
  let added = false;
  for (const value of values) {
    const ev = asEvent(value);
    if (ev === null || held.has(ev.id) || !countsAsRemoval(ev, nowS)) continue;
    held.set(ev.id, ev);
    added = true;
  }
  return added;
}

/** `items` in runs of at most `size`, in order. */
function runsOf<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) runs.push(items.slice(start, start + size));
  return runs;
}

/**
 * Everything one relay sends for `filters` (`removalFilters`), each read with `read`,
 * `REMOVAL_REQUESTS_AT_ONCE` at a time, the next run once the last is answered. Throws as `read` does:
 * a relay that fails one of them gives none.
 */
export async function removalsFrom(
  filters: readonly NostrFilter[],
  read: (filter: NostrFilter) => Promise<unknown[]>,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const run of runsOf(filters, REMOVAL_REQUESTS_AT_ONCE)) {
    for (const sent of await Promise.all(run.map(read))) values.push(...sent);
  }
  return values;
}

/**
 * What to ask a relay for the removals of `reviews`: by their ids (`#e`), and by their addresses
 * (`#a`, `34259:<pubkey>:<d>`, the `d` as NIP-01 reads it: the first, or empty when there is none),
 * each value once and at most `REMOVAL_BATCH` to a request, so more requests for more reviews. None
 * for no reviews.
 */
export function removalFilters(reviews: readonly Pick<NostrEvent, "id" | "pubkey" | "tags">[]): NostrFilter[] {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const review of reviews) {
    ids.add(review.id);
    addresses.add(`${REVIEW_KIND}:${review.pubkey}:${review.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`);
  }
  return [
    ...runsOf([...ids], REMOVAL_BATCH).map((run): NostrFilter => ({ kinds: [EventDeletion], "#e": run, limit: REMOVAL_LIMIT })),
    ...runsOf([...addresses], REMOVAL_BATCH).map((run): NostrFilter => ({ kinds: [EventDeletion], "#a": run, limit: REMOVAL_LIMIT })),
  ];
}
