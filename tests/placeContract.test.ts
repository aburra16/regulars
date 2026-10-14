import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { parsePlaces } from "../src/places/load";
import type { RelayReader } from "../src/nostr/events";
import { reviewStamp } from "../src/review/post";
import { REVIEW_KIND } from "../src/reviews/review";
import { removalTemplate, reviewTemplate, type WholeStars } from "../src/reviews/write";
import { formatScore } from "../src/score/score";
import { ScoresStore } from "../src/score/store";
import raw from "./fixtures/funchal-items.json";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

/*
 * The checks both apps hold for the reviews of a place, as Regulars makes them: the record each app
 * writes, which reviews stand, and an edit made here of a review another app wrote. Brainstorm-UI
 * holds the same checks in the tests of its `client/src/lib/placeReviews.ts`. Records are signed with
 * keys made for each test, and read through the scores store, as the pages read them, from a review
 * relay held in memory; for a star value, with the ranks of a scorer the house names, held in memory
 * too, shaped and not signed, as the readers held in memory check no signature. Nothing opens a socket.
 */

const places: NostrEvent[] = raw;
const JACAFE = parsePlaces(places).find((place) => place.d === "osm-node-11330857543")!;

/** The review relay the store reads, held in memory. */
const SEARCH = "wss://search.brainstorm.world";
/** Where the house's list names its scorer (`config.houseTrustRelays`); a scorer made up for the test, and its relay. */
const TRUST = "wss://scores.brainstorm.world";
const SCORER = hex64("5");
const SCORER_RELAY = "wss://ranks.example.test";

/** Thursday 8 October 2026, 12:00 UTC, in seconds: the device's clock, which stands still here. */
const NOW = 1_791_460_800;

/** A photo's address, as Brainstorm puts one in a review (NIP-92); and a review's words. */
const PHOTO = "https://blossom.example/abc.jpg";
const WORDS = "Get the bolo de caco with garlic butter.";

/** Someone with a key of their own, made for the test. */
function someone() {
  const key = generateSecretKey();
  return { key, pubkey: getPublicKey(key) };
}

/** `template` signed with `key`, as a person's signer signs it. */
const signed = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array): NostrEvent => finalizeEvent({ ...template }, key);

/** A review of Jacafé, 4 stars, with the words `WORDS`, as Regulars writes it, dated `at`. */
const asRegularsWrites = (at = NOW - 86_400) => reviewTemplate(JACAFE, 4, WORDS, at);

/**
 * A review of Jacafé, 4 stars, as Brainstorm writes it in full: the record Regulars writes, then a
 * price, how the reviewer paid, a photo whose address follows the words, and the app that signed it.
 */
const asBrainstormWrites = (at = NOW - 86_400) => ({
  kind: REVIEW_KIND,
  created_at: at,
  content: `${WORDS}\n${PHOTO}`,
  tags: [
    ["d", `place:${JACAFE.address}`],
    ["a", JACAFE.address],
    ["m", "place"],
    ["rating", "0.800"],
    ["s", "4"],
    ["alt", `Review of ${JACAFE.name}: 4 of 5 stars`],
    ["price", "2"],
    ["paid", "lightning"],
    ["imeta", `url ${PHOTO}`],
    ["client", "Brainstorm"],
  ],
});

/** The stores made in a test, stopped after it. */
const stores: ScoresStore[] = [];

/** The house's list (kind 10040), naming `SCORER`; and `SCORER`'s ranks of people, each `[pubkey, rank]`. */
const houseList = () => shapedEvent({ kind: 10040, pubkey: config.houseHex, tags: [["30382:rank", SCORER, SCORER_RELAY]] });
const ranksOf = (ranks: readonly [string, number][]) =>
  ranks.map(([pubkey, rank]) => shapedEvent({ kind: 30382, pubkey: SCORER, tags: [["d", pubkey], ["rank", String(rank)]] }));

/**
 * The scores store, reading `events` from the review relay, once it has read Jacafé's reviews. With
 * `ranks`, the house names `SCORER`, who ranks people so; without, the house's view can't be had.
 * `relay` makes the review relay's reader of its own from the one over `events`.
 */
async function reading(
  events: readonly NostrEvent[],
  { ranks, relay = (reader) => reader }: { ranks?: readonly [string, number][]; relay?: (reader: RelayReader) => RelayReader } = {},
): Promise<ScoresStore> {
  config.reviewRelays = [SEARCH];
  const house: Record<string, NostrEvent[]> = ranks === undefined ? {} : { [TRUST]: [houseList()], [SCORER_RELAY]: ranksOf(ranks) };
  const store = new ScoresStore((url) => (url === SEARCH ? relay(createMemoryReader([...events])) : createMemoryReader(house[url] ?? [])));
  stores.push(store);
  store.start();
  store.want([JACAFE.address]);
  await vi.waitFor(() => expect(store.readStateOf(JACAFE.address)).toBe("read"));
  return store;
}

/**
 * The review `author` signs when they post `stars` and `words` for Jacafé here, as the review form's
 * Post makes it (src/review/usePost.ts): once the place's reviews and their removals are read, built
 * on their review of it that `store` shows, and dated after it and after any removal of theirs.
 */
async function editedHere(store: ScoresStore, author: { key: Uint8Array; pubkey: string }, stars: WholeStars, words: string): Promise<NostrEvent> {
  await store.readSettled(JACAFE.address, new AbortController().signal);
  const stamp = reviewStamp(NOW, store.ownCoordinates(author.pubkey, JACAFE.address), store.ownRemovedAt(author.pubkey, JACAFE.address));
  const previous = store.ownNewest(author.pubkey, JACAFE.address);
  return signed(reviewTemplate(JACAFE, stars, words, stamp, previous), author.key);
}

/** The tags of `ev` named `price`, `paid` or `imeta`, in order: what another app gave that Regulars does not set. */
const givenElsewhere = (ev: NostrEvent) => ev.tags.filter(([name]) => name === "price" || name === "paid" || name === "imeta");

beforeEach(() => {
  // Only the date stands still: the store's reads still take their turns.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
  vi.useRealTimers();
});

describe("the reviews of a place, as both apps read and write them", () => {
  it("reads the record Regulars writes as one review, with its stars and its words", async () => {
    const author = someone();
    const record = signed(asRegularsWrites(), author.key);
    expect(verifyEvent(record)).toBe(true);
    const store = await reading([record]);
    expect(store.reviewsOf(JACAFE.address)).toEqual([
      expect.objectContaining({ id: record.id, reviewer: author.pubkey, stars: 4, text: WORDS }),
    ]);
  });

  it("reads the record Brainstorm writes in full as one review, with its stars, and its words without the photo's address", async () => {
    const author = someone();
    const record = signed(asBrainstormWrites(), author.key);
    const store = await reading([record]);
    expect(store.reviewsOf(JACAFE.address)).toEqual([
      expect.objectContaining({ id: record.id, reviewer: author.pubkey, stars: 4, text: WORDS }),
    ]);
  });

  it("an edit made here keeps the price, payment and photo another app gave", async () => {
    const author = someone();
    const record = signed(asBrainstormWrites(), author.key);
    const store = await reading([record]);
    const [shown] = store.reviewsOf(JACAFE.address);

    const edit = await editedHere(store, author, 5, shown!.text);
    expect(givenElsewhere(edit)).toEqual(givenElsewhere(record));
    expect(givenElsewhere(edit)).toEqual([
      ["price", "2"],
      ["paid", "lightning"],
      ["imeta", `url ${PHOTO}`],
    ]);
    // The app that signed the version it replaces is not credited with this one.
    expect(edit.tags.some(([name]) => name === "client")).toBe(false);

    const after = await reading([record, edit]);
    expect(after.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: edit.id, stars: 5, text: WORDS })]);
  });

  it("reads two records of one person's for the place, a day apart, the older at the bare address as its d, as one review: the newer", async () => {
    const author = someone();
    const older = signed({ ...asRegularsWrites(NOW - 2 * 86_400), tags: [["d", JACAFE.address], ["a", JACAFE.address], ["m", "place"], ["s", "2"]] }, author.key);
    const newer = signed(asRegularsWrites(NOW - 86_400), author.key);
    const store = await reading([older, newer]);
    expect(store.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: newer.id, stars: 4 })]);
  });

  it("keeps a person's real review, and ignores theirs dated a year ahead", async () => {
    const author = someone();
    const real = signed(asRegularsWrites(), author.key);
    const ahead = signed({ ...asRegularsWrites(NOW + 365 * 86_400), content: "From next year" }, author.key);
    const store = await reading([real, ahead]);
    expect(store.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: real.id, text: WORDS })]);
  });

  it("takes a comment on the place by a third person for no review: the reviews and the star value are as they were", async () => {
    const [first, second, third] = [someone(), someone(), someone()];
    const reviews = [signed(asRegularsWrites(), first.key), signed(reviewTemplate(JACAFE, 2, WORDS, NOW - 86_400), second.key)];
    // A comment (NIP-22) on the place, with stars of its own, which a relay sends with the reviews though it was not asked for.
    const comment = signed(
      {
        kind: 1111,
        created_at: NOW - 3_600,
        content: "Five stars, best in town",
        tags: [["A", JACAFE.address], ["K", "39999"], ["a", JACAFE.address], ["k", "39999"], ["s", "5"], ["rating", "1"]],
      },
      third.key,
    );
    const ranks: [string, number][] = [
      [first.pubkey, 80],
      [second.pubkey, 30],
      [third.pubkey, 90],
    ];
    const sendingTheComment = (reader: RelayReader): RelayReader => ({
      async *req(filter, signal) {
        yield* reader.req(filter, signal);
        yield comment;
      },
    });
    const without = await reading(reviews, { ranks });
    const withIt = await reading([...reviews, comment], { ranks, relay: sendingTheComment });
    await vi.waitFor(() => expect(withIt.scoreOf(JACAFE.address)).toBeDefined());
    await vi.waitFor(() => expect(without.scoreOf(JACAFE.address)).toBeDefined());

    expect(withIt.reviewsOf(JACAFE.address).map((review) => review.id)).toEqual(without.reviewsOf(JACAFE.address).map((review) => review.id));
    expect(withIt.reviewsOf(JACAFE.address)).toHaveLength(2);
    const { score, counted, outside } = withIt.scoreOf(JACAFE.address)!;
    expect({ score, counted, outside }).toEqual({ score: without.scoreOf(JACAFE.address)!.score, counted: 2, outside: 0 });
  });

  it("shows no review once its author's removal naming it by e, by a and by k is read", async () => {
    const author = someone();
    const record = signed(asRegularsWrites(), author.key);
    const removal = signed(removalTemplate({ id: record.id, pubkey: author.pubkey, d: `place:${JACAFE.address}` }, NOW - 3_600), author.key);
    expect(removal.tags).toEqual([
      ["e", record.id],
      ["a", `${REVIEW_KIND}:${author.pubkey}:place:${JACAFE.address}`],
      ["k", String(REVIEW_KIND)],
    ]);
    const store = await reading([record, removal]);
    // The review was read; then its removal, which takes it down.
    expect(store.ownCoordinates(author.pubkey, JACAFE.address).map((review) => review.id)).toEqual([record.id]);
    await vi.waitFor(() => expect(store.reviewsOf(JACAFE.address)).toEqual([]));
  });

  it.each([
    { given: "an s of 4 beside a rating of 0.800", tags: [["s", "4"], ["rating", "0.800"]], stars: 4, as: "4 stars" },
    { given: "a rating of 4 alone", tags: [["rating", "4"]], stars: 4, as: "4 stars" },
    { given: "a rating of 0.9 alone", tags: [["rating", "0.9"]], stars: 4.5, as: "4.5 stars" },
    { given: "a rating of 0", tags: [["rating", "0"]], stars: null, as: "no stars" },
    { given: "a rating of 7", tags: [["rating", "7"]], stars: null, as: "no stars" },
  ])("reads $given as $as, and lists the review all the same", async ({ tags, stars }) => {
    const author = someone();
    const record = signed(
      {
        kind: REVIEW_KIND,
        created_at: NOW - 86_400,
        content: WORDS,
        tags: [["d", `place:${JACAFE.address}`], ["a", JACAFE.address], ["m", "place"], ...tags],
      },
      author.key,
    );
    const store = await reading([record]);
    expect(store.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: record.id, stars, text: WORDS })]);
  });

  it("gives the star value of reviewers ranked 80, 30 and 4 who gave 5, 3 and 1 stars as 4.5, the third outside and not counted", async () => {
    const [high, middle, low] = [someone(), someone(), someone()];
    const reviews = [
      signed(reviewTemplate(JACAFE, 5, WORDS, NOW - 86_400), high.key),
      signed(reviewTemplate(JACAFE, 3, WORDS, NOW - 86_400), middle.key),
      signed(reviewTemplate(JACAFE, 1, WORDS, NOW - 86_400), low.key),
    ];
    const ranks: [string, number][] = [
      [high.pubkey, 80],
      [middle.pubkey, 30],
      [low.pubkey, 4],
    ];
    const store = await reading(reviews, { ranks });

    await vi.waitFor(() => expect(store.scoreOf(JACAFE.address)).toBeDefined());
    const score = store.scoreOf(JACAFE.address)!;
    expect(score.score).toBeCloseTo((0.8 * 5 + 0.3 * 3) / 1.1, 10);
    expect(formatScore(score.score!)).toBe("4.5");
    expect(score).toMatchObject({ counted: 2, outside: 1 });
    expect(score.folded.map((review) => review.reviewer)).toEqual([low.pubkey]);
  });

  it("shows no review once its author's removal naming it by e alone is read", async () => {
    const author = someone();
    const record = signed(asRegularsWrites(), author.key);
    const removal = signed({ kind: 5, created_at: NOW - 3_600, content: "", tags: [["e", record.id]] }, author.key);
    const store = await reading([record, removal]);
    expect(store.ownCoordinates(author.pubkey, JACAFE.address).map((review) => review.id)).toEqual([record.id]);
    await vi.waitFor(() => expect(store.reviewsOf(JACAFE.address)).toEqual([]));
  });

  it("keeps a record written at a d after its author's removal through a, which takes the one before it", async () => {
    const author = someone();
    const before = signed(asRegularsWrites(NOW - 86_400), author.key);
    const removal = signed(
      { kind: 5, created_at: NOW - 3_600, content: "", tags: [["a", `${REVIEW_KIND}:${author.pubkey}:place:${JACAFE.address}`], ["k", String(REVIEW_KIND)]] },
      author.key,
    );
    const after = signed({ ...asRegularsWrites(NOW - 60), content: "Back again, and better" }, author.key);
    const store = await reading([before, removal, after]);
    // The removal is read, and held: the next review here would be dated after it.
    await vi.waitFor(() => expect(store.ownRemovedAt(author.pubkey, JACAFE.address)).toBe(NOW - 3_600));
    expect(store.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: after.id, text: "Back again, and better" })]);

    // Read without the newer record, the one before is taken down: the removal counts, and spares only
    // what was written after it.
    const without = await reading([before, removal]);
    await vi.waitFor(() => expect(without.reviewsOf(JACAFE.address)).toEqual([]));
  });

  it("dates an edit made here a second after the review it replaces when that one's clock ran ahead, and it replaces it", async () => {
    const author = someone();
    const ahead = signed(asRegularsWrites(NOW + 3_600), author.key);
    const store = await reading([ahead]);
    expect(store.reviewsOf(JACAFE.address).map((review) => review.id)).toEqual([ahead.id]);

    const edit = await editedHere(store, author, 5, "Better than last time");
    expect(edit.created_at).toBe(ahead.created_at + 1);
    expect(edit.tags.find(([name]) => name === "d")).toEqual(["d", `place:${JACAFE.address}`]);

    const after = await reading([ahead, edit]);
    expect(after.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: edit.id, stars: 5, text: "Better than last time" })]);
  });

  it("an edit made here of a review with a photo keeps the photo's address after the new words, and its imeta as it was", async () => {
    const author = someone();
    const record = signed(asBrainstormWrites(), author.key);
    const store = await reading([record]);

    const edit = await editedHere(store, author, 4, "Better than last time");
    expect(edit.content).toBe(`Better than last time\n${PHOTO}`);
    expect(edit.content.endsWith(`\n${PHOTO}`)).toBe(true);
    expect(edit.tags.filter(([name]) => name === "imeta")).toEqual(record.tags.filter(([name]) => name === "imeta"));

    const after = await reading([record, edit]);
    expect(after.reviewsOf(JACAFE.address)).toEqual([expect.objectContaining({ id: edit.id, text: "Better than last time" })]);
  });
});
