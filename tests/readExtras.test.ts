import type { NostrFilter } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { type ReadOptions, type RelayReader, readAll, withReadExtras } from "../src/nostr/events";
import { createMemoryReader } from "./support/memoryReader";

/** Sends `filter` through `reader`, and gives the filter that reached the relay. */
async function sent(extras: { search?: string } | undefined, filter: NostrFilter): Promise<NostrFilter | undefined> {
  const relay = createMemoryReader([]);
  for await (const _ of withReadExtras(relay, extras).req(filter, new AbortController().signal)) {
    // Nothing is stored: only the filter matters.
  }
  return relay.requests[0];
}

describe("withReadExtras (config.relayReadExtras)", () => {
  it("is the reader itself when its relay has no extras", () => {
    const relay = createMemoryReader([]);
    expect(withReadExtras(relay, undefined)).toBe(relay);
  });

  it("adds the relay's extras to each filter, and leaves the filter it was given as it was", async () => {
    const filter: NostrFilter = { kinds: [34259], "#a": ["x"] };
    expect(await sent({ search: "include:spam" }, filter)).toEqual({ kinds: [34259], "#a": ["x"], search: "include:spam" });
    expect(filter).toEqual({ kinds: [34259], "#a": ["x"] });
  });

  it("puts the relay's search words before the read's own, rather than in their place", async () => {
    expect(await sent({ search: "include:spam" }, { kinds: [0], search: "bolo" })).toEqual({
      kinds: [0],
      search: "include:spam bolo",
    });
    // A read whose search is blank, and extras with none, change nothing about the words.
    expect(await sent({ search: "include:spam" }, { kinds: [0], search: "  " })).toEqual({
      kinds: [0],
      search: "include:spam",
    });
    expect(await sent({}, { kinds: [0], search: "bolo" })).toEqual({ kinds: [0], search: "bolo" });
  });
});

describe("how a read is to be made (ReadOptions, ruling R40)", () => {
  /** A relay's reader that notes how each read was to be made, as it was given. */
  function noting() {
    const seen: (ReadOptions | undefined)[] = [];
    const reader: RelayReader = {
      async *req(_filter, _signal, opts) {
        seen.push(opts);
      },
    };
    return { reader, seen };
  }
  const signal = new AbortController().signal;
  const failFast: ReadOptions = { failFast: true };

  it("is passed on by a reader with its relay's extras, as it came, and nothing is made up when none is given", async () => {
    const { reader, seen } = noting();
    const withExtras = withReadExtras(reader, { search: "include:spam" });

    await readAll(withExtras, { kinds: [3] }, signal, failFast);
    await readAll(withExtras, { kinds: [3] }, signal);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(failFast);
    expect(seen[1]).toBeUndefined();
  });

  it("is passed on by readAll to the reader it reads", async () => {
    const { reader, seen } = noting();

    await readAll(reader, { kinds: [3] }, signal, failFast);
    await readAll(reader, { kinds: [3] }, signal);

    expect(seen).toEqual([failFast, undefined]);
  });
});
