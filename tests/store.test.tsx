import type { NostrEvent } from "@nostrify/nostrify";
import { act, renderHook, waitFor } from "@testing-library/react";
import { get, set } from "idb-keyval";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { CACHE_KEY } from "../src/places/cache";
import type { RelayReader } from "../src/places/load";
import { PlacesProvider, usePlaces } from "../src/places/store";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;

interface Saved {
  events: NostrEvent[];
  savedAt: number;
}

const saveCopy = (events: unknown[], savedAt = 1_000) => set(CACHE_KEY, { events, savedAt });
const savedCopy = () => get<Saved>(CACHE_KEY);

/**
 * Renders `usePlaces` inside a provider, and keeps every distinct `status:source` it showed,
 * in order, so a test can tell what a person saw on the way.
 */
function renderPlaces(reader?: RelayReader, opts: { strict?: boolean } = {}) {
  const seen: string[] = [];
  const view = renderHook(
    () => {
      const state = usePlaces();
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
  return {
    reader: {
      async *req(filter, signal) {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield* inner.req(filter, signal);
      },
    } satisfies RelayReader,
    /** Lets request `index` through, or every request held so far. */
    release(index?: number) {
      for (const open of index === undefined ? gates : [gates[index]!]) open();
    },
    get waiting() {
      return gates.length;
    },
  };
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
    expect(result.current.error).toBeUndefined();

    await waitFor(() => expect(gate.waiting).toBe(1));
    gate.release();
    await waitFor(() => expect(result.current.places).toHaveLength(43));
    expect(result.current.source).toBe("network");
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeUndefined();
    expect(result.current.savedAt).toBeGreaterThan(1_000);
    expect(seen).toEqual(["loading:network", "ready:cache", "ready:network"]);
  });

  it("with no saved copy and the network down, gives an error code, and retry() tries again", async () => {
    const reader = failingOnce();
    const { result, seen } = renderPlaces(reader);

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("network");
    expect(result.current.places).toEqual([]);

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
    const reader = createMemoryReader(fixtures, { failWith: new Error("down"), delayMs: 10 });
    const { result, seen } = renderPlaces(reader);

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
    const reader = failingOnce();
    const { result } = renderPlaces(reader);

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

  it("settles on the network's places under StrictMode, which mounts twice", async () => {
    const reader = createMemoryReader(fixtures, { delayMs: 10 });
    const { result } = renderPlaces(reader, { strict: true });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.source).toBe("network");
    expect(result.current.places).toHaveLength(43);
    await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(43));
  });

  it("asks the places relay when no reader is given", async () => {
    vi.doMock("../src/places/relayReader", () => ({ relayReader: createMemoryReader(fixtures) }));
    try {
      const { result } = renderPlaces();
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.places).toHaveLength(43);
    } finally {
      vi.doUnmock("../src/places/relayReader");
    }
  });
});

describe("saving places on the device", () => {
  it("saves the events after a complete fetch, with the time saved", async () => {
    const { result } = renderPlaces(createMemoryReader(fixtures));

    await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(43));
    const saved = (await savedCopy())!;
    expect(saved.events).toEqual(expect.arrayContaining(fixtures));
    expect(saved.savedAt).toBe(result.current.savedAt);
  });

  it("treats an answer with no places as a failure, and keeps the saved copy", async () => {
    await saveCopy(fixtures.slice(0, 5));
    const { result } = renderPlaces(createMemoryReader([], { delayMs: 10 }));

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

    it("is shown and saved when nothing was saved before", async () => {
      const { result } = renderPlaces(createMemoryReader(incomplete));

      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.source).toBe("network");
      expect(result.current.places).toHaveLength(10_000);
      await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(10_000));
    });

    it("replaces a smaller saved copy", async () => {
      await saveCopy(fixtures.slice(0, 5));
      const { result } = renderPlaces(createMemoryReader(incomplete, { delayMs: 10 }));

      await waitFor(() => expect(result.current.places).toHaveLength(10_000));
      expect(result.current.source).toBe("network");
      await waitFor(async () => expect((await savedCopy())?.events).toHaveLength(10_000));
    });

    it("never replaces a fuller saved copy, which stays on screen", async () => {
      await saveCopy(generated(10_002));
      const { result } = renderPlaces(createMemoryReader(incomplete, { delayMs: 10 }));

      await waitFor(() => expect(result.current.error).toBe("network"));
      expect(result.current.status).toBe("ready");
      expect(result.current.source).toBe("cache");
      expect(result.current.places).toHaveLength(10_002);
      expect((await savedCopy())!.events).toHaveLength(10_002);
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
    ["no list of events", { events: { length: 1 }, savedAt: 1 }],
    ["no time", { events: fixtures, savedAt: "yesterday" }],
    ["no places", { events: [], savedAt: 1 }],
  ])("ignores a saved copy with %s", async (_why, value) => {
    await set(CACHE_KEY, value);
    const { result, seen } = renderPlaces(createMemoryReader(fixtures, { delayMs: 10 }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(seen).toEqual(["loading:network", "ready:network"]);
  });

  it("still loads from the network when the device cannot save (private browsing)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("idb-keyval", () => ({
      get: () => Promise.reject(new Error("IndexedDB is unavailable")),
      set: () => Promise.reject(new Error("IndexedDB is unavailable")),
    }));
    try {
      const store = await import("../src/places/store");
      const { result } = renderHook(() => store.usePlaces(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <store.PlacesProvider reader={createMemoryReader(fixtures)}>{children}</store.PlacesProvider>
        ),
      });

      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.source).toBe("network");
      expect(result.current.places).toHaveLength(43);
      await waitFor(() => expect(debug).toHaveBeenCalledTimes(2)); // one read, one write
    } finally {
      vi.doUnmock("idb-keyval");
      vi.resetModules();
    }
  });
});

describe("usePlaces", () => {
  it("throws a clear error outside a PlacesProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => usePlaces())).toThrow("usePlaces must be used inside <PlacesProvider>");
  });
});
