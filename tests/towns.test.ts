import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import file from "../src/data/towns.json";
import { buildIndexes, type City, cityLabel, cityLabeller } from "../src/places/indexes";
import { PLACE_KIND, type Place } from "../src/places/place";
import { pickerMatches, townFinder } from "../src/places/townSearch";
import { foldName, TOWN_REACH_KM, type TownsFile } from "../src/places/towns";
import { townsOf } from "./support/towns";

let made = 0;
/** A place with only what the test names; the rest is plain. */
function make(name: string, over: Partial<Place> = {}): Place {
  made += 1;
  const d = over.d ?? `towns-${made}`;
  return {
    address: `${PLACE_KIND}:${config.houseHex}:${d}`,
    d,
    pubkey: config.houseHex,
    name,
    category: "restaurant",
    lat: 0,
    lon: 0,
    geohash: "u2fkbbbbb",
    keywords: [],
    createdAt: 0,
    ...over,
  };
}

// GeoNames' points for these towns, to four decimals.
const PRAGUE = { id: 3067696, name: "Prague", lat: 50.088, lon: 14.4208 };
const RICANY = { id: 3066636, name: "Říčany", lat: 49.9917, lon: 14.6543 };
const LISBON = { id: 2267057, name: "Lisbon", country: "PT", lat: 38.7251, lon: -9.1498 };
const FUNCHAL = { id: 2267827, name: "Funchal", country: "PT", lat: 32.6657, lon: -16.9255 };
const NEW_YORK = { id: 5128581, name: "New York City", country: "US", lat: 40.7143, lon: -74.006 };
const LODZ = { id: 3093133, name: "Łódź", ascii: "Lodz", country: "PL", lat: 51.75, lon: 19.4667 };
const towns = townsOf([PRAGUE, RICANY, LISBON, FUNCHAL, NEW_YORK, LODZ]);

/** A place in Prague, `km` kilometres east of its point, with `locality`. */
const inPrague = (name: string, locality?: string, km = 1) =>
  make(name, { lat: PRAGUE.lat, lon: PRAGUE.lon + km / (111.19 * Math.cos((PRAGUE.lat * Math.PI) / 180)), country: "CZ", locality });

const byName = (cities: readonly City[], name: string) => cities.find((city) => city.name === name);

describe("towns from the file", () => {
  it("puts each place in the town nearest to it within 30 km, called by GeoNames' name, at GeoNames' point", () => {
    const places = [inPrague("A", "Praha"), inPrague("B", "Praha 10", 3), inPrague("C", "Praha 8", 5), make("D", { lat: 38.72, lon: -9.14, locality: "Lisboa" })];
    const { cities, townOf } = buildIndexes(places, towns);
    expect(cities.map((city) => [city.name, city.country, city.count])).toEqual([
      ["Prague", "CZ", 3],
      ["Lisbon", "PT", 1],
    ]);
    expect(byName(cities, "Prague")).toMatchObject({ lat: PRAGUE.lat, lon: PRAGUE.lon, geonameId: PRAGUE.id });
    expect(townOf(places[0]!)).toBe(byName(cities, "Prague"));
    expect(townOf(places[3]!)?.name).toBe("Lisbon");
    expect(TOWN_REACH_KM).toBe(30);
  });

  it("counts a place with no locality under its nearest town", () => {
    const bare = inPrague("No locality", undefined, 8);
    const { cities, townOf } = buildIndexes([inPrague("A", "Praha"), bare], towns);
    expect(cities.map((city) => [city.name, city.count])).toEqual([["Prague", 2]]);
    expect(townOf(bare)?.name).toBe("Prague");
  });

  it("finds a town by the localities its places give it, and by its ASCII name, and shows none of them", () => {
    const { cities } = buildIndexes(
      [
        inPrague("A", "Praha"),
        inPrague("B", "Praha 10"),
        inPrague("C", " praha  10 "),
        inPrague("D", "PRAGUE"),
        inPrague("E", "Hlavní město Praha"),
        make("F", { lat: 38.72, lon: -9.14, locality: "Lisboa" }),
        make("G", { lat: 51.76, lon: 19.46 }),
      ],
      towns,
    );
    // Folded, once each; the town's own name, in any case, is not another name.
    expect(byName(cities, "Prague")?.aliases).toEqual(["hlavni mesto praha", "praha", "praha 10"]);
    expect(byName(cities, "Lisbon")?.aliases).toEqual(["lisboa"]);
    expect(byName(cities, "Łódź")?.aliases).toEqual(["lodz"]);
    // The label is the name.
    expect(cities.map((city) => cityLabel(city, cities)).sort()).toEqual(["Lisbon", "Prague", "Łódź"]);
  });

  it("never makes another town of the file's name another name of a town: two real towns stay two", () => {
    // Two places in Prague with an odd tag: one names Říčany, a town 13 km away, the other Funchal.
    const odd = [inPrague("A", "Praha"), inPrague("B", "Říčany"), inPrague("C", "funchal")];
    const inRicany = make("In Říčany", { lat: RICANY.lat, lon: RICANY.lon, locality: "Říčany" });
    const { cities } = buildIndexes([...odd, inRicany], towns);
    expect(byName(cities, "Prague")).toMatchObject({ count: 3, aliases: ["praha"] });
    expect(byName(cities, "Říčany")).toMatchObject({ count: 1, aliases: [] });

    const find = townFinder(cities, (city) => city.name);
    expect(find("Říčany", 3).map((city) => city.name)).toEqual(["Říčany"]);
    expect(find("funchal", 3)).toEqual([]);
  });

  it("keeps a place more than 30 km from every town in the town of its locality, as before", () => {
    // Kutná Hora is 65 km east of Prague: no town of this list is in reach.
    const far = [0, 1, 2].map((i) => make(`Far ${i}`, { lat: 49.948 + i * 0.001, lon: 15.268, locality: "Kutná Hora", country: "CZ" }));
    const lonely = make("Lonely", { lat: 49.5, lon: 16.5, locality: "Lonely" });
    const { cities, townOf } = buildIndexes([inPrague("A", "Praha"), ...far, lonely], towns);
    expect(cities.map((city) => [city.name, city.count])).toEqual([
      ["Kutná Hora", 3],
      ["Prague", 1],
    ]);
    const kutnaHora = byName(cities, "Kutná Hora")!;
    expect(kutnaHora.geonameId).toBeUndefined();
    expect(kutnaHora.aliases).toBeUndefined();
    expect(townOf(far[0]!)).toBe(kutnaHora);
    // A locality of fewer than three places is no town, as before.
    expect(townOf(lonely)).toBeUndefined();
  });

  it("leaves out a town that no place is in", () => {
    const { cities } = buildIndexes([inPrague("A")], towns);
    expect(cities.map((city) => city.name)).toEqual(["Prague"]);
  });

  it("counts a place nearest a part of a town in that town", () => {
    // A part 20 km north of Funchal, which is nearer to the place than Funchal itself.
    const withPart = townsOf([FUNCHAL, { id: 1, name: "Other", country: "PT", lat: 32.83, lon: -16.93 }], [[32.84, -16.93, FUNCHAL.id]]);
    const place = make("Up north", { lat: 32.845, lon: -16.93 });
    const { cities, townOf } = buildIndexes([place], withPart);
    expect(cities.map((city) => [city.name, city.count])).toEqual([["Funchal", 1]]);
    expect(townOf(place)?.name).toBe("Funchal");
  });

  it("takes the region most of its places name, and tells two towns of one name apart by it", () => {
    const lexingtons = townsOf([
      { id: 4297983, name: "Lexington", country: "US", lat: 38.0498, lon: -84.4586 },
      { id: 4941873, name: "Lexington", country: "US", lat: 42.4473, lon: -71.2245 },
    ]);
    const { cities } = buildIndexes(
      [
        make("K1", { lat: 38.05, lon: -84.46, region: "KY" }),
        make("K2", { lat: 38.05, lon: -84.46, region: "KY" }),
        make("K3", { lat: 38.05, lon: -84.46, region: "Kentucky" }),
        make("M1", { lat: 42.45, lon: -71.22, region: "MA" }),
      ],
      lexingtons,
    );
    const label = cityLabeller(cities);
    expect(cities.map(label)).toEqual(["Lexington, KY", "Lexington, MA"]);
  });

  it("names each country of the file, and none without it", () => {
    expect(buildIndexes([inPrague("A")], towns).countryName("CZ")).toBe("Czechia");
    expect(buildIndexes([inPrague("A")], towns).countryName("ZZ")).toBeUndefined();
    expect(buildIndexes([inPrague("A")]).countryName("CZ")).toBeUndefined();
  });

  it("groups the places by locality, as before, when the towns could not be loaded", () => {
    const places = [inPrague("A", "Praha"), inPrague("B", "Praha"), inPrague("C", "Praha"), inPrague("D")];
    for (const none of [null, undefined]) {
      const { cities, townOf } = buildIndexes(places, none);
      expect(cities.map((city) => [city.name, city.count])).toEqual([["Praha", 3]]);
      expect(townOf(places[3]!)).toBeUndefined();
    }
  });
});

describe("the app's towns", () => {
  const app = file as unknown as TownsFile;

  it("are a GeoNames file with its licence, and its date", () => {
    expect(app.source).toMatch(/GeoNames/);
    expect(app.licence).toMatch(/CC BY 4\.0/);
    expect(app.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(app.regenerate).toMatch(/node tools\/towns\.ts/);
  });

  it("have the shape the app reads: rows of an id, a name, a point and maybe an ASCII name, parts that name a town of the file", () => {
    const ids = new Set<number>();
    for (const [country, rows] of Object.entries(app.towns)) {
      expect(country).toMatch(/^[A-Z]{2}$/);
      expect(app.countries[country]).toEqual(expect.any(String));
      for (const row of rows) {
        const [id, name, lat, lon, ascii] = row;
        expect(row.length === 4 || (row.length === 5 && typeof ascii === "string")).toBe(true);
        expect(Number.isInteger(id) && typeof name === "string" && name !== "").toBe(true);
        expect(Math.abs(lat) <= 90 && Math.abs(lon) <= 180).toBe(true);
        expect([lat, lon].every((degrees) => Math.round(degrees * 1e4) / 1e4 === degrees)).toBe(true);
        ids.add(id);
      }
    }
    for (const [id, lat, lon, of] of app.parts) {
      expect(Number.isInteger(id) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180).toBe(true);
      expect(ids.has(of)).toBe(true);
    }
  });

  it("know Prague, Lisbon, Munich and Vienna by their English names", () => {
    const names = Object.values(app.towns).flat().map(([, name]) => name);
    expect(names).toEqual(expect.arrayContaining(["Prague", "Lisbon", "Munich", "Vienna", "Funchal"]));
    expect(names).not.toEqual(expect.arrayContaining(["Praha"]));
  });
});

describe("townFinder", () => {
  const city = (name: string, count: number, over: Partial<City> = {}): City => ({ name, country: "XX", lat: 0, lon: 0, count, ...over });
  const prague = city("Prague", 31, { country: "CZ", aliases: ["hlavni mesto praha", "praha", "praha 10", "praha 8"] });
  const lisbon = city("Lisbon", 9, { country: "PT", aliases: ["lisboa"] });
  const names = (cities: City[]) => cities.map((each) => each.name);
  const plain = (each: City) => each.name;

  it("finds Prague by its name and by Praha, and leads praha 10 to Prague", () => {
    const find = townFinder([lisbon, prague], plain);
    expect(names(find("Prague", 3))).toEqual(["Prague"]);
    expect(names(find("praha", 3))).toEqual(["Prague"]);
    expect(names(find("Praha 10", 3))).toEqual(["Prague"]);
    expect(names(find("  PRAHA   10 ", 3))).toEqual(["Prague"]);
  });

  it("finds Lisbon by Lisbon and by Lisboa", () => {
    const find = townFinder([lisbon, prague], plain);
    expect(names(find("Lisbon", 3))).toEqual(["Lisbon"]);
    expect(names(find("lisboa", 3))).toEqual(["Lisbon"]);
    expect(names(find("lisb", 3))).toEqual(["Lisbon"]);
  });

  it("matches the start of each word, whatever its case and accents, not the middle of one", () => {
    const find = townFinder([city("São Paulo", 10), city("New York City", 4), prague], plain);
    expect(names(find("sao", 3))).toEqual(["São Paulo"]);
    expect(names(find("PAULO", 3))).toEqual(["São Paulo"]);
    expect(names(find("new yo", 3))).toEqual(["New York City"]);
    expect(names(find("york", 3))).toEqual(["New York City"]);
    expect(find("ague", 3)).toEqual([]);
  });

  it("puts the best match first, then the town with more places, and lists at most the limit", () => {
    const find = townFinder(
      [city("Santa Ana", 34), city("San Salvador", 184), city("Salzburg", 2), city("San José", 50), city("Sankt Gallen", 12)],
      plain,
    );
    expect(names(find("san", 3))).toEqual(["San Salvador", "San José", "Santa Ana"]);
    expect(names(find("san jose", 3))).toEqual(["San José"]);
    // Salzburg starts with the word; San Salvador only has a word that does.
    expect(names(find("sal", 3))).toEqual(["Salzburg", "San Salvador"]);
  });

  it("puts a town whose own name matches before one that another name matches as well", () => {
    const find = townFinder([city("Big town", 500, { aliases: ["valencia"] }), city("Valencia", 5)], plain);
    expect(names(find("valencia", 3))).toEqual(["Valencia", "Big town"]);
  });

  it("matches the label a town is shown by", () => {
    const ky = city("Lexington", 50, { region: "KY" });
    const ma = city("Lexington", 9, { region: "MA" });
    const find = townFinder([ky, ma], cityLabeller([ky, ma]));
    expect(find("lexington ky", 3)).toEqual([ky]);
    expect(find("lexington", 3)).toEqual([ky, ma]);
  });

  it("finds nothing for fewer than two characters", () => {
    const find = townFinder([prague], plain);
    expect(find("p", 3)).toEqual([]);
    expect(find("  ", 3)).toEqual([]);
    expect(find("pr", 3)).toEqual([prague]);
  });
});

describe("pickerMatches", () => {
  const prague: City = { name: "Prague", country: "CZ", lat: 0, lon: 0, count: 31, aliases: ["praha", "praha 10"] };

  it("matches the text anywhere in the label, or in another name", () => {
    expect(pickerMatches(prague, "prague", "")).toBe(true);
    expect(pickerMatches(prague, "prague", "ague")).toBe(true);
    expect(pickerMatches(prague, "prague", foldName("Praha"))).toBe(true);
    expect(pickerMatches(prague, "prague", foldName("praha 10"))).toBe(true);
    expect(pickerMatches(prague, "prague", "lisboa")).toBe(false);
  });
});

describe("elsewhere", () => {
  // Here is New York; the places matched are in Prague, 6,600 km away.
  const here = { lat: NEW_YORK.lat, lon: NEW_YORK.lon, beyondKm: 25, limit: 5 };
  const names = (rows: { place: Place }[]) => rows.map((row) => row.place.name);

  it("lists the places beyond the distance whose names have the words, with how far each is", () => {
    const vltava = inPrague("Kavárna Vltava", "Praha");
    const nearby = make("Vltava Deli", { lat: NEW_YORK.lat + 0.05, lon: NEW_YORK.lon });
    const idx = buildIndexes([vltava, nearby, inPrague("Other")], towns);
    const rows = idx.elsewhere("vltava", here);
    expect(names(rows)).toEqual(["Kavárna Vltava"]);
    expect(rows[0]!.km).toBeGreaterThan(6000);
    // The one within the distance is a result near, not elsewhere.
    expect(names(idx.search("vltava", { lat: here.lat, lon: here.lon, radiusKm: 25 }))).toEqual(["Vltava Deli"]);
  });

  it("goes by the name alone: a place whose locality, kind or cuisine has the words is not listed", () => {
    const idx = buildIndexes([inPrague("Kavárna", "Praha"), inPrague("U Fleků", undefined), inPrague("Praha Bistro")], towns);
    expect(names(idx.elsewhere("praha", here))).toEqual(["Praha Bistro"]);
    // A word a letter away is not the word.
    expect(idx.elsewhere("prahq", here)).toEqual([]);
  });

  it("lists nothing for a kind of place, or for no words", () => {
    const cafes = [0, 1, 2, 3, 4, 5].map((i) => inPrague(`Cafe ${i}`, "Praha", i + 1));
    const idx = buildIndexes(cafes.map((place) => ({ ...place, category: "cafe" })), towns);
    expect(idx.isKindQuery("cafe")).toBe(true);
    expect(idx.elsewhere("cafe", here)).toEqual([]);
    expect(idx.elsewhere("  ", here)).toEqual([]);
    expect(idx.elsewhere("vltava", { ...here, lat: Number.NaN })).toEqual([]);
  });

  it("puts the best match first, the nearer of two as good, and lists at most the limit", () => {
    const places = [
      inPrague("Golden Tiger", "Praha", 9),
      inPrague("Golden Tiger Too", "Praha", 2),
      ...[1, 2, 3, 4, 5].map((i) => inPrague(`The Tiger Room ${i}`, "Praha", i)),
      make("Golden Tiger Lisboa", { lat: 38.72, lon: -9.14 }),
    ];
    const idx = buildIndexes(places, towns);
    const rows = idx.elsewhere("golden tiger", here);
    // Lisbon is nearer New York than Prague is.
    expect(names(rows)).toEqual(["Golden Tiger Lisboa", "Golden Tiger Too", "Golden Tiger"]);
    expect(idx.elsewhere("tiger", here)).toHaveLength(5);
    expect(idx.elsewhere("tiger", { ...here, limit: 2 })).toHaveLength(2);
  });
});
