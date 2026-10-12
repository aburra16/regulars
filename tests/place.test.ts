import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import { parsePlace, type Place, PLACE_KIND } from "../src/places/place";
import raw from "./fixtures/funchal-items.json";

const fixtures: NostrEvent[] = raw;
const HEADER = config.headerCoordinate;
const first = fixtures[0]!;
const minimal = fixtures[40]!;
const longName = fixtures[41]!;
const japanese = fixtures[42]!;

/** Every value of the tags called `name`, in order. */
const valuesOf = (ev: NostrEvent, name: string) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]);

/** A copy of `ev` with its tags changed. */
const withTags = (ev: NostrEvent, change: (tags: string[][]) => string[][]): NostrEvent => ({
  ...ev,
  tags: change(ev.tags.map((t) => [...t])),
});
const without = (ev: NostrEvent, ...names: string[]) => withTags(ev, (tags) => tags.filter((t) => !names.includes(t[0]!)));
const replacing = (ev: NostrEvent, name: string, value: string) =>
  withTags(ev, (tags) => tags.map((t) => (t[0] === name ? [name, value] : t)));
const adding = (ev: NostrEvent, ...tag: string[]) => withTags(ev, (tags) => [...tags, tag]);

function parsed(ev: NostrEvent): Place {
  const place = parsePlace(ev, HEADER);
  if (place === null) throw new Error("expected the event to parse");
  return place;
}

describe("the fixtures", () => {
  it("hold 40 real items and 3 crafted ones, all place events from the house curator", () => {
    expect(fixtures).toHaveLength(43);
    expect(fixtures.every((ev) => ev.kind === PLACE_KIND && ev.pubkey === config.houseHex)).toBe(true);
    expect(fixtures.slice(40).map((ev) => valuesOf(ev, "d")[0])).toEqual([
      "crafted-minimal",
      "crafted-long-name",
      "crafted-japanese-name",
    ]);
  });

  it("have unique, well-shaped fake ids and signatures", () => {
    expect(new Set(fixtures.map((ev) => ev.id)).size).toBe(43);
    expect(fixtures.every((ev) => /^[0-9a-f]{64}$/.test(ev.id) && /^[0-9a-f]{128}$/.test(ev.sig))).toBe(true);
  });
});

describe("parsePlace: fields", () => {
  it("reads a real item", () => {
    const place = parsed(first);
    const d = valuesOf(first, "d")[0]!;
    expect(place.d).toBe(d);
    expect(place.pubkey).toBe("4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64");
    expect(place.address).toBe(`39999:4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64:${d}`);
    expect(place.name).toBe(valuesOf(first, "name")[0]);
    expect(place.category).toBe(valuesOf(first, "category")[0]);
    expect(place.createdAt).toBe(first.created_at);
  });

  it("reads coordinates as numbers", () => {
    const place = parsed(first);
    expect(typeof place.lat).toBe("number");
    expect(typeof place.lon).toBe("number");
    expect(place.lat).toBe(Number(valuesOf(first, "lat")[0]));
    expect(place.lon).toBe(Number(valuesOf(first, "lon")[0]));
    expect(place.lat).toBeCloseTo(config.defaultCity.lat, 1);
    expect(place.lon).toBeCloseTo(config.defaultCity.lon, 1);
  });

  it("keeps every t value as a keyword, in order", () => {
    const place = parsed(first);
    expect(place.keywords).toEqual(valuesOf(first, "t"));
    expect(place.keywords.length).toBeGreaterThan(0);
  });

  it("uses the 9-character g tag as the geohash", () => {
    const place = parsed(first);
    expect(place.geohash).toHaveLength(9);
    expect(place.geohash).toBe(valuesOf(first, "g").find((g) => g!.length === 9));
  });

  it("maps the address tag to street and the rest by name", () => {
    const place = parsed(first);
    expect(place.street).toBe(valuesOf(first, "address")[0]);
    expect(place.locality).toBe(valuesOf(first, "locality")[0]);
    expect(place.postalCode).toBe(valuesOf(first, "postal-code")[0]);
    expect(place.country).toBe(valuesOf(first, "country")[0]);
    expect(place.cuisine).toBe(valuesOf(first, "cuisine")[0]);
    expect(place.phone).toBe(valuesOf(first, "phone")[0]);
    expect(place.website).toBe(valuesOf(first, "website")[0]);
    expect(place.openingHours).toBe(valuesOf(first, "opening-hours")[0]);
    expect(place.osmId).toBe(valuesOf(first, "osm-id")[0]);
    expect(place.btcmapId).toBe(valuesOf(first, "btcmap-id")[0]);
    expect(place.acceptsBitcoin).toBe(valuesOf(first, "accepts-bitcoin")[0]);
  });

  it("reads the region and description when a place has them", () => {
    const place = parsed(
      adding(adding(first, "region", "Madeira"), "description", "Small but mighty"),
    );
    expect(place.region).toBe("Madeira");
    expect(place.description).toBe("Small but mighty");
  });

  it("reads the image when a place has one", () => {
    expect(parsed(adding(first, "image", "https://example.org/a.jpg")).image).toBe("https://example.org/a.jpg");
  });

  it("takes the first value of a field that appears twice", () => {
    const place = parsed(adding(adding(first, "name", "Second name"), "phone", "+351 000"));
    expect(place.name).toBe(valuesOf(first, "name")[0]);
    expect(place.phone).toBe(valuesOf(first, "phone")[0]);
  });

  it("parses all 43 fixtures, each with its own address", () => {
    const places = fixtures.map((ev) => parsePlace(ev, HEADER));
    expect(places.every((place) => place !== null)).toBe(true);
    expect(new Set(places.map((place) => place!.address)).size).toBe(43);
  });

  it("keeps a 67-character name whole", () => {
    const place = parsed(longName);
    expect(place.name).toHaveLength(67);
    expect(place.name).toBe(valuesOf(longName, "name")[0]);
  });

  it("keeps a Japanese name whole", () => {
    expect(parsed(japanese).name).toBe("ペーパー・クレーン");
  });
});

describe("parsePlace: optional fields", () => {
  const OPTIONAL = [
    "cuisine",
    "street",
    "locality",
    "region",
    "postalCode",
    "country",
    "phone",
    "website",
    "openingHours",
    "description",
    "image",
    "acceptsBitcoin",
    "osmId",
    "btcmapId",
  ] as const;

  it("are undefined, never an empty string, on a place with only the required ones", () => {
    const place = parsed(minimal);
    for (const key of OPTIONAL) expect(place[key], key).toBeUndefined();
    expect(place.keywords).toEqual([]);
    expect(place.name).toBe("Minimal Table");
    expect(place.category).toBe("restaurant");
    expect(place.geohash).toHaveLength(9);
  });

  it("are never an empty string on any fixture", () => {
    for (const ev of fixtures) {
      for (const [key, value] of Object.entries(parsed(ev))) expect(value, key).not.toBe("");
    }
  });

  it("are undefined when the tag is there but blank", () => {
    const place = parsed(
      withTags(first, (tags) =>
        tags.map((t) => (["phone", "website", "cuisine", "address", "accepts-bitcoin"].includes(t[0]!) ? [t[0]!, "  "] : t)),
      ),
    );
    expect(place.phone).toBeUndefined();
    expect(place.website).toBeUndefined();
    expect(place.cuisine).toBeUndefined();
    expect(place.street).toBeUndefined();
    expect(place.acceptsBitcoin).toBeUndefined();
  });

  it("leave out a t tag with no text", () => {
    expect(parsed(adding(first, "t", "")).keywords).toEqual(valuesOf(first, "t"));
  });
});

describe("parsePlace: acceptsBitcoin", () => {
  it.each(["lightning", "onchain", "both", "yes"] as const)("keeps %s", (value) => {
    expect(parsed(replacing(first, "accepts-bitcoin", value)).acceptsBitcoin).toBe(value);
  });

  it.each(["no", "maybe", "Lightning", "true", "1"])("turns %j into undefined", (value) => {
    expect(parsed(replacing(first, "accepts-bitcoin", value)).acceptsBitcoin).toBeUndefined();
  });
});

describe("parsePlace: events that are not places", () => {
  it("rejects another kind", () => {
    expect(parsePlace({ ...first, kind: 1 }, HEADER)).toBeNull();
    expect(parsePlace({ ...first, kind: 39998 }, HEADER)).toBeNull();
  });

  it("rejects an event with no z tag, or a z tag for another list", () => {
    expect(parsePlace(without(first, "z"), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "z", "39998:" + "a".repeat(64) + ":other-list"), HEADER)).toBeNull();
    expect(parsePlace(first, "39998:" + "a".repeat(64) + ":other-list")).toBeNull();
  });

  it("rejects an event with no name or no category", () => {
    expect(parsePlace(without(first, "name"), HEADER)).toBeNull();
    expect(parsePlace(without(first, "category"), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "name", ""), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "name", "   "), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "category", ""), HEADER)).toBeNull();
  });

  it("rejects an event with no d, since the d is the place's identity", () => {
    expect(parsePlace(without(first, "d"), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "d", ""), HEADER)).toBeNull();
  });

  it.each(["lat", "lon"])("rejects a missing or non-finite %s", (name) => {
    expect(parsePlace(without(first, name), HEADER)).toBeNull();
    for (const bad of ["", " ", "abc", "NaN", "Infinity", "-Infinity", "32,65"]) {
      expect(parsePlace(replacing(first, name, bad), HEADER), bad).toBeNull();
    }
  });

  it("rejects coordinates that are not on the globe", () => {
    expect(parsePlace(replacing(first, "lat", "90.5"), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "lat", "-91"), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "lon", "180.5"), HEADER)).toBeNull();
    expect(parsePlace(replacing(first, "lon", "-181"), HEADER)).toBeNull();
    expect(parsed(replacing(replacing(first, "lat", "-90"), "lon", "180")).lat).toBe(-90);
  });

  it("accepts coordinates at zero", () => {
    const place = parsed(replacing(replacing(first, "lat", "0"), "lon", "0"));
    expect(place.lat).toBe(0);
    expect(place.lon).toBe(0);
  });

  it("rejects an event whose pubkey is not 64 lowercase hex characters", () => {
    expect(parsePlace({ ...first, pubkey: "" }, HEADER)).toBeNull();
    expect(parsePlace({ ...first, pubkey: first.pubkey.slice(1) }, HEADER)).toBeNull();
    expect(parsePlace({ ...first, pubkey: first.pubkey.toUpperCase() }, HEADER)).toBeNull();
    expect(parsePlace({ ...first, pubkey: "g" + first.pubkey.slice(1) }, HEADER)).toBeNull();
  });

  it("rejects an event with no 9-character geohash", () => {
    expect(parsePlace(without(first, "g"), HEADER)).toBeNull();
    expect(parsePlace(withTags(first, (tags) => tags.filter((t) => t[0] !== "g" || t[1]!.length !== 9)), HEADER)).toBeNull();
  });
});
