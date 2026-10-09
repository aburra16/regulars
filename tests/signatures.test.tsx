import type { NostrEvent } from "@nostrify/nostrify";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { readSaved } from "../src/places/cache";
import { checkSignatures, SLICE_MS } from "../src/places/signatures";
import { PlacesProvider, usePlaces } from "../src/places/store";
import raw from "./fixtures/funchal-items.json";
import type { RelayReader } from "../src/nostr/events";
import { createMemoryReader } from "./support/memoryReader";

// The places relay is read with its signature checks off, for speed: a fresh list has a sample of its
// signatures checked instead, and all of them when one of the sample fails (src/places/signatures.ts).
// The fixtures' signatures are fakes (tests/fixtures/README.md), so these tests sign the places with a
// key made here, which stands in for the house's.

// The real check: every other test has one that checks nothing (tests/setup.ts).
vi.unmock("../src/places/signatures");

const fixtures: NostrEvent[] = raw;

/** As a relay sends it: a plain copy, with nothing nostr-tools kept on the object it signed. */
const asSent = (event: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(event)) as NostrEvent;

/** `template`'s place, signed with `secret`, at `template`'s time. */
function signed(template: NostrEvent, secret: Uint8Array): NostrEvent {
  const { kind, created_at, tags, content } = template;
  return asSent(finalizeEvent({ kind, created_at, tags, content }, secret));
}

/** `event` with its name changed after it was signed: its id and signature no longer fit it. */
function forged(event: NostrEvent): NostrEvent {
  return asSent({ ...event, tags: event.tags.map((tag) => (tag[0] === "name" ? ["name", "Forged Place"] : tag)) });
}

const nameOf = (event: NostrEvent) => event.tags.find((tag) => tag[0] === "name")?.[1];

/** `count` places signed with `secret`, each a fixture's with its own `d`. */
function signedPlaces(count: number, secret: Uint8Array): NostrEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const template = fixtures[i % fixtures.length]!;
    const tags = template.tags.map((tag) => (tag[0] === "d" ? ["d", `signed-${i}`] : tag));
    return signed({ ...template, tags }, secret);
  });
}

const never = new AbortController().signal;

describe("checkSignatures", () => {
  const secret = generateSecretKey();
  const events = signedPlaces(100, secret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks only the sample of a list whose sample is good, and keeps the whole list", async () => {
    const verify = vi.fn(verifyEvent);
    const result = await checkSignatures(events, { sample: 64, signal: never, verify });
    expect(verify).toHaveBeenCalledTimes(64);
    expect(new Set(verify.mock.calls.map(([event]) => event.id)).size).toBe(64);
    expect(result).toEqual({ events, checked: 64, failed: 0 });
  });

  it("checks every one when one of the sample fails, and leaves out each that fails", async () => {
    // The sample is the first 64 (a random number of 0 picks each in turn); the forged one is in it.
    const list = events.map((event, i) => (i === 10 ? forged(event) : event));
    const verify = vi.fn(verifyEvent);
    const result = await checkSignatures(list, { sample: 64, signal: never, verify, random: () => 0 });
    // Each once: the sample, then the rest.
    expect(verify).toHaveBeenCalledTimes(100);
    expect(new Set(verify.mock.calls.map(([event]) => event.id)).size).toBe(100);
    expect(result.failed).toBe(1);
    expect(result.checked).toBe(100);
    expect(result.events).toHaveLength(99);
    expect(result.events.map(nameOf)).not.toContain("Forged Place");
    expect(result.events).toEqual(list.filter((_, i) => i !== 10));
  });

  it("leaves out every one that fails once the whole list is checked, in the sample or not", async () => {
    const list = events.map((event, i) => (i === 3 || i === 90 ? forged(event) : event));
    const result = await checkSignatures(list, { sample: 64, signal: never, random: () => 0 });
    expect(result.failed).toBe(2);
    expect(result.events.map(nameOf)).not.toContain("Forged Place");
  });

  it("picks a different sample each time", async () => {
    const picks: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const verify = vi.fn(verifyEvent);
      await checkSignatures(events, { sample: 8, signal: never, verify });
      picks.push(verify.mock.calls.map(([event]) => event.id).sort());
    }
    // Two samples of 8 out of 100 are the same once in 186 billion.
    expect(picks[0]).not.toEqual(picks[1]);
  });

  it("checks the whole of a list no longer than the sample", async () => {
    const verify = vi.fn(verifyEvent);
    const result = await checkSignatures(events.slice(0, 10), { sample: 64, signal: never, verify });
    expect(verify).toHaveBeenCalledTimes(10);
    expect(result).toEqual({ events: events.slice(0, 10), checked: 10, failed: 0 });
  });

  it("checks nothing with a sample of none", async () => {
    const verify = vi.fn(verifyEvent);
    const result = await checkSignatures(events, { sample: 0, signal: never, verify });
    expect(verify).not.toHaveBeenCalled();
    expect(result).toEqual({ events, checked: 0, failed: 0 });
  });

  it("gives the page back between slices of at most SLICE_MS", async () => {
    // Each check takes 5 ms of a clock of the test's own: a slice ends after two of them.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let other = false;
    const otherAtEachCheck: boolean[] = [];
    const verify = (event: NostrEvent) => {
      // Something else the page has to do, asked for during the first check.
      if (otherAtEachCheck.length === 0) setTimeout(() => (other = true), 0);
      otherAtEachCheck.push(other);
      clock += 5;
      return verifyEvent(event);
    };
    await checkSignatures(events, { sample: 6, signal: never, verify });
    expect(SLICE_MS).toBeLessThanOrEqual(16);
    // The first two in one slice; the other work runs before the third.
    expect(otherAtEachCheck).toEqual([false, false, true, true, true, true]);
  });

  it("stops when the signal aborts, with its reason", async () => {
    const controller = new AbortController();
    const verify = vi.fn((event: NostrEvent) => {
      controller.abort(new Error("gone"));
      return verifyEvent(event);
    });
    await expect(checkSignatures(events, { sample: 64, signal: controller.signal, verify })).rejects.toThrow("gone");
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe("the places from the relay, with their signatures sampled", () => {
  const secret = generateSecretKey();
  const house = getPublicKey(secret);
  const before = { houseHex: config.houseHex, sample: config.placesSignatureSample };

  beforeEach(() => {
    // The key made here is the house's, for these tests, and the sample takes the whole list.
    config.houseHex = house;
    config.placesSignatureSample = 64;
  });
  afterEach(() => {
    config.houseHex = before.houseHex;
    config.placesSignatureSample = before.sample;
    vi.restoreAllMocks();
  });

  /** A relay that sends every event it has, whatever it is asked for, as a compromised one might. */
  const sendsAll = (events: NostrEvent[]): RelayReader => ({
    async *req(_filter, signal) {
      for (const event of events) {
        signal.throwIfAborted();
        yield event;
      }
    },
  });

  function renderPlaces(events: NostrEvent[], reader: RelayReader = createMemoryReader(events)) {
    return renderHook(() => usePlaces(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PlacesProvider reader={reader} towns={null}>
          {children}
        </PlacesProvider>
      ),
    });
  }

  const places = () => fixtures.map((template) => signed(template, secret));

  it("shows a clean list whole, and saves it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = places();
    const { result } = renderPlaces(list);
    await waitFor(() => expect(result.current.savedAt).toBeDefined());
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(list.length);
    expect((await readSaved())?.events).toHaveLength(list.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves a forged place out, shows the rest, and saves only the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = places();
    const fake = forged(list[5]!);
    const { result } = renderPlaces(list.map((event, i) => (i === 5 ? fake : event)));
    await waitFor(() => expect(result.current.savedAt).toBeDefined());

    expect(result.current.status).toBe("ready");
    expect(result.current.source).toBe("network");
    expect(result.current.places.map((place) => place.name)).not.toContain("Forged Place");
    expect(result.current.places).toHaveLength(list.length - 1);

    const saved = await readSaved();
    expect(saved?.events).toHaveLength(list.length - 1);
    expect(saved?.events.map((event) => (event as NostrEvent).id)).not.toContain(fake.id);

    // Once, with the count, and nothing of the events.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[places] 1 of ${list.length} signatures failed`);
  });

  it("leaves out a place by another key, signed well or not, and never saves it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stranger = generateSecretKey();
    const list = places();
    const theirs = signed({ ...list[0]!, tags: list[0]!.tags.map((tag) => (tag[0] === "d" ? ["d", "theirs"] : tag)) }, stranger);
    const theirsForged = forged(signed({ ...list[1]!, tags: list[1]!.tags.map((tag) => (tag[0] === "d" ? ["d", "theirs-forged"] : tag)) }, stranger));
    const all = [...list, theirs, theirsForged];
    const { result } = renderPlaces(all, sendsAll(all));
    await waitFor(() => expect(result.current.savedAt).toBeDefined());

    expect(result.current.places.map((place) => place.d)).not.toContain("theirs");
    expect(result.current.places.map((place) => place.d)).not.toContain("theirs-forged");
    expect(result.current.places).toHaveLength(list.length);
    const ids = (await readSaved())?.events.map((event) => (event as NostrEvent).id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(theirsForged.id);
    // They are not the house's: left out before any signature is checked, so none failed.
    expect(warn).not.toHaveBeenCalled();
  });
});
