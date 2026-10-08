import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { latestReviews, newestPerReviewer, parseReview, REVIEW_KIND, type Review, starsOf } from "../src/reviews/review";
import { hex64, shapedEvent } from "./support/events";

const FILER = "4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64";
const PLACE = `39999:${FILER}:osm-way-993221389`;
const OTHER_PLACE = `39999:${FILER}:osm-node-4417361789`;
const ALICE = hex64("a");
const BOB = hex64("b");

/** A review as brief § 4.1 draws it: 4 stars of `PLACE` by Alice, with `fields` over it. */
const review = (fields: Partial<NostrEvent> = {}): NostrEvent =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: ALICE,
    tags: [
      ["d", PLACE],
      ["a", PLACE],
      ["m", "place"],
      ["rating", "0.800"],
      ["s", "4"],
    ],
    content: "Get the grilled oysters and sit at the bar.",
    ...fields,
  });

describe("starsOf, as Brainstorm-UI reads stars", () => {
  it("reads an s of 1 to 5 first", () => {
    expect(starsOf([["s", "4"]])).toBe(4);
    expect(starsOf([["rating", "0.200"], ["s", "4"]])).toBe(4);
  });

  it("reads a rating of 0 to 1 as a fraction of five stars", () => {
    expect(starsOf([["rating", "0.800"]])).toBe(4);
    expect(starsOf([["rating", "0.9"]])).toBe(4.5);
  });

  it("reads a rating of exactly 1 as a fraction: five stars (Review Focus 5)", () => {
    expect(starsOf([["rating", "1"]])).toBe(5);
  });

  it("reads numbers as Number() does, as Brainstorm-UI does: space around them is ignored", () => {
    expect(starsOf([["s", " 4 "]])).toBe(4);
    expect(starsOf([["rating", " 0.8 "]])).toBe(4);
  });

  it("reads a rating above 1, up to 5, as stars", () => {
    expect(starsOf([["rating", "3"]])).toBe(3);
    expect(starsOf([["rating", "5"]])).toBe(5);
  });

  it("reads no stars from a rating above 5", () => {
    expect(starsOf([["rating", "7"]])).toBeNull();
  });

  it("passes over an s that is not a whole number from 1 to 5, to the rating", () => {
    expect(starsOf([["s", "0"], ["rating", "0.6"]])).toBe(3);
    expect(starsOf([["s", "6"], ["rating", "0.6"]])).toBe(3);
    expect(starsOf([["s", "4.5"], ["rating", "0.6"]])).toBe(3);
    expect(starsOf([["s", "four"], ["rating", "0.6"]])).toBe(3);
  });

  it("prefers the first rating with no aspect, then the first rating", () => {
    expect(starsOf([["rating", "0.9", "speed"], ["rating", "0.4"]])).toBe(2);
    expect(starsOf([["rating", "0.9", "speed"], ["rating", "0.4", "price"]])).toBe(4.5);
  });

  it("reads no stars from a missing, empty, negative or unreadable rating", () => {
    expect(starsOf([])).toBeNull();
    expect(starsOf([["m", "place"]])).toBeNull();
    expect(starsOf([["rating"]])).toBeNull();
    expect(starsOf([["rating", ""]])).toBeNull();
    expect(starsOf([["rating", "-0.5"]])).toBeNull();
    expect(starsOf([["rating", "abc"]])).toBeNull();
    expect(starsOf([["rating", "Infinity"]])).toBeNull();
  });

  // A departure from Brainstorm-UI, which reads a rating of 0 as 0 stars. A review is 1 to 5
  // stars (brief § 4), so 0 stars is no rating at all: it must not pull a score down.
  it("reads no stars from a rating of 0", () => {
    expect(starsOf([["rating", "0"]])).toBeNull();
    expect(starsOf([["rating", "0.000"]])).toBeNull();
    expect(starsOf([["rating", "-0"]])).toBeNull();
  });
});

describe("parseReview", () => {
  it("reads a review of a place: who, which place, its d, the stars, the words and the time", () => {
    const ev = review();
    expect(parseReview(ev)).toEqual({
      id: ev.id,
      reviewer: ALICE,
      address: PLACE,
      d: PLACE,
      stars: 4,
      text: "Get the grilled oysters and sit at the bar.",
      createdAt: ev.created_at,
    });
  });

  it("keeps the review's own d, which its removal names, whatever form it takes", () => {
    expect(parseReview(review({ tags: [["d", `place:${PLACE}`], ["a", PLACE], ["s", "4"]] }))?.d).toBe(`place:${PLACE}`);
    expect(parseReview(review({ tags: [["d", "my-review"], ["a", PLACE], ["s", "4"]] }))?.d).toBe("my-review");
    // NIP-01: an addressable event with no d tag is at the empty d.
    expect(parseReview(review({ tags: [["a", PLACE], ["s", "4"]] }))?.d).toBe("");
  });

  it("takes the place from a when it is a place's address", () => {
    const ev = review({ tags: [["d", "place:osm-way-993221389"], ["a", PLACE], ["s", "4"]] });
    expect(parseReview(ev)?.address).toBe(PLACE);
  });

  it("takes the place from d when a is missing or not a place's address", () => {
    expect(parseReview(review({ tags: [["d", PLACE], ["s", "4"]] }))?.address).toBe(PLACE);
    const other = `30023:${FILER}:an-article`;
    expect(parseReview(review({ tags: [["d", PLACE], ["a", other], ["s", "4"]] }))?.address).toBe(PLACE);
  });

  it("takes the place from a d with no a: the bare address, or the address after place: (decision 17)", () => {
    expect(parseReview(review({ tags: [["d", PLACE], ["s", "4"]] }))?.address).toBe(PLACE);
    expect(parseReview(review({ tags: [["d", `place:${PLACE}`], ["s", "4"]] }))?.address).toBe(PLACE);
  });

  it("rejects a place: d whose rest is not a place's address", () => {
    expect(parseReview(review({ tags: [["d", "place:"], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", "place:osm-way-993221389"], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", `place:30040:${FILER}:a-list`], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", `place:place:${PLACE}`], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", `Place:${PLACE}`], ["s", "4"]] }))).toBeNull();
  });

  it("rejects a review whose subject is not a place's address", () => {
    expect(parseReview(review({ tags: [["d", `30040:${FILER}:a-list`], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", "39999:not-a-key:osm-way-1"], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", `39999:${FILER}:`], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["d", `39999:${FILER}:  `], ["s", "4"]] }))).toBeNull();
    expect(parseReview(review({ tags: [["s", "4"]] }))).toBeNull();
  });

  it("rejects an event of another kind", () => {
    expect(parseReview(review({ kind: 1 }))).toBeNull();
    expect(parseReview(review({ kind: 39999 }))).toBeNull();
  });

  it("rejects a bad public key", () => {
    const npub = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";
    expect(parseReview(review({ pubkey: npub }))).toBeNull();
    expect(parseReview(review({ pubkey: ALICE.toUpperCase() }))).toBeNull();
    expect(parseReview(review({ pubkey: ALICE.slice(1) }))).toBeNull();
  });

  it("rejects text that is not a string, and anything that is not an event", () => {
    expect(parseReview({ ...review(), content: 5 })).toBeNull();
    expect(parseReview({ ...review(), content: null })).toBeNull();
    expect(parseReview(null)).toBeNull();
    expect(parseReview("a review")).toBeNull();
    expect(parseReview({ ...review(), tags: [["d", PLACE], ["s", 4]] })).toBeNull();
  });

  it("keeps a review with no stars, for its words, and a review with no words, for its stars", () => {
    expect(parseReview(review({ tags: [["d", PLACE]] }))).toMatchObject({ stars: null, text: review().content });
    expect(parseReview(review({ content: "" }))).toMatchObject({ stars: 4, text: "" });
  });
});

describe("latestReviews (Review Focus 2)", () => {
  it("keeps the newer of two reviews by one person of one place, in either order", () => {
    const older = review({ created_at: 1_700_000_000, tags: [["d", PLACE], ["s", "1"]] });
    const newer = review({ created_at: 1_700_000_100, tags: [["d", PLACE], ["s", "3"]] });
    expect(latestReviews([older, newer]).map((r) => r.id)).toEqual([newer.id]);
    expect(latestReviews([newer, older]).map((r) => r.id)).toEqual([newer.id]);
  });

  it("keeps the lower id of two reviews made in the same second", () => {
    const low = review({ id: hex64("1") });
    const high = review({ id: hex64("2") });
    expect(latestReviews([high, low]).map((r) => r.id)).toEqual([low.id]);
    expect(latestReviews([low, high]).map((r) => r.id)).toEqual([low.id]);
  });

  it("keeps one review per person per place", () => {
    const alice = review();
    const bob = review({ pubkey: BOB });
    const aliceElsewhere = review({ tags: [["d", OTHER_PLACE], ["s", "2"]] });
    expect(latestReviews([alice, bob, aliceElsewhere]).map((r) => r.id)).toEqual([alice.id, bob.id, aliceElsewhere.id]);
  });

  it("lets a newer review replace the older one at its d, though the older names another place", () => {
    // The reviewer moved the review to another place: same d, new a. A relay that lags still sends both.
    const older = review({ created_at: 1_700_000_000, tags: [["d", PLACE], ["a", PLACE], ["s", "2"]] });
    const newer = review({ created_at: 1_700_000_100, tags: [["d", PLACE], ["a", OTHER_PLACE], ["s", "5"]] });
    for (const values of [
      [older, newer],
      [newer, older],
    ]) {
      const reviews = latestReviews(values);
      expect(reviews.map((r) => r.id)).toEqual([newer.id]);
      expect(reviews[0]).toMatchObject({ address: OTHER_PLACE, stars: 5 });
    }
  });

  it("lets a newer event at a review's d replace it, though the newer one reviews no place", () => {
    const older = review({ created_at: 1_700_000_000, tags: [["d", "my-review"], ["a", PLACE], ["s", "4"]] });
    const newer = review({ created_at: 1_700_000_100, tags: [["d", "my-review"], ["s", "4"]] });
    expect(latestReviews([older, newer])).toEqual([]);
  });

  it("keeps the newer review of one place when one person filed it under two d tags", () => {
    const older = review({ created_at: 1_700_000_000, tags: [["d", "first"], ["a", PLACE], ["s", "2"]] });
    const newer = review({ created_at: 1_700_000_100, tags: [["d", "second"], ["a", PLACE], ["s", "5"]] });
    expect(latestReviews([newer, older]).map((r) => r.id)).toEqual([newer.id]);
  });

  it("keeps the newer review of one place filed under its bare address and under place: (decision 16)", () => {
    const older = review({ created_at: 1_700_000_000, tags: [["d", PLACE], ["s", "2"]] });
    const newer = review({ created_at: 1_700_000_100, tags: [["d", `place:${PLACE}`], ["s", "5"]] });
    for (const values of [
      [older, newer],
      [newer, older],
    ]) {
      expect(latestReviews(values).map((r) => r.id)).toEqual([newer.id]);
    }
  });

  it("forgets a review the relays no longer send, such as one its reviewer deleted", () => {
    const kept = review();
    const deleted = review({ pubkey: BOB });
    expect(latestReviews([kept, deleted])).toHaveLength(2);
    expect(latestReviews([kept]).map((r) => r.id)).toEqual([kept.id]);
  });

  it("counts a review once when two relays both send it", () => {
    const ev = review();
    expect(latestReviews([ev, { ...ev }])).toHaveLength(1);
  });

  it("passes over values that are not reviews of a place", () => {
    const ev = review();
    expect(latestReviews([null, review({ kind: 1 }), { ...ev, sig: "nope" }, ev]).map((r) => r.id)).toEqual([ev.id]);
  });
});

describe("newestPerReviewer (one voice per person, brief § 4.3)", () => {
  const FILED_TWICE = `39999:${FILER}:osm-way-993221389-again`;
  let made = 0;
  const at = (reviewer: string, address: string, createdAt: number, id?: string): Review => ({
    id: id ?? `${"e".repeat(60)}${(made++).toString(16).padStart(4, "0")}`,
    reviewer,
    address,
    d: `place:${address}`,
    stars: 4,
    text: "",
    createdAt,
  });

  it("keeps each person's newest review across two filings of one place, in either order", () => {
    const older = at(ALICE, PLACE, 1_700_000_000);
    const newer = at(ALICE, FILED_TWICE, 1_700_000_100);
    const bob = at(BOB, PLACE, 1_700_000_050);
    expect(newestPerReviewer([older, newer, bob])).toEqual([newer, bob]);
    expect(newestPerReviewer([bob, newer, older])).toEqual([bob, newer]);
  });

  it("keeps the lower id of two made in the same second", () => {
    const low = at(ALICE, PLACE, 1_700_000_000, hex64("1"));
    const high = at(ALICE, FILED_TWICE, 1_700_000_000, hex64("2"));
    expect(newestPerReviewer([high, low])).toEqual([low]);
    expect(newestPerReviewer([low, high])).toEqual([low]);
  });

  it("leaves one review per person as it is", () => {
    const reviews = [at(ALICE, PLACE, 1_700_000_000), at(BOB, FILED_TWICE, 1_700_000_100)];
    expect(newestPerReviewer(reviews)).toEqual(reviews);
    expect(newestPerReviewer([])).toEqual([]);
  });
});
