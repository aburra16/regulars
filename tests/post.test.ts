import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountChanged } from "../src/account/AccountProvider";
import { config } from "../src/config";
import type { RelayReader, RelayWriter } from "../src/nostr/events";
import { parsePlaces } from "../src/places/load";
import {
  NotPosted,
  PUBLISH_TIMEOUT_MS,
  postReview,
  reviewStamp,
  WRITE_RELAYS_WAIT_MS,
  whereToPost,
} from "../src/review/post";
import { reviewTemplate } from "../src/reviews/write";
import raw from "./fixtures/funchal-items.json";
import { shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";
import { createMemoryWriter, type MemoryWriter } from "./support/memoryWriter";

/*
 * Posting a review (M2b Task 6, ruling R12): where it goes, bounded in time; signing it with the
 * person's signer; sending it to each relay with a limit of its own; and the time it is stamped
 * with. Relays are held in memory; nothing opens a socket.
 */

const places: NostrEvent[] = raw;
const JACAFE = parsePlaces(places).find((place) => place.d === "osm-node-11330857543")!;

/** Brainstorm's search relay, where reviews are read; a relay the person writes to; and the relay-list directory. */
const SEARCH = "wss://search.brainstorm.world";
const OWN = "wss://nos.example.test";
const OTHER = "wss://other.example.test";
const DIRECTORY = "wss://purplepag.es";

const KEY = generateSecretKey();
const PUBKEY = getPublicKey(KEY);

/** A signer as an add-on is: it signs with the person's key, and can say nothing of their relays. */
function signer(): NostrSigner & { signEvent: ReturnType<typeof vi.fn> } {
  return {
    getPublicKey: async () => PUBKEY,
    // finalizeEvent writes the id, key and signature into what it is given: given a copy, the call keeps what was asked.
    signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent({ ...template }, KEY)),
  };
}

/** Writers by relay URL, from `relays`; a relay not in it has no writer, which a test should not reach. */
function writersOver(relays: Record<string, MemoryWriter>): (url: string) => RelayWriter {
  return (url) => {
    const writer = relays[url];
    if (writer === undefined) throw new Error(`No relay at ${url} in this test`);
    return writer;
  };
}

/** The review the tests post: Jacafé, 4 stars, "Get the bolo", at a fixed time. */
const template = () => reviewTemplate(JACAFE, 4, "Get the bolo", 1_800_000_000);

const run = (relays: string[], writers: (url: string) => RelayWriter, signal = new AbortController().signal, by = signer()) =>
  postReview(template(), by, relays, signal, writers);

afterEach(() => {
  vi.useRealTimers();
});

describe("postReview", () => {
  beforeEach(() => {
    config.reviewRelays = [SEARCH];
  });

  it("signs the review once with the person's signer, and sends that event to every relay", async () => {
    const search = createMemoryWriter();
    const own = createMemoryWriter();
    const by = signer();

    const posted = await run([SEARCH, OWN], writersOver({ [SEARCH]: search, [OWN]: own }), undefined, by);

    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(by.signEvent).toHaveBeenCalledWith(template());
    expect(verifyEvent(posted.event)).toBe(true);
    expect(posted.event).toMatchObject({ ...template(), pubkey: PUBKEY });
    expect(search.published).toEqual([posted.event]);
    expect(own.published).toEqual([posted.event]);
    expect(posted.accepted).toEqual([SEARCH, OWN]);
    expect(posted.refused).toEqual({});
  });

  it("is posted when one relay takes it and another refuses, and says which did which", async () => {
    const posted = await run(
      [SEARCH, OWN],
      writersOver({ [SEARCH]: createMemoryWriter(), [OWN]: createMemoryWriter({ refuse: "blocked: not on the list" }) }),
    );
    expect(posted.accepted).toEqual([SEARCH]);
    expect(posted.refused).toEqual({ [OWN]: "blocked: not on the list" });
  });

  it("is not posted when only the person's own relays take it: no review relay has it (R13)", async () => {
    const posting = run(
      [SEARCH, OWN],
      writersOver({ [SEARCH]: createMemoryWriter({ refuse: "rate-limited" }), [OWN]: createMemoryWriter() }),
    );
    await expect(posting).rejects.toBeInstanceOf(NotPosted);
    // What each relay did is said, so the form can say where it went.
    await expect(posting).rejects.toMatchObject({ accepted: [OWN], refused: { [SEARCH]: "rate-limited" } });
  });

  it("knows a review relay however its address is written", async () => {
    config.reviewRelays = ["wss://Search.Brainstorm.world/"];
    const posted = await run([SEARCH, OWN], writersOver({ [SEARCH]: createMemoryWriter(), [OWN]: createMemoryWriter() }));
    expect(posted.accepted).toEqual([SEARCH, OWN]);
  });

  it.each([
    ["its time", { created_at: 1_800_000_009 }],
    ["its words", { content: "Something else" }],
    ["its tags", { tags: [["d", "place:other"]] }],
    ["its kind", { kind: 1 }],
  ])("is not posted, and nothing is sent, when the signer changes %s", async (_, change) => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) => finalizeEvent({ ...asked, ...change }, KEY));
    const search = createMemoryWriter();
    await expect(run([SEARCH], writersOver({ [SEARCH]: search }), undefined, by)).rejects.toBeInstanceOf(NotPosted);
    expect(search.published).toEqual([]);
  });

  it("fails with what each relay said when every relay refuses", async () => {
    const posting = run(
      [SEARCH, OWN],
      writersOver({ [SEARCH]: createMemoryWriter({ refuse: "invalid: bad tag" }), [OWN]: createMemoryWriter({ refuse: "blocked" }) }),
    );
    await expect(posting).rejects.toBeInstanceOf(NotPosted);
    await expect(posting).rejects.toMatchObject({ refused: { [SEARCH]: "invalid: bad tag", [OWN]: "blocked" } });
  });

  it("fails when a writer cannot be made for a relay, as when it refuses", async () => {
    const posting = run([OTHER], writersOver({}));
    await expect(posting).rejects.toBeInstanceOf(NotPosted);
  });

  it("gives up on relays still silent when its one limit for them all is reached, and keeps what the others said", async () => {
    vi.useFakeTimers();
    const silent = createMemoryWriter({ silent: true });
    const search = createMemoryWriter();
    let outcome: Awaited<ReturnType<typeof postReview>> | undefined;
    void run([SEARCH, OWN], writersOver({ [SEARCH]: search, [OWN]: silent })).then((posted) => {
      outcome = posted;
    });

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    expect(silent.signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(silent.signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(outcome).toBeDefined());
    expect(outcome!.accepted).toEqual([SEARCH]);
    expect(Object.keys(outcome!.refused)).toEqual([OWN]);
    expect(PUBLISH_TIMEOUT_MS).toBe(12_000);
  });

  it("sends to every relay at once, under that one limit: none waits for another", async () => {
    vi.useFakeTimers();
    const first = createMemoryWriter({ silent: true });
    const second = createMemoryWriter({ silent: true });
    const posting = run([SEARCH, OWN], writersOver({ [SEARCH]: first, [OWN]: second }));
    posting.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    // Both are being sent to before either has answered.
    expect(first.published).toHaveLength(1);
    expect(second.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - 1);
    expect(first.signals[0]?.aborted || second.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(posting).rejects.toBeInstanceOf(NotPosted);
    expect(first.signals[0]?.aborted && second.signals[0]?.aborted).toBe(true);
  });

  it("fails with nowhere to send it, and asks nobody to sign", async () => {
    const by = signer();
    await expect(run([], writersOver({}), undefined, by)).rejects.toBeInstanceOf(NotPosted);
    expect(by.signEvent).not.toHaveBeenCalled();
  });

  it("passes on a signer's AccountChanged as it is, so the form can send the person to sign in", async () => {
    const by = signer();
    by.signEvent.mockRejectedValueOnce(new AccountChanged());
    const search = createMemoryWriter();
    await expect(run([SEARCH], writersOver({ [SEARCH]: search }), undefined, by)).rejects.toBeInstanceOf(AccountChanged);
    expect(search.published).toEqual([]);
  });

  it("stops when its signal aborts, with the signal's reason, and stops the relays it was sending to", async () => {
    const controller = new AbortController();
    const silent = createMemoryWriter({ silent: true });
    const posting = run([SEARCH], writersOver({ [SEARCH]: silent }), controller.signal);
    await vi.waitFor(() => expect(silent.signals).toHaveLength(1));
    const reason = new Error("The person closed the form");
    controller.abort(reason);
    await expect(posting).rejects.toBe(reason);
    expect(silent.signals[0]?.aborted).toBe(true);
  });
});

describe("whereToPost", () => {
  /** The person's relay list (kind 10002), writing to `urls`. */
  const listOf = (urls: string[]) => shapedEvent({ kind: 10002, pubkey: PUBKEY, tags: urls.map((url) => ["r", url]) });

  /** A reader that never answers: it waits until its signal aborts. */
  const silentReader: RelayReader = {
    async *req(_filter, signal) {
      await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };

  beforeEach(() => {
    config.reviewRelays = [SEARCH];
  });

  it("is the review relays and the relays the person's list writes to", async () => {
    const readers = (url: string) => createMemoryReader(url === DIRECTORY ? [listOf([OWN])] : []);
    expect(await whereToPost(PUBKEY, signer(), readers, new AbortController().signal)).toEqual([SEARCH, OWN]);
  });

  it("is the review relays alone when the lists are not read within its limit", async () => {
    vi.useFakeTimers();
    const readers = (url: string) => (url === DIRECTORY ? silentReader : createMemoryReader([]));
    let where: string[] | undefined;
    void whereToPost(PUBKEY, signer(), readers, new AbortController().signal).then((relays) => {
      where = relays;
    });
    await vi.advanceTimersByTimeAsync(WRITE_RELAYS_WAIT_MS - 1);
    expect(where).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(where).toEqual([SEARCH]));
    expect(WRITE_RELAYS_WAIT_MS).toBe(4_000);
  });

  it("is nowhere when there are no review relays and the person has no list", async () => {
    config.reviewRelays = [];
    expect(await whereToPost(PUBKEY, signer(), () => createMemoryReader([]), new AbortController().signal)).toEqual([]);
  });

  it("fails only when its signal aborts, with the signal's reason", async () => {
    const controller = new AbortController();
    const where = whereToPost(PUBKEY, signer(), () => silentReader, controller.signal);
    const reason = new Error("The person closed the form");
    controller.abort(reason);
    await expect(where).rejects.toBe(reason);
  });
});

describe("reviewStamp", () => {
  const NOW = 1_800_000_000;

  it("is now, for a first review", () => {
    expect(reviewStamp(NOW, [], undefined)).toBe(NOW);
  });

  it("is a second after the person's newest review of the place, when that is now or later: an edit in the same second still replaces it", () => {
    expect(reviewStamp(NOW, [{ createdAt: NOW }], undefined)).toBe(NOW + 1);
    expect(reviewStamp(NOW, [{ createdAt: NOW + 5 }, { createdAt: NOW - 100 }], undefined)).toBe(NOW + 6);
    expect(reviewStamp(NOW, [{ createdAt: NOW - 100 }], undefined)).toBe(NOW);
  });

  it("is a second after the person's last removal of a review of the place, which would otherwise take the new one too", () => {
    expect(reviewStamp(NOW, [], NOW)).toBe(NOW + 1);
    expect(reviewStamp(NOW, [{ createdAt: NOW + 1 }], NOW + 3)).toBe(NOW + 4);
    expect(reviewStamp(NOW, [], NOW - 10)).toBe(NOW);
  });
});
