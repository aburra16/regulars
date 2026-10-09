import type { NostrEvent } from "@nostrify/nostrify";
import { act, renderHook, waitFor } from "@testing-library/react";
import { set } from "idb-keyval";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RelayReader } from "../src/nostr/events";
import { CACHE_KEY } from "../src/places/cache";
import { buildIndexes } from "../src/places/indexes";
import { PlacesProvider, TOWNS_WAIT_MS, usePlaces } from "../src/places/store";
import { loadTowns, readTowns, type TownList, townsLoader } from "../src/places/towns";
import { useIndexes } from "../src/places/useIndexes";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";
import { townsOf } from "./support/towns";

// `loadTowns` as the test has it: the real one, unless a test gives the store its own answer.
const towns = vi.hoisted(() => ({ load: undefined as (() => Promise<unknown>) | undefined }));
vi.mock("../src/places/towns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/towns")>();
  return { ...actual, loadTowns: () => (towns.load ?? actual.loadTowns)() };
});

// The real `buildIndexes`, counted.
vi.mock("../src/places/indexes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/indexes")>();
  return { ...actual, buildIndexes: vi.fn(actual.buildIndexes) };
});

// The saved copy's read, as the app does it, with word to the test when it has answered.
const device = vi.hoisted(() => ({ onRead: undefined as (() => void) | undefined }));
vi.mock("../src/places/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/cache")>();
  return {
    ...actual,
    readSaved: async () => {
      const saved = await actual.readSaved();
      device.onRead?.();
      return saved;
    },
  };
});

const fixtures: NostrEvent[] = raw;

afterEach(() => {
  towns.load = undefined;
  device.onRead = undefined;
});

/**
 * Renders the places and their indexes inside a provider that reads `events`, or reads with `reader`.
 * The places wait for their towns a minute unless `townsWaitMs` says otherwise: no test leans on a real
 * window of time.
 */
function renderPlaces(events: NostrEvent[], given?: { towns?: TownList | null; reader?: RelayReader; townsWaitMs?: number }) {
  const reader = given?.reader ?? createMemoryReader(events);
  return renderHook(() => ({ places: usePlaces(), indexes: useIndexes() }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PlacesProvider
        reader={reader}
        townsWaitMs={given?.townsWaitMs ?? 60_000}
        {...(given?.towns === undefined ? {} : { towns: given.towns })}
      >
        {children}
      </PlacesProvider>
    ),
  });
}

/** A promise the test settles. */
function later<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("townsLoader", () => {
  const file = { default: { source: "", licence: "", date: "", regenerate: "", towns: { PT: [[2267827, "Funchal", 32.6657, -16.9255]] }, parts: [], localities: {} } };

  it("gives null when the chunk cannot be loaded, loads again at the next call, and keeps what loaded", async () => {
    const load = vi.fn<() => Promise<{ default: unknown }>>().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(file);
    const read = townsLoader(load);
    expect(await read()).toBeNull();
    const list = await read();
    expect(list?.towns.map((town) => town.name)).toEqual(["Funchal"]);
    expect(read()).toBe(read());
    expect(await read()).toBe(list);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives null for a file it cannot read, and never rejects", async () => {
    const read = townsLoader(async () => ({ default: { towns: 5 } }));
    await expect(read()).resolves.toBeNull();
    expect(readTowns(file.default as never).towns).toHaveLength(1);
  });
});

describe("loadTowns", () => {
  it("reads the app's towns from their chunk, once, however many ask", async () => {
    const first = loadTowns();
    expect(loadTowns()).toBe(first);
    const list = await first;
    expect(list?.towns.find((town) => town.name === "Prague")).toMatchObject({ id: 3067696, country: "CZ" });
    expect(list?.towns.filter((town) => town.name === "Kansas City").map((town) => town.region).sort()).toEqual(["KS", "MO"]);
  });
});

describe("the places, with their towns", () => {
  it("are put in the app's towns, which load with them", async () => {
    const { result } = renderPlaces(fixtures);
    await waitFor(() => expect(result.current.indexes).toBeDefined());
    expect(result.current.places.towns).toBeTruthy();
    const funchal = result.current.indexes!.cities.find((city) => city.name === "Funchal");
    expect(funchal).toMatchObject({ geonameId: 2267827, country: "PT" });
  });

  it("wait a moment for their towns, from the relay or from the device, and show with them when they come in time", async () => {
    await set(CACHE_KEY, { events: fixtures.slice(0, 10), savedAt: 1_000, complete: true });
    const slow = later<TownList | null>();
    towns.load = () => slow.promise;
    const read = later<void>();
    device.onRead = () => read.settle();
    const answered = later<void>();
    const memory = createMemoryReader(fixtures);
    const reader: RelayReader = {
      async *req(filter, signal) {
        yield* memory.req(filter, signal);
        answered.settle();
      },
    };
    const seen: (TownList | null | undefined)[] = [];
    const { result } = renderHook(
      () => {
        const value = { places: usePlaces(), indexes: useIndexes() };
        if (value.places.status === "ready") seen.push(value.places.towns);
        return value;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <PlacesProvider reader={reader} townsWaitMs={60_000}>
            {children}
          </PlacesProvider>
        ),
      },
    );

    // The saved copy has been read, and the relay has answered: still loading, a moment, for the towns.
    await act(async () => {
      await Promise.all([read.promise, answered.promise]);
    });
    expect(result.current.places.status).toBe("loading");
    expect(result.current.indexes).toBeUndefined();

    const list = townsOf([{ id: 2267827, name: "Funchal", country: "PT", lat: 32.6657, lon: -16.9255 }]);
    slow.settle(list);
    await waitFor(() => expect(result.current.indexes?.byD.size).toBe(43));
    expect(result.current.places.towns).toBe(list);
    expect(result.current.indexes!.cities.map((city) => [city.name, city.count])).toEqual([["Funchal", 43]]);
    // Never on screen without them.
    expect(seen.every((each) => each === list)).toBe(true);
    // The app's own wait, which this test sets longer.
    expect(TOWNS_WAIT_MS).toBe(300);
  });

  it("show without their towns when the chunk stalls, and take them, building the indexes once more, when they come", async () => {
    vi.mocked(buildIndexes).mockClear();
    const slow = later<TownList | null>();
    towns.load = () => slow.promise;
    // No wait at all: the chunk has stalled as soon as the places are in.
    const { result } = renderPlaces(fixtures, { townsWaitMs: 0 });

    // Past the wait: the places, in the towns their localities name.
    await waitFor(() => expect(result.current.indexes?.byD.size).toBe(43));
    expect(result.current.places.towns).toBeNull();
    expect(result.current.indexes!.cities.map((city) => [city.name, city.geonameId])).toEqual([["Funchal", undefined]]);
    expect(vi.mocked(buildIndexes)).toHaveBeenCalledTimes(1);

    const list = townsOf([{ id: 2267827, name: "Funchal", country: "PT", lat: 32.6657, lon: -16.9255 }]);
    slow.settle(list);
    await waitFor(() => expect(result.current.places.towns).toBe(list));
    expect(result.current.indexes!.cities.map((city) => [city.name, city.geonameId])).toEqual([["Funchal", 2267827]]);
    expect(vi.mocked(buildIndexes)).toHaveBeenCalledTimes(2);
  });

  it("load the towns again when the browser is back on line, while they could not be loaded", async () => {
    const list = townsOf([{ id: 2267827, name: "Funchal", country: "PT", lat: 32.6657, lon: -16.9255 }]);
    const load = vi.fn<() => Promise<TownList | null>>().mockResolvedValueOnce(null).mockResolvedValue(list);
    towns.load = load;
    const { result } = renderPlaces(fixtures);
    await waitFor(() => expect(result.current.indexes).toBeDefined());
    expect(result.current.places.towns).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.places.towns).toBe(list));
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.indexes!.cities[0]).toMatchObject({ name: "Funchal", geonameId: 2267827 });
  });

  it("go in the towns their localities name when the towns cannot be loaded", async () => {
    towns.load = async () => null;
    const { result } = renderPlaces(fixtures);
    await waitFor(() => expect(result.current.indexes).toBeDefined());
    expect(result.current.places.towns).toBeNull();
    expect(result.current.indexes!.cities.map((city) => [city.name, city.geonameId])).toEqual([["Funchal", undefined]]);
  });

  it("take the towns a test gives the store, and never load the chunk", async () => {
    const load = vi.fn(async () => null);
    towns.load = load;
    const given = townsOf([{ id: 1, name: "Somewhere", country: "PT", lat: 32.65, lon: -16.91 }]);
    const { result } = renderPlaces(fixtures, { towns: given });
    await waitFor(() => expect(result.current.indexes).toBeDefined());
    expect(result.current.indexes!.cities.map((city) => city.name)).toEqual(["Somewhere"]);
    expect(load).not.toHaveBeenCalled();
  });
});
