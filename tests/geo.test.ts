import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import KDBush from "kdbush";
import { describe, expect, it } from "vitest";

import { around, distance, withinCounter } from "../src/places/geo";

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance, written out here so the tests do not lean on the code they test. */
function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** A deterministic stream in [0, 1), so the points are the same on every run. */
function stream(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Point = [lng: number, lat: number];

function indexOf(points: Point[]): KDBush {
  const index = new KDBush(points.length);
  for (const [lng, lat] of points) index.add(lng, lat);
  return index.finish();
}

/** Points in a box of the given size around a centre, and some anywhere on the Earth. */
function scatter(count: number, seed: number, centre: Point, spanDegrees: number): Point[] {
  const random = stream(seed);
  return Array.from({ length: count }, (_, i): Point =>
    i % 10 === 0
      ? [random() * 360 - 180, random() * 170 - 85]
      : [centre[0] + (random() - 0.5) * spanDegrees, centre[1] + (random() - 0.5) * spanDegrees],
  );
}

const FUNCHAL: Point = [-16.9084, 32.6507];
const points = scatter(3000, 11, FUNCHAL, 1.5);
const index = indexOf(points);
const dense = scatter(3000, 5, FUNCHAL, 0.05);
const denseIndex = indexOf(dense);

const queries: Point[] = [FUNCHAL, [-17.2, 32.9], [-16.5, 32.4], [0, 0], [-120, 48], [10, -60], [-16.9, 32.65]];

describe("the notice", () => {
  const source = readFileSync(resolve(process.cwd(), "src/places/geo.ts"), "utf8");
  const header = source.slice(0, source.indexOf("import"));

  it("keeps the ISC licence and the authors at the top of the file", () => {
    expect(header).toContain("ISC License");
    expect(header).toContain("Copyright (c) 2017, Vladimir Agafonkin");
    expect(header).toContain("Tomas Kafka");
    expect(header).toContain("Permission to use, copy, modify, and/or distribute this software");
    expect(header).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
    expect(header).toContain("geokdbush");
  });
});

describe("distance", () => {
  it("is the great-circle distance in kilometres, from (lng, lat) to (lng, lat)", () => {
    expect(distance(0, 0, 0, 1)).toBeCloseTo((Math.PI / 180) * EARTH_RADIUS_KM, 6);
    expect(distance(-16.9084, 32.6507, -9.1393, 38.7223)).toBeCloseTo(haversineKm(-16.9084, 32.6507, -9.1393, 38.7223), 6);
    expect(distance(5, 5, 5, 5)).toBe(0);
  });

  it("goes the short way across the antimeridian", () => {
    expect(distance(179.9, 0, -179.9, 0)).toBeCloseTo(haversineKm(179.9, 0, -179.9, 0), 6);
    expect(distance(179.9, 0, -179.9, 0)).toBeLessThan(25);
  });
});

describe("around", () => {
  const ranked = (list: Point[], lng: number, lat: number) =>
    list.map((p, id) => ({ id, km: haversineKm(lng, lat, p[0], p[1]) })).sort((a, b) => a.km - b.km);

  it.each(queries)("lists every point nearest first from (%s, %s)", (lng, lat) => {
    const found = around(index, lng, lat);
    expect(found).toHaveLength(points.length);
    const expected = ranked(points, lng, lat);
    const kms = found.map((id) => haversineKm(lng, lat, points[id]![0], points[id]![1]));
    for (let i = 1; i < kms.length; i += 1) expect(kms[i]!).toBeGreaterThanOrEqual(kms[i - 1]! - 1e-9);
    expect(kms.slice(0, 50)).toEqual(expected.slice(0, 50).map((row) => expect.closeTo(row.km, 6)));
  });

  it.each(queries)("stops at the limit from (%s, %s)", (lng, lat) => {
    const found = around(index, lng, lat, 25);
    expect(found).toHaveLength(25);
    expect(new Set(found)).toEqual(new Set(ranked(points, lng, lat).slice(0, 25).map((row) => row.id)));
  });

  it.each([0.5, 3, 12, 40, 250, 2000])("keeps the points within %s km", (radius) => {
    for (const [lng, lat] of queries) {
      const expected = ranked(points, lng, lat).filter((row) => row.km <= radius).map((row) => row.id);
      expect(new Set(around(index, lng, lat, undefined, radius))).toEqual(new Set(expected));
    }
  });

  it("combines a limit and a distance", () => {
    const found = around(index, FUNCHAL[0], FUNCHAL[1], 10, 30);
    const within = ranked(points, FUNCHAL[0], FUNCHAL[1]).filter((row) => row.km <= 30);
    expect(found).toHaveLength(Math.min(10, within.length));
  });

  it("leaves out the points the predicate refuses", () => {
    const even = around(index, FUNCHAL[0], FUNCHAL[1], 40, 100, (id) => id % 2 === 0);
    expect(even.length).toBeGreaterThan(0);
    expect(even.every((id) => id % 2 === 0)).toBe(true);
  });

  it("finds nothing in an empty index", () => {
    expect(around(indexOf([]), 0, 0)).toEqual([]);
    expect(around(indexOf([]), 0, 0, 5, 100)).toEqual([]);
  });

  it("finds points across the antimeridian", () => {
    const list: Point[] = [[179.9, 0], [-179.9, 0.05], [-179.8, -0.05], [170, 0], [0, 0]];
    const found = around(indexOf(list), 179.95, 0, undefined, 30);
    expect(new Set(found)).toEqual(new Set([0, 1, 2]));
  });
});

describe("withinCounter", () => {
  /** One count, with a counter made for it. */
  const countWithin = (from: KDBush, lng: number, lat: number, radius: number) => withinCounter(from)(lng, lat, radius);
  const brute = (list: Point[], lng: number, lat: number, radius: number) =>
    list.filter((p) => haversineKm(lng, lat, p[0], p[1]) <= radius).length;

  it.each([0.2, 1, 3, 12, 25, 40, 250, 2000, 20000])("counts the points within %s km", (radius) => {
    for (const [lng, lat] of queries) {
      expect(countWithin(index, lng, lat, radius)).toBe(brute(points, lng, lat, radius));
      expect(countWithin(denseIndex, lng, lat, radius)).toBe(brute(dense, lng, lat, radius));
    }
  });

  it("counts from every point of the index with one counter, as the cities do", () => {
    const count = withinCounter(denseIndex);
    for (const [lng, lat] of dense.slice(0, 300)) {
      expect(count(lng, lat, 2)).toBe(brute(dense, lng, lat, 2));
    }
  });

  it("agrees with around", () => {
    for (const [lng, lat] of queries) {
      expect(countWithin(index, lng, lat, 60)).toBe(around(index, lng, lat, undefined, 60).length);
    }
  });

  it("counts nothing in an empty index, within a distance below zero, or from a location that is not one", () => {
    expect(countWithin(indexOf([]), 0, 0, 100)).toBe(0);
    expect(countWithin(index, FUNCHAL[0], FUNCHAL[1], -1)).toBe(0);
    expect(countWithin(index, FUNCHAL[0], FUNCHAL[1], Number.NaN)).toBe(0);
    expect(countWithin(index, Number.NaN, FUNCHAL[1], 100)).toBe(0);
    expect(countWithin(index, FUNCHAL[0], Number.POSITIVE_INFINITY, 100)).toBe(0);
  });

  it("counts every point for a distance past the other side of the Earth", () => {
    expect(countWithin(index, FUNCHAL[0], FUNCHAL[1], 25_000)).toBe(points.length);
    expect(countWithin(index, FUNCHAL[0], FUNCHAL[1], Number.POSITIVE_INFINITY)).toBe(points.length);
  });

  it("counts across the antimeridian, where a box of longitudes wraps round", () => {
    const list: Point[] = [[179.9, 0], [-179.9, 0.05], [-179.8, -0.05], [170, 0], [0, 0], [180, 0], [-180, 0.01]];
    for (const lng of [179.95, -179.95, 180, -180, 179.5]) {
      for (const radius of [1, 10, 30, 100, 1500]) {
        expect(countWithin(indexOf(list), lng, 0, radius)).toBe(brute(list, lng, 0, radius));
      }
    }
  });

  it("does not look at every point when most of them are well inside the distance", () => {
    // 30,000 points within a few kilometres, counted from 3,000 of them. If each count looked at
    // every point that would be 90 million distances; a count that takes whole nodes is a few
    // hundred visits each.
    const many = scatter(30_000, 3, FUNCHAL, 0.04);
    const count = withinCounter(indexOf(many));
    const started = performance.now();
    let total = 0;
    for (const [lng, lat] of many.slice(0, 3000)) total += count(lng, lat, 25);
    const elapsed = performance.now() - started;
    expect(total).toBeGreaterThan(3000 * 20_000);
    expect(elapsed).toBeLessThan(300);
  });
});
