import { type NostrEvent, NSchema } from "@nostrify/nostrify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { asEvent, fetchHousePlaces, MAX_PAGES, type RelayReader } from "../src/places/load";
import raw from "./fixtures/funchal-items.json";
import { createMemoryReader } from "./support/memoryReader";

const fixtures: NostrEvent[] = raw;
const BASE = fixtures[0]!.created_at;

/** The `d` of a fixture. */
const dOf = (ev: NostrEvent) => ev.tags.find((tag) => tag[0] === "d")![1]!;
const addressOf = (ev: NostrEvent) => `39999:${ev.pubkey}:${dOf(ev)}`;

/** The fixtures with one second between each, the first the oldest. The real list shares one time. */
const spread = fixtures.map((ev, i) => ({ ...ev, created_at: BASE + i }));

/** A copy of `ev` with its tags changed. */
const withTags = (ev: NostrEvent, change: (tags: string[][]) => string[][]): NostrEvent => ({
  ...ev,
  tags: change(ev.tags.map((tag) => [...tag])),
});
const renamed = (ev: NostrEvent, name: string) =>
  withTags(ev, (tags) => tags.map((tag) => (tag[0] === "name" ? ["name", name] : tag)));

/** A 64-character hex id made of one repeated digit. */
const idOf = (digit: string) => digit.repeat(64);

/**
 * A reader that yields `values` exactly as given, in order, whatever the filter: a relay that
 * is broken or hostile. It counts its requests.
 */
function rawReader(values: unknown[]): RelayReader & { calls: number } {
  const reader = {
    calls: 0,
    async *req() {
      reader.calls += 1;
      yield* values as NostrEvent[];
    },
  };
  return reader;
}

/** The debug log, silenced for the test, so the output stays clean. */
const spyOnDebug = () => vi.spyOn(console, "debug").mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchHousePlaces: the request", () => {
  it("asks for the house's places in the list, up to dcosl's limit of 10000", async () => {
    const reader = createMemoryReader(fixtures);
    const { places, complete } = await fetchHousePlaces(reader);

    expect(reader.requests).toStrictEqual([
      {
        kinds: [39999],
        authors: [config.houseHex],
        "#z": [config.headerCoordinate],
        limit: 10000,
      },
    ]);
    expect(places).toHaveLength(43);
    expect(complete).toBe(true);
  });

  it("returns every fixture as a place, one per address", async () => {
    const { places } = await fetchHousePlaces(createMemoryReader(fixtures));
    expect(places.map((place) => place.address).sort()).toEqual(fixtures.map(addressOf).sort());
  });

  it("passes the caller's signal to the reader", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const memory = createMemoryReader(fixtures);
    const reader: RelayReader = {
      req(filter, signal) {
        seen.push(signal);
        return memory.req(filter, signal);
      },
    };
    await fetchHousePlaces(reader, { signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
  });
});

describe("fetchHousePlaces: paging (Review Focus 2)", () => {
  it("follows a full page with the next, until the oldest time seen, and returns all 43", async () => {
    const reader = createMemoryReader(spread);
    const { places, complete } = await fetchHousePlaces(reader, { pageSize: 10 });

    // Newest first: 42..33, then 33..24 (33 again, since `until` includes it), 24..15, 15..6, 6..0.
    expect(reader.requests.map((filter) => filter.until)).toEqual([
      undefined,
      BASE + 33,
      BASE + 24,
      BASE + 15,
      BASE + 6,
    ]);
    expect(reader.requests.every((filter) => filter.limit === 10)).toBe(true);
    expect(places).toHaveLength(43);
    expect(new Set(places.map((place) => place.address)).size).toBe(43);
    expect(complete).toBe(true);
  });

  it("asks once more after a full last page, and ends on the short answer", async () => {
    const reader = createMemoryReader(spread.slice(0, 10));
    const { places, complete } = await fetchHousePlaces(reader, { pageSize: 10 });

    expect(reader.requests.map((filter) => filter.until)).toEqual([undefined, BASE]);
    expect(places).toHaveLength(10);
    expect(complete).toBe(true);
  });

  it("stops when a page adds no new place, and says the list is incomplete (no progress)", async () => {
    // The importer signs a whole run at one time, so `until` cannot get past the first page.
    expect(new Set(fixtures.map((ev) => ev.created_at)).size).toBe(1);
    const reader = createMemoryReader(fixtures);
    const { places, complete } = await fetchHousePlaces(reader, { pageSize: 10 });

    expect(reader.requests.map((filter) => filter.until)).toEqual([undefined, BASE]);
    expect(places).toHaveLength(10);
    expect(complete).toBe(false);
  });

  it(`gives up after ${MAX_PAGES} full pages, however many new places keep coming`, async () => {
    let calls = 0;
    let next = 0;
    const template = fixtures[0]!;
    const endless: RelayReader = {
      async *req(filter) {
        calls += 1;
        for (let i = 0; i < (filter.limit ?? 0); i++, next++) {
          yield {
            ...withTags(template, (tags) => tags.map((tag) => (tag[0] === "d" ? ["d", `endless-${next}`] : tag))),
            created_at: BASE - next,
          };
        }
      },
    };
    const { places, complete } = await fetchHousePlaces(endless, { pageSize: 2 });

    expect(calls).toBe(MAX_PAGES);
    expect(places).toHaveLength(MAX_PAGES * 2);
    expect(complete).toBe(false);
  });
});

describe("fetchHousePlaces: which version of a place wins", () => {
  const older = { ...renamed(fixtures[0]!, "Old name"), id: idOf("1"), created_at: BASE };
  const newer = { ...renamed(fixtures[0]!, "New name"), id: idOf("2"), created_at: BASE + 1 };

  it.each([
    ["newest first", [newer, older]],
    ["oldest first", [older, newer]],
  ])("keeps the newest event at an address (%s)", async (_order, events) => {
    const { places } = await fetchHousePlaces(rawReader(events));
    expect(places).toHaveLength(1);
    expect(places[0]!.name).toBe("New name");
    expect(places[0]!.createdAt).toBe(BASE + 1);
  });

  it("breaks a tie in time with the lowest id, as NIP-01 says", async () => {
    const low = { ...renamed(fixtures[0]!, "Low id"), id: idOf("a"), created_at: BASE };
    const high = { ...renamed(fixtures[0]!, "High id"), id: idOf("f"), created_at: BASE };
    for (const events of [
      [low, high],
      [high, low],
    ]) {
      const { places } = await fetchHousePlaces(rawReader(events));
      expect(places.map((place) => place.name)).toEqual(["Low id"]);
    }
  });

  it("drops events that are not places of the list", async () => {
    const nameless = { ...withTags(fixtures[1]!, (tags) => tags.filter((tag) => tag[0] !== "name")), id: idOf("3") };
    const otherList = {
      ...withTags(fixtures[2]!, (tags) => tags.map((tag) => (tag[0] === "z" ? ["z", "39998:abc:other"] : tag))),
      id: idOf("4"),
    };
    const { places } = await fetchHousePlaces(rawReader([fixtures[0], nameless, otherList, fixtures[3]]));
    expect(places.map((place) => place.address)).toEqual([addressOf(fixtures[0]!), addressOf(fixtures[3]!)]);
  });

  it("drops the place when its newest version is not a place, rather than showing the old one", async () => {
    const broken = {
      ...withTags(fixtures[0]!, (tags) => tags.filter((tag) => tag[0] !== "lat")),
      id: idOf("5"),
      created_at: BASE + 1,
    };
    const { places } = await fetchHousePlaces(rawReader([fixtures[0], broken, fixtures[1]]));
    expect(places.map((place) => place.address)).toEqual([addressOf(fixtures[1]!)]);
  });

  it("drops events from anyone but the house account", async () => {
    const debug = spyOnDebug();
    const stranger = { ...fixtures[1]!, pubkey: "b".repeat(64), id: idOf("6") };
    const { places } = await fetchHousePlaces(rawReader([fixtures[0], stranger]));
    expect(places.map((place) => place.pubkey)).toEqual([config.houseHex]);
    expect(debug).toHaveBeenCalledWith("[places] dropped 1 events from the relay: malformed, or not the house's");
  });
});

describe("fetchHousePlaces: malformed events", () => {
  const malformed: unknown[] = [
    withTags(fixtures[3]!, (tags) => [...tags, "t" as unknown as string[]]), // a tag that is not an array
    withTags(fixtures[4]!, (tags) => [...tags, ["t", 5 as unknown as string]]), // a number in a tag
    { ...fixtures[5]!, created_at: "yesterday" },
    { ...fixtures[6]!, sig: "not a signature" },
    null,
    "junk",
  ];

  it("drops an event whose tags hold a non-array or a number, without throwing", async () => {
    const debug = spyOnDebug();
    const { places, complete } = await fetchHousePlaces(rawReader([...fixtures.slice(0, 3), ...malformed]));

    expect(places.map((place) => place.address)).toEqual(fixtures.slice(0, 3).map(addressOf));
    expect(complete).toBe(true);
    expect(debug.mock.calls).toEqual([["[places] dropped 6 events from the relay: malformed, or not the house's"]]);
  });

  it("logs nothing when every event is well formed", async () => {
    const debug = spyOnDebug();
    await fetchHousePlaces(createMemoryReader(fixtures));
    expect(debug).not.toHaveBeenCalled();
  });
});

describe("asEvent", () => {
  const ev = fixtures[0]!;
  const cases: Array<[string, unknown]> = [
    ["a fixture", ev],
    ["an empty tag list and content", { ...ev, tags: [], content: "" }],
    ["an empty tag", { ...ev, tags: [[]] }],
    ["kind 0", { ...ev, kind: 0 }],
    ["kind 65535", { ...ev, kind: 65535 }],
    ["kind 65536", { ...ev, kind: 65536 }],
    ["a negative kind", { ...ev, kind: -1 }],
    ["a fractional kind", { ...ev, kind: 1.5 }],
    ["a kind as text", { ...ev, kind: "39999" }],
    ["time 0", { ...ev, created_at: 0 }],
    ["a negative time", { ...ev, created_at: -1 }],
    ["a fractional time", { ...ev, created_at: 1.5 }],
    ["an unsafe integer time", { ...ev, created_at: 2 ** 53 }],
    ["an infinite time", { ...ev, created_at: Infinity }],
    ["a time as text", { ...ev, created_at: "1791242721" }],
    ["an upper-case id", { ...ev, id: ev.id.toUpperCase() }],
    ["a short id", { ...ev, id: ev.id.slice(1) }],
    ["a short pubkey", { ...ev, pubkey: ev.pubkey.slice(1) }],
    ["a short signature", { ...ev, sig: ev.sig.slice(1) }],
    ["no signature", { ...ev, sig: undefined }],
    ["content as a number", { ...ev, content: 1 }],
    ["tags as an object", { ...ev, tags: {} }],
    ["a tag that is text", { ...ev, tags: ["d"] }],
    ["a tag holding null", { ...ev, tags: [["d", null]] }],
    ["a nested tag", { ...ev, tags: [[["d"]]] }],
    ["null", null],
    ["an array", [ev]],
    ["text", JSON.stringify(ev)],
  ];

  it.each(cases)("agrees with Nostrify's NSchema.event() on %s", (_name, value) => {
    expect(asEvent(value) !== null).toBe(NSchema.event().safeParse(value).success);
  });

  it("keeps exactly the event's fields, and drops any others", () => {
    const extra = { ...ev, seenOn: ["wss://elsewhere"], [Symbol("verified")]: true };
    const result = asEvent(extra);
    expect(result).toStrictEqual({
      id: ev.id,
      pubkey: ev.pubkey,
      created_at: ev.created_at,
      kind: ev.kind,
      tags: ev.tags,
      content: ev.content,
      sig: ev.sig,
    });
  });
});

describe("fetchHousePlaces: failure", () => {
  it("rejects when the reader fails", async () => {
    const reader = createMemoryReader(fixtures, { failWith: new Error("unreachable") });
    await expect(fetchHousePlaces(reader)).rejects.toThrow("unreachable");
  });

  it("sends no request once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = createMemoryReader(fixtures);
    await expect(fetchHousePlaces(reader, { signal: controller.signal })).rejects.toThrow();
    expect(reader.requests).toEqual([]);
  });

  it("rejects when aborted during a page, even if the reader then just stops", async () => {
    const controller = new AbortController();
    const quiet: RelayReader = {
      async *req() {
        yield fixtures[0]!;
        controller.abort();
      },
    };
    await expect(fetchHousePlaces(quiet, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("the test environment", () => {
  it("refuses to open a network socket", () => {
    expect(() => new WebSocket("wss://example.invalid")).toThrow(/must not open a network socket/);
  });
});
