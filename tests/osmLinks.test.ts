import { describe, expect, it } from "vitest";

import { goUrl, osmNoteUrl, osmUrl } from "../src/place/osmLinks";

describe("osmUrl", () => {
  it.each([
    ["node:123", "https://www.openstreetmap.org/node/123"],
    ["way:4567", "https://www.openstreetmap.org/way/4567"],
    ["relation:89", "https://www.openstreetmap.org/relation/89"],
    // The sort of id the places carry.
    ["node:11330857543", "https://www.openstreetmap.org/node/11330857543"],
  ])("makes %s the page of the thing on OpenStreetMap", (id, url) => {
    expect(osmUrl(id)).toBe(url);
  });

  it.each(["", "node", "node:", "node:abc", "node:12:3", "area:5", "NODE:5", " node:5", "node:5 ", "node:5/../../x", "https://x.test/node:5"])(
    "gives nothing for %j, which is not an id",
    (id) => {
      expect(osmUrl(id)).toBeUndefined();
    },
  );
});

describe("osmNoteUrl", () => {
  it("opens OpenStreetMap's form for a note at the place, zoomed in, with the coordinates to six decimals", () => {
    expect(osmNoteUrl(32.6507, -16.9084)).toBe("https://www.openstreetmap.org/note/new#map=19/32.650700/-16.908400");
  });

  it("rounds to six decimals", () => {
    expect(osmNoteUrl(32.65070049, -16.90839951)).toBe("https://www.openstreetmap.org/note/new#map=19/32.650700/-16.908400");
    expect(osmNoteUrl(0, 0)).toBe("https://www.openstreetmap.org/note/new#map=19/0.000000/0.000000");
  });

  it.each([
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [1, Number.NEGATIVE_INFINITY],
  ])("gives no link for a place that is not a point (%s, %s), so the caller can leave the link out", (lat, lon) => {
    expect(osmNoteUrl(lat, lon)).toBe("");
  });
});

describe("goUrl", () => {
  it("asks for directions to the place, from wherever the person is, with the coordinates to six decimals", () => {
    expect(goUrl({ lat: 32.6507, lon: -16.9084 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=32.650700,-16.908400",
    );
    expect(goUrl({ lat: 32.65070049, lon: -16.90839951 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=32.650700,-16.908400",
    );
  });

  it("gives no link for a place that is not a point", () => {
    expect(goUrl({ lat: Number.NaN, lon: 1 })).toBe("");
    expect(goUrl({ lat: 1, lon: Number.POSITIVE_INFINITY })).toBe("");
  });
});
