import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { parsePlaces } from "../src/places/load";
import { parseReview, REVIEW_KIND } from "../src/reviews/review";
import { removalTemplate, reviewTemplate } from "../src/reviews/write";
import raw from "./fixtures/funchal-items.json";
import { hex64 } from "./support/events";

const fixtures: NostrEvent[] = raw;
const jacafe = parsePlaces(fixtures).find((place) => place.name === "Jacafé")!;

const FILER = "4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64";
const JACAFE = `39999:${FILER}:osm-node-11330857543`;
const NOW = 1_790_000_000;
const ALICE = hex64("a");

describe("reviewTemplate (decision 17)", () => {
  it("writes a review of Jacafé: its d, a, m, rating, s and alt, and the words", () => {
    expect(jacafe.address).toBe(JACAFE);
    expect(reviewTemplate(jacafe, 4, "Get the bolo", NOW)).toEqual({
      kind: 34259,
      created_at: NOW,
      content: "Get the bolo",
      tags: [
        ["d", `place:${JACAFE}`],
        ["a", JACAFE],
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
