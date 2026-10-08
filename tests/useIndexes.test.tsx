import type { NostrEvent } from "@nostrify/nostrify";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { set } from "idb-keyval";
import { type ReactNode, StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CACHE_KEY } from "../src/places/cache";
import { buildIndexes, type Indexes } from "../src/places/indexes";
import type { RelayReader } from "../src/places/load";
import { PlacesProvider, usePlaces } from "../src/places/store";
import { useIndexes } from "../src/places/useIndexes";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

// The real `buildIndexes`, counted.
vi.mock("../src/places/indexes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/places/indexes")>();
  return { ...actual, buildIndexes: vi.fn(actual.buildIndexes) };
});

const fixtures: NostrEvent[] = raw;

/** Renders `useIndexes` inside a provider, next to the places it is built from. */
function renderIndexes(reader: RelayReader) {
  return renderHook(() => ({ indexes: useIndexes(), places: usePlaces() }), {
    wrapper: ({ children }: { children: ReactNode }) => <PlacesProvider reader={reader}>{children}</PlacesProvider>,
  });
}

describe("useIndexes", () => {
  it("is undefined while the places load, and the places' indexes once they have", async () => {
    const { result } = renderIndexes(createMemoryReader(fixtures, { delayMs: 20 }));
    expect(result.current.places.status).toBe("loading");
    expect(result.current.indexes).toBeUndefined();

    await waitFor(() => expect(result.current.indexes).toBeDefined());
    expect(result.current.indexes!.byD.size).toBe(43);
    expect(result.current.indexes!.near(32.6507, -16.9084, 25)).toHaveLength(43);
  });

  it("is undefined when no places could be loaded", async () => {
    const { result } = renderIndexes(createMemoryReader([], { failWith: new Error("down") }));
    await waitFor(() => expect(result.current.places.status).toBe("error"));
    expect(result.current.indexes).toBeUndefined();
  });

  it("is built once for a places array, not again when only the state around it changes", async () => {
    const { result, rerender } = renderIndexes(createMemoryReader(fixtures));
    await waitFor(() => expect(result.current.indexes).toBeDefined());
    const first = result.current.indexes;
    const places = result.current.places.places;

    // The places are saved on the device a moment after they show: the state changes, the places do not.
    await waitFor(() => expect(result.current.places.savedAt).toBeDefined());
    expect(result.current.places.places).toBe(places);
    expect(result.current.indexes).toBe(first);

    rerender();
    expect(result.current.indexes).toBe(first);
  });

  it("is built again when the places are replaced", async () => {
    await set(CACHE_KEY, { events: fixtures.slice(0, 10), savedAt: 1_000, complete: true });
    // The relay answers when the test lets it, after the saved places are on screen.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memory = createMemoryReader(fixtures);
    const { result } = renderIndexes({
      async *req(filter, signal) {
        await released;
        yield* memory.req(filter, signal);
      },
    });

    await waitFor(() => expect(result.current.indexes?.byD.size).toBe(10));
    const fromDevice = result.current.indexes;

    release();
    await waitFor(() => expect(result.current.indexes?.byD.size).toBe(43));
    expect(result.current.indexes).not.toBe(fromDevice);
  });

  it("builds once for a list of places, however many components ask, and not again when one mounts later or remounts", async () => {
    vi.mocked(buildIndexes).mockClear();
    const seen = new Map<string, Indexes | undefined>();
    const saved: { at?: number } = {};
    const controls: { remount?: () => void } = {};

    function Probe({ name }: { name: string }) {
      seen.set(name, useIndexes());
      return null;
    }
    // Shows its probe once the places are in, so it mounts after the others have built.
    function Late() {
      const { status, savedAt } = usePlaces();
      saved.at = savedAt;
      return status === "ready" ? <Probe name="late" /> : null;
    }
    function Harness() {
      const [round, setRound] = useState(0);
      controls.remount = () => setRound((n) => n + 1);
      return (
        <PlacesProvider reader={createMemoryReader(fixtures, { delayMs: 10 })}>
          <Probe name="first" />
          <Probe key={round} name="second" />
          <Late />
        </PlacesProvider>
      );
    }

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await waitFor(() => expect(["first", "second", "late"].map((name) => seen.get(name))).not.toContain(undefined));
    expect(vi.mocked(buildIndexes)).toHaveBeenCalledTimes(1);
    const indexes = seen.get("first");
    expect(seen.get("second")).toBe(indexes);
    expect(seen.get("late")).toBe(indexes);

    // The places are saved on the device a moment later: the state changes, the places do not.
    await waitFor(() => expect(saved.at).toBeDefined());
    // A consumer that mounts again finds the indexes that are there.
    seen.delete("second");
    act(() => controls.remount?.());
    await waitFor(() => expect(seen.get("second")).toBeDefined());
    expect(seen.get("second")).toBe(indexes);
    expect(vi.mocked(buildIndexes)).toHaveBeenCalledTimes(1);
  });
});
