import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { countsAsRemoval, REMOVAL_BATCH, REMOVAL_LIMIT, REMOVAL_REQUESTS_AT_ONCE, removalFilters, removalsFrom, takesDown } from "../src/reviews/removals";
import { REVIEW_KIND, type Review } from "../src/reviews/review";
import { hex64, shapedEvent } from "./support/events";

/*
 * Which removals (NIP-09, kind 5) take a review down, as both apps read them: by the review's own
 * author, naming it by id, or by address up to the removal's time, as Brainstorm-UI's `removes` in
 * `client/src/lib/placeReviews.ts` reads them. And how they are asked for.
 */

const FILER = "4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64";
const PLACE = `39999:${FILER}:osm-way-993221389`;
const ALICE = hex64("a");
const BOB = hex64("b");
/** Thursday 8 October 2026, 12:00 UTC, in seconds. */
const NOW = 1_791_460_800;
const HOUR = 3_600;
const DAY = 86_400;

/** Alice's review of `PLACE` at its usual `d`, as a removal sees it, dated `createdAt`. */
const reviewAt = (createdAt: number, fields: Partial<Pick<Review, "id" | "reviewer" | "d">> = {}) => ({
  id: hex64("1"),
  reviewer: ALICE,
  d: `place:${PLACE}`,
  createdAt,
  ...fields,
});

/** The address a removal names a review by: `34259:<reviewer>:<d>`. */
const addressOf = (review: { reviewer: string; d: string }) => `${REVIEW_KIND}:${review.reviewer}:${review.d}`;

/** A removal by `pubkey` (Alice unless named) with `tags`, dated `createdAt`. */
const removal = (tags: string[][], createdAt = NOW, pubkey = ALICE) => shapedEvent({ kind: 5, pubkey, created_at: createdAt, tags });

describe("takesDown", () => {
  it("takes down the review an e names, with no a beside it, whenever the removal is dated", () => {
    const review = reviewAt(NOW);
    expect(takesDown(removal([["e", review.id]], NOW - DAY), review)).toBe(true);
    expect(takesDown(removal([["e", hex64("2")]]), review)).toBe(false);
  });

  it("takes down through an a the versions dated before or at the removal, and not one dated after it", () => {
    const takes = removal([["a", addressOf(reviewAt(NOW))], ["k", String(REVIEW_KIND)]], NOW);
    expect(takesDown(takes, reviewAt(NOW - 1))).toBe(true);
    expect(takesDown(takes, reviewAt(NOW))).toBe(true);
    expect(takesDown(takes, reviewAt(NOW + 1))).toBe(false);
  });

  it("never takes down another author's review, whatever it names", () => {
    const bobs = reviewAt(NOW, { reviewer: BOB });
    const byAlice = removal([["e", bobs.id], ["a", addressOf(bobs)]]);
    expect(takesDown(byAlice, bobs)).toBe(false);
    expect(takesDown({ ...byAlice, pubkey: BOB }, bobs)).toBe(true);
  });

  it("takes down nothing through an a that names another d", () => {
    const review = reviewAt(NOW - 1);
    expect(takesDown(removal([["a", addressOf({ reviewer: ALICE, d: PLACE })]]), review)).toBe(false);
    expect(takesDown(removal([["a", addressOf({ reviewer: ALICE, d: PLACE })]]), { ...review, d: PLACE })).toBe(true);
  });

  it("reads a review with no d at the empty d, as NIP-01 does", () => {
    const review = reviewAt(NOW - 1, { d: "" });
    expect(takesDown(removal([["a", `${REVIEW_KIND}:${ALICE}:`]]), review)).toBe(true);
  });
});

describe("countsAsRemoval", () => {
  it("counts a removal dated an hour ahead of the device's clock, and not one two days ahead", () => {
    expect(countsAsRemoval(removal([], NOW + HOUR), NOW)).toBe(true);
    expect(countsAsRemoval(removal([], NOW + DAY), NOW)).toBe(true);
    expect(countsAsRemoval(removal([], NOW + 2 * DAY), NOW)).toBe(false);
  });

  it("counts only kind 5", () => {
    expect(countsAsRemoval(shapedEvent({ kind: REVIEW_KIND, pubkey: ALICE, created_at: NOW }), NOW)).toBe(false);
    expect(countsAsRemoval(shapedEvent({ kind: 1, pubkey: ALICE, created_at: NOW }), NOW)).toBe(false);
  });
});

describe("removalsFrom", () => {
  it("reads a relay's requests for removals two at a time, in order, the next two once those are answered", async () => {
    expect(REMOVAL_REQUESTS_AT_ONCE).toBe(2);
    const filters = [1, 2, 3, 4, 5].map((n) => ({ kinds: [5], "#e": [hex64(String(n))] }));
    let open = 0;
    let most = 0;
    const sent: string[] = [];
    const values = await removalsFrom(filters, async (filter) => {
      open += 1;
      most = Math.max(most, open);
      const id = filter["#e"]?.[0] ?? "";
      sent.push(id);
      await Promise.resolve();
      open -= 1;
      return [id];
    });
    expect(most).toBe(2);
    expect(sent).toEqual(filters.map((filter) => filter["#e"][0]));
    expect(values).toEqual(filters.map((filter) => filter["#e"][0]));
  });

  it("fails as a request fails, and sends no more after it", async () => {
    const filters = [1, 2, 3].map((n) => ({ kinds: [5], "#e": [hex64(String(n))] }));
    const sent: number[] = [];
    const reading = removalsFrom(filters, async (filter) => {
      sent.push(filters.indexOf(filter as (typeof filters)[number]));
      if (sent.length === 1) throw new Error("The relay answered 503");
      return [];
    });
    await expect(reading).rejects.toThrow("503");
    expect(sent).toEqual([0, 1]);
  });
});

describe("removalFilters", () => {
  /** A review event by `pubkey` at `d`, or with no d at all when `d` is null. */
  const event = (n: number, d: string | null, pubkey = ALICE): NostrEvent =>
    shapedEvent({
      kind: REVIEW_KIND,
      pubkey,
      id: n.toString(16).padStart(64, "0"),
      tags: d === null ? [["s", "4"]] : [["d", d], ["s", "4"]],
    });

  it("asks for nothing when there are no reviews", () => {
    expect(removalFilters([])).toEqual([]);
  });

  it("asks for the removals of one review by its id and by its address", () => {
    const one = event(1, `place:${PLACE}`);
    expect(removalFilters([one])).toEqual([
      { kinds: [5], "#e": [one.id], limit: REMOVAL_LIMIT },
      { kinds: [5], "#a": [`${REVIEW_KIND}:${ALICE}:place:${PLACE}`], limit: REMOVAL_LIMIT },
    ]);
    expect(REMOVAL_LIMIT).toBe(500);
  });

  it("names each value once, the address of a review with no d at the empty d", () => {
    const first = event(1, `place:${PLACE}`);
    const second = event(2, `place:${PLACE}`);
    const bare = event(3, null);
    expect(removalFilters([first, second, { ...first }, bare])).toEqual([
      { kinds: [5], "#e": [first.id, second.id, bare.id], limit: REMOVAL_LIMIT },
      { kinds: [5], "#a": [`${REVIEW_KIND}:${ALICE}:place:${PLACE}`, `${REVIEW_KIND}:${ALICE}:`], limit: REMOVAL_LIMIT },
    ]);
  });

  it("names at most 100 values to a request: 250 reviews are asked for in three of each", () => {
    expect(REMOVAL_BATCH).toBe(100);
    const reviews = Array.from({ length: 250 }, (_, n) => event(n + 1, `d-${n}`));
    const filters = removalFilters(reviews);
    const byE = filters.filter((filter) => filter["#e"] !== undefined);
    const byA = filters.filter((filter) => filter["#a"] !== undefined);
    expect(byE.map((filter) => filter["#e"]!.length)).toEqual([100, 100, 50]);
    expect(byA.map((filter) => filter["#a"]!.length)).toEqual([100, 100, 50]);
    expect(byE.flatMap((filter) => filter["#e"])).toEqual(reviews.map((review) => review.id));
    expect(byA.flatMap((filter) => filter["#a"])).toEqual(reviews.map((_, n) => `${REVIEW_KIND}:${ALICE}:d-${n}`));
    for (const filter of filters) expect(filter).toMatchObject({ kinds: [5], limit: REMOVAL_LIMIT });
    expect(filters).toHaveLength(6);
  });
});
