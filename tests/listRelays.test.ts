import { describe, expect, it } from "vitest";

import { listRelaysWith, newListQuorum } from "../src/nostr/listRelays";

/*
 * Where a list a person keeps as one replaceable record is read and saved, given their relay list,
 * the app's own relays for such lists and the most there is room for; and how many of the app's
 * relays must answer before their having nothing of the person is believed. Nothing here reads a
 * relay or the app's settings: each is given what it decides from.
 */

const A = "wss://a.example.com";
const B = "wss://b.example.com";
const W1 = "wss://w1.example.com";
const W2 = "wss://w2.example.com";
const W3 = "wss://w3.example.com";
const R1 = "wss://r1.example.com";

describe("listRelaysWith", () => {
  it("keeps the app's relays, and lets the person's last give way when there is no room for them", () => {
    expect(listRelaysWith({ write: [W1, W2, W3], read: [R1] }, [A, B], 4)).toEqual({ relays: [W1, W2, A, B], writes: [W1, W2] });
  });

  it("gives the app's relays, and nowhere the person writes, when they have no relay list", () => {
    expect(listRelaysWith(null, [A, B], 4)).toEqual({ relays: [A, B], writes: [] });
  });

  it("leaves out a relay of the person's that is not wss:// or is on a private address", () => {
    const theirs = { write: ["ws://plain.example.com", "wss://localhost", W1], read: ["wss://192.168.1.2"] };

    expect(listRelaysWith(theirs, [A, B], 4)).toEqual({ relays: [W1, A, B], writes: [W1] });
  });
});

describe("newListQuorum", () => {
  it.each([
    [5, 3],
    [6, 4],
    [2, 3],
  ])("of %i relays, %i", (appRelays, quorum) => {
    expect(newListQuorum(appRelays)).toBe(quorum);
  });
});
