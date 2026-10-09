// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readTowns, TOWN_REACH_KM, type TownsFile } from "../src/places/towns";
import { ABSORBING } from "../tools/towns-absorb";
import { chooseTowns, formatTownsFile, marginTowns, type PlacePoint, readGeoNames, readPlaces, type TownChoice, townsFile } from "../tools/towns";

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
  { ascii = name, alternates = "", featureClass = "P", code = "PPL", country = "PT", admin1 = "10", population = 5000 } = {},
): string {
  return [id, name, ascii, alternates, lat, lon, featureClass, code, country, "", admin1, "3101", "", "", population, "", "50", "Atlantic/Madeira", "2026-01-01"].join("\t");
}

/**
 * A line of the live list as the places relay gives it (one event to a line): a place event with these
 * coordinates and, if given, a locality. `d`, `createdAt` and `kind` make another version of a place, or
 * an event that is no place.
 */
function placeLine(lat: number, lon: number, locality?: string, { d = `osm-node-${lat}-${lon}`, createdAt = 1, kind = 39999 } = {}): string {
  const tags = [
    ["d", d],
    ["name", "A place"],
    ["lat", String(lat)],
    ["lon", String(lon)],
    ...(locality === undefined ? [] : [["locality", locality]]),
  ];
  return JSON.stringify({ kind, tags, content: "", created_at: createdAt, pubkey: "a".repeat(64), id: "b".repeat(64), sig: "c".repeat(128) });
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
      admin1: "10",
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

  it("reads only places, and of a place given twice, its newest version, whatever the order", () => {
    const lines = [
      placeLine(32.6, LON, "Old", { d: "osm-node-1", createdAt: 100 }),
      placeLine(32.7, LON, "New", { d: "osm-node-1", createdAt: 200 }),
      placeLine(32.8, LON, "A note, not a place", { kind: 1 }),
      placeLine(32.9, LON, "Other", { d: "osm-node-2" }),
    ];
    for (const order of [lines, [...lines].reverse()]) {
      const { places: read, skipped, older } = readPlaces(order.join("\n"));
      expect(read.sort((a, b) => a.lat - b.lat)).toEqual([
        { lat: 32.7, lon: LON, locality: "New" },
        { lat: 32.9, lon: LON, locality: "Other" },
      ]);
      expect(skipped).toBe(1);
      expect(older).toBe(1);
    }
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
    // GeoNames' other names, which a locality names a town by for parts, not for step 1.
    const rows = geo(
      geoRow(1, "Big", 32.7, LON, { population: 100000, alternates: "Grande" }),
      geoRow(2, "Small", 32.6, LON, { population: 5000, alternates: "Pequeno" }),
      geoRow(3, "Tiny", 32.59, LON, { population: 1000, alternates: "Mini" }),
    );
    const at = (...localities: (string | undefined)[]) => places(...localities.map((locality, i) => placeLine(32.6 + i * 0.001, LON, locality)));
    // Two say Big and two say Small: half is not most.
    expect(ids(chooseTowns(rows, at("Grande", "Grande", "Pequeno", "Pequeno")).towns)).toEqual([2]);
    // Two of three say Big, and one Small: Small is a part of Big.
    expect(ids(chooseTowns(rows, at("Grande", "Grande", "Pequeno")).towns)).toEqual([1]);
    // They say Tiny, which is smaller.
    const tiny = chooseTowns(rows, at("Mini", "Mini"));
    expect(ids(tiny.towns)).toEqual([2]);
    expect(tiny.parts).toEqual([]);
  });

  it("does not count a bigger town that is out of the place's reach", () => {
    const rows = geo(geoRow(1, "Far city", 34, LON, { population: 1000000 }), geoRow(2, "Village", 32.6, LON));
    expect(ids(chooseTowns(rows, places(placeLine(32.6, LON, "Far city"))).towns)).toEqual([2]);
  });

  it("puts a part of a part in the town at the end of the chain", () => {
    const rows = geo(
      geoRow(1, "City", 32.7, LON, { population: 500000, alternates: "Metropolis" }),
      geoRow(2, "Borough", 32.665, LON, { population: 50000, alternates: "Burgh" }),
      geoRow(3, "Street", 32.62, LON, { population: 2000 }),
      geoRow(4, "Other", 32.6, LON, { population: 3000 }),
    );
    // Borough's places say City; Street's say Borough. Without Street, the bare place by it would be Other's.
    const bare = { lat: 32.618, lon: LON };
    const choice = chooseTowns(rows, [
      ...places(placeLine(32.665, LON, "Metropolis"), placeLine(32.666, LON, "Metropolis")),
      ...places(placeLine(32.62, LON, "Burgh"), placeLine(32.621, LON, "Burgh")),
      bare,
      ...places(placeLine(32.59, LON, "Other")),
    ]);
    expect(ids(choice.towns)).toEqual([1, 4]);
    expect(choice.parts.map(({ part, of }) => [part.id, of.id])).toEqual([[3, 1]]);
    expect(runtimeTown(choice, bare)).toBe("City");
    expect(choice.astray).toBe(0);
  });
});

/** The town the app puts a place in, with the file the choice makes. */
function runtimeTown(choice: TownChoice, place: PlacePoint) {
  return readTowns(townsFile(choice, { date: "2026-10-09", places: 1 })).townAt(place.lat, place.lon, place.locality)?.name;
}

describe("chooseTowns: a locality that names a town", () => {
  // Los Angeles, and around it Glendale and Burbank, with GeoNames' points and people.
  const losAngeles = geoRow(5368361, "Los Angeles", 34.0522, -118.2437, { code: "PPLA2", country: "US", admin1: "CA", population: 3820914 });
  const glendale = geoRow(5352423, "Glendale", 34.1425, -118.2551, { country: "US", admin1: "CA", population: 201020 });
  const burbank = geoRow(5331835, "Burbank", 34.1808, -118.309, { country: "US", admin1: "CA", population: 107337 });
  // Phoenix's Glendale, far from these.
  const glendaleAZ = geoRow(5295985, "Glendale", 33.5387, -112.186, { country: "US", admin1: "AZ", population: 240126 });

  it("puts the place in the town its locality names, within reach, before the nearest town", () => {
    // Nearer Burbank's point than Glendale's, and it says Glendale.
    const place = { lat: 34.17, lon: -118.29, locality: "Glendale" };
    const choice = chooseTowns(geo(losAngeles, glendale, burbank, glendaleAZ), [place, { lat: 34.05, lon: -118.24, locality: "Los Angeles" }]);
    expect(ids(choice.towns)).toEqual([5352423, 5368361]);
    expect(runtimeTown(choice, place)).toBe("Glendale");
    expect(choice.astray).toBe(0);
  });

  it("reads the locality as the town's name or ASCII name, folded, and goes by the nearest when it names none", () => {
    const rows = geo(
      geoRow(3067696, "Prague", 50.088, 14.4208, { code: "PPLC", country: "CZ", population: 1165581, alternates: "Praha" }),
      geoRow(3066636, "Říčany", 49.9917, 14.6543, { ascii: "Ricany", country: "CZ", population: 15000 }),
    );
    const ricany = { lat: 50.05, lon: 14.5, locality: "RICANY" };
    // "Praha" is another name of Prague, not its name: the place goes by the nearest town.
    const praha = { lat: 50.0, lon: 14.62, locality: "Praha" };
    const choice = chooseTowns(rows, [ricany, praha]);
    expect(runtimeTown(choice, ricany)).toBe("Říčany");
    expect(runtimeTown(choice, praha)).toBe("Říčany");
    expect(choice.astray).toBe(0);
  });

  it("does not take a town of the name beyond reach", () => {
    const place = { lat: 34.17, lon: -118.29, locality: "Glendale" };
    const choice = chooseTowns(geo(losAngeles, burbank, glendaleAZ), [place]);
    expect(runtimeTown(choice, place)).toBe("Burbank");
  });
});

describe("chooseTowns: parts", () => {
  it("judges a town's own places by its name or ASCII name before another name: the City of London's places that say London are London's", () => {
    const rows = geo(
      geoRow(2643743, "London", 51.5085, -0.1257, { code: "PPLC", country: "GB", admin1: "ENG", population: 8961989 }),
      // GeoNames gives the City of London "London" among its other names.
      geoRow(2643741, "City of London", 51.5128, -0.0918, { code: "PPLA3", country: "GB", admin1: "ENG", population: 8072, alternates: "City,London,The City" }),
      geoRow(2643744, "Shoreditch", 51.5262, -0.078, { country: "GB", admin1: "ENG", population: 20000 }),
    );
    const bare = { lat: 51.5125, lon: -0.09 };
    const choice = chooseTowns(rows, [
      { lat: 51.513, lon: -0.092, locality: "London" },
      { lat: 51.512, lon: -0.091, locality: "London" },
      bare,
      { lat: 51.526, lon: -0.078, locality: "Shoreditch" },
    ]);
    expect(ids(choice.towns)).toEqual([2643743, 2643744]);
    expect(runtimeTown(choice, bare)).toBe("London");
    expect(choice.astray).toBe(0);
  });

  it("makes a town a part only when at least two of its places name the bigger town, and most of them do", () => {
    const rows = geo(
      geoRow(2886242, "Köln", 50.9333, 6.95, { ascii: "Koeln", code: "PPLA2", country: "DE", admin1: "07", population: 1075935 }),
      geoRow(2878234, "Leverkusen", 51.0303, 6.9843, { code: "PPLA3", country: "DE", admin1: "07", population: 162738 }),
    );
    const one = chooseTowns(rows, [{ lat: 51.03, lon: 6.985, locality: "Köln" }, { lat: 51.031, lon: 6.984 }]);
    expect(ids(one.towns)).toEqual([2878234, 2886242]);
    expect(one.parts).toEqual([]);
    // Two places of three, in Leverkusen's reach, say Köln: Leverkusen is part of it.
    const two = chooseTowns(rows, [{ lat: 51.03, lon: 6.985, locality: "Köln" }, { lat: 51.031, lon: 6.984, locality: "Koeln" }, { lat: 51.029, lon: 6.986 }]);
    expect(ids(two.towns)).toEqual([2886242]);
  });
});

describe("chooseTowns: a capital that takes in its districts", () => {
  // Bangkok, two of its districts (in its own province, 40), and Pak Kret (Nonthaburi, 38).
  const bangkok = geoRow(1609350, "Bangkok", 13.754, 100.5014, { code: "PPLC", country: "TH", admin1: "40", population: 5104476 });
  const bangKapi = geoRow(1619650, "Bang Kapi", 13.7657, 100.6475, { country: "TH", admin1: "40", population: 140000 });
  const saiMai = geoRow(1607725, "Sai Mai", 13.9198, 100.6457, { country: "TH", admin1: "40", population: 190000 });
  const pakKret = geoRow(1608048, "Pak Kret", 13.9118, 100.4977, { code: "PPLA2", country: "TH", admin1: "38", population: 190272 });
  const rows = geo(bangkok, bangKapi, saiMai, pakKret);
  const absorbing = [{ id: 1609350, withinKm: 25 }];

  it("puts the places of its districts, which name none, in it, and keeps a town of another province separate", () => {
    const inBangKapi = { lat: 13.766, lon: 100.646 };
    const inSaiMai = { lat: 13.92, lon: 100.645 };
    const inPakKret = { lat: 13.912, lon: 100.498 };
    const choice = chooseTowns(rows, [inBangKapi, inSaiMai, inPakKret], absorbing);
    expect(ids(choice.towns)).toEqual([1608048, 1609350]);
    expect(runtimeTown(choice, inBangKapi)).toBe("Bangkok");
    expect(runtimeTown(choice, inSaiMai)).toBe("Bangkok");
    expect(runtimeTown(choice, inPakKret)).toBe("Pak Kret");
    expect(choice.astray).toBe(0);
  });

  it("does so only for the capitals on the list", () => {
    const choice = chooseTowns(rows, [{ lat: 13.766, lon: 100.646 }]);
    expect(ids(choice.towns)).toEqual([1619650]);
  });

  it("lists Bangkok, at 25 km, and Tokyo, at 10 km, each once, with its GeoNames id", () => {
    expect(ABSORBING.find((entry) => entry.id === 1609350)).toMatchObject({ name: "Bangkok", withinKm: 25 });
    // Short of Kichijōji (Musashino, 10.5 km) and Mitaka (11.9 km), cities of their own in Tokyo-to.
    expect(ABSORBING.find((entry) => entry.id === 1850147)).toMatchObject({ name: "Tokyo", withinKm: 10 });
    expect(new Set(ABSORBING.map((entry) => entry.id)).size).toBe(ABSORBING.length);
    for (const entry of ABSORBING) expect(entry.withinKm).toBeLessThanOrEqual(25);
  });
});

describe("chooseTowns: localities of their own", () => {
  // La Libertad, El Salvador, and St. Louis, Missouri, which GeoNames also calls Saint Louis.
  const laLibertad = geoRow(3585157, "La Libertad", 13.4883, -89.3222, { country: "SV", admin1: "05", population: 16855 });
  const stLouis = geoRow(4407066, "St. Louis", 38.6273, -90.1979, { code: "PPLA2", country: "US", admin1: "MO", population: 279695, alternates: "Saint Louis,STL" });
  const at = (lat: number, lon: number, locality: string, country: string, n = 3) =>
    Array.from({ length: n }, (_, i) => ({ lat: lat + i * 0.001, lon, locality, country }));

  it("lists a locality that three places name, close together, more than 5 km from their town's point, that no town in reach is called", () => {
    // El Zonte, 13 km west of La Libertad's point.
    const choice = chooseTowns(geo(laLibertad), at(13.495, -89.441, "El Zonte", "SV"));
    expect(townsFile(choice, { date: "2026-10-09", places: 3 }).localities).toEqual({ SV: ["el zonte"] });
  });

  it("does not list one that is another name of a town in reach, one too few, or one close to its town's point", () => {
    // Saint Louis is St. Louis's other name in GeoNames.
    expect(chooseTowns(geo(stLouis), at(38.62, -90.266, "Saint Louis", "US")).localities).toEqual([]);
    // Two places.
    expect(chooseTowns(geo(laLibertad), at(13.495, -89.441, "El Zonte", "SV", 2)).localities).toEqual([]);
    // 1 km from La Libertad's point.
    expect(chooseTowns(geo(laLibertad), at(13.49, -89.33, "Malecón", "SV")).localities).toEqual([]);
    // A district's number off, the name of the town: Praha 10 is in Praha, which is Prague.
    const prague = geoRow(3067696, "Prague", 50.088, 14.4208, { code: "PPLC", country: "CZ", population: 1165581, alternates: "Praha" });
    expect(chooseTowns(geo(prague), at(50.068, 14.484, "Praha 10", "CZ")).localities).toEqual([]);
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
    // With no locality, nearest Santa Luzia: Funchal's, through the part, where Camacha is nearer.
    placeLine(32.654, LON),
    placeLine(32.668, -16.88, "Camacha"),
    placeLine(42.46, 1.49),
  ];
  /** The file's text, from the rows and the places in the order `order` puts them. */
  const write = (order: (list: string[]) => string[]) =>
    formatTownsFile(townsFile(chooseTowns(geo(...order(rowsText)), places(...order(lines))), { date: "2026-10-09", places: 7 }));

  it("has each town's id, name, point to four decimals, and ASCII name only where it is not the name without accents, by country", () => {
    const file = townsFile(chooseTowns(geo(...rowsText), places(...lines)), { date: "2026-10-09", places: 7 });
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
    // No country names: the app names countries itself.
    expect(Object.keys(file)).toEqual(["source", "licence", "date", "regenerate", "towns", "parts", "localities"]);
    expect(file.localities).toEqual({});
    expect(file).toMatchObject({ date: "2026-10-09" });
    expect(file.licence).toMatch(/CC BY 4\.0/);
    expect(file.source).toMatch(/GeoNames/);
    expect(file.regenerate).toMatch(/tools\/towns\.ts/);
    // The places are the live list, read from the places relay.
    expect(file.source).toMatch(/the live list/);
    expect(file.regenerate).toMatch(/places relay/);
    expect(file.regenerate).toMatch(/nak req -k 39999/);
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
    // A point nearest Santa Luzia is in Funchal, which Santa Luzia is part of; one beyond reach is in none.
    expect(list.townAt(32.655, LON)?.name).toBe("Funchal");
    expect(list.townAt(32.668, -16.88)?.name).toBe("Camacha");
    expect(list.townAt(36, LON)).toBeUndefined();
  });

  it("groups the towns of the United States and Canada by their state or province, which the app labels them by", () => {
    const rows = geo(
      geoRow(4393217, "Kansas City", 39.0997, -94.5786, { country: "US", admin1: "MO", population: 475378 }),
      geoRow(4273837, "Kansas City", 39.1142, -94.6275, { country: "US", admin1: "KS", population: 152933 }),
      geoRow(6167865, "Toronto", 43.7064, -79.3986, { code: "PPLA", country: "CA", admin1: "08", population: 2600000 }),
      geoRow(6173331, "Vancouver", 49.2497, -123.1193, { country: "CA", admin1: "02", population: 600000 }),
    );
    const file = townsFile(
      chooseTowns(rows, places(placeLine(39.0997, -94.5786), placeLine(39.1142, -94.6275), placeLine(43.7064, -79.3986), placeLine(49.2497, -123.1193))),
      { date: "2026-10-09", places: 4 },
    );
    expect(Object.keys(file.towns).sort()).toEqual(["CA-BC", "CA-ON", "US-KS", "US-MO"]);
    const list = readTowns(file);
    expect(list.towns.map((town) => [town.name, town.country, town.region]).sort()).toEqual([
      ["Kansas City", "US", "KS"],
      ["Kansas City", "US", "MO"],
      ["Toronto", "CA", "ON"],
      ["Vancouver", "CA", "BC"],
    ]);
  });
});

describe("the tool, run as the README says", () => {
  it("runs in Node as it is, reads the two files, and writes the file", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "towns-"));
    writeFileSync(join(dir, "cities1000.txt"), [geoRow(2267827, "Funchal", 32.66568, -16.92547, { code: "PPLA", population: 105795 })].join("\n"));
    writeFileSync(join(dir, "places.jsonl"), [placeLine(32.66, -16.92, "Funchal")].join("\n"));
    const out = join(dir, "towns.json");
    execFileSync(process.execPath, ["--no-warnings", "tools/towns.ts", join(dir, "cities1000.txt"), join(dir, "places.jsonl"), "--date", "2026-10-09", "--out", out]);
    const file = JSON.parse(readFileSync(out, "utf8")) as TownsFile;
    rmSync(dir, { recursive: true });
    expect(file.towns).toEqual({ PT: [[2267827, "Funchal", 32.6657, -16.9255]] });
  }, 30_000);
});
