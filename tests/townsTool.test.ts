// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readTowns, TOWN_REACH_KM, type TownsFile } from "../src/places/towns";
import {
  chooseTowns,
  formatTownsFile,
  marginTowns,
  readCountries,
  readGeoNames,
  readPlaces,
  townsFile,
} from "../tools/towns";

/*
 * tools/towns.ts on a few rows in GeoNames' layout (cities1000.txt: 19 columns, apart by tabs) and a
 * few places in the importer's (one event to a line). The towns are made up, on a line of longitude
 * near Funchal: a hundredth of a degree of latitude is 1.11 km.
 */

/** A row of cities1000.txt. */
function geoRow(
  id: number,
  name: string,
  lat: number,
  lon: number,
  { ascii = name, alternates = "", featureClass = "P", code = "PPL", country = "PT", population = 5000 } = {},
): string {
  return [id, name, ascii, alternates, lat, lon, featureClass, code, country, "", "10", "3101", "", "", population, "", "50", "Atlantic/Madeira", "2026-01-01"].join("\t");
}

/** A line of the importer's signed.jsonl: a place event with these coordinates and, if given, a locality. */
function placeLine(lat: number, lon: number, locality?: string): string {
  const tags = [
    ["d", `osm-node-${lat}-${lon}`],
    ["name", "A place"],
    ["lat", String(lat)],
    ["lon", String(lon)],
    ...(locality === undefined ? [] : [["locality", locality]]),
  ];
  return JSON.stringify({ kind: 39999, tags, content: "", created_at: 1, pubkey: "a".repeat(64), id: "b".repeat(64), sig: "c".repeat(128) });
}

const LON = -16.9;
const geo = (...rows: string[]) => readGeoNames(rows.join("\n"));
const places = (...lines: string[]) => readPlaces(lines.join("\n")).places;
const ids = (towns: readonly { id: number }[]) => towns.map((town) => town.id).sort((a, b) => a - b);

describe("readGeoNames", () => {
  it("reads each populated place's id, names, point, kind, country and population", () => {
    const [town] = geo(geoRow(2267827, "Funchal", 32.66568, -16.92547, { code: "PPLA", population: 105795, alternates: "FNC,Funchal,Фуншал" }));
    expect(town).toEqual({
      id: 2267827,
      name: "Funchal",
      ascii: "Funchal",
      alternates: ["FNC", "Funchal", "Фуншал"],
      lat: 32.66568,
      lon: -16.92547,
      code: "PPLA",
      country: "PT",
      population: 105795,
    });
  });

  it("leaves out districts (PPLX), abandoned, destroyed, historical and religious places, and everything that is not a populated place", () => {
    const rows = geo(
      geoRow(1, "Town", 32.6, LON),
      geoRow(2, "District", 32.6, LON, { code: "PPLX" }),
      geoRow(3, "Historical", 32.6, LON, { code: "PPLH" }),
      geoRow(4, "Abandoned", 32.6, LON, { code: "PPLQ" }),
      geoRow(5, "Destroyed", 32.6, LON, { code: "PPLW" }),
      geoRow(6, "Religious centre", 32.6, LON, { code: "PPLCH" }),
      geoRow(7, "A mountain", 32.6, LON, { featureClass: "T", code: "MT" }),
      geoRow(8, "Seat", 32.6, LON, { code: "PPLA2" }),
      geoRow(9, "Capital", 32.6, LON, { code: "PPLC" }),
    );
    expect(ids(rows)).toEqual([1, 8, 9]);
  });

  it("skips a line it cannot read, and blank lines", () => {
    const rows = geo(geoRow(1, "Town", 32.6, LON), "", "not\ta\trow", geoRow(2, "Nowhere", 95, LON), geoRow(3, "Other", 32.7, LON));
    expect(ids(rows)).toEqual([1, 3]);
  });
});

describe("readPlaces", () => {
  it("reads each place's point and locality, one event to a line, and skips what is not a place", () => {
    const { places: read, skipped } = readPlaces(
      [placeLine(32.65, LON, "Funchal"), "", "{not json", JSON.stringify({ kind: 39999, tags: [["lat", "x"], ["lon", "1"]] }), placeLine(32.7, LON)].join("\n"),
    );
    expect(read).toEqual([{ lat: 32.65, lon: LON, locality: "Funchal" }, { lat: 32.7, lon: LON }]);
    expect(skipped).toBe(2);
  });
});

describe("readCountries", () => {
  it("reads each country's code and name, past the comments", () => {
    const text = [
      "# GeoNames country info",
      "#ISO\tISO3\tISO-Numeric\tfips\tCountry",
      "CZ\tCZE\t203\tEZ\tCzechia\tPrague\t78866\t10625695\tEU",
      "PT\tPRT\t620\tPO\tPortugal\tLisbon\t92391\t10281762\tEU",
    ].join("\n");
    expect(readCountries(text)).toEqual(new Map([["CZ", "Czechia"], ["PT", "Portugal"]]));
  });
});

describe("chooseTowns", () => {
  it("keeps the town nearest to each place, and no other", () => {
    const rows = geo(geoRow(1, "North", 32.7, LON), geoRow(2, "Middle", 32.65, LON), geoRow(3, "South", 32.6, LON));
    // 1.1 km from Middle, 4.4 from North.
    const choice = chooseTowns(rows, places(placeLine(32.66, LON)));
    expect(ids(choice.towns)).toEqual([2]);
    expect(choice.parts).toEqual([]);
    expect(choice).toMatchObject({ placed: 1, unplaced: 0 });
  });

  it("keeps no town more than 30 km from every place, and counts a place with none that near", () => {
    // 0.27 degrees of latitude is 30.0 km; 0.28 is 31.1 km.
    const rows = geo(geoRow(1, "Near enough", 32.6 + 0.269, LON), geoRow(2, "Too far", 40, LON));
    expect(ids(chooseTowns(rows, places(placeLine(32.6, LON))).towns)).toEqual([1]);

    const far = geo(geoRow(1, "Too far", 32.6 + 0.28, LON));
    const choice = chooseTowns(far, places(placeLine(32.6, LON)));
    expect(choice.towns).toEqual([]);
    expect(choice).toMatchObject({ placed: 0, unplaced: 1 });
    expect(TOWN_REACH_KM).toBe(30);
  });

  it("never keeps a district, however near: the town beyond it is the place's", () => {
    const rows = geo(geoRow(1, "District", 32.65, LON, { code: "PPLX" }), geoRow(2, "Town", 32.62, LON));
    expect(ids(chooseTowns(rows, places(placeLine(32.65, LON))).towns)).toEqual([2]);
  });

  it("makes a town whose places mostly name a bigger one near them a part of it, and keeps the bigger one", () => {
    // Santa Luzia is nearest to the three places, and two of them say Funchal, which is bigger. Camacha,
    // a town of its own, is nearer them than Funchal is: without the part they would be Camacha's.
    const rows = geo(
      geoRow(1, "Funchal", 32.666, -16.925, { code: "PPLA", population: 105795 }),
      geoRow(2, "Santa Luzia", 32.655, LON, { population: 5490 }),
      geoRow(3, "Camacha", 32.667, -16.88, { population: 7000 }),
    );
    const choice = chooseTowns(
      rows,
      places(placeLine(32.655, LON, "Funchal"), placeLine(32.656, LON, "Funchal"), placeLine(32.654, LON), placeLine(32.668, -16.88, "Camacha")),
    );
    expect(ids(choice.towns)).toEqual([1, 3]);
    expect(choice.parts.map(({ part, of }) => [part.id, of.id])).toEqual([[2, 1]]);
  });

  it("leaves out a part that puts no place in another town: the places' next nearest point is the town's", () => {
    const rows = geo(
      geoRow(1, "Funchal", 32.666, -16.925, { code: "PPLA", population: 105795 }),
      geoRow(2, "Santa Luzia", 32.655, LON, { population: 5490 }),
    );
    const choice = chooseTowns(rows, places(placeLine(32.655, LON, "Funchal"), placeLine(32.656, LON, "Funchal")));
    expect(ids(choice.towns)).toEqual([1]);
    expect(choice.parts).toEqual([]);
  });

  it("reads a locality as the name, the ASCII name or another name of the bigger town, with or without a district number", () => {
    const rows = geo(
      geoRow(3067696, "Prague", 50.088, 14.4208, { code: "PPLC", country: "CZ", population: 1165581, alternates: "Prag,Praga,Praha" }),
      geoRow(3077929, "Čakovice", 50.1518, 14.5251, { ascii: "Cakovice", country: "CZ", population: 11984 }),
    );
    // Both places are nearest Čakovice; "Praha" and "Praha 9" are Prague.
    const choice = chooseTowns(rows, places(placeLine(50.152, 14.525, "Praha"), placeLine(50.151, 14.524, "Praha 9")));
    expect(ids(choice.towns)).toEqual([3067696]);
  });

  it("keeps a town whose places name it, or name a smaller town, or are split", () => {
    const rows = geo(
      geoRow(1, "Big", 32.7, LON, { population: 100000 }),
      geoRow(2, "Small", 32.6, LON, { population: 5000 }),
      geoRow(3, "Tiny", 32.59, LON, { population: 1000 }),
    );
    // Small's places: one says Small, one says Big. Half is not most.
    expect(ids(chooseTowns(rows, places(placeLine(32.6, LON, "Small"), placeLine(32.601, LON, "Big"))).towns)).toEqual([2]);
    // Its places say Tiny, which is smaller.
    const tiny = chooseTowns(rows, places(placeLine(32.6, LON, "Tiny"), placeLine(32.601, LON, "Tiny")));
    expect(ids(tiny.towns)).toEqual([2]);
    expect(tiny.parts).toEqual([]);
  });

  it("does not count a bigger town that is out of the place's reach", () => {
    const rows = geo(geoRow(1, "Far city", 34, LON, { population: 1000000 }), geoRow(2, "Village", 32.6, LON));
    expect(ids(chooseTowns(rows, places(placeLine(32.6, LON, "Far city"))).towns)).toEqual([2]);
  });

  it("puts a part of a part in the town at the end of the chain", () => {
    const rows = geo(
      geoRow(1, "City", 32.7, LON, { population: 500000 }),
      geoRow(2, "Borough", 32.665, LON, { population: 50000 }),
      geoRow(3, "Street", 32.62, LON, { population: 2000 }),
      geoRow(4, "Other", 32.6, LON, { population: 3000 }),
    );
    // Borough's place says City; Street's says Borough. Without Street, its place would be Other's.
    const choice = chooseTowns(rows, places(placeLine(32.665, LON, "City"), placeLine(32.62, LON, "Borough"), placeLine(32.59, LON, "Other")));
    expect(ids(choice.towns)).toEqual([1, 4]);
    expect(choice.parts.map(({ part, of }) => [part.id, of.id])).toEqual([[3, 1]]);
  });
});

describe("marginTowns", () => {
  it("is the towns of at least that many people within reach of a place that are not kept already", () => {
    const rows = geo(
      geoRow(1, "Kept", 32.6, LON, { population: 2000 }),
      geoRow(2, "Big neighbour", 32.7, LON, { population: 20000 }),
      geoRow(3, "Small neighbour", 32.65, LON, { population: 2000 }),
      geoRow(4, "Big and far", 34, LON, { population: 900000 }),
    );
    const near = places(placeLine(32.6, LON));
    const choice = chooseTowns(rows, near);
    expect(ids(marginTowns(rows, near, choice, 15_000))).toEqual([2]);
  });
});

describe("the file", () => {
  const rowsText = [
    geoRow(3067696, "Prague", 50.088039, 14.420761, { code: "PPLC", country: "CZ", population: 1165581, alternates: "Praha" }),
    geoRow(3093133, "Łódź", 51.75, 19.46667, { ascii: "Lodz", country: "PL", population: 768755 }),
    geoRow(2267827, "Funchal", 32.66568, -16.92547, { code: "PPLA", population: 105795 }),
    geoRow(2264131, "Santa Luzia", 32.655, LON, { population: 5490 }),
    geoRow(2270378, "Camacha", 32.667, -16.88, { population: 7000 }),
    geoRow(3039163, "Sant Julià de Lòria", 42.46372, 1.49129, { ascii: "Sant Julia de Loria", country: "AD" }),
  ];
  const lines = [
    placeLine(50.09, 14.42, "Praha 10"),
    placeLine(51.76, 19.46),
    placeLine(32.655, LON, "Funchal"),
    placeLine(32.656, LON, "Funchal"),
    placeLine(32.668, -16.88, "Camacha"),
    placeLine(42.46, 1.49),
  ];
  const countries = new Map([
    ["AD", "Andorra"],
    ["CZ", "Czechia"],
    ["PL", "Poland"],
    ["PT", "Portugal"],
    ["US", "United States"],
  ]);
  /** The file's text, from the rows and the places in the order `order` puts them. */
  const write = (order: (list: string[]) => string[]) =>
    formatTownsFile(townsFile(chooseTowns(geo(...order(rowsText)), places(...order(lines))), countries, { date: "2026-10-09", places: 6 }));

  it("has each town's id, name, point to four decimals, and ASCII name only where it is not the name without accents, by country", () => {
    const file = townsFile(chooseTowns(geo(...rowsText), places(...lines)), countries, { date: "2026-10-09", places: 6 });
    expect(file.towns).toEqual({
      AD: [[3039163, "Sant Julià de Lòria", 42.4637, 1.4913]],
      CZ: [[3067696, "Prague", 50.088, 14.4208]],
      PL: [[3093133, "Łódź", 51.75, 19.4667, "Lodz"]],
      PT: [
        [2267827, "Funchal", 32.6657, -16.9255],
        [2270378, "Camacha", 32.667, -16.88],
      ],
    });
    expect(file.parts).toEqual([[2264131, 32.655, LON, 2267827]]);
    // The names of the countries that have towns, and no others.
    expect(file.countries).toEqual({ AD: "Andorra", CZ: "Czechia", PL: "Poland", PT: "Portugal" });
    expect(file).toMatchObject({ date: "2026-10-09" });
    expect(file.licence).toMatch(/CC BY 4\.0/);
    expect(file.source).toMatch(/GeoNames/);
    expect(file.regenerate).toMatch(/tools\/towns\.ts/);
  });

  it("is the same text, byte for byte, whatever order the rows and places come in", () => {
    const first = write((list) => list);
    expect(write((list) => [...list].reverse())).toBe(first);
    expect(write((list) => [...list.slice(2), ...list.slice(0, 2)])).toBe(first);
  });

  it("is JSON, one town to a line, that the app reads back", () => {
    const text = write((list) => list);
    const file = JSON.parse(text) as TownsFile;
    expect(text.split("\n").filter((line) => line.startsWith("[3067696,"))).toEqual(['[3067696,"Prague",50.088,14.4208]']);
    expect(text.split("\n").filter((line) => line.startsWith("[2267827,"))).toEqual(['[2267827,"Funchal",32.6657,-16.9255],']);
    expect(text.endsWith("}\n")).toBe(true);

    const list = readTowns(file);
    expect(list.towns.map((town) => town.name).sort()).toEqual(["Camacha", "Funchal", "Prague", "Sant Julià de Lòria", "Łódź"]);
    expect(list.countryName("CZ")).toBe("Czechia");
    // A point nearest Santa Luzia is in Funchal, which Santa Luzia is part of; one beyond reach is in none.
    expect(list.townAt(32.655, LON)?.name).toBe("Funchal");
    expect(list.townAt(32.668, -16.88)?.name).toBe("Camacha");
    expect(list.townAt(36, LON)).toBeUndefined();
  });
});
