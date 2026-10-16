import type { NostrEvent } from "@nostrify/nostrify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isHttpsUrl,
  latestReviews,
  newestPerReviewer,
  PAID_WAYS,
  parseReview,
  photosOf,
  REVIEW_KIND,
  type Review,
  starsOf,
  wordsOf,
} from "../src/reviews/review";
import { hex64, shapedEvent } from "./support/events";

const FILER = "4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64";
const PLACE = `39999:${FILER}:osm-way-993221389`;
const OTHER_PLACE = `39999:${FILER}:osm-node-4417361789`;
const ALICE = hex64("a");
const BOB = hex64("b");
/** Photos' addresses, as another app puts them in a review (NIP-92). */
const PHOTO = "https://blossom.example/abc.jpg";
const SECOND_PHOTO = "https://blossom.example/def.png";

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
      photos: [],
      price: null,
      paid: null,
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

  it("takes the place from an a that also says where the place is found, as Regulars writes it", () => {
    const ev = review({ tags: [["d", `place:${PLACE}`], ["a", PLACE, "wss://dcosl.brainstorm.world"], ["s", "4"]] });
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

  it("reads the words without the photos' addresses that another app put after them", () => {
    const ev = review({
      content: `Get the grilled oysters and sit at the bar.\n${PHOTO}`,
      tags: [...review().tags, ["imeta", `url ${PHOTO}`, "m image/jpeg"]],
    });
    expect(parseReview(ev)?.text).toBe("Get the grilled oysters and sit at the bar.");
    expect(latestReviews([ev])[0]?.text).toBe("Get the grilled oysters and sit at the bar.");
  });
});

describe("photosOf and wordsOf: a review's photos, and its words without their addresses, as Brainstorm reads them", () => {
  it("finds a photo's address in the url part of an imeta tag, wherever that part is, trimmed", () => {
    expect(photosOf([["imeta", `url ${PHOTO}`]])).toEqual([PHOTO]);
    expect(photosOf([["imeta", "m image/jpeg", `url ${PHOTO}`, "dim 640x480"]])).toEqual([PHOTO]);
    expect(photosOf([["imeta", `url   ${PHOTO}  `]])).toEqual([PHOTO]);
  });

  it("finds each photo once, in the order the tags give them, and nothing where an imeta has no url part", () => {
    expect(
      photosOf([
        ["imeta", `url ${SECOND_PHOTO}`],
        ["s", "4"],
        ["imeta", `url ${PHOTO}`],
        ["imeta", `url ${SECOND_PHOTO}`],
      ]),
    ).toEqual([SECOND_PHOTO, PHOTO]);
    expect(photosOf([["imeta", "m image/jpeg"]])).toEqual([]);
    expect(photosOf([["imeta"], ["imeta", "url "], ["imeta", "url   "]])).toEqual([]);
    // Only the first url part of a tag names its photo.
    expect(photosOf([["imeta", `url ${PHOTO}`, `url ${SECOND_PHOTO}`]])).toEqual([PHOTO]);
    expect(photosOf([["url", PHOTO], ["r", PHOTO]])).toEqual([]);
  });

  it("takes out one photo on a line after the words", () => {
    expect(wordsOf(`Get the bolo.\n${PHOTO}`, [["imeta", `url ${PHOTO}`]])).toBe("Get the bolo.");
  });

  it("takes out two photos, each on its line", () => {
    const tags = [
      ["imeta", `url ${PHOTO}`],
      ["imeta", `url ${SECOND_PHOTO}`],
    ];
    expect(wordsOf(`Get the bolo.\n${PHOTO}\n${SECOND_PHOTO}`, tags)).toBe("Get the bolo.");
  });

  it("takes out every time the content gives the same address", () => {
    expect(wordsOf(`${PHOTO}\nGet the bolo.\n${PHOTO}`, [["imeta", `url ${PHOTO}`]])).toBe("Get the bolo.");
  });

  it("takes out an address in the middle of a sentence, and leaves the rest of the sentence as it is", () => {
    expect(wordsOf(`See ${PHOTO} for the menu`, [["imeta", `url ${PHOTO}`]])).toBe("See  for the menu");
  });

  it("finds the address of an imeta whose url part is not its first", () => {
    expect(wordsOf(`Get the bolo.\n${PHOTO}`, [["imeta", "m image/jpeg", `url ${PHOTO}`]])).toBe("Get the bolo.");
  });

  it("leaves an address that no imeta names, and takes out nothing for an imeta with no url part", () => {
    expect(wordsOf(`Get the bolo.\n${PHOTO}`, [["imeta", "m image/jpeg"]])).toBe(`Get the bolo.\n${PHOTO}`);
    expect(wordsOf(`Get the bolo.\n${PHOTO}`, [])).toBe(`Get the bolo.\n${PHOTO}`);
  });

  it("takes out the spaces and tabs before a line break, and trims the ends", () => {
    expect(wordsOf(`Get the bolo. \t \n${PHOTO}`, [["imeta", `url ${PHOTO}`]])).toBe("Get the bolo.");
    expect(wordsOf(`Get the bolo. ${PHOTO}\nSit outside.`, [["imeta", `url ${PHOTO}`]])).toBe("Get the bolo.\nSit outside.");
    expect(wordsOf("  Get the bolo. \nSit outside.\n\n", [])).toBe("Get the bolo.\nSit outside.");
  });

  it("gives no words for a review that is a photo alone", () => {
    expect(wordsOf(PHOTO, [["imeta", `url ${PHOTO}`]])).toBe("");
    expect(wordsOf(`\n${PHOTO}\n`, [["imeta", `url ${PHOTO}`]])).toBe("");
  });

  it("finds every address an imeta names, whatever it starts with, so that each still comes out of the words", () => {
    const tags = [
      ["imeta", "url http://blossom.example/abc.jpg"],
      ["imeta", "url javascript:alert(1)"],
    ];
    expect(photosOf(tags)).toEqual(["http://blossom.example/abc.jpg", "javascript:alert(1)"]);
    expect(wordsOf("Get the bolo.\nhttp://blossom.example/abc.jpg\njavascript:alert(1)", tags)).toBe("Get the bolo.");
  });
});

describe("isHttpsUrl: the only addresses a photo is shown from", () => {
  it("is true of an absolute https address, in any case", () => {
    expect(isHttpsUrl(PHOTO)).toBe(true);
    expect(isHttpsUrl("HTTPS://blossom.example/abc.jpg")).toBe(true);
    expect(isHttpsUrl("https://blossom.example:8443/a/b.webp?w=640#top")).toBe(true);
  });

  it("is false of any other scheme, of an address with no scheme, and of what is no address", () => {
    for (const text of [
      "http://blossom.example/abc.jpg",
      // Read alone, these are absolute; a page at an https address reads them as paths of its own.
      "https:blossom.example/abc.jpg",
      "https:/blossom.example/abc.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,AA==",
      "blob:https://blossom.example/1234",
      "ftp://blossom.example/abc.jpg",
      "//blossom.example/abc.jpg",
      "/abc.jpg",
      "abc.jpg",
      "photo",
      "https://",
      "",
    ]) {
      expect(isHttpsUrl(text), text).toBe(false);
    }
  });
});

describe("a review's photos, price and how they paid, as Brainstorm-UI's readReview reads them", () => {
  /** Alice's review with `tags` after its own. */
  const reviewWith = (...tags: string[][]) => review({ tags: [...review().tags, ...tags] });

  it("reads the price, how they paid and the photos that a review gives", () => {
    const ev = review({
      content: `Get the bolo.\n${PHOTO}\n${SECOND_PHOTO}`,
      tags: [...review().tags, ["price", "2"], ["paid", "cash"], ["imeta", `url ${PHOTO}`], ["imeta", `url ${SECOND_PHOTO}`, "m image/png"]],
    });
    expect(parseReview(ev)).toMatchObject({ price: 2, paid: "cash", photos: [PHOTO, SECOND_PHOTO], text: "Get the bolo." });
  });

  it("gives no price, no way paid and no photos for a review that gives none", () => {
    expect(parseReview(review())).toMatchObject({ price: null, paid: null, photos: [] });
  });

  it("reads a price as Number() does, so space around it is ignored, and keeps it only when a whole number from 1 to 4", () => {
    const priceOf = (value: string) => parseReview(reviewWith(["price", value]))?.price;
    expect(["1", "2", "3", "4"].map(priceOf)).toEqual([1, 2, 3, 4]);
    expect(priceOf(" 2 ")).toBe(2);
    for (const value of ["0", "5", "2.5", "two", "-1", ""]) expect(priceOf(value), value).toBeNull();
    expect(parseReview(reviewWith(["price"]))?.price).toBeNull();
  });

  it("reads only the first price, as Brainstorm does: a bad first one is no price, though a good one follows", () => {
    expect(parseReview(reviewWith(["price", "9"], ["price", "2"]))?.price).toBeNull();
    expect(parseReview(reviewWith(["price", "3"], ["price", "1"]))?.price).toBe(3);
  });

  it("reads how they paid only as one of the four ways, written as the record writes them, from the first paid", () => {
    const paidOf = (value: string) => parseReview(reviewWith(["paid", value]))?.paid;
    expect(PAID_WAYS.map(paidOf)).toEqual(["lightning", "onchain", "card", "cash"]);
    for (const value of ["Lightning", "bitcoin", "on-chain", " cash", ""]) expect(paidOf(value), value).toBeNull();
    expect(parseReview(reviewWith(["paid", "bitcoin"], ["paid", "cash"]))?.paid).toBeNull();
  });

  it("keeps to the https photos: one at any other address is not among them, and its address still comes out of the words", () => {
    const others = ["http://blossom.example/abc.jpg", "javascript:alert(1)", "data:image/png;base64,AA==", "photo"];
    const ev = review({
      content: `Get the bolo.\n${others.join("\n")}\n${PHOTO}`,
      tags: [...review().tags, ...others.map((url) => ["imeta", `url ${url}`]), ["imeta", `url ${PHOTO}`]],
    });
    expect(parseReview(ev)).toMatchObject({ photos: [PHOTO], text: "Get the bolo." });
    expect(latestReviews([ev])[0]?.photos).toEqual([PHOTO]);
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

describe("latestReviews, with the removals among what the relays sent (NIP-09)", () => {
  /** Thursday 8 October 2026, 12:00 UTC, in seconds: the time on the device. */
  const NOW = 1_791_460_800;
  const DAY = 86_400;

  /** A removal by `pubkey` (Alice unless named) with `tags`, dated `createdAt`. */
  const removal = (tags: string[][], createdAt = NOW, pubkey = ALICE) => shapedEvent({ kind: 5, pubkey, created_at: createdAt, tags });
  /** The address a removal names Alice's review at `d` by. */
  const addressAt = (d: string, pubkey = ALICE) => `${REVIEW_KIND}:${pubkey}:${d}`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves out a review whose removal names it by e and by a, with k, in either order", () => {
    const record = review({ created_at: NOW - DAY });
    const removed = removal([["e", record.id], ["a", addressAt(PLACE)], ["k", String(REVIEW_KIND)]]);
    expect(latestReviews([record, removed])).toEqual([]);
    expect(latestReviews([removed, record])).toEqual([]);
  });

  it("leaves out a review whose removal names it by e alone", () => {
    const record = review({ created_at: NOW - DAY });
    expect(latestReviews([record, removal([["e", record.id]], NOW - 2 * DAY)])).toEqual([]);
  });

  it("keeps a newer review at the d a removal named by a", () => {
    const removed = review({ created_at: NOW - DAY });
    const newer = review({ created_at: NOW - DAY + 60, tags: [["d", PLACE], ["a", PLACE], ["s", "5"]] });
    const values = [removed, removal([["a", addressAt(PLACE)]], NOW - DAY + 30), newer];
    expect(latestReviews(values).map((r) => r.id)).toEqual([newer.id]);
  });

  it("does not bring back an older version at the same d when the newest is taken down by e", () => {
    const older = review({ created_at: NOW - 2 * DAY, tags: [["d", PLACE], ["a", PLACE], ["s", "2"]] });
    const newest = review({ created_at: NOW - DAY });
    expect(latestReviews([older, newest, removal([["e", newest.id]])])).toEqual([]);
  });

  it("does not bring back an older review of the place under another d when the newest is taken down", () => {
    const olderElsewhere = review({ created_at: NOW - 2 * DAY, tags: [["d", `place:${PLACE}`], ["a", PLACE], ["s", "2"]] });
    const newest = review({ created_at: NOW - DAY });
    const bob = review({ pubkey: BOB });
    const reviews = latestReviews([olderElsewhere, newest, bob, removal([["e", newest.id]])]);
    expect(reviews.map((r) => r.id)).toEqual([bob.id]);
  });

  it("ignores a removal by anyone but the review's author", () => {
    const record = review({ created_at: NOW - DAY });
    const byBob = removal([["e", record.id], ["a", addressAt(PLACE)]], NOW, BOB);
    expect(latestReviews([record, byBob]).map((r) => r.id)).toEqual([record.id]);
  });

  it("ignores a removal dated more than a day ahead of the device's clock, and counts one an hour ahead", () => {
    const record = review({ created_at: NOW - DAY });
    const tags = [["a", addressAt(PLACE)]];
    expect(latestReviews([record, removal(tags, NOW + 2 * DAY)]).map((r) => r.id)).toEqual([record.id]);
    expect(latestReviews([record, removal(tags, NOW + 3_600)])).toEqual([]);
  });

  it("takes down only what a removal names: another review of the same person stays", () => {
    const here = review({ created_at: NOW - DAY });
    const there = review({ created_at: NOW - DAY, tags: [["d", OTHER_PLACE], ["s", "3"]] });
    expect(latestReviews([here, there, removal([["e", here.id], ["a", addressAt(PLACE)]])]).map((r) => r.id)).toEqual([there.id]);
  });
});

describe("reviews from the future", () => {
  /** Thursday 8 October 2026, 12:00 UTC, in seconds: the time on the device. */
  const NOW = 1_791_460_800;
  const DAY = 86_400;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a review more than a day ahead of the device's clock: no date can be shown for it, nor trusted", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    expect(parseReview(review({ created_at: 9e12 }))).toBeNull();
    expect(parseReview(review({ created_at: NOW + DAY + 1 }))).toBeNull();
    // A clock a little ahead of the device's is a clock, not a forgery.
    expect(parseReview(review({ created_at: NOW + DAY }))?.createdAt).toBe(NOW + DAY);
    expect(parseReview(review({ created_at: NOW }))?.createdAt).toBe(NOW);
  });

  it("does not let one from the future stand in for the reviewer's real review at its d", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const real = review({ created_at: NOW - DAY });
    const future = review({ created_at: 9e12, content: "Pinned to the top forever" });
    expect(latestReviews([real, future]).map((each) => each.id)).toEqual([real.id]);
    expect(latestReviews([future])).toEqual([]);
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
    photos: [],
    price: null,
    paid: null,
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
