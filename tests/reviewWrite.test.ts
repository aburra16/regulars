import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { parsePlaces } from "../src/places/load";
import { parseReview, REVIEW_KIND } from "../src/reviews/review";
import { removalTemplate, REVIEW_WORDS_MAX, reviewTemplate } from "../src/reviews/write";
import raw from "./fixtures/funchal-items.json";
import { hex64 } from "./support/events";

const fixtures: NostrEvent[] = raw;
const jacafe = parsePlaces(fixtures).find((place) => place.name === "Jacafé")!;

const FILER = "4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64";
const JACAFE = `39999:${FILER}:osm-node-11330857543`;
/** Jacafé filed a second time, under another d. */
const JACAFE_AGAIN = `39999:${FILER}:jacafe-again`;
const NOW = 1_790_000_000;
const ALICE = hex64("a");
/** The list hub, where the places are found: the hint a review gives with its place's address. */
const HUB = "wss://dcosl.brainstorm.world";
/** Photos' addresses, as another app puts them in a review (NIP-92). */
const PHOTO = "https://blossom.example/abc.jpg";
const SECOND_PHOTO = "https://blossom.example/def.png";

/**
 * The tags of a review of Jacafé as Brainstorm writes it, in full: Regulars' own, then a price, how
 * the reviewer paid, a photo, and the app that signed it.
 */
const brainstormTags = (): string[][] => [
  ["d", `place:${JACAFE}`],
  ["a", JACAFE],
  ["m", "place"],
  ["rating", "0.800"],
  ["s", "4"],
  ["alt", "Review of Jacafé: 4 of 5 stars"],
  ["price", "2"],
  ["paid", "lightning"],
  ["imeta", `url ${PHOTO}`],
  ["client", "Brainstorm"],
];

describe("reviewTemplate (decision 17)", () => {
  it("writes a review of Jacafé: its d, a (with the list hub as where the place is found), m, rating, s and alt, and the words", () => {
    expect(jacafe.address).toBe(JACAFE);
    expect(reviewTemplate(jacafe, 4, "Get the bolo", NOW)).toEqual({
      kind: 34259,
      created_at: NOW,
      content: "Get the bolo",
      tags: [
        ["d", `place:${JACAFE}`],
        ["a", JACAFE, HUB],
        ["m", "place"],
        ["rating", "0.800"],
        ["s", "4"],
        ["alt", "Review of Jacafé: 4 of 5 stars"],
      ],
    });
  });

  it("gives the rating as stars ÷ 5 to three decimals, and s as the whole stars", () => {
    const tagsFor = (stars: 1 | 2 | 3 | 4 | 5) => reviewTemplate(jacafe, stars, "", NOW).tags;
    expect(tagsFor(1)).toContainEqual(["rating", "0.200"]);
    expect(tagsFor(1)).toContainEqual(["s", "1"]);
    expect(tagsFor(3)).toContainEqual(["rating", "0.600"]);
    expect(tagsFor(5)).toContainEqual(["rating", "1.000"]);
    expect(tagsFor(5)).toContainEqual(["s", "5"]);
    expect(tagsFor(5)).toContainEqual(["alt", "Review of Jacafé: 5 of 5 stars"]);
  });

  it("allows a review that is stars alone", () => {
    expect(reviewTemplate(jacafe, 5, "", NOW).content).toBe("");
  });

  it("refuses stars that are not a whole number from 1 to 5", () => {
    for (const stars of [0, 6, 4.5, Number.NaN]) {
      expect(() => reviewTemplate(jacafe, stars as 1, "", NOW), String(stars)).toThrow(RangeError);
    }
  });

  it("signs into a valid event, which parseReview reads back", () => {
    const secret = generateSecretKey();
    const signed = finalizeEvent(reviewTemplate(jacafe, 4, "Get the bolo", NOW), secret);
    expect(verifyEvent(signed)).toBe(true);
    expect(parseReview(signed)).toEqual({
      id: signed.id,
      reviewer: getPublicKey(secret),
      address: JACAFE,
      d: `place:${JACAFE}`,
      stars: 4,
      text: "Get the bolo",
      createdAt: NOW,
    });
  });
});

describe("reviewTemplate on an edit: built on the person's review, it keeps what Regulars does not set", () => {
  it("keeps the price, payment and photo another app gave, changes the stars and words, and drops the app that signed it", () => {
    const previous = { tags: brainstormTags() };
    expect(reviewTemplate(jacafe, 5, "Better than last time", NOW, previous)).toEqual({
      kind: 34259,
      created_at: NOW,
      content: `Better than last time\n${PHOTO}`,
      tags: [
        ["d", `place:${JACAFE}`],
        ["a", JACAFE, HUB],
        ["m", "place"],
        ["rating", "1.000"],
        ["s", "5"],
        ["alt", "Review of Jacafé: 5 of 5 stars"],
        ["price", "2"],
        ["paid", "lightning"],
        ["imeta", `url ${PHOTO}`],
      ],
    });
  });

  it("keeps tags no app here knows, in their order and with their values; drops a nonce, and a rating with an aspect", () => {
    const previous = {
      tags: [
        ["d", `place:${JACAFE}`],
        ["x-flavour", "tart"],
        ["a", JACAFE],
        ["rating", "0.600", "service"],
        ["s", "3"],
        ["nonce", "776797", "20"],
        ["t", "coffee"],
        ["client", "SomeApp", "31990:abc:def"],
      ],
    };
    expect(reviewTemplate(jacafe, 4, "", NOW, previous).tags).toEqual([
      ["d", `place:${JACAFE}`],
      ["a", JACAFE, HUB],
      ["m", "place"],
      ["rating", "0.800"],
      ["s", "4"],
      ["alt", "Review of Jacafé: 4 of 5 stars"],
      ["x-flavour", "tart"],
      ["t", "coffee"],
    ]);
  });

  it("keeps the review's own d when it names the place: the bare address, or place: and the address", () => {
    const at = (d: string) => reviewTemplate(jacafe, 4, "", NOW, { tags: [["d", d], ["s", "2"]] }).tags[0];
    expect(at(JACAFE)).toEqual(["d", JACAFE]);
    expect(at(`place:${JACAFE}`)).toEqual(["d", `place:${JACAFE}`]);
  });

  it("writes at the place's own d when the review's d names another filing of it, and still keeps its other tags", () => {
    const previous = {
      tags: [
        ["d", `place:${JACAFE_AGAIN}`],
        ["a", JACAFE_AGAIN],
        ["price", "3"],
        ["imeta", `url ${PHOTO}`],
      ],
    };
    const template = reviewTemplate(jacafe, 4, "Get the bolo", NOW, previous);
    expect(template.tags.slice(0, 2)).toEqual([
      ["d", `place:${JACAFE}`],
      ["a", JACAFE, HUB],
    ]);
    expect(template.tags.slice(6)).toEqual([
      ["price", "3"],
      ["imeta", `url ${PHOTO}`],
    ]);
    expect(template.content).toBe(`Get the bolo\n${PHOTO}`);
  });

  it("writes at the place's own d when the review has none, or one that names no place here", () => {
    expect(reviewTemplate(jacafe, 4, "", NOW, { tags: [["s", "2"]] }).tags[0]).toEqual(["d", `place:${JACAFE}`]);
    expect(reviewTemplate(jacafe, 4, "", NOW, { tags: [["d", "my-review"]] }).tags[0]).toEqual(["d", `place:${JACAFE}`]);
  });

  it("puts each photo's address after the words, each on its line, in order; a photo alone is its address", () => {
    const tags = [
      ["d", `place:${JACAFE}`],
      ["imeta", `url ${PHOTO}`, "m image/jpeg"],
      ["imeta", "m image/png", `url ${SECOND_PHOTO}`],
    ];
    expect(reviewTemplate(jacafe, 4, "Get the bolo", NOW, { tags }).content).toBe(`Get the bolo\n${PHOTO}\n${SECOND_PHOTO}`);
    expect(reviewTemplate(jacafe, 4, "", NOW, { tags }).content).toBe(`${PHOTO}\n${SECOND_PHOTO}`);
    expect(reviewTemplate(jacafe, 4, "", NOW, { tags: brainstormTags() }).content).toBe(PHOTO);
  });

  it("writes the review as it is without an edit when the person's review had nothing of its own", () => {
    const previous = { tags: reviewTemplate(jacafe, 2, "Too busy", NOW - 60).tags };
    expect(reviewTemplate(jacafe, 4, "Get the bolo", NOW, previous)).toEqual(reviewTemplate(jacafe, 4, "Get the bolo", NOW));
  });

  it("copies the tags it keeps: changing the edit changes nothing of the review it was built on", () => {
    const previous = { tags: brainstormTags() };
    const template = reviewTemplate(jacafe, 5, "", NOW, previous);
    const price = template.tags.find((tag) => tag[0] === "price")!;
    price[1] = "4";
    template.tags.push(["extra", "1"]);
    expect(previous.tags).toEqual(brainstormTags());
  });

  it("signs into a valid event that reads back with the words, the stars and the place", () => {
    const secret = generateSecretKey();
    const signed = finalizeEvent(reviewTemplate(jacafe, 5, "Better than last time", NOW, { tags: brainstormTags() }), secret);
    expect(verifyEvent(signed)).toBe(true);
    expect(parseReview(signed)).toMatchObject({ address: JACAFE, d: `place:${JACAFE}`, stars: 5, text: "Better than last time" });
  });
});

describe("REVIEW_WORDS_MAX", () => {
  it("is 1,200 characters, which the template does not hold the words to", () => {
    expect(REVIEW_WORDS_MAX).toBe(1_200);
    const long = "a".repeat(REVIEW_WORDS_MAX + 100);
    expect(reviewTemplate(jacafe, 4, long, NOW).content).toBe(long);
  });
});

describe("removalTemplate (NIP-09)", () => {
  it("asks to delete the review by its id and by its address, and names its kind", () => {
    const review = { id: hex64("1"), pubkey: ALICE, d: `place:${JACAFE}` };
    expect(removalTemplate(review, NOW)).toEqual({
      kind: 5,
      created_at: NOW,
      content: "",
      tags: [
        ["e", review.id],
        ["a", `34259:${ALICE}:place:${JACAFE}`],
        ["k", "34259"],
      ],
    });
  });

  it("asks to delete several reviews in one: an e and an a for each, in order, and the kind once", () => {
    const first = { id: hex64("1"), pubkey: ALICE, d: `place:${JACAFE}` };
    const second = { id: hex64("2"), pubkey: ALICE, d: JACAFE };
    expect(removalTemplate([first, second], NOW)).toEqual({
      kind: 5,
      created_at: NOW,
      content: "",
      tags: [
        ["e", first.id],
        ["a", `34259:${ALICE}:place:${JACAFE}`],
        ["e", second.id],
        ["a", `34259:${ALICE}:${JACAFE}`],
        ["k", "34259"],
      ],
    });
    // One review in a list is the same as one on its own.
    expect(removalTemplate([first], NOW)).toEqual(removalTemplate(first, NOW));
  });

  it("removes the review a reviewTemplate made, and signs into a valid event", () => {
    const secret = generateSecretKey();
    const review = finalizeEvent(reviewTemplate(jacafe, 2, "", NOW), secret);
    const d = review.tags.find((tag) => tag[0] === "d")![1]!;
    const removal = finalizeEvent(removalTemplate({ id: review.id, pubkey: review.pubkey, d }, NOW + 60), secret);
    expect(verifyEvent(removal)).toBe(true);
    expect(removal.tags).toContainEqual(["e", review.id]);
    expect(removal.tags).toContainEqual(["a", `${REVIEW_KIND}:${review.pubkey}:place:${JACAFE}`]);
  });
});
