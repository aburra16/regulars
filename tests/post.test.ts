import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountChanged } from "../src/account/AccountProvider";
import { config } from "../src/config";
import type { RelayReader, RelayWriter } from "../src/nostr/events";
import { parsePlaces } from "../src/places/load";
import {
  NotPosted,
  type Posted,
  PUBLISH_TIMEOUT_MS,
  postReview,
  REVIEW_RELAY_PATIENCE_MS,
  REVIEW_RELAY_TRIES,
  REVIEW_RELAY_WAITS_MS,
  removalRelays,
  removeReview,
  reviewStamp,
  SIGN_TIMEOUT_MS,
  SLOW_POST_MS,
  type SendOptions,
  sendReview,
  WRITE_RELAYS_WAIT_MS,
  whereToPost,
} from "../src/review/post";
import { removalTemplate, reviewTemplate } from "../src/reviews/write";
import raw from "./fixtures/funchal-items.json";
import { shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";
import { createMemoryWriter, type MemoryWriter } from "./support/memoryWriter";
import { postWarnings, quietPostWarnings } from "./support/postWarnings";

/*
 * Posting a review (M2b Task 6, rulings R12 to R14): where it goes, bounded in time; signing it with
 * the person's signer; sending it to every relay at once, posted as soon as a review relay takes it,
 * the others going on; patient with a review relay that is slow or fails for now, and trying it again
 * (ruling P1); and the time it is stamped with. Relays are held in memory; nothing opens a socket.
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
  postReview(template(), by, relays, signal, { writers });

/** The relays' warnings, kept off the output of every test here: a test that looks at them takes them from this. */
let warnings: ReturnType<typeof quietPostWarnings>;

beforeEach(() => {
  warnings = quietPostWarnings();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    await posted.settled;
    expect(posted.accepted).toEqual([SEARCH, OWN]);
    expect(posted.refused).toEqual({});
  });

  it("gives the signer 60 seconds when asked to (an add-on), then is not posted, and nothing is sent", async () => {
    vi.useFakeTimers();
    const by = signer();
    by.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const search = createMemoryWriter();
    const posting = postReview(template(), by, [SEARCH], new AbortController().signal, {
      writers: writersOver({ [SEARCH]: search }),
      signWithin: SIGN_TIMEOUT_MS,
    });
    let outcome: unknown;
    posting.catch((error: unknown) => {
      outcome = error;
    });
    expect(SIGN_TIMEOUT_MS).toBe(60_000);

    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(NotPosted);
    expect(search.published).toEqual([]);
  });

  it("gives the signer no time limit of its own when not asked to (a phone app has its own)", async () => {
    vi.useFakeTimers();
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked: Parameters<typeof finalizeEvent>[0]) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent({ ...asked }, KEY));
        }),
    );
    const search = createMemoryWriter();
    const posting = run([SEARCH], writersOver({ [SEARCH]: search }), undefined, by);
    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS * 2);
    sign();
    const posted = await posting;
    expect(search.published).toEqual([posted.event]);
  });

  it("is posted when one relay takes it and another refuses, and says which did which", async () => {
    const posted = await run(
      [SEARCH, OWN],
      writersOver({ [SEARCH]: createMemoryWriter(), [OWN]: createMemoryWriter({ refuse: "blocked: not on the list" }) }),
    );
    await posted.settled;
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
    await posted.settled;
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

  it("is posted with the tags a signer adds after the review's own, which stay as the review's prefix (R15)", async () => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...asked, tags: [...asked.tags, ["client", "x"]] }, KEY),
    );
    const search = createMemoryWriter();
    const posted = await run([SEARCH], writersOver({ [SEARCH]: search }), undefined, by);
    expect(posted.event.tags).toEqual([...template().tags, ["client", "x"]]);
    expect(search.published).toEqual([posted.event]);
  });

  it("is posted with any other tag a signer adds after them, such as a nonce: the rule names what may not be added", async () => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...asked, tags: [...asked.tags, ["nonce", "776797", "20"], ["client", "x"]] }, KEY),
    );
    const search = createMemoryWriter();
    const posted = await run([SEARCH], writersOver({ [SEARCH]: search }), undefined, by);
    expect(posted.event.tags).toEqual([...template().tags, ["nonce", "776797", "20"], ["client", "x"]]);
  });

  it.each([
    ["a second a, filing the review under another place too", ["a", "39999:other:place"]],
    ["a d", ["d", "place:39999:other:place"]],
    ["an e", ["e", "f".repeat(64)]],
    ["a k", ["k", "1"]],
    ["a p", ["p", "f".repeat(64)]],
    ["another of a name the review uses", ["s", "5"]],
    ["an expiration, which would have relays drop the review (NIP-40)", ["expiration", "1800000600"]],
    ["a -, which relays refuse from an app that has not proven whose it is (NIP-70)", ["-"]],
    ["a delegation, which would make it another person's (NIP-26)", ["delegation", "f".repeat(64), "kind=34259", "f".repeat(128)]],
  ])("is not posted, and nothing is sent, when the signer appends %s (R17)", async (_, tag) => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...asked, tags: [...asked.tags, tag] }, KEY),
    );
    const search = createMemoryWriter();
    await expect(run([SEARCH], writersOver({ [SEARCH]: search }), undefined, by)).rejects.toBeInstanceOf(NotPosted);
    expect(search.published).toEqual([]);
  });

  it.each([
    ["puts a tag before the review's own", (tags: string[][]) => [["client", "x"], ...tags]],
    ["leaves one of the review's tags out", (tags: string[][]) => tags.slice(0, -1)],
    ["changes the value of one", (tags: string[][]) => tags.map((tag) => (tag[0] === "s" ? ["s", "5"] : tag))],
  ])("is not posted, and nothing is sent, when the signer %s", async (_, change) => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...asked, tags: change(asked.tags) }, KEY),
    );
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
    // With the event that was signed, so that Try again can send it again without asking for it to be signed again.
    const error = (await posting.catch((caught: unknown) => caught)) as NotPosted;
    expect(error.event).toMatchObject({ ...template(), pubkey: PUBKEY });
    expect(verifyEvent(error.event!)).toBe(true);
  });

  it("fails when a writer cannot be made for a relay, as when it refuses", async () => {
    const posting = run([OTHER], writersOver({}));
    await expect(posting).rejects.toBeInstanceOf(NotPosted);
  });

  it("is posted as soon as a review relay takes it; a slower relay goes on, and its answer is recorded when it comes", async () => {
    vi.useFakeTimers();
    const search = createMemoryWriter();
    const own = createMemoryWriter({ delayMs: 5_000 });
    let outcome: Posted | undefined;
    void run([SEARCH, OWN], writersOver({ [SEARCH]: search, [OWN]: own })).then((posted) => {
      outcome = posted;
    });

    // Posted at once, while the other relay has not answered.
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeDefined();
    expect(outcome!.accepted).toEqual([SEARCH]);

    // It answers later: what it said is added.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome!.accepted).toEqual([SEARCH, OWN]);
    await outcome!.settled;
  });

  it("gives up on the person's own relays still silent at the end of their one try, after it is posted", async () => {
    vi.useFakeTimers();
    const silent = createMemoryWriter({ silent: true });
    const search = createMemoryWriter();
    let outcome: Posted | undefined;
    let settled = false;
    void run([SEARCH, OWN], writersOver({ [SEARCH]: search, [OWN]: silent })).then((posted) => {
      outcome = posted;
      void posted.settled.then(() => {
        settled = true;
      });
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(outcome?.accepted).toEqual([SEARCH]);
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - 1);
    expect(silent.signals[0]?.aborted).toBe(false);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(silent.signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(outcome!.accepted).toEqual([SEARCH]);
    expect(Object.keys(outcome!.refused)).toEqual([OWN]);
    expect(PUBLISH_TIMEOUT_MS).toBe(15_000);
  });

  it("goes on sending to the others once posted, even when the caller stops: only its limit stops them then", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const slow = createMemoryWriter({ delayMs: 3_000 });
    const posted = run([SEARCH, OWN], writersOver({ [SEARCH]: createMemoryWriter(), [OWN]: slow }), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await posted;
    // The person has gone back to the place, and the form is gone.
    controller.abort(new Error("The form was closed"));
    expect(slow.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(outcome.accepted).toEqual([SEARCH, OWN]);
  });

  it("waits for a review relay while only the person's own relays have taken it", async () => {
    vi.useFakeTimers();
    let outcome: Posted | undefined;
    void run(
      [SEARCH, OWN],
      writersOver({ [SEARCH]: createMemoryWriter({ delayMs: 3_000 }), [OWN]: createMemoryWriter() }),
    ).then((posted) => {
      outcome = posted;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome?.accepted).toEqual([SEARCH, OWN]);
  });

  it("sends to every relay at once, each try with the same time: none waits for another", async () => {
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
    expect(first.signals[0]?.aborted && second.signals[0]?.aborted).toBe(true);
    // The review relay is tried again, within its patience; the person's own relay is not.
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS - PUBLISH_TIMEOUT_MS);
    await expect(posting).rejects.toBeInstanceOf(NotPosted);
    expect(first.published).toHaveLength(REVIEW_RELAY_TRIES);
    expect(second.published).toHaveLength(1);
  });

  it("sends an event signed already, as it is, to the relays given: no one is asked to sign it again (sendReview)", async () => {
    const event = finalizeEvent(template(), KEY);
    const search = createMemoryWriter();
    const posted = await sendReview(event, [SEARCH], new AbortController().signal, { writers: writersOver({ [SEARCH]: search }) });
    expect(search.published).toEqual([event]);
    expect(posted.event).toBe(event);
    expect(posted.accepted).toEqual([SEARCH]);
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

describe("patience with the review relays (ruling P1)", () => {
  /** The review, signed already, as Try again sends it. */
  const signed = () => finalizeEvent(template(), KEY);

  /** How a send ended once it has: posted, or what it threw. Undefined while it goes on. */
  function track(sending: Promise<Posted>) {
    const outcome: { posted?: Posted; error?: unknown } = {};
    sending.then(
      (posted) => (outcome.posted = posted),
      (error: unknown) => (outcome.error = error),
    );
    return outcome;
  }

  /** Sends `event` to `relays` with `writers`, which are asked for each try, and how it ended once it has. */
  const send = (
    event: NostrEvent,
    relays: string[],
    writers: (url: string) => RelayWriter,
    signal = new AbortController().signal,
    opts: SendOptions = {},
  ) => track(sendReview(event, relays, signal, { writers, ...opts }));

  beforeEach(() => {
    config.reviewRelays = [SEARCH];
    vi.useFakeTimers();
  });

  it("gives each try 15 seconds, a review relay up to 3 tries, 2 and then 5 seconds apart, all within 50 seconds", () => {
    expect(PUBLISH_TIMEOUT_MS).toBe(15_000);
    expect(REVIEW_RELAY_TRIES).toBe(3);
    expect(REVIEW_RELAY_WAITS_MS).toEqual([2_000, 5_000]);
    expect(REVIEW_RELAY_PATIENCE_MS).toBe(50_000);
    expect(SLOW_POST_MS).toBe(8_000);
  });

  it("sends the review again to a review relay that did not answer in time, over a new connection, and is posted when it takes it", async () => {
    const event = signed();
    const search = createMemoryWriter({ answers: [{ silent: true }] });
    const writers = vi.fn(writersOver({ [SEARCH]: search }));
    const sent = send(event, [SEARCH], writers);

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);
    expect(search.signals[0]?.aborted).toBe(true);
    expect(search.published).toHaveLength(1);
    expect(sent).toEqual({});

    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]!);
    await vi.waitFor(() => expect(sent.posted).toBeDefined());
    expect(search.published).toEqual([event, event]);
    // A writer of its own for each try: the app's opens a new connection for each.
    expect(writers).toHaveBeenCalledTimes(2);
    expect(sent.posted!.accepted).toEqual([SEARCH]);
    expect(sent.posted!.refused).toEqual({});
  });

  it.each([
    ["error:, a fault of its own", { refuse: "error: vespa feed 503" }],
    ["rate-limited:", { refuse: "rate-limited: slow down" }],
    ["its connection closing before it answered", { closes: true }],
  ])("sends the review again to a review relay after %s, and is posted when it takes it", async (_, first) => {
    const event = signed();
    const search = createMemoryWriter({ answers: [first] });
    const sent = send(event, [SEARCH], writersOver({ [SEARCH]: search }));

    await vi.advanceTimersByTimeAsync(0);
    expect(search.published).toHaveLength(1);
    expect(sent).toEqual({});
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]!);
    await vi.waitFor(() => expect(sent.posted).toBeDefined());
    expect(search.published).toEqual([event, event]);
  });

  it.each([
    "blocked: not on the list",
    "invalid: bad tag",
    "replaced: have a newer version",
    "pow: difficulty 20 needed",
    "restricted: members only",
    "auth-required: sign in first",
    "shadowbanned: some other prefix",
    "no prefix at all",
  ])("takes a review relay's %j as its answer: no second try, and not on Regulars when the person's own relay took it", async (reason) => {
    const search = createMemoryWriter({ refuse: reason });
    const own = createMemoryWriter();
    const sent = send(signed(), [SEARCH, OWN], writersOver({ [SEARCH]: search, [OWN]: own }));

    await vi.waitFor(() => expect(sent.error).toBeInstanceOf(NotPosted));
    expect(sent.error).toMatchObject({ accepted: [OWN], refused: { [SEARCH]: reason } });
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS);
    expect(search.published).toHaveLength(1);
  });

  it("is not posted once a review relay has failed a third time, when its patience is up", async () => {
    const search = createMemoryWriter({ silent: true });
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: search }));

    // 15 seconds, 2, 15, 5, and what is left of the 50 for the third.
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS - 1);
    expect(search.published).toHaveLength(REVIEW_RELAY_TRIES);
    expect(sent).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sent.error).toBeInstanceOf(NotPosted));
    expect(search.signals.every((signal) => signal.aborted)).toBe(true);
    expect(Object.keys((sent.error as NotPosted).refused)).toEqual([SEARCH]);

    // And no fourth.
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS);
    expect(search.published).toHaveLength(REVIEW_RELAY_TRIES);
  });

  it("is not posted after a third refusal that may pass, without waiting out its patience", async () => {
    const search = createMemoryWriter({ refuse: "error: vespa feed 503" });
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: search }));

    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]! + REVIEW_RELAY_WAITS_MS[1]!);
    await vi.waitFor(() => expect(sent.error).toBeInstanceOf(NotPosted));
    expect(search.published).toHaveLength(REVIEW_RELAY_TRIES);
    expect(sent.error).toMatchObject({ accepted: [], refused: { [SEARCH]: "error: vespa feed 503" } });
  });

  it("tries the person's own relays once, whatever they say, while the review relay is tried again", async () => {
    const search = createMemoryWriter({ answers: [{ refuse: "error: vespa feed 503" }] });
    const own = createMemoryWriter({ refuse: "error: disk full" });
    const other = createMemoryWriter({ silent: true });
    const sent = send(signed(), [SEARCH, OWN, OTHER], writersOver({ [SEARCH]: search, [OWN]: own, [OTHER]: other }));

    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]!);
    await vi.waitFor(() => expect(sent.posted).toBeDefined());
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS);
    await sent.posted!.settled;
    expect(search.published).toHaveLength(2);
    expect(own.published).toHaveLength(1);
    expect(other.published).toHaveLength(1);
    expect(sent.posted!.accepted).toEqual([SEARCH]);
    expect(Object.keys(sent.posted!.refused).sort()).toEqual([OTHER, OWN].sort());
  });

  it("stops trying a review relay again when its signal aborts before it is posted: the person has left the form", async () => {
    const search = createMemoryWriter({ refuse: "error: vespa feed 503" });
    const controller = new AbortController();
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: search }), controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(search.published).toHaveLength(1);
    // Waiting for the second try, the form is closed.
    const reason = new Error("The person closed the form");
    controller.abort(reason);
    await vi.waitFor(() => expect(sent.error).toBe(reason));
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS);
    expect(search.published).toHaveLength(1);
  });

  it("stops a try under way when its signal aborts, and tries no more", async () => {
    const search = createMemoryWriter({ silent: true });
    const controller = new AbortController();
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: search }), controller.signal);

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS + REVIEW_RELAY_WAITS_MS[0]! + 1_000);
    expect(search.published).toHaveLength(2);
    const reason = new Error("The person closed the form");
    controller.abort(reason);
    await vi.waitFor(() => expect(sent.error).toBe(reason));
    expect(search.signals[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS);
    expect(search.published).toHaveLength(2);
  });

  it("says it is slow once no review relay has taken it 8 seconds after it was sent", async () => {
    const onSlow = vi.fn();
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: createMemoryWriter({ answers: [{ silent: true }] }) }), undefined, {
      onSlow,
    });

    await vi.advanceTimersByTimeAsync(SLOW_POST_MS - 1);
    expect(onSlow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS + REVIEW_RELAY_WAITS_MS[0]!);
    await vi.waitFor(() => expect(sent.posted).toBeDefined());
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("does not say it is slow when a review relay takes it within 8 seconds, or the person leaves first", async () => {
    const onSlow = vi.fn();
    const sent = send(signed(), [SEARCH, OWN], writersOver({ [SEARCH]: createMemoryWriter({ delayMs: 3_000 }), [OWN]: createMemoryWriter({ silent: true }) }), undefined, {
      onSlow,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.posted).toBeDefined();

    const controller = new AbortController();
    const left = send(signed(), [SEARCH], writersOver({ [SEARCH]: createMemoryWriter({ silent: true }) }), controller.signal, { onSlow });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error("The person closed the form"));
    await vi.waitFor(() => expect(left.error).toBeDefined());

    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_PATIENCE_MS);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it("counts the 8 seconds from when the review is sent, not from when the signer was asked to sign it", async () => {
    const onSlow = vi.fn();
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked: Parameters<typeof finalizeEvent>[0]) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent({ ...asked }, KEY));
        }),
    );
    const search = createMemoryWriter({ silent: true });
    void postReview(template(), by, [SEARCH], new AbortController().signal, { writers: writersOver({ [SEARCH]: search }), onSlow }).catch(() => {});

    // The person takes 20 seconds to answer their add-on.
    await vi.advanceTimersByTimeAsync(20_000);
    sign();
    await vi.advanceTimersByTimeAsync(SLOW_POST_MS - 1);
    expect(search.published).toHaveLength(1);
    expect(onSlow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("gives a removal the same patience: the review relay is sent it again, and it is removed when it takes it", async () => {
    const reviews = [{ id: "1".repeat(64), d: `place:${JACAFE.address}`, createdAt: 1_800_000_000 }];
    const search = createMemoryWriter({ answers: [{ silent: true }, { refuse: "error: vespa feed 503" }] });
    let removed: Posted | undefined;
    void removeReview(reviews, { pubkey: PUBKEY, signer: signer() }, [SEARCH], 1_800_000_500, new AbortController().signal, {
      writers: writersOver({ [SEARCH]: search }),
    }).then((done) => (removed = done));

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS + REVIEW_RELAY_WAITS_MS[0]! + REVIEW_RELAY_WAITS_MS[1]!);
    await vi.waitFor(() => expect(removed).toBeDefined());
    expect(removed!.event).toMatchObject({ kind: 5, pubkey: PUBKEY });
    expect(search.published).toEqual([removed!.event, removed!.event, removed!.event]);
  });

  it("warns of each try a review relay did not take, by its address and what it said, and of nothing the person wrote or who they are", async () => {
    const event = signed();
    const sent = send(
      event,
      [SEARCH, OWN],
      writersOver({
        [SEARCH]: createMemoryWriter({ answers: [{ refuse: "error: vespa feed 503" }, { silent: true }] }),
        [OWN]: createMemoryWriter(),
      }),
    );

    await vi.advanceTimersByTimeAsync(REVIEW_RELAY_WAITS_MS[0]! + PUBLISH_TIMEOUT_MS + REVIEW_RELAY_WAITS_MS[1]!);
    await vi.waitFor(() => expect(sent.posted).toBeDefined());
    expect(postWarnings(warnings)).toEqual([
      "[post] wss://search.brainstorm.world did not take it: error: vespa feed 503",
      "[post] wss://search.brainstorm.world did not take it: The relay did not answer in time",
    ]);
    // One line each, and nothing else passed with it: never the review, its words, its id, the person's key or the signature.
    expect(warnings.mock.calls.every((args) => args.length === 1)).toBe(true);
    for (const line of postWarnings(warnings)) {
      for (const secret of [event.content, event.id, event.pubkey, event.sig]) expect(line).not.toContain(secret);
    }
  });

  it("warns of a review relay however its address is written, by the address it was sent to", async () => {
    config.reviewRelays = ["wss://Search.Brainstorm.world/"];
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: createMemoryWriter({ refuse: "blocked: not on the list" }) }));
    await vi.waitFor(() => expect(sent.error).toBeInstanceOf(NotPosted));
    expect(postWarnings(warnings)).toEqual(["[post] wss://search.brainstorm.world did not take it: blocked: not on the list"]);
  });

  it("never warns of the person's own relays, whatever they say: their addresses may come from the person's signer", async () => {
    const sent = send(
      signed(),
      [SEARCH, OWN, OTHER],
      writersOver({
        [SEARCH]: createMemoryWriter(),
        [OWN]: createMemoryWriter({ refuse: "blocked: not on the list" }),
        [OTHER]: createMemoryWriter({ silent: true }),
      }),
    );
    await vi.waitFor(() => expect(sent.posted).toBeDefined());
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);
    await sent.posted!.settled;
    expect(Object.keys(sent.posted!.refused).sort()).toEqual([OTHER, OWN].sort());
    expect(postWarnings(warnings)).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("does not warn of a try the person stopped by leaving", async () => {
    const controller = new AbortController();
    const sent = send(signed(), [SEARCH], writersOver({ [SEARCH]: createMemoryWriter({ silent: true }) }), controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error("The person closed the form"));
    await vi.waitFor(() => expect(sent.error).toBeDefined());
    expect(postWarnings(warnings)).toEqual([]);
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

describe("removeReview (NIP-09)", () => {
  const D = `place:${JACAFE.address}`;
  const reviews = [
    { id: "1".repeat(64), d: D, createdAt: 1_800_000_000 },
    { id: "2".repeat(64), d: JACAFE.address, createdAt: 1_799_000_000 },
  ];

  beforeEach(() => {
    config.reviewRelays = [SEARCH];
  });

  it("signs one removal of every review given, and sends it to the relays: removed once a review relay takes it", async () => {
    const by = signer();
    const search = createMemoryWriter();
    const own = createMemoryWriter();
    const removed = await removeReview(reviews, { pubkey: PUBKEY, signer: by }, [SEARCH, OWN], 1_800_000_500, new AbortController().signal, {
      writers: writersOver({ [SEARCH]: search, [OWN]: own }),
    });

    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(removed.event).toMatchObject({
      ...removalTemplate(
        reviews.map(({ id, d }) => ({ id, pubkey: PUBKEY, d })),
        1_800_000_500,
      ),
      pubkey: PUBKEY,
    });
    expect(verifyEvent(removed.event)).toBe(true);
    expect(search.published).toEqual([removed.event]);
    expect(own.published).toEqual([removed.event]);
  });

  it("is stamped no earlier than the newest review it removes", async () => {
    const removed = await removeReview(reviews, { pubkey: PUBKEY, signer: signer() }, [SEARCH], 1_799_999_000, new AbortController().signal, {
      writers: writersOver({ [SEARCH]: createMemoryWriter() }),
    });
    expect(removed.event.created_at).toBe(1_800_000_000);
  });

  it("is not removed when only the person's own relays take it, and says so with the signed removal (R13)", async () => {
    const removing = removeReview(reviews, { pubkey: PUBKEY, signer: signer() }, [SEARCH, OWN], 1_800_000_500, new AbortController().signal, {
      writers: writersOver({ [SEARCH]: createMemoryWriter({ refuse: "blocked" }), [OWN]: createMemoryWriter() }),
    });
    const error = (await removing.catch((caught: unknown) => caught)) as NotPosted;
    expect(error).toBeInstanceOf(NotPosted);
    expect(error.accepted).toEqual([OWN]);
    expect(error.event).toMatchObject({ kind: 5, pubkey: PUBKEY });
  });

  it("is not removed, and nothing is sent, when the signer widens the removal with an e or an a of its own (R17)", async () => {
    for (const tag of [
      ["e", "3".repeat(64)],
      ["a", `34259:${PUBKEY}:place:39999:other:place`],
    ]) {
      const by = signer();
      by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
        finalizeEvent({ ...asked, tags: [...asked.tags, tag] }, KEY),
      );
      const search = createMemoryWriter();
      await expect(
        removeReview(reviews, { pubkey: PUBKEY, signer: by }, [SEARCH], 1_800_000_500, new AbortController().signal, {
          writers: writersOver({ [SEARCH]: search }),
        }),
      ).rejects.toBeInstanceOf(NotPosted);
      expect(search.published).toEqual([]);
    }
  });

  it.each([
    ["an expiration", ["expiration", "1800000600"]],
    ["a -", ["-"]],
    ["a delegation", ["delegation", "f".repeat(64), "kind=5", "f".repeat(128)]],
  ])("is not removed, and nothing is sent, when the signer appends %s", async (_, tag) => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...asked, tags: [...asked.tags, tag] }, KEY),
    );
    const search = createMemoryWriter();
    await expect(
      removeReview(reviews, { pubkey: PUBKEY, signer: by }, [SEARCH], 1_800_000_500, new AbortController().signal, {
        writers: writersOver({ [SEARCH]: search }),
      }),
    ).rejects.toBeInstanceOf(NotPosted);
    expect(search.published).toEqual([]);
  });

  it("is removed with a tag naming the signer appended, such as client", async () => {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...asked, tags: [...asked.tags, ["client", "x"]] }, KEY),
    );
    const removed = await removeReview(reviews, { pubkey: PUBKEY, signer: by }, [SEARCH], 1_800_000_500, new AbortController().signal, {
      writers: writersOver({ [SEARCH]: createMemoryWriter() }),
    });
    expect(removed.event.tags.at(-1)).toEqual(["client", "x"]);
  });

  it("asks nobody to sign when there is nothing to remove, or nowhere to send it", async () => {
    const by = signer();
    const writers = writersOver({ [SEARCH]: createMemoryWriter() });
    await expect(removeReview([], { pubkey: PUBKEY, signer: by }, [SEARCH], 1, new AbortController().signal, { writers })).rejects.toBeInstanceOf(NotPosted);
    await expect(removeReview(reviews, { pubkey: PUBKEY, signer: by }, [], 1, new AbortController().signal, { writers })).rejects.toBeInstanceOf(NotPosted);
    expect(by.signEvent).not.toHaveBeenCalled();
  });
});

describe("removalRelays", () => {
  beforeEach(() => {
    config.reviewRelays = [SEARCH];
  });

  it("is where the person writes now, and every relay their reviews went to, each once, however written", () => {
    expect(
      removalRelays(
        [SEARCH, OWN],
        [{ relays: ["wss://NOS.example.test/", OTHER] }, {}, { relays: [SEARCH, OTHER] }],
      ),
    ).toEqual([SEARCH, OWN, OTHER]);
  });

  it("always has the review relays, and keeps only relays a review may be sent to", () => {
    expect(removalRelays([], [{ relays: ["ws://localhost:7777", "https://example.test", "wss://192.168.1.2", OWN] }])).toEqual([SEARCH, OWN]);
  });

  it("keeps a review relay of the app's own in development, as configured", () => {
    config.reviewRelays = ["ws://localhost:10547"];
    expect(removalRelays(["ws://localhost:10547"], [{ relays: ["ws://localhost:10547/"] }])).toEqual(["ws://localhost:10547"]);
  });
});
