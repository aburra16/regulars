import type { NostrEvent } from "@nostrify/nostrify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import type { RelayReader } from "../src/places/load";
import { fetchRanks, ranksFrom, resolveScorer, scorerFrom, weightOf } from "../src/trust/houseWeights";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

const HOUSE = config.houseHex;
// Made-up scorers: the house's real one is never written into the app or its tests.
const SCORER = hex64("5");
const OTHER_SCORER = hex64("6");
const SCORES_RELAY = "wss://scores.example.test";
const ALICE = hex64("a");
const BOB = hex64("b");

/** A kind 10040 by the house, shaped like its real one, naming `SCORER` unless `tags` say otherwise. */
const trustList = (fields: Partial<NostrEvent> = {}): NostrEvent =>
  shapedEvent({
    kind: 10040,
    pubkey: HOUSE,
    tags: [
      ["30382:rank", SCORER, SCORES_RELAY],
      ["30382:followers", SCORER, SCORES_RELAY],
      ["client", "Brainstorm"],
    ],
    ...fields,
  });

/** A kind 30382 by `SCORER` giving `subject` the rank `rank`, shaped like a real one. */
const rankOf = (subject: string, rank: string, fields: Partial<NostrEvent> = {}): NostrEvent =>
  shapedEvent({
    kind: 30382,
    pubkey: SCORER,
    tags: [
      ["d", subject],
      ["rank", rank],
      ["followers", "9"],
      ["reporters", "0"],
      ["muters", "0"],
      ["hops", "4"],
    ],
    ...fields,
  });

describe("scorerFrom", () => {
  it("reads the scorer and its relay from the house's 10040", () => {
    expect(scorerFrom([trustList()], HOUSE)).toEqual({ pubkey: SCORER, relay: SCORES_RELAY });
  });

  it("follows the house's newest 10040, in whatever order they come", () => {
    const older = trustList({ created_at: 1_700_000_000, tags: [["30382:rank", OTHER_SCORER, SCORES_RELAY]] });
    const newer = trustList({ created_at: 1_700_000_100 });
    expect(scorerFrom([older, newer], HOUSE)?.pubkey).toBe(SCORER);
    expect(scorerFrom([newer, older], HOUSE)?.pubkey).toBe(SCORER);
  });

  it("follows the lower id of two 10040s made in the same second", () => {
    const low = trustList({ id: hex64("1") });
    const high = trustList({ id: hex64("2"), tags: [["30382:rank", OTHER_SCORER, SCORES_RELAY]] });
    expect(scorerFrom([high, low], HOUSE)?.pubkey).toBe(SCORER);
  });

  it("ignores a 10040 by anyone but the house, however new", () => {
    const stranger = trustList({
      pubkey: hex64("c"),
      created_at: 1_800_000_000,
      tags: [["30382:rank", OTHER_SCORER, SCORES_RELAY]],
    });
    expect(scorerFrom([trustList(), stranger], HOUSE)?.pubkey).toBe(SCORER);
    expect(scorerFrom([stranger], HOUSE)).toBeNull();
  });

  it("reads the first 30382:rank tag", () => {
    const tags = [
      ["30382:followers", OTHER_SCORER, SCORES_RELAY],
      ["30382:rank", SCORER, SCORES_RELAY],
      ["30382:rank", OTHER_SCORER, SCORES_RELAY],
    ];
    expect(scorerFrom([trustList({ tags })], HOUSE)?.pubkey).toBe(SCORER);
  });

  it("names no scorer when the tag's scorer is not a hex key, or its relay not a ws or wss URL", () => {
    for (const tag of [
      ["30382:rank", "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8", SCORES_RELAY],
      ["30382:rank", hex64("e").toUpperCase(), SCORES_RELAY],
      ["30382:rank", SCORER, "https://scores.example.test"],
      ["30382:rank", SCORER, "scores.example.test"],
      ["30382:rank", SCORER],
    ]) {
      expect(scorerFrom([trustList({ tags: [tag] })], HOUSE), tag.join(" ")).toBeNull();
    }
  });

  it("names no scorer when the house's newest 10040 names none, though an older one did", () => {
    const older = trustList({ created_at: 1_700_000_000 });
    const newer = trustList({ created_at: 1_700_000_100, tags: [["client", "Brainstorm"]] });
    expect(scorerFrom([older, newer], HOUSE)).toBeNull();
  });

  it("names no scorer from nothing, or from values that are not the house's 10040", () => {
    expect(scorerFrom([], HOUSE)).toBeNull();
    expect(scorerFrom([null, "10040", { ...trustList(), sig: "nope" }, trustList({ kind: 10041 })], HOUSE)).toBeNull();
  });
});

describe("ranksFrom", () => {
  it("reads each reviewer's rank from the scorer's 30382s", () => {
    expect(ranksFrom([rankOf(ALICE, "80"), rankOf(BOB, "6")], SCORER)).toEqual(
      new Map([
        [ALICE, 80],
        [BOB, 6],
      ]),
    );
  });

  it("keeps ranks from 0 to 100, ends included", () => {
    expect(ranksFrom([rankOf(ALICE, "0"), rankOf(BOB, "100")], SCORER)).toEqual(
      new Map([
        [ALICE, 0],
        [BOB, 100],
      ]),
    );
    expect(ranksFrom([rankOf(ALICE, "12.5")], SCORER).get(ALICE)).toBe(12.5);
  });

  it("leaves out a rank that is not a number from 0 to 100, with no NaN anywhere (Review Focus 1)", () => {
    for (const rank of ["abc", "-1", "101", "", " ", "NaN", "Infinity", "0x10", "1e1", " 50", "50 "]) {
      const ranks = ranksFrom([rankOf(ALICE, rank)], SCORER);
      expect(ranks.has(ALICE), JSON.stringify(rank)).toBe(false);
    }
    const missing = rankOf(ALICE, "80", { tags: [["d", ALICE]] });
    expect(ranksFrom([missing], SCORER).size).toBe(0);
  });

  it("keeps the newest 30382 for each reviewer, in whatever order they come", () => {
    const older = rankOf(ALICE, "80", { created_at: 1_700_000_000 });
    const newer = rankOf(ALICE, "30", { created_at: 1_700_000_100 });
    expect(ranksFrom([older, newer], SCORER).get(ALICE)).toBe(30);
    expect(ranksFrom([newer, older], SCORER).get(ALICE)).toBe(30);
  });

  it("leaves a reviewer out when their newest 30382 has a bad rank, though an older one was good", () => {
    const older = rankOf(ALICE, "80", { created_at: 1_700_000_000 });
    const newer = rankOf(ALICE, "abc", { created_at: 1_700_000_100 });
    expect(ranksFrom([older, newer], SCORER).has(ALICE)).toBe(false);
  });

  it("reads only the scorer's 30382s about a public key", () => {
    const values = [
      rankOf(ALICE, "80", { pubkey: OTHER_SCORER }),
      rankOf(ALICE, "80", { kind: 30383 }),
      rankOf("not-a-key", "80"),
      rankOf(ALICE, "80", { tags: [["rank", "80"]] }),
      null,
      { ...rankOf(BOB, "80"), sig: "nope" },
    ];
    expect(ranksFrom(values, SCORER).size).toBe(0);
  });
});

describe("weightOf", () => {
  it("is 0 for a reviewer the scorer has not ranked", () => {
    expect(weightOf(undefined, 2)).toBe(0);
  });

  it("is 0 below the line", () => {
    expect(weightOf(1, 2)).toBe(0);
    expect(weightOf(0, 2)).toBe(0);
  });

  it("is the rank out of 100 from the line up", () => {
    expect(weightOf(2, 2)).toBe(0.02);
    expect(weightOf(80, 2)).toBe(0.8);
    expect(weightOf(100, 2)).toBe(1);
  });

  it("is 0, never NaN, for a rank that is not one", () => {
    expect(weightOf(Number.NaN, 2)).toBe(0);
    expect(weightOf(101, 2)).toBe(0);
  });
});

describe("fetchRanks", () => {
  const signal = new AbortController().signal;

  it("asks for 500 reviewers at a time: 1,200 in three requests", async () => {
    const pubkeys = Array.from({ length: 1200 }, (_, n) => n.toString(16).padStart(64, "0"));
    const reader = createMemoryReader([]);
    await fetchRanks(reader, SCORER, pubkeys, signal);

    expect(reader.requests.map((filter) => filter["#d"]?.length)).toEqual([500, 500, 200]);
    for (const filter of reader.requests) {
      expect(filter).toMatchObject({ kinds: [30382], authors: [SCORER] });
      expect(filter.limit).toBe(filter["#d"]?.length);
    }
    expect(reader.requests.flatMap((filter) => filter["#d"])).toEqual(pubkeys);
  });

  it("gives the ranks the relay sends back, for every batch", async () => {
    const pubkeys = Array.from({ length: 600 }, (_, n) => n.toString(16).padStart(64, "0"));
    const first = pubkeys[0]!;
    const last = pubkeys[599]!;
    const reader = createMemoryReader([rankOf(first, "80"), rankOf(last, "6"), rankOf(ALICE, "50")]);
    const ranks = await fetchRanks(reader, SCORER, pubkeys, signal);
    expect(ranks).toEqual(
      new Map([
        [first, 80],
        [last, 6],
      ]),
    );
  });

  it("asks for each reviewer once, and asks nothing for no reviewers", async () => {
    const reader = createMemoryReader([]);
    await fetchRanks(reader, SCORER, [ALICE, BOB, ALICE], signal);
    expect(reader.requests.map((filter) => filter["#d"])).toEqual([[ALICE, BOB]]);

    const idle = createMemoryReader([]);
    expect(await fetchRanks(idle, SCORER, [], signal)).toEqual(new Map());
    expect(idle.requests).toHaveLength(0);
  });

  it("fails when the relay fails, so the caller can say the house's view is unavailable", async () => {
    const reader = createMemoryReader([], { failWith: new Error("scores relay down") });
    await expect(fetchRanks(reader, SCORER, [ALICE], signal)).rejects.toThrow("scores relay down");
  });
});

describe("resolveScorer", () => {
  const houseTrustRelays = config.houseTrustRelays;
  const signal = new AbortController().signal;

  afterEach(() => {
    config.houseTrustRelays = houseTrustRelays;
  });

  /** Readers by URL, over the given events; a relay not listed holds nothing. */
  function readersOver(byUrl: Record<string, RelayReader>) {
    const made: string[] = [];
    const readers = vi.fn((url: string) => {
      made.push(url);
      return byUrl[url] ?? createMemoryReader([]);
    });
    return { readers, made };
  }

  it("uses the development scorer without asking any relay, when one is set", async () => {
    config.devScorer = { pubkey: OTHER_SCORER, relay: "ws://localhost:10547" };
    const { readers } = readersOver({});
    expect(await resolveScorer(readers, signal)).toEqual(config.devScorer);
    expect(readers).not.toHaveBeenCalled();
  });

  it("reads the house's newest 10040 from the house's trust relays", async () => {
    const reader = createMemoryReader([trustList()]);
    const { readers, made } = readersOver({ [config.houseTrustRelays[0]!]: reader });
    expect(await resolveScorer(readers, signal)).toEqual({ pubkey: SCORER, relay: SCORES_RELAY });
    expect(made).toEqual(["wss://scores.brainstorm.world"]);
    expect(reader.requests).toEqual([{ kinds: [10040], authors: [HOUSE], limit: 1 }]);
  });

  it("is null when no relay has the house's 10040 (Review Focus 4)", async () => {
    const { readers } = readersOver({});
    expect(await resolveScorer(readers, signal)).toBeNull();
  });

  it("is null, and does not throw, when the relay fails (Review Focus 4)", async () => {
    const down = createMemoryReader([trustList()], { failWith: new Error("scores relay down") });
    const { readers } = readersOver({ [config.houseTrustRelays[0]!]: down });
    expect(await resolveScorer(readers, signal)).toBeNull();
  });

  it("is null, and does not throw, when a reader cannot be made", async () => {
    const readers = () => {
      throw new Error("no such relay");
    };
    expect(await resolveScorer(readers, signal)).toBeNull();
  });

  it("finds the scorer on one relay when another is down", async () => {
    config.houseTrustRelays = ["wss://down.example.test", "wss://up.example.test"];
    const { readers } = readersOver({
      "wss://down.example.test": createMemoryReader([], { failWith: new Error("down") }),
      "wss://up.example.test": createMemoryReader([trustList()]),
    });
    expect(await resolveScorer(readers, signal)).toEqual({ pubkey: SCORER, relay: SCORES_RELAY });
  });

  it("ends with the caller's reason when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("unmounted");
    controller.abort(reason);
    const { readers } = readersOver({ [config.houseTrustRelays[0]!]: createMemoryReader([trustList()]) });
    await expect(resolveScorer(readers, controller.signal)).rejects.toBe(reason);
  });
});
