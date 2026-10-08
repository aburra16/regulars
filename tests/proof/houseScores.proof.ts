/**
 * House scores, end to end, on a relay on this machine (README, "House scores, locally").
 *
 * Throwaway keys, made here and never written anywhere, play the house H, its scorer S and four
 * reviewers. H names S in a kind 10040, S ranks the reviewers in kind 30382 events, and the
 * reviewers review two real places from tests/fixtures/funchal-items.json in kind 34259 events. All
 * of it is published to the local relay, then read back through the app's own reader and scored by
 * the app's own code. The places' events themselves are not published: only their addresses are used.
 *
 * The relay also holds tests/fixtures/forged-reviews.jsonl, two reviews whose signature is not by
 * the reviewer they name, loaded when it starts: it checks what is published to it, not what it
 * loads. S ranks their reviewer high, so they would move both scores if the reader let them through.
 *
 * Not part of `npm test`: run it with `npm run proof:house-scores` (vitest.proof.config.ts).
 */
import { type NostrEvent, type NostrFilter, NRelay1 } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { config } from "../../src/config";
import type { RelayReader } from "../../src/nostr/events";
import { CONNECT_TIMEOUT_MS, readerFor } from "../../src/nostr/relayReader";
import { parsePlace, type Place } from "../../src/places/place";
import { latestReviews, REVIEW_KIND, type Review } from "../../src/reviews/review";
import { formatScore, type PlaceScore, scorePlace } from "../../src/score/score";
import { fetchRanks, type Scorer, scorerFrom, weightOf } from "../../src/trust/houseWeights";
import raw from "../fixtures/funchal-items.json";
import forgedText from "../fixtures/forged-reviews.jsonl?raw";
import { assertLocal } from "./local";

/** The relay to publish to and read from: `nak serve` listens here unless told otherwise. */
const RELAY = process.env.PROOF_RELAY?.trim() || "ws://localhost:10547";
// Before anything else, and so before any connection: test events go to this machine only.
assertLocal(RELAY);

/** How to start the relay the proof expects. */
const START = "nak serve --events tests/fixtures/forged-reviews.jsonl";

/** The list in which an account names its scorers (NIP-85), and a scorer's rank of one person. */
const TRUST_LIST_KIND = 10040;
const RANK_KIND = 30382;

/** Nothing aborts the reads but the reader's own limits, which name the relay when they do. */
const signal = new AbortController().signal;

/** The first two real places of the fixture: Jacafé and Loft Brunch & Cocktails. */
function fixturePlaces(): [Place, Place] {
  const [first, second] = (raw as NostrEvent[]).map((ev) => parsePlace(ev, config.headerCoordinate));
  if (!first || !second) throw new Error("tests/fixtures/funchal-items.json no longer starts with two places");
  return [first, second];
}
const [place1, place2] = fixturePlaces();

/** A throwaway key and its public key. The secret key lives in this process only. */
function throwaway(): { sk: Uint8Array; pk: string } {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}
const house = throwaway();
const scorer = throwaway();
const [a, b, c, d] = [throwaway(), throwaway(), throwaway(), throwaway()];

/** The reviewer the forged reviews name, and the reviews as the relay loaded them. */
const forgedEvents: NostrEvent[] = forgedText
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as NostrEvent);
const forger = forgedEvents[0]?.pubkey;
if (forger === undefined || forgedEvents.some((ev) => ev.pubkey !== forger)) {
  throw new Error("tests/fixtures/forged-reviews.jsonl must hold reviews by one reviewer");
}

const now = Math.floor(Date.now() / 1000);

const sign = (sk: Uint8Array, kind: number, tags: string[][], content = "", createdAt = now): NostrEvent =>
  finalizeEvent({ kind, created_at: createdAt, tags, content }, sk);

/** A review as brief § 4.1 writes one: the place's address as `d` and `a`, and stars both ways. */
const review = (sk: Uint8Array, place: Place, stars: number, createdAt = now): NostrEvent =>
  sign(
    sk,
    REVIEW_KIND,
    [
      ["d", place.address],
      ["a", place.address],
      ["m", "place"],
      ["rating", (stars / 5).toFixed(3)],
      ["s", String(stars)],
      ["alt", `Review of ${place.name}: ${stars} of 5 stars`],
    ],
    `Proof review: ${stars} of 5 stars.`,
    createdAt,
  );

const rank = (subject: string, value: number): NostrEvent =>
  sign(scorer.sk, RANK_KIND, [
    ["d", subject],
    ["rank", String(value)],
  ]);

/** What the proof publishes, in this order: B's newer review of place 1 replaces the older one. */
const published: { what: string; event: NostrEvent }[] = [
  { what: "H's kind 10040", event: sign(house.sk, TRUST_LIST_KIND, [["30382:rank", scorer.pk, RELAY]]) },
  { what: "S's rank of A", event: rank(a.pk, 80) },
  { what: "S's rank of B", event: rank(b.pk, 30) },
  { what: "S's rank of C", event: rank(c.pk, 1) },
  // D has no rank. The forged reviews' reviewer has a high one, so they would count if they got in.
  { what: "S's rank of the forged reviews' reviewer", event: rank(forger, 90) },
  { what: "A's review of place 1", event: review(a.sk, place1, 5) },
  { what: "B's older review of place 1", event: review(b.sk, place1, 1, now - 60) },
  { what: "B's newer review of place 1", event: review(b.sk, place1, 3) },
  { what: "C's review of place 1", event: review(c.sk, place1, 1) },
  { what: "D's review of place 1", event: review(d.sk, place1, 4) },
  { what: "C's review of place 2", event: review(c.sk, place2, 5) },
];

/**
 * Opens and closes one connection to `url`. NRelay1 retries a relay that is not there without a
 * word, so without this a missing relay would show only when the first publish timed out.
 */
function preflight(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    // The first of these settles the promise. Closing a socket that has failed fails it again, so
    // only an open socket, or one still trying, is closed.
    const timer = setTimeout(() => {
      reject(new Error(`${url} did not answer within ${CONNECT_TIMEOUT_MS / 1000} s. Start a relay with: ${START}`));
      socket.close();
    }, CONNECT_TIMEOUT_MS);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
        socket.close();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${url}: is a local relay running? Start one with: ${START}`));
      },
      { once: true },
    );
  });
}

/** Publishes `published` to `url`, one event at a time, each acknowledged before the next. */
async function publishAll(url: string): Promise<void> {
  const relay = new NRelay1(url);
  try {
    for (const { what, event } of published) {
      try {
        await relay.event(event, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      } catch (error) {
        throw new Error(`${url} did not take ${what}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }
  } finally {
    await relay.close().catch(() => {});
  }
}

async function readAll(reader: RelayReader, filter: NostrFilter): Promise<NostrEvent[]> {
  const events: NostrEvent[] = [];
  for await (const event of reader.req(filter, signal)) events.push(event);
  return events;
}

/** Reviews of the two places by this run's reviewers and the forged reviews' one, not earlier runs'. */
const reviewFilter: NostrFilter = {
  kinds: [REVIEW_KIND],
  "#d": [place1.address, place2.address],
  authors: [a.pk, b.pk, c.pk, d.pk, forger],
};

/** Everything read back, filled in by `beforeAll`. */
let resolved: Scorer | null = null;
let reviews: Review[] = [];
let ranks = new Map<string, number>();
let unverifiedEvents: NostrEvent[] = [];
let forgerRank: number | undefined;

const weight = (pubkey: string) => weightOf(ranks.get(pubkey), config.scoring.line);
const scoreOf = (list: readonly Review[], place: Place, by: (pubkey: string) => number): PlaceScore =>
  scorePlace(
    list.filter((r) => r.address === place.address),
    by,
    config.scoring,
  );
const reviewersOf = (list: readonly Review[]) => list.map((r) => r.reviewer).sort();
const sorted = (...pubkeys: string[]) => [...pubkeys].sort();

describe(`house scores on ${RELAY}`, () => {
  beforeAll(async () => {
    await preflight(RELAY);
    await publishAll(RELAY);

    // The scorer, as the house names it, read through the reader the app uses for every relay but
    // the places relay: it checks signatures.
    const lists = await readAll(readerFor(RELAY), { kinds: [TRUST_LIST_KIND], authors: [house.pk], limit: 1 });
    resolved = scorerFrom(lists, house.pk);
    if (resolved === null) throw new Error(`${RELAY} did not send back the house's kind 10040`);

    reviews = latestReviews(await readAll(readerFor(RELAY), reviewFilter));

    // The ranks come from the relay the house's list names, which must be on this machine too.
    assertLocal(resolved.relay);
    const scorerReader = readerFor(resolved.relay);
    ranks = await fetchRanks(
      scorerReader,
      resolved.pubkey,
      reviews.map((r) => r.reviewer),
      signal,
    );

    // The same reviews with signatures unchecked, as the relay serves them, for the forged ones.
    unverifiedEvents = await readAll(readerFor(RELAY, { verify: false }), reviewFilter);
    forgerRank = (await fetchRanks(scorerReader, resolved.pubkey, [forger], signal)).get(forger);
  });

  /** How many of the four checks below have passed: "Proof passed" only when all have. */
  let proven = 0;
  afterAll(() => {
    if (proven < 4) return;
    if (process.env.PROOF_KEEP === "1") {
      console.log("For a browser check, in .env.local:");
      console.log(`VITE_REVIEW_RELAYS=${RELAY}`);
      console.log(`VITE_DEV_SCORER=${scorer.pk}@${RELAY}`);
    }
    console.log("Proof passed");
  });

  it("finds the scorer the house names", () => {
    expect(resolved).toEqual({ pubkey: scorer.pk, relay: RELAY });
    console.log(`Scorer: ${scorer.pk}, on ${RELAY}, as the house's kind 10040 names it`);
    proven += 1;
  });

  it("scores place 1 from the two reviewers the house trusts, and folds the other two", () => {
    const result = scoreOf(reviews, place1, weight);

    expect(result.score).toBeCloseTo((0.8 * 5 + 0.3 * 3) / 1.1, 10);
    expect(formatScore(result.score!)).toBe("4.5");
    expect(result.counted).toBe(2);
    expect(reviewersOf(result.inside)).toEqual(sorted(a.pk, b.pk));
    // C is below the line (rank 1, under the line of 5); D has no rank.
    expect(result.outside).toBe(2);
    expect(reviewersOf(result.folded)).toEqual(sorted(c.pk, d.pk));
    // B reviewed it twice: only the newer review, of 3 stars, counts.
    const byB = reviews.filter((r) => r.reviewer === b.pk && r.address === place1.address);
    expect(byB.map((r) => r.stars)).toEqual([3]);

    console.log(
      `${place1.name} (${place1.address}): ${formatScore(result.score!)}, ` +
        `from ${result.counted} counted; ${result.outside} folded`,
    );
    proven += 1;
  });

  it("gives place 2 no score: its one reviewer is below the line", () => {
    const result = scoreOf(reviews, place2, weight);

    expect(result.score).toBeNull();
    expect(result.counted).toBe(0);
    expect(result.outside).toBe(1);
    expect(reviewersOf(result.folded)).toEqual([c.pk]);

    console.log(`${place2.name} (${place2.address}): no score; ${result.outside} folded`);
    proven += 1;
  });

  it("drops forged reviews that the relay serves", () => {
    const ids = (events: readonly NostrEvent[]) => events.map((ev) => ev.id).sort();
    const served = unverifiedEvents.filter((ev) => ev.pubkey === forger);
    expect(ids(served), `${RELAY} does not hold the forged reviews. Start it with: ${START}`).toEqual(
      ids(forgedEvents),
    );
    for (const ev of served) {
      // Well formed, with the right id: only the signature is wrong.
      expect(getEventHash(ev)).toBe(ev.id);
      expect(verifyEvent(ev)).toBe(false);
    }

    // Through the reader, which checks signatures: not there, so in no score.
    const through = reviews.filter((r) => r.reviewer === forger);
    expect(through).toEqual([]);

    // Had they got through, the house's view would count their reviewer, and both scores would move.
    expect(forgerRank).toBe(90);
    const unchecked = latestReviews(unverifiedEvents);
    const withForger = (pubkey: string) =>
      pubkey === forger ? weightOf(forgerRank, config.scoring.line) : weight(pubkey);
    expect(scoreOf(unchecked, place2, withForger).score).toBe(1);
    const place1Score = scoreOf(reviews, place1, weight).score!;
    expect(scoreOf(unchecked, place1, withForger).score).not.toBeCloseTo(place1Score, 1);

    console.log(
      `Forged reviews: ${served.length} on the relay, ${through.length} through the reader; ` +
        `unchecked, ${place2.name} would score 1.0`,
    );
    proven += 1;
  });
});
