import type { NostrFilter } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { withReadExtras } from "../src/nostr/events";
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
