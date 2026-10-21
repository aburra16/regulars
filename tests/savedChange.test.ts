import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Account, REQUEST_TIMEOUT_MS } from "../src/account/session";
import { config } from "../src/config";
import { PUBLISH_TIMEOUT_MS, SIGN_TIMEOUT_MS } from "../src/nostr/send";
import {
  belowSavedFloor,
  changeSaved,
  forgetSavedFloor,
  raiseSavedFloor,
  SAVED_LOCK,
  SAVED_SETTLE_MS,
  type SavedDeps,
  type SavedOutcome,
} from "../src/saved/change";
import { SAVED_READ_MS } from "../src/saved/read";
import { shapedEvent } from "./support/events";
import { DIRECTORY, failingWhen, OWN, relay, strangers, type World } from "./support/followWorld";
import { FakeLocks, useLocks } from "./support/locks";
import { asksForSaved, FIVE, FOUR, ONE, SAVED_RELAYS, savedWorld, setUpSavedRelays, THREE, TWO } from "./support/savedWorld";

/*
 * Changing a person's saved places (a bookmark set, kind 30003): `changeSaved`, the only code that
 * signs or sends one. A list is one record, and saving it replaces the whole of it in every app the
 * person uses, so these hold the change to its safeguards: one at a time, read fresh, never a list
 * older than one the tab has seen, never a guessed list, one entry changed and the rest as it was,
 * the signed event exactly what was built, sent where it was read. Relays are held in memory, the
 * keys are thrown away, and the clock is fake; nothing opens a socket.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const SOMEONE_ELSE = generateSecretKey();

/** The clock, in seconds. */
const NOW = 1_800_000_000;
/** The hint each place's entry gives: the list hub. */
const HUB = config.placesRelay;

/** A place of the list the app shows: its address is the house's, with `d`. */
const placeAt = (d: string) => ({ address: `39999:${config.houseHex}:${d}` });
const CAFE = placeAt("cafe-funchal");
const BAR = placeAt("bar-funchal");
const TEA = placeAt("tea-funchal");
/** A place's entry in the list, as a save writes it. */
const entry = (place: { address: string }) => ["a", place.address, HUB];

/** Another app's entries in the same record, and the text it keeps encrypted in `content`. */
const THEIRS = [
  ["a", `30023:${getPublicKey(SOMEONE_ELSE)}:a-long-post`, "wss://writing.example.com"],
  ["e", "e".repeat(64), "wss://notes.example.com"],
  ["t", "x"],
  ["image", "https://pictures.example.com/cover.jpg"],
  ["r", "https://example.com/a-page"],
];
const ENCRYPTED = "  Ag8kZ0vN3l+q1Kc/0aW9qQ==?iv=k9d+/F7ql2hzIJVlQ6Z1Ug==\né中 ";

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** A saved list of the person's, truly signed: its name, its title and `tags`, made at `at`. */
const savedList = (tags: string[][], at = NOW - 100, content = "", fields: Partial<EventTemplate> = {}): NostrEvent =>
  asSent(finalizeEvent({ kind: 30003, created_at: at, tags: [["d", "regulars-saved"], ["title", "Saved places"], ...tags], content, ...fields }, SECRET));

/** The person's relay list (kind 10002): each entry is `[url]`, `[url, "read"]` or `[url, "write"]`. */
const relayList = (entries: string[][]) => shapedEvent({ kind: 10002, pubkey: ME, tags: entries.map((entry) => ["r", ...entry]) });

/** A relay that answers no read, and takes nothing. */
const down = () => relay([], { reads: failingWhen(() => true), writes: { refuse: "error: down" } });

/** A signer as an add-on is: it signs what it is asked to with the person's key. */
function signer(key = SECRET) {
  return {
    getPublicKey: async () => getPublicKey(key),
    signEvent: vi.fn(async (asked: EventTemplate): Promise<NostrEvent> => finalizeEvent(structuredClone(asked), key)),
  };
}

/** A signer that takes `ms` to sign. */
function slowSigner(ms: number) {
  const by = signer();
  by.signEvent.mockImplementation(async (asked) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return finalizeEvent(structuredClone(asked), SECRET);
  });
  return by;
}

interface Options {
  by?: ReturnType<typeof signer>;
  signal?: AbortSignal;
  now?: number;
  signWithin?: number;
}

/**
 * Aborts when each test ends. Every change is stopped by it, so that one a failed test left under
 * way ends there: the code keeps a tab's changes in turn, and it would hold up every test after it.
 */
let life: AbortController;

/** What a change does: a save of a place, or an unsave of an address. */
type Change = Parameters<typeof changeSaved>[1];

/** The person saves or unsaves a place, over the relays of `w`, in this tab or in `tab`. */
function change(w: World, what: Change, opts: Options = {}, tab = changeSaved): Promise<SavedOutcome> {
  const account: Account = { pubkey: ME, signer: opts.by ?? signer(), how: "browser" };
  const deps: SavedDeps = { readers: w.readers, writers: w.writers, now: () => opts.now ?? NOW, signWithin: opts.signWithin };
  const signal = opts.signal === undefined ? life.signal : AbortSignal.any([opts.signal, life.signal]);
  return tab(account, what, deps, signal);
}

/** How a change ended, once it has: its outcome, or what it threw. Neither while it goes on. */
function track(changing: Promise<SavedOutcome>) {
  const ended: { outcome?: SavedOutcome; error?: unknown } = {};
  changing.then(
    (outcome) => (ended.outcome = outcome),
    (error: unknown) => (ended.error = error),
  );
  return ended;
}

/** The list a change saved; fails the test when it did not save one. */
function savedBy(outcome: SavedOutcome | undefined): NostrEvent {
  if (outcome?.kind !== "saved") throw new Error(`Not saved: ${JSON.stringify(outcome?.kind)}`);
  return outcome.list;
}

/** A tab of the app: a copy of the code of its own, as another tab has, set up as this one is. */
async function openTab(): Promise<typeof changeSaved> {
  vi.resetModules();
  const tab = await import("../src/saved/change");
  setUpSavedRelays((await import("../src/config")).config);
  return tab.changeSaved;
}

/** What the app logs, on any level: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  life = new AbortController();
  setUpSavedRelays(config);
  // Each test starts as a tab just opened: no list seen yet.
  forgetSavedFloor();
  strangers.length = 0;
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    // No timer of a change outlives it, and no relay but the test's own was asked anything.
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
  } finally {
    life.abort(new Error("The test is over"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useLocks(undefined);
  }
});

// ---------------------------------------------------------------------------------------------

describe("a first save", () => {
  it("makes a list of its name, its title and the place when three of the five saved-list relays answer with none, and sends it to those three and to the relay the person writes to", async () => {
    // The relay the person writes to answers no read, and takes what it is sent.
    const own = relay([], { reads: failingWhen(() => true) });
    const w = savedWorld([], {}, { [FOUR]: down(), [FIVE]: down(), [OWN]: own }, [relayList([[OWN, "write"]])]);
    const by = signer();

    const outcome = await change(w, { save: CAFE }, { by });

    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved });
    expect(saved).toMatchObject({ kind: 30003, pubkey: ME, created_at: NOW, content: "", tags: [["d", "regulars-saved"], ["title", "Saved places"], entry(CAFE)] });
    expect(verifyEvent({ ...saved })).toBe(true);
    expect(by.signEvent).toHaveBeenCalledTimes(1);
    for (const url of [ONE, TWO, THREE, OWN]) expect(w.relays[url]!.writer.published).toEqual([saved]);
    // The two that did not answer the read are not sent it.
    for (const url of [FOUR, FIVE]) expect(w.relays[url]!.writer.published).toEqual([]);
  });

  it.each([
    ["two of the five answer with none", {}, []],
    ["two of the five answer with none, and the relay the person writes to does too: only the app's relays count", { [OWN]: relay() }, [relayList([[OWN, "write"]])]],
  ])("is not loaded, and nothing is signed or sent, when %s", async (_, theirs, relayLists) => {
    const w = savedWorld([], {}, { [THREE]: down(), [FOUR]: down(), [FIVE]: down(), ...theirs }, relayLists);
    const by = signer();

    expect(await change(w, { save: CAFE }, { by })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is not loaded, and nothing is signed or sent, when the person's relay list could not be read, though all five saved-list relays answer with none: their list may be on their own relays alone", async () => {
    const w = savedWorld([], {}, { [DIRECTORY]: down() });
    const by = signer();

    expect(await change(w, { save: CAFE }, { by })).toEqual({ kind: "not-loaded" });
    // The app's relays were read, each of them, and every one answered.
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.asked.filter(asksForSaved)).toHaveLength(1);
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("makes a first list when the person is known to have no relay list and all five saved-list relays answer with none", async () => {
    // The relay-list relay answers, with no relay list of theirs.
    const w = savedWorld([]);

    const saved = savedBy(await change(w, { save: CAFE }));

    expect(saved.tags).toEqual([["d", "regulars-saved"], ["title", "Saved places"], entry(CAFE)]);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });
});

describe("a save onto a list", () => {
  it("adds the place's entry at the end, and keeps every other tag in its order and the content byte for byte", async () => {
    const old = savedList([...THEIRS, entry(CAFE)], NOW - 100, ENCRYPTED);
    const w = savedWorld([old]);
    const by = signer();

    const saved = savedBy(await change(w, { save: TEA }, { by }));

    expect(saved.tags).toEqual([...old.tags, entry(TEA)]);
    expect(saved.content).toBe(ENCRYPTED);
    expect(saved).toMatchObject({ kind: 30003, pubkey: ME, created_at: NOW });
    expect(verifyEvent({ ...saved })).toBe(true);
    // The signer was asked once, for exactly that.
    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(by.signEvent.mock.calls[0]![0]).toEqual({ kind: 30003, created_at: NOW, tags: [...old.tags, entry(TEA)], content: ENCRYPTED });
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });

  it("builds on the newest list the relays hold, one second after it when the clock is behind it, and sends the result to the relays that held an older one too", async () => {
    const older = savedList([entry(CAFE)], NOW - 100);
    const newest = savedList([entry(CAFE), entry(BAR)], NOW + 30);
    const w = savedWorld([older], {}, { [TWO]: relay([newest]) });

    const saved = savedBy(await change(w, { save: TEA }));

    expect(saved.tags).toEqual([...newest.tags, entry(TEA)]);
    expect(saved.created_at).toBe(NOW + 31);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });
});

describe("an unsave", () => {
  it("takes out the place's entry, and keeps everything else as it was", async () => {
    const old = savedList([entry(CAFE), ...THEIRS, entry(TEA)], NOW - 100, ENCRYPTED);
    const w = savedWorld([old]);

    const saved = savedBy(await change(w, { unsave: CAFE.address }));

    expect(saved.tags).toEqual([["d", "regulars-saved"], ["title", "Saved places"], ...THEIRS, entry(TEA)]);
    expect(saved.content).toBe(ENCRYPTED);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });

  it.each([
    ["a place that is not in the list", [savedList([entry(CAFE)])]],
    ["a place, when enough of the relays answer and none has a list", []],
  ])("is unchanged, and nothing is signed or sent, for %s", async (_, held) => {
    const w = savedWorld(held);
    const by = signer();

    expect(await change(w, { unsave: BAR.address }, { by })).toEqual({ kind: "unchanged", list: held[0] ?? null });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });
});

describe("a list older than one this tab has seen", () => {
  const older = () => savedList([entry(CAFE)], NOW - 100);
  const newer = () => savedList([entry(CAFE), entry(BAR)], NOW - 50);

  it.each<[string, Change]>([
    ["a save", { save: TEA }],
    ["an unsave", { unsave: CAFE.address }],
  ])("is not loaded for %s, and the signer is never asked, when the relays now send an older list than one the tab has seen", async (_, what) => {
    raiseSavedFloor(ME, newer());
    const w = savedWorld([older()]);
    const by = signer();

    expect(await change(w, what, { by })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is not loaded when the relays send no list at all, and a list has been seen", async () => {
    raiseSavedFloor(ME, older());
    const by = signer();

    expect(await change(savedWorld([]), { save: TEA }, { by })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
  });

  it("lets a change go on from the list seen, or a newer one", async () => {
    raiseSavedFloor(ME, older());

    expect(savedBy(await change(savedWorld([older()]), { save: TEA })).tags).toEqual([...older().tags, entry(TEA)]);
    forgetSavedFloor();
    raiseSavedFloor(ME, older());
    expect(savedBy(await change(savedWorld([newer()]), { save: TEA })).tags).toEqual([...newer().tags, entry(TEA)]);
  });

  it("is raised by nothing but the person's own saved list: another's, another kind and another set leave it as it was", async () => {
    const later = NOW;
    raiseSavedFloor(ME, asSent(finalizeEvent({ kind: 30003, created_at: later, tags: [["d", "regulars-saved"]], content: "" }, SOMEONE_ELSE)));
    raiseSavedFloor(ME, savedList([], later, "", { kind: 10003 }));
    raiseSavedFloor(ME, asSent(finalizeEvent({ kind: 30003, created_at: later, tags: [["d", "reading-list"]], content: "" }, SECRET)));

    expect(belowSavedFloor(ME, older())).toBe(false);
    expect(belowSavedFloor(ME, null)).toBe(false);
    expect(savedBy(await change(savedWorld([older()]), { save: TEA })).tags).toEqual([...older().tags, entry(TEA)]);
  });

  it("never lowers, and takes the older list again once what was seen is forgotten, as at sign-out", async () => {
    raiseSavedFloor(ME, newer());
    raiseSavedFloor(ME, older());
    expect(belowSavedFloor(ME, older())).toBe(true);
    expect(belowSavedFloor(ME, newer())).toBe(false);

    forgetSavedFloor();

    expect(belowSavedFloor(ME, older())).toBe(false);
    expect(savedBy(await change(savedWorld([older()]), { save: TEA })).tags).toEqual([...older().tags, entry(TEA)]);
  });
});

describe("when no relay answers", () => {
  it.each<[string, Change]>([
    ["a save", { save: CAFE }],
    ["an unsave", { unsave: CAFE.address }],
  ])("writes nothing for %s: it is not loaded, and nothing is signed or sent", async (_, what) => {
    const w = savedWorld([savedList([entry(CAFE)])], { reads: failingWhen(asksForSaved), writes: { refuse: "error: down" } });
    const by = signer();

    expect(await change(w, what, { by })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });
});

describe("one change at a time", () => {
  /** A save of the café, its signer taking a second, and a save of the bar started at once, and how they ended. */
  async function twoAtOnce(w: World, firstTab = changeSaved, secondTab = changeSaved) {
    const first = change(w, { save: CAFE }, { by: slowSigner(1_000) }, firstTab);
    const second = change(w, { save: BAR }, {}, secondTab);
    const both = Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(1_000);
    return both;
  }

  /** The second save was built on the list the first saved, and each relay was sent them in that order. */
  function expectInTurn(w: World, old: NostrEvent, one: SavedOutcome, two: SavedOutcome) {
    const first = savedBy(one);
    const second = savedBy(two);
    expect(first.tags).toEqual([...old.tags, entry(CAFE)]);
    expect(second.tags).toEqual([...old.tags, entry(CAFE), entry(BAR)]);
    // Both at the same second by the clock: the second is made a second after the first, so it is the newer everywhere.
    expect(second.created_at).toBe(first.created_at + 1);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toEqual([first, second]);
  }

  it("makes a second save in the same tab wait for the first, and build on the list the first saved (no Web Locks)", async () => {
    const old = savedList(THEIRS);
    const w = savedWorld([old]);

    const [one, two] = await twoAtOnce(w);

    expectInTurn(w, old, one, two);
  });

  it("holds the browser's lock for saved places, so a second save in the same tab waits for the first", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = savedList(THEIRS);
    const w = savedWorld([old]);

    const [one, two] = await twoAtOnce(w);

    expectInTurn(w, old, one, two);
    expect(locks.requests).toEqual([SAVED_LOCK, SAVED_LOCK]);
    expect(SAVED_LOCK).toBe("regulars.saved");
  });

  it("holds it across tabs: a save in a second tab waits for the first tab's, and builds on what it saved", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = savedList(THEIRS);
    const w = savedWorld([old]);

    const firstTab = await openTab();
    const secondTab = await openTab();
    // Two copies of the code: neither knows of the other's changes but through the browser's lock.
    expect(secondTab).not.toBe(firstTab);

    const [one, two] = await twoAtOnce(w, firstTab, secondTab);

    expectInTurn(w, old, one, two);
    expect(locks.requests).toEqual([SAVED_LOCK, SAVED_LOCK]);
  });

  it("does not wait for ever on a lock another tab never lets go: it goes ahead once the longest change could have ended", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    // Another tab holds the lock and never lets go.
    void locks.request(SAVED_LOCK, {}, () => new Promise<never>(() => {}));
    const w = savedWorld([savedList([])]);
    const ended = track(change(w, { save: CAFE }));
    // The relay list and the list, each with room for twice a relay's time, the slowest signer (a
    // phone's), two tries at each relay, and time to spare.
    const wait = 4 * SAVED_READ_MS + Math.max(SIGN_TIMEOUT_MS, REQUEST_TIMEOUT_MS) + 2 * PUBLISH_TIMEOUT_MS + 20_000;

    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(w.asked()).toEqual([]);
    expect(ended).toEqual({});

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(ended.outcome?.kind).toBe("saved"));
  });

  it("makes a second save of the same place, started with the first, unchanged: nothing more is signed or sent", async () => {
    const old = savedList(THEIRS);
    const w = savedWorld([old]);
    const by = slowSigner(1_000);

    const both = Promise.all([change(w, { save: CAFE }, { by }), change(w, { save: CAFE }, { by })]);
    await vi.advanceTimersByTimeAsync(1_000);
    const [one, two] = await both;

    const first = savedBy(one);
    expect(two).toEqual({ kind: "unchanged", list: first });
    expect(by.signEvent).toHaveBeenCalledTimes(1);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toEqual([first]);
  });

  it("lets the next change go ahead when one is stopped while its signer is asked: it rejects with the signal's reason, and sends nothing", async () => {
    const old = savedList([]);
    const w = savedWorld([old]);
    const never = signer();
    never.signEvent.mockImplementation(() => new Promise<never>(() => {}));
    const stop = new AbortController();

    const stopped = track(change(w, { save: CAFE }, { by: never, signal: stop.signal, signWithin: 3_600_000 }));
    const next = change(w, { save: BAR });
    await vi.advanceTimersByTimeAsync(10);
    expect(never.signEvent).toHaveBeenCalledTimes(1);
    const reason = new Error("signed out");
    stop.abort(reason);

    expect(savedBy(await next).tags).toEqual([...old.tags, entry(BAR)]);
    expect(stopped.error).toBe(reason);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toHaveLength(1);
  });
});

describe("a signer that signs something other than what was built", () => {
  it.each<[string, (asked: EventTemplate) => EventTemplate]>([
    ["adds a tag", (asked) => ({ ...asked, tags: [...asked.tags, ["client", "an-app"]] })],
    ["changes the time", (asked) => ({ ...asked, created_at: asked.created_at + 1 })],
    ["leaves the new entry out", (asked) => ({ ...asked, tags: asked.tags.slice(0, -1) })],
  ])("is not saved, and nothing is sent, when the signer %s", async (_, changed) => {
    const w = savedWorld([savedList(THEIRS)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => finalizeEvent(changed(structuredClone(asked)), SECRET));

    expect(await change(w, { save: CAFE }, { by })).toEqual({ kind: "not-saved" });
    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(w.published()).toEqual([]);
  });

  it.each<[string, (signed: NostrEvent, other: NostrEvent) => NostrEvent]>([
    ["a signature that is not over its fields", (signed, other) => ({ ...asSent(signed), sig: other.sig })],
    ["an id that is not the hash of its fields", (signed, other) => ({ ...asSent(signed), id: other.id })],
  ])("is not saved, and nothing is sent, when the signer returns the right fields with %s", async (_, forged) => {
    const w = savedWorld([savedList(THEIRS)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => {
      const signed = finalizeEvent(structuredClone(asked), SECRET);
      // Another event of the person's own, truly signed: its id and its signature are a pair, of other fields.
      const other = finalizeEvent({ ...structuredClone(asked), content: "another event" }, SECRET);
      return forged(signed, other);
    });

    expect(await change(w, { save: CAFE }, { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not saved, and nothing is sent, when the signer signs as someone else", async () => {
    const w = savedWorld([savedList(THEIRS)]);

    expect(await change(w, { save: CAFE }, { by: signer(SOMEONE_ELSE) })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not approved, and nothing is sent, when the signer says no", async () => {
    const w = savedWorld([savedList(THEIRS)]);
    const by = signer();
    by.signEvent.mockRejectedValueOnce(new Error("The person said no"));

    expect(await change(w, { save: CAFE }, { by })).toEqual({ kind: "not-approved" });
    expect(w.published()).toEqual([]);
  });

  it("is not approved, and nothing is sent, when the signer does not answer in its time", async () => {
    const w = savedWorld([savedList(THEIRS)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));

    const ended = track(change(w, { save: CAFE }, { by, signWithin: 1_000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(ended.outcome).toEqual({ kind: "not-approved" });
    expect(w.published()).toEqual([]);
  });
});

describe("a newer list seen while the signer is asked", () => {
  it("is not loaded, and what was signed is sent nowhere: the list it was built on was not the newest", async () => {
    const old = savedList([entry(CAFE)], NOW - 100);
    const w = savedWorld([old]);
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent(structuredClone(asked), SECRET));
        }),
    );
    const ended = track(change(w, { save: TEA }, { by }));
    await vi.advanceTimersByTimeAsync(10);
    expect(by.signEvent).toHaveBeenCalledTimes(1);

    // While the signer signs, the page reads the list, and finds one saved meanwhile in another app.
    raiseSavedFloor(ME, savedList([entry(CAFE), entry(BAR)], NOW - 50));
    sign();
    await vi.advanceTimersByTimeAsync(SAVED_SETTLE_MS);

    expect(ended.outcome).toEqual({ kind: "not-loaded" });
    expect(w.published()).toEqual([]);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.held).toEqual([old]);
  });

  it("is not loaded for a first list, and what was signed is sent nowhere: the person had a list after all", async () => {
    const w = savedWorld([]);
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent(structuredClone(asked), SECRET));
        }),
    );
    const ended = track(change(w, { save: CAFE }, { by }));
    await vi.advanceTimersByTimeAsync(10);
    expect(by.signEvent).toHaveBeenCalledTimes(1);

    // While the signer signs, the page reads the list, and finds one saved meanwhile in another app.
    raiseSavedFloor(ME, savedList([entry(BAR)], NOW - 50));
    sign();
    await vi.advanceTimersByTimeAsync(SAVED_SETTLE_MS);

    expect(ended.outcome).toEqual({ kind: "not-loaded" });
    expect(w.published()).toEqual([]);
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.held).toEqual([]);
  });
});

describe("where a changed list goes, and when it is saved", () => {
  it("is not saved when no relay takes it, and the next change is held to no list it sent", async () => {
    const old = savedList([entry(CAFE)]);
    const w = savedWorld([old], { writes: { answers: [{ refuse: "blocked: not now" }] } });

    expect(await change(w, { save: TEA })).toEqual({ kind: "not-saved" });
    for (const url of SAVED_RELAYS) expect(w.relays[url]!.writer.published).toHaveLength(1);
    expect(belowSavedFloor(ME, old)).toBe(false);

    // Each relay takes the next it is sent: the change is made again on the list they hold.
    expect(savedBy(await change(w, { save: TEA }, { now: NOW + 10 })).tags).toEqual([...old.tags, entry(TEA)]);
  });

  it("is saved when one of the five takes it, and the floor rises to it: a change that then finds only the old list is not loaded", async () => {
    const old = savedList([entry(CAFE)]);
    let oneDown = false;
    const refusing = () => relay([old], { writes: { refuse: "blocked: not now" } });
    const w = savedWorld([], {}, { [ONE]: relay([old], { reads: failingWhen(() => oneDown) }), [TWO]: refusing(), [THREE]: refusing(), [FOUR]: refusing(), [FIVE]: refusing() });

    const saved = savedBy(await change(w, { save: TEA }));

    expect(w.relays[ONE]!.held).toContainEqual(saved);
    for (const url of [TWO, THREE, FOUR, FIVE]) expect(w.relays[url]!.held).toEqual([old]);
    expect(belowSavedFloor(ME, old)).toBe(true);
    expect(belowSavedFloor(ME, saved)).toBe(false);

    // The relay that took it is out now, and the others hold the old list: nothing is built on that.
    oneDown = true;
    const by = signer();
    expect(await change(w, { save: BAR }, { by, now: NOW + 10 })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
  });

  it("is saved though a relay says it holds a newer list: the others took it", async () => {
    const old = savedList([entry(CAFE)]);
    const w = savedWorld([old], {}, { [ONE]: relay([old], { writes: { refuse: "replaced: have newer event" } }) });

    const outcome = await change(w, { save: TEA });

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome) });
  });
});

describe("what a change may be asked", () => {
  it.each<[string, Partial<Account>, unknown]>([
    ["a save of an address that is not a place's", {}, { save: { address: `30023:${ME}:a-long-post` } }],
    ["a save of no address", {}, { save: {} }],
    ["an unsave of what is no address", {}, { unsave: 39999 }],
    ["neither a save nor an unsave", {}, { follow: CAFE.address }],
    ["an account whose key is no key", { pubkey: "npub1nokey" }, { save: CAFE }],
  ])("rejects %s with a TypeError, before anything is read or signed", async (_, account, what) => {
    const w = savedWorld([savedList([])]);
    const by = signer();
    const deps: SavedDeps = { readers: w.readers, writers: w.writers, now: () => NOW };

    await expect(changeSaved({ pubkey: ME, signer: by, how: "browser", ...account }, what as Change, deps, life.signal)).rejects.toBeInstanceOf(TypeError);
    expect(w.asked()).toEqual([]);
    expect(by.signEvent).not.toHaveBeenCalled();
  });
});
