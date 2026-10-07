import type { NostrEvent } from "@nostrify/nostrify";
import { act, renderHook, waitFor } from "@testing-library/react";
import { get, set } from "idb-keyval";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { CACHE_KEY } from "../src/places/cache";
import type { RelayReader } from "../src/places/load";
import * as defaultStore from "../src/places/store";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;
const { usePlaces } = defaultStore;

type Store = typeof defaultStore;

interface Saved {
  events: NostrEvent[];
  savedAt: number;
  complete: boolean;
}

const saveCopy = (events: unknown[], { savedAt = 1_000, complete = true } = {}) =>
  set(CACHE_KEY, { events, savedAt, complete });
const savedCopy = () => get<Saved>(CACHE_KEY);

/**
 * Renders `usePlaces` inside a provider, and keeps every distinct `status:source` it showed,
 * in order, so a test can tell what a person saw on the way. `store` is a fresh copy of the
 * store module, for tests that replace its storage.
 */
function renderPlaces(reader?: RelayReader, opts: { strict?: boolean; store?: Store } = {}) {
  const { PlacesProvider, usePlaces: use } = opts.store ?? defaultStore;
  const seen: string[] = [];
  const view = renderHook(
    () => {
      const state = use();
      const step = `${state.status}:${state.source}`;
      if (seen.at(-1) !== step) seen.push(step);
      return state;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => {
        const provider = <PlacesProvider reader={reader}>{children}</PlacesProvider>;
        return opts.strict ? <StrictMode>{provider}</StrictMode> : provider;
      },
    },
  );
  return { ...view, seen };
}

/** The device's storage as idb-keyval presents it, for tests that replace it. */
interface Storage {
  get(key: unknown): Promise<unknown>;
  set(key: unknown, value: unknown): Promise<void>;
}

/** Renders a fresh copy of the store whose IndexedDB (idb-keyval) is `storage`. */
async function renderWithStorage(storage: Storage, reader: RelayReader) {
  vi.resetModules();
  vi.doMock("idb-keyval", () => storage);
  const store: Store = await import("../src/places/store");
  return renderPlaces(reader, { store });
}

/** A promise and the function that settles it, for a storage read that answers when told. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** `count` distinct places that share one time, as the importer signs a run. */
function generated(count: number): NostrEvent[] {
  const template = fixtures[0]!;
  return Array.from({ length: count }, (_, i) => ({
    ...template,
    id: i.toString(16).padStart(64, "0"),
    tags: template.tags.map((tag) => (tag[0] === "d" ? ["d", `generated-${i}`] : tag)),
  }));
}

/**
 * A reader that holds each request until it is released, so a test sees the state before the
 * answer. `waiting` counts the requests it has held so far.
 */
function held(inner: RelayReader) {
  const gates: Array<() => void> = [];
  let open = false;
  return {
    reader: {
      async *req(filter, signal) {
        if (!open) await new Promise<void>((resolve) => gates.push(resolve));
        yield* inner.req(filter, signal);
      },
    } satisfies RelayReader,
    /** Lets request `index` through; or, with no index, every request, now and later. */
    release(index?: number) {
      if (index === undefined) open = true;
      for (const gate of index === undefined ? gates : [gates[index]!]) gate();
    },
    get waiting() {
      return gates.length;
    },
  };
}

/**
 * Renders the provider over a saved copy, and lets the network answer from `inner` only once
 * the saved copy is on screen, so the test sees what follows a saved copy.
 */
async function renderAfterSavedCopy(inner: RelayReader) {
  const gate = held(inner);
  const view = renderPlaces(gate.reader);
  await waitFor(() => expect(view.result.current.source).toBe("cache"));
  await waitFor(() => expect(gate.waiting).toBe(1));
  gate.release();
  return view;
}

/** A reader that fails its first request and then answers from the fixtures. */
function failingOnce(): RelayReader & { calls: number } {
  const memory = createMemoryReader(fixtures);
  const reader = {
    calls: 0,
    async *req(filter: Parameters<RelayReader["req"]>[0], signal: AbortSignal) {
      reader.calls += 1;
      if (reader.calls === 1) throw new Error("wss://dcosl.brainstorm.world answered 503");
      yield* memory.req(filter, signal);
    },
  };
  return reader;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("idb-keyval");
  vi.doUnmock("../src/places/relayReader");
  vi.resetModules();
});

describe("the saved copy", () => {
  it("is kept under places:v1:<header coordinate>", () => {
    expect(CACHE_KEY).toBe(`places:v1:${config.headerCoordinate}`);
  });
});

describe("PlacesProvider (Review Focus 1)", () => {
  it("is loading at first, with no places", async () => {
    const { result } = renderPlaces(createMemoryReader(fixtures, { delayMs: 20 }));
    expect(result.current.status).toBe("loading");
    expect(result.current.places).toEqual([]);
    expect(result.current.complete).toBe(false);
    expect(result.current.error).toBeUndefined();
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("with a saved copy, shows it at once, then the network's places", async () => {
    await saveCopy(fixtures.slice(0, 5));
    const gate = held(createMemoryReader(fixtures));
    const { result, seen } = renderPlaces(gate.reader);

    await waitFor(() => expect(result.current.source).toBe("cache"));
    expect(result.current.status).toBe("ready");
    expect(result.current.places).toHaveLength(5);
    expect(result.current.savedAt).toBe(1_000);
    expect(result.current.complete).toBe(true);
    expect(result.current.error).toBeUndefined();

    await waitFor(() => expect(gate.waiting).toBe(1));
    gate.release();
    await waitFor(() => expect(result.current.places).toHaveLength(43));
    expect(result.current.source).toBe("network");
    expect(result.current.status).toBe("ready");
    expect(result.current.complete).toBe(true);
    expect(result.current.error).toBeUndefined();
    await waitFor(() => expect(result.current.savedAt).toBeGreaterThan(1_000));
    expect(seen).toEqual(["loading:network", "ready:cache", "ready:network"]);
  });

  it("shows a saved copy from an incomplete load as incomplete", async () => {
    await saveCopy(fixtures.slice(0, 5), { complete: false });
    const gate = held(createMemoryReader(fixtures));
    const { result } = renderPlaces(gate.reader);

    await waitFor(() => expect(result.current.source).toBe("cache"));
    expect(result.current.complete).toBe(false);
    gate.release();
    await waitFor(() => expect(result.current.places).toHaveLength(43));
  });

  it("with no saved copy and the network down, gives an error code, and retry() tries again", async () => {
    const reader = failingOnce();
    const { result, seen } = renderPlaces(reader);

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("network");
    expect(result.current.places).toEqual([]);
    expect(result.current.complete).toBe(false);

    act(() => result.current.retry());
    expect(result.current.status).toBe("loading");
    expect(result.current.error).toBeUndefined();

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(43);
    expect(result.current.error).toBeUndefined();
    expect(reader.calls).toBe(2);
    expect(seen).toEqual(["loading:network", "error:network", "loading:network", "ready:network"]);
  });

  it("retry() asks the network again each time it is called", async () => {
    const reader = createMemoryReader(fixtures, { failWith: new Error("down") });
    const { result } = renderPlaces(reader);

    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.retry());
    await waitFor(() => expect(reader.requests).toHaveLength(2));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("network");
  });

  it("shows no error when retry() is called while the first load is still running", async () => {
    const gate = held(createMemoryReader(fixtures));
    const { result, seen } = renderPlaces(gate.reader);

    await waitFor(() => expect(gate.waiting).toBe(1));
    act(() => result.current.retry());
    await waitFor(() => expect(gate.waiting).toBe(2));

    // The first request was abandoned by retry(); its failure must not reach the screen.
    await act(async () => {
      gate.release(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.status).toBe("loading");

    gate.release(1);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.places).toHaveLength(43);
    expect(result.current.error).toBeUndefined();
    expect(seen).toEqual(["loading:network", "ready:network"]);
  });

  it("with a saved copy and the network down, stays ready from the saved copy", async () => {
    await saveCopy(fixtures.slice(0, 5));
    const { result, seen } = await renderAfterSavedCopy(createMemoryReader(fixtures, { failWith: new Error("down") }));

    await waitFor(() => expect(result.current.error).toBe("network"));
    expect(result.current.status).toBe("ready");
    expect(result.current.source).toBe("cache");
    expect(result.current.places).toHaveLength(5);
    expect(result.current.savedAt).toBe(1_000);
    expect(seen).toEqual(["loading:network", "ready:cache"]);
    expect((await savedCopy())!.events).toHaveLength(5);
  });

  it("keeps showing the saved copy while retry() runs, and clears the error when it succeeds", async () => {
    await saveCopy(fixtures.slice(0, 5));
    const { result } = await renderAfterSavedCopy(failingOnce());

    await waitFor(() => expect(result.current.error).toBe("network"));
    act(() => result.current.retry());
    expect(result.current.status).toBe("ready");
    expect(result.current.places).toHaveLength(5);

    await waitFor(() => expect(result.current.places).toHaveLength(43));
    expect(result.current.source).toBe("network");
    expect(result.current.error).toBeUndefined();
  });

  it("stops the request when it unmounts, and saves nothing", async () => {
    const signals: AbortSignal[] = [];
    const memory = createMemoryReader(fixtures, { delayMs: 10_000 });
    const reader: RelayReader = {
      req(filter, signal) {
        signals.push(signal);
        return memory.req(filter, signal);
      },
    };
    const { unmount } = renderPlaces(reader);

    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0]!.aborted).toBe(true);
    expect(await savedCopy()).toBeUndefined();
  });

  it("sends exactly one request under StrictMode, which mounts twice", async () => {
    const reader = createMemoryReader(fixtures, { delayMs: 10 });
    const { result } = renderPlaces(reader, { strict: true });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(43);
    expect(reader.requests).toHaveLength(1);
    await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(43));
  });

  it("asks the places relay when no reader is given", async () => {
    vi.doMock("../src/places/relayReader", () => ({ relayReader: createMemoryReader(fixtures) }));
    const { result } = renderPlaces();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.places).toHaveLength(43);
  });
});

describe("reading the saved copy alongside the network", () => {
  it("does not let a saved copy that never loads hold up the network's places", async () => {
    const write = vi.fn(() => Promise.resolve());
    const { result, seen } = await renderWithStorage(
      { get: () => new Promise(() => {}), set: write },
      createMemoryReader(fixtures),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(43);
    expect(result.current.savedAt).toBeUndefined();
    expect(seen).toEqual(["loading:network", "ready:network"]);
    // With no answer about the saved copy, the device is not written to either.
    expect(write).not.toHaveBeenCalled();
  });

  it("ignores a saved copy that arrives after the network's places, then saves them", async () => {
    const read = deferred<unknown>();
    const write = vi.fn((_key: unknown, _value: unknown) => Promise.resolve());
    const { result, seen } = await renderWithStorage({ get: () => read.promise, set: write }, createMemoryReader(fixtures));

    await waitFor(() => expect(result.current.places).toHaveLength(43));
    await act(async () => {
      read.resolve({ events: fixtures.slice(0, 5), savedAt: 1_000, complete: true });
    });

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect((write.mock.calls[0]![1] as Saved).events).toHaveLength(43);
    await waitFor(() => expect(result.current.savedAt).toBe((write.mock.calls[0]![1] as Saved).savedAt));
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(43);
    expect(seen).toEqual(["loading:network", "ready:network"]);
  });

  it("does not save over a fuller saved copy that arrives after the network's places", async () => {
    const read = deferred<unknown>();
    const write = vi.fn(() => Promise.resolve());
    const { result } = await renderWithStorage({ get: () => read.promise, set: write }, createMemoryReader(generated(40)));

    await waitFor(() => expect(result.current.places).toHaveLength(40));
    await act(async () => {
      read.resolve({ events: generated(100), savedAt: 1_000, complete: true });
    });

    // The places on screen stay the network's; the device keeps its fuller copy.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(40);
    expect(write).not.toHaveBeenCalled();
  });

  it("when the network fails before the saved copy is read, shows the saved copy with the error", async () => {
    const read = deferred<unknown>();
    const { result } = await renderWithStorage(
      { get: () => read.promise, set: () => Promise.resolve() },
      createMemoryReader(fixtures, { failWith: new Error("down") }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    await act(async () => {
      read.resolve({ events: fixtures.slice(0, 5), savedAt: 1_000, complete: true });
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source).toBe("cache");
    expect(result.current.places).toHaveLength(5);
    expect(result.current.error).toBe("network");
  });
});

describe("saving places on the device", () => {
  it("saves the events after a complete fetch, with the time saved", async () => {
    const { result } = renderPlaces(createMemoryReader(fixtures));

    await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(43));
    const saved = (await savedCopy())!;
    expect(saved.events).toEqual(expect.arrayContaining(fixtures));
    expect(saved.complete).toBe(true);
    await waitFor(() => expect(result.current.savedAt).toBe(saved.savedAt));
    expect(result.current.complete).toBe(true);
  });

  it("leaves savedAt unset when the save fails and nothing was saved (private browsing)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const write = vi.fn(() => Promise.reject(new Error("IndexedDB is unavailable")));
    const { result } = await renderWithStorage(
      { get: () => Promise.reject(new Error("IndexedDB is unavailable")), set: write },
      createMemoryReader(fixtures),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(43);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(debug).toHaveBeenCalledTimes(2)); // one read, one write
    expect(result.current.savedAt).toBeUndefined();
  });

  it("keeps the earlier savedAt when the save fails", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const write = vi.fn(() => Promise.reject(new Error("quota exceeded")));
    const { result } = await renderWithStorage(
      {
        get: () => Promise.resolve({ events: fixtures.slice(0, 5), savedAt: 1_000, complete: true }),
        set: write,
      },
      createMemoryReader(fixtures, { delayMs: 10 }),
    );

    await waitFor(() => expect(result.current.places).toHaveLength(43));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(result.current.source).toBe("network");
    expect(result.current.savedAt).toBe(1_000);
  });

  it("judges a later load against what this mount saved", async () => {
    let calls = 0;
    const answers = [createMemoryReader(generated(100)), createMemoryReader(generated(40))];
    const reader: RelayReader = {
      req(filter, signal) {
        return answers[Math.min(calls++, 1)]!.req(filter, signal);
      },
    };
    const { result } = renderPlaces(reader);
    await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(100));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBe("network"));
    expect(result.current.places).toHaveLength(100);
    expect((await savedCopy())!.events).toHaveLength(100);
  });

  it("treats an answer with no places as a failure, and keeps the saved copy", async () => {
    await saveCopy(fixtures.slice(0, 5));
    const { result } = await renderAfterSavedCopy(createMemoryReader([]));

    await waitFor(() => expect(result.current.error).toBe("network"));
    expect(result.current.source).toBe("cache");
    expect(result.current.places).toHaveLength(5);
    expect((await savedCopy())!.events).toHaveLength(5);
  });

  it("treats an answer with no places as a failure when nothing is saved", async () => {
    const { result } = renderPlaces(createMemoryReader([]));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("network");
    expect(await savedCopy()).toBeUndefined();
  });

  describe("an incomplete fetch (a full first page and no progress after it)", () => {
    // 10,005 places at one time: the first page holds 10,000 and the next adds nothing.
    const incomplete = generated(10_005);

    it("is shown and saved, marked incomplete, when nothing was saved before", async () => {
      const { result } = renderPlaces(createMemoryReader(incomplete));

      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.source).toBe("network");
      expect(result.current.places).toHaveLength(10_000);
      expect(result.current.complete).toBe(false);
      await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(10_000));
      expect((await savedCopy())!.complete).toBe(false);
    });

    it.each([
      ["a smaller", 5],
      ["a fuller", 10_002],
    ])("is a failure over %s saved copy, which stays on screen", async (_size, count) => {
      await saveCopy(count === 5 ? fixtures.slice(0, 5) : generated(count));
      const { result } = await renderAfterSavedCopy(createMemoryReader(incomplete));

      await waitFor(() => expect(result.current.error).toBe("network"));
      expect(result.current.status).toBe("ready");
      expect(result.current.source).toBe("cache");
      expect(result.current.places).toHaveLength(count);
      expect((await savedCopy())!.events).toHaveLength(count);
    });
  });

  describe("a complete fetch never shrinks the saved copy by more than half", () => {
    it("keeps 100 saved places over a complete answer of 40, with the error", async () => {
      await saveCopy(generated(100));
      const { result } = await renderAfterSavedCopy(createMemoryReader(generated(40)));

      await waitFor(() => expect(result.current.error).toBe("network"));
      expect(result.current.source).toBe("cache");
      expect(result.current.places).toHaveLength(100);
      expect((await savedCopy())!.events).toHaveLength(100);
    });

    it.each([60, 50])("accepts a complete answer of %i over 100 saved places", async (count) => {
      await saveCopy(generated(100));
      const { result } = await renderAfterSavedCopy(createMemoryReader(generated(count)));

      await waitFor(() => expect(result.current.source).toBe("network"));
      expect(result.current.places).toHaveLength(count);
      expect(result.current.error).toBeUndefined();
      await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(count));
    });
  });

  it("drops malformed saved events without throwing", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const badTags = { ...fixtures[3]!, tags: [["d", "x"], 5] };
    const badNumber = { ...fixtures[4]!, tags: [["d", "y"], ["t", 7]] };
    await saveCopy([...fixtures.slice(0, 3), badTags, badNumber, null]);
    const gate = held(createMemoryReader(fixtures));
    const { result } = renderPlaces(gate.reader);

    await waitFor(() => expect(result.current.source).toBe("cache"));
    expect(result.current.places).toHaveLength(3);
    expect(debug).toHaveBeenCalledWith("[places] dropped 3 events from this device: malformed, or not the house's");

    await waitFor(() => expect(gate.waiting).toBe(1));
    gate.release();
    await waitFor(() => expect(result.current.places).toHaveLength(43));
  });

  it.each<[string, unknown]>([
    ["not an object", "junk"],
    ["no list of events", { events: { length: 1 }, savedAt: 1, complete: true }],
    ["no time", { events: fixtures, savedAt: "yesterday", complete: true }],
    ["no completeness flag", { events: fixtures, savedAt: 1 }],
    ["no places", { events: [], savedAt: 1, complete: true }],
  ])("ignores a saved copy with %s, quietly", async (_why, value) => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    await set(CACHE_KEY, value);
    const { result, seen } = renderPlaces(createMemoryReader(fixtures, { delayMs: 10 }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(seen).toEqual(["loading:network", "ready:network"]);
    expect(debug).not.toHaveBeenCalled();
  });
});

describe("usePlaces", () => {
  it("throws a clear error outside a PlacesProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => usePlaces())).toThrow("usePlaces must be used inside <PlacesProvider>");
  });
});
