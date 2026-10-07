import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import { parsePlaces } from "../src/places/load";
import { PLACE_KIND, type Place } from "../src/places/place";
import {
  buildIndexes,
  type Chain,
  chainId,
  chainKey,
  chainSlug,
  cityLabel,
  formatDistance,
  groupForList,
  type Indexes,
} from "../src/places/indexes";
import raw from "./fixtures/funchal-items.json";

const fixtures: NostrEvent[] = raw;
const places = parsePlaces(fixtures);
const CENTER = { lat: config.defaultCity.lat, lon: config.defaultCity.lon };
const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_OF_LATITUDE = (Math.PI / 180) * EARTH_RADIUS_KM;

/** Great-circle distance, written out here so the tests do not lean on the code they test. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const kmFromCenter = (place: Place) => haversineKm(CENTER.lat, CENTER.lon, place.lat, place.lon);

let made = 0;
/** A place with only what the test names; the rest is plain. */
function make(name: string, over: Partial<Place> = {}): Place {
  made += 1;
  const d = over.d ?? `test-${made}`;
  return {
    address: `${PLACE_KIND}:${config.houseHex}:${d}`,
    d,
    pubkey: config.houseHex,
    name,
    category: "restaurant",
    lat: CENTER.lat,
    lon: CENTER.lon,
    geohash: "etgcxpyg8",
    keywords: [],
    createdAt: 0,
    ...over,
  };
}

/** Where a place `km` north of the centre is. */
const north = (km: number) => ({ lat: CENTER.lat + km / KM_PER_DEGREE_OF_LATITUDE, lon: CENTER.lon });

/** Where a place `km` west of the centre is. */
const west = (km: number) => ({
  lat: CENTER.lat,
  lon: CENTER.lon - km / (KM_PER_DEGREE_OF_LATITUDE * Math.cos((CENTER.lat * Math.PI) / 180)),
});

/** The point `northKm` kilometres north and `eastKm` east of (`lat`, `lon`). */
const offset = (lat: number, lon: number, northKm: number, eastKm = 0) => ({
  lat: lat + northKm / KM_PER_DEGREE_OF_LATITUDE,
  lon: lon + eastKm / (KM_PER_DEGREE_OF_LATITUDE * Math.cos((lat * Math.PI) / 180)),
});

/** The chain of that name in that country. */
const chainNamed = (idx: Indexes, name: string, country = "PT") => idx.chains.get(chainId(chainKey(name), country));

const namesOf = (rows: { place: Place }[]) => rows.map((row) => row.place.name);
const search = (idx: Indexes, q: string, radiusKm?: number) =>
  idx.search(q, { ...CENTER, ...(radiusKm === undefined ? {} : { radiusKm }) });

const fixtureIndexes = buildIndexes(places);

/** Words that are in no name here, for making names of different lengths. */
const MORE_WORDS = ["mar", "sol", "lua", "rio", "vila", "praia", "ponte", "casa", "forno", "tasca"];

describe("the fixtures", () => {
  it("parse to all 43 places", () => {
    expect(places).toHaveLength(43);
  });
});

describe("chainKey", () => {
  it("is the same for spellings that differ in case, quotes and spacing", () => {
    expect(chainKey("Steak 'n Shake")).toBe(chainKey("STEAK ’N SHAKE "));
    expect(chainKey("Steak 'n Shake")).toBe(chainKey("steak ‘n shake"));
    expect(chainKey("Steak 'n Shake")).toBe(chainKey("steak `n shake"));
    expect(chainKey("Steak 'n Shake")).toBe(chainKey("  Steak   'n\tShake  "));
  });

  it("writes the quotes as a plain apostrophe", () => {
    expect(chainKey("Theo’s")).toBe("theo's");
    expect(chainKey("Theo‘s")).toBe("theo's");
    expect(chainKey("Theo`s")).toBe("theo's");
  });

  it("folds compatibility forms (NFKC)", () => {
    expect(chainKey("ＰＩＺＺＡ ＨＵＴ")).toBe("pizza hut");
    expect(chainKey("ﬁsh bar")).toBe("fish bar");
  });

  it("strips trailing . , ; : ! and the space around them", () => {
    expect(chainKey("Joe's Pizza.")).toBe("joe's pizza");
    expect(chainKey("Wow!!!")).toBe("wow");
    expect(chainKey("Foo , ;: . ")).toBe("foo");
    expect(chainKey("Bar & Grill ;")).toBe("bar & grill");
  });

  it("leaves other punctuation, and punctuation inside the name, alone", () => {
    expect(chainKey("Why Not?")).toBe("why not?");
    expect(chainKey("Boba & Chill - Bubble Tea")).toBe("boba & chill - bubble tea");
    expect(chainKey("St. Mary's")).toBe("st. mary's");
    expect(chainKey("Kampo (Funchal)")).toBe("kampo (funchal)");
  });

  it("keeps accents and other scripts: they are part of the name", () => {
    expect(chainKey("Jacafé")).toBe("jacafé");
    expect(chainKey("ペーパー・クレーン")).toBe("ペーパー・クレーン");
  });

  it("is empty for a name that is only trailing punctuation and space", () => {
    expect(chainKey(" . ! ")).toBe("");
  });

  describe("on a very long name", () => {
    /** How long `chainKey` takes on `text`, in milliseconds. */
    function timeOf(text: string): number {
      const started = performance.now();
      chainKey(text);
      return performance.now() - started;
    }

    it("trims a run of 100,000 trailing characters in linear time", () => {
      const run = "!".repeat(100_000);
      expect(chainKey(run)).toBe("");
      expect(chainKey(`Pizza${run}`)).toBe("pizza");
      expect(chainKey(`Pizza${" .".repeat(50_000)}`)).toBe("pizza");
      expect(timeOf(run)).toBeLessThan(50);
      expect(timeOf(`Pizza${run}`)).toBeLessThan(50);
      expect(timeOf(`Pizza${" .".repeat(50_000)}`)).toBeLessThan(50);
    });

    it("does not slow down when a long run of punctuation is not at the end", () => {
      // A pattern that looks for a trailing run from every start would try each one in turn.
      const name = `Pizza${"!".repeat(100_000)}Hut`;
      expect(chainKey(name)).toBe(name.toLowerCase());
      expect(timeOf(name)).toBeLessThan(50);
      expect(timeOf(`Pizza${" ".repeat(100_000)}Hut`)).toBeLessThan(50);
    });
  });
});

describe("near", () => {
  it("returns the places within the radius, nearest first, with their distance in km", () => {
    const rows = fixtureIndexes.near(CENTER.lat, CENTER.lon, 25);
    expect(rows).toHaveLength(43);
    expect(rows.every((row) => row.km <= 25)).toBe(true);
    expect(rows.map((row) => row.km)).toEqual([...rows.map((row) => row.km)].sort((a, b) => a - b));
    for (const row of rows) expect(row.km).toBeCloseTo(kmFromCenter(row.place), 6);
    expect(rows[0]!.place.name).toBe("Minimal Table");
  });

  it("leaves out the places beyond the radius", () => {
    const rows = fixtureIndexes.near(CENTER.lat, CENTER.lon, 0.3);
    const expected = places.filter((place) => kmFromCenter(place) <= 0.3).map((place) => place.address);
    expect(expected.length).toBeGreaterThan(5);
    expect(expected.length).toBeLessThan(places.length);
    expect(rows.map((row) => row.place.address).sort()).toEqual(expected.sort());
  });

  it("stops at the limit, keeping the nearest", () => {
    const all = fixtureIndexes.near(CENTER.lat, CENTER.lon, 25);
    const some = fixtureIndexes.near(CENTER.lat, CENTER.lon, 25, 5);
    expect(some.map((row) => row.place.address)).toEqual(all.slice(0, 5).map((row) => row.place.address));
  });

  it("measures from the point it is given, not from the centre of Funchal", () => {
    const far = make("Lisboa", { lat: 38.7223, lon: -9.1393 });
    const idx = buildIndexes([...places, far]);
    expect(idx.near(CENTER.lat, CENTER.lon, 25)).toHaveLength(43);
    const fromLisbon = idx.near(38.7223, -9.1393, 25);
    expect(namesOf(fromLisbon)).toEqual(["Lisboa"]);
    expect(fromLisbon[0]!.km).toBeCloseTo(0, 6);
    const wide = idx.near(CENTER.lat, CENTER.lon, 2000);
    expect(wide).toHaveLength(44);
    expect(wide.at(-1)!.place.name).toBe("Lisboa");
    expect(wide.at(-1)!.km).toBeCloseTo(kmFromCenter(far), 6);
  });

  it("finds nothing among no places", () => {
    expect(buildIndexes([]).near(CENTER.lat, CENTER.lon, 25)).toEqual([]);
  });

  it("finds nothing for a radius below zero, or a limit of none", () => {
    expect(fixtureIndexes.near(CENTER.lat, CENTER.lon, -5)).toEqual([]);
    expect(fixtureIndexes.near(CENTER.lat, CENTER.lon, Number.NaN)).toEqual([]);
    expect(fixtureIndexes.near(CENTER.lat, CENTER.lon, 25, 0)).toEqual([]);
    expect(fixtureIndexes.near(CENTER.lat, CENTER.lon, 0)).toEqual([]);
  });

  it("reaches every place for a radius with no end, or one past the other side of the Earth", () => {
    // A place on the opposite side of the Earth from the centre.
    const antipode = make("Antipode", { lat: -CENTER.lat, lon: CENTER.lon + 180 - 360 });
    const idx = buildIndexes([...places, antipode]);
    expect(idx.near(CENTER.lat, CENTER.lon, Number.POSITIVE_INFINITY)).toHaveLength(44);
    expect(idx.near(CENTER.lat, CENTER.lon, 25_000)).toHaveLength(44);
    expect(idx.near(CENTER.lat, CENTER.lon, 20_000)).toHaveLength(43);
    expect(idx.near(CENTER.lat, CENTER.lon, 25_000).at(-1)!.place.name).toBe("Antipode");
  });

  it.each<[string, number, number]>([
    ["a latitude that is NaN", Number.NaN, CENTER.lon],
    ["a longitude that is NaN", CENTER.lat, Number.NaN],
    ["an infinite latitude", Number.POSITIVE_INFINITY, CENTER.lon],
    ["an infinite longitude", CENTER.lat, Number.NEGATIVE_INFINITY],
  ])("finds nothing for %s", (_what, lat, lon) => {
    expect(fixtureIndexes.near(lat, lon, 25)).toEqual([]);
  });
});

describe("search", () => {
  const field = (over: Partial<Place>) => make(over.name ?? "Zed", over);

  it("matches the name", () => {
    const idx = buildIndexes([field({ name: "Quokka Place" }), field({ name: "Other" })]);
    expect(namesOf(search(idx, "quokka"))).toEqual(["Quokka Place"]);
  });

  it("matches the kind label", () => {
    const idx = buildIndexes([field({ name: "Zed", category: "bakery" }), field({ name: "Other" })]);
    expect(namesOf(search(idx, "bakery"))).toEqual(["Zed"]);
    expect(namesOf(search(idx, "restaurant"))).toEqual(["Other"]);

    const cafe = buildIndexes([field({ name: "Zed", category: "cafe" }), field({ name: "Other" })]);
    expect(namesOf(search(cafe, "cafe"))).toEqual(["Zed"]);
  });

  it("finds cafes among the fixtures by their kind", () => {
    const names = namesOf(search(fixtureIndexes, "cafe"));
    const cafes = places.filter((place) => place.category === "cafe").map((place) => place.name);
    expect(cafes).toHaveLength(9);
    for (const name of cafes) expect(names).toContain(name);
    // A bar with "Café" in its name is found too.
    expect(names).toContain("Barreirinha Bar Café");
  });

  it("matches the cuisine label", () => {
    const idx = buildIndexes([
      field({ name: "Zed", cuisine: "steak_house" }),
      field({ name: "Stop", category: "bar", cuisine: "cafe" }),
      field({ name: "Other" }),
    ]);
    expect(namesOf(search(idx, "steak"))).toEqual(["Zed"]);
    expect(namesOf(search(idx, "house"))).toEqual(["Zed"]);
    expect(namesOf(search(idx, "cafe"))).toEqual(["Stop"]);

    const onlyCuisine = buildIndexes([field({ name: "Zed", category: "restaurant", cuisine: "cafe" })]);
    expect(namesOf(search(onlyCuisine, "cafe"))).toEqual(["Zed"]);
  });

  it("matches the locality", () => {
    const idx = buildIndexes([
      field({ name: "Zed", locality: "Câmara de Lobos" }),
      field({ name: "Other", locality: "Funchal" }),
    ]);
    expect(namesOf(search(idx, "lobos"))).toEqual(["Zed"]);
    expect(namesOf(search(idx, "Funchal"))).toEqual(["Other"]);
  });

  it("matches the keywords", () => {
    const idx = buildIndexes([field({ name: "Zed", keywords: ["rooftop", "são martinho"] }), field({ name: "Other" })]);
    expect(namesOf(search(idx, "rooftop"))).toEqual(["Zed"]);
    expect(namesOf(search(idx, "martinho"))).toEqual(["Zed"]);
  });

  it("finds the fixtures' Funchal places by Funchal", () => {
    const rows = search(fixtureIndexes, "Funchal");
    const inFunchal = places.filter((place) => place.locality === "Funchal");
    expect(inFunchal.length).toBeGreaterThanOrEqual(30);
    expect(rows.map((row) => row.place.address).sort()).toEqual(inFunchal.map((place) => place.address).sort());
  });

  it("finds pizza by cuisine", () => {
    const names = namesOf(search(fixtureIndexes, "pizza"));
    expect(names).toContain("Ciao Pizzeria");
    expect(names).toContain("Xarambinha Pizzeria Expresso");
  });

  it("still finds a word with a typo", () => {
    const names = namesOf(search(fixtureIndexes, "piza"));
    expect(names).toContain("Ciao Pizzeria");
    expect(names).toContain("Xarambinha Pizzeria Expresso");
    expect(namesOf(search(fixtureIndexes, "restarant")).length).toBeGreaterThan(10);
  });

  it("puts a word that is spelled right ahead of a typo of it", () => {
    const idx = buildIndexes([
      make("Piza Palace", { ...north(0.1) }),
      make("Pizza Palace", { ...north(5) }),
    ]);
    expect(namesOf(search(idx, "pizza"))).toEqual(["Pizza Palace", "Piza Palace"]);
  });

  it("matches the start of a word as you type", () => {
    expect(namesOf(search(fixtureIndexes, "xaram"))).toEqual(["Xarambinha Pizzeria Expresso"]);
  });

  it("needs every word of the query", () => {
    expect(namesOf(search(fixtureIndexes, "loft cocktails")).sort()).toEqual([
      "Loft Brunch & Cocktails",
      "Loft Brunch & Cocktails",
    ]);
    expect(search(fixtureIndexes, "loft pizza")).toEqual([]);
  });

  it("ignores accents and case, in the places and in the query", () => {
    expect(namesOf(search(fixtureIndexes, "jacafe"))).toEqual(["Jacafé"]);
    expect(namesOf(search(fixtureIndexes, "JACAFÉ"))).toEqual(["Jacafé"]);
    expect(namesOf(search(fixtureIndexes, "avo acores"))).toEqual(["Queijaria da Avó - Açores Cheese Shop"]);
    expect(namesOf(search(fixtureIndexes, "sao roque"))).toEqual(["A Cafetaria [nos.viveiros]"]);
  });

  it("ignores accents where a typo would not cover for them", () => {
    // "acucar" is two edits from "açúcar": too many for the fuzzy match.
    const idx = buildIndexes([make("Açúcar e Pão"), make("Acucar Doce"), make("Other")]);
    expect(namesOf(search(idx, "acucar")).sort()).toEqual(["Acucar Doce", "Açúcar e Pão"]);
    expect(namesOf(search(idx, "AÇÚCAR")).sort()).toEqual(["Acucar Doce", "Açúcar e Pão"]);
  });

  it("finds a name in another script", () => {
    expect(namesOf(search(fixtureIndexes, "クレーン"))).toEqual(["ペーパー・クレーン"]);
    // The kana are not stripped to their base letters: ペ and ヘ are different.
    expect(search(fixtureIndexes, "ヘーハー")).toEqual([]);
  });

  it("gives each result its distance from the point searched from", () => {
    const rows = search(fixtureIndexes, "jacafe");
    expect(rows[0]!.km).toBeCloseTo(kmFromCenter(rows[0]!.place), 6);
    const away = fixtureIndexes.search("jacafe", { lat: 32.7507, lon: -16.9084 });
    expect(away[0]!.km).toBeCloseTo(haversineKm(32.7507, -16.9084, rows[0]!.place.lat, rows[0]!.place.lon), 6);
  });

  describe("by the words for a kind of place", () => {
    it.each<[string, string]>([
      ["cafe", "coffee"],
      ["bar", "drinks"],
      ["pub", "beer"],
      ["bakery", "bread"],
      ["pastry", "cake"],
      ["ice_cream", "gelato"],
      ["fast_food", "takeaway"],
      ["fast_food", "burger"],
      ["brewery", "beer"],
      ["brewery", "wine"],
    ])("finds a place of kind %s by %s", (category, word) => {
      const idx = buildIndexes([make("Zed", { category }), make("Other", { category: "restaurant" })]);
      expect(namesOf(search(idx, word))).toEqual(["Zed"]);
    });

    it("does not find a restaurant by them", () => {
      const idx = buildIndexes([make("Zed", { category: "restaurant" })]);
      for (const word of ["coffee", "drinks", "beer", "bread", "cake", "gelato", "takeaway", "burger", "wine"]) {
        expect(search(idx, word)).toEqual([]);
      }
    });
  });

  describe("over the fixtures and two places farther out", () => {
    // Neither place is in the fixtures. Each is a copy of one that is, with another name and
    // tags of its own: the Bolo do Caco place is a regional restaurant that has Pizza in its name.
    const farther = (like: string, over: Partial<Place>): Place => {
      const base = places.find((place) => place.name === like)!;
      const d = `farther-${made + 1}`;
      return make(over.name ?? base.name, { ...base, d, address: `${PLACE_KIND}:${base.pubkey}:${d}`, ...over });
    };
    const bolo = farther("Ciao Pizzeria", {
      name: "Bolo do Caco Grill & Pizza",
      cuisine: "regional",
      keywords: ["restaurant", "regional", "funchal"],
      ...west(19),
    });
    const ribeira = farther("A Cafetaria [nos.viveiros]", {
      name: "A Cafetaria [na.ribeira brava]",
      locality: "Ribeira Brava",
      keywords: ["cafe", "coffee_shop", "ribeira brava"],
      ...west(14),
    });
    const idx = buildIndexes([...places, bolo, ribeira]);
    const rowsOf = (q: string) => search(idx, q, 25);
    const addressesOf = (q: string) => rowsOf(q).map((row) => row.place.address);
    const addressOf = (name: string) => places.find((place) => place.name === name)!.address;

    it("puts the pizzerias near the centre ahead of a place 19 km out with Pizza in its name", () => {
      expect(Math.round(kmFromCenter(bolo))).toBe(19);
      const found = addressesOf("pizza");
      const far = found.indexOf(bolo.address);
      expect(far).toBeGreaterThanOrEqual(0);
      for (const name of ["Ciao Pizzeria", "Xarambinha Pizzeria Expresso"]) {
        const near = found.indexOf(addressOf(name));
        expect(near).toBeGreaterThanOrEqual(0);
        expect(near).toBeLessThan(far);
      }
    });

    it("finds cafes by coffee, including those with no cuisine", () => {
      const found = addressesOf("coffee");
      const plain = places.filter((place) => place.category === "cafe" && place.cuisine === undefined);
      expect(plain.map((place) => place.name)).toContain("Maia");
      for (const place of plain) expect(found).toContain(place.address);
    });

    it("puts cafes under a kilometre ahead of a cafe 14 km out whose name starts with the word", () => {
      expect(Math.round(kmFromCenter(ribeira))).toBe(14);
      const rows = rowsOf("cafe");
      const found = rows.map((row) => row.place.address);
      const far = found.indexOf(ribeira.address);
      expect(far).toBeGreaterThanOrEqual(0);
      // The first result is a cafe under a kilometre away, and it is not the far one.
      expect(rows[0]!.place.category).toBe("cafe");
      expect(rows[0]!.km).toBeLessThan(1);
      // So are the cafes that have the word in their name.
      for (const name of ["Museu Café", "Between Cafe & Healthy Food"]) {
        expect(found.indexOf(addressOf(name))).toBeGreaterThanOrEqual(0);
        expect(found.indexOf(addressOf(name))).toBeLessThan(far);
      }
    });
  });

  describe("order", () => {
    /** "Verde", then `extra` more words. Each word a name has makes it score a little less for "verde". */
    const verde = (extra: number) => ["Verde", ...MORE_WORDS.slice(0, extra)].join(" ");

    it("puts the nearer place first when two match equally well", () => {
      const idx = buildIndexes([
        make("Casa Verde", north(3)),
        make("Casa Verde", north(1)),
        make("Casa Verde", north(2)),
      ]);
      const km = search(idx, "verde").map((row) => Math.round(row.km));
      expect(km).toEqual([1, 2, 3]);
    });

    it("puts a match in the name ahead of one in the keywords, however far it is", () => {
      // The word is in one place's name and in another's keywords, and in no other place.
      const idx = buildIndexes([
        make("Zed", { ...north(0.5), keywords: ["verde"] }),
        make("Tasca Verde", north(9)),
        make("Other One"),
        make("Other Two"),
        make("Other Three"),
      ]);
      expect(namesOf(search(idx, "verde"))).toEqual(["Tasca Verde", "Zed"]);
    });

    it("puts a match in the cuisine ahead of one in the keywords, however far it is", () => {
      const idx = buildIndexes([
        make("Zed", { ...north(0.5), keywords: ["pizza"] }),
        make("Zee", { ...north(9), cuisine: "pizza" }),
        make("Other One"),
        make("Other Two"),
        make("Other Three"),
      ]);
      expect(namesOf(search(idx, "pizza"))).toEqual(["Zee", "Zed"]);
    });

    it("puts the nearer place first among matches that score nearly the same", () => {
      const idx = buildIndexes([
        make(verde(1), north(4)),
        make(verde(2), north(1)),
        make(verde(3), north(0.5)),
        make("Other Place"),
        make("Another Place"),
        make("Third Place"),
      ]);
      expect(namesOf(search(idx, "verde"))).toEqual([verde(3), verde(2), verde(1)]);
    });

    it("puts a match that scores far less after the others, however near it is", () => {
      const idx = buildIndexes([
        make(verde(0), north(8)),
        make(verde(1), north(6)),
        make("Zed", { ...north(0.1), keywords: ["verde"] }),
        make("Other Place"),
        make("Another Place"),
        make("Third Place"),
      ]);
      expect(namesOf(search(idx, "verde"))).toEqual([verde(1), verde(0), "Zed"]);
    });
  });

  describe("radius", () => {
    const idx = buildIndexes([
      make("Casa Perto", north(1)),
      make("Casa Longe", north(40)),
    ]);

    it("drops places beyond it", () => {
      expect(namesOf(search(idx, "casa", 25))).toEqual(["Casa Perto"]);
      expect(namesOf(search(idx, "casa", 50))).toEqual(["Casa Perto", "Casa Longe"]);
    });

    it("reaches everywhere without one", () => {
      expect(namesOf(search(idx, "casa"))).toEqual(["Casa Perto", "Casa Longe"]);
    });

    it("judges the matches that are left against the best of them, not against one it dropped", () => {
      // Each extra word in a name lowers its score a little. Beside the best match, 40 km away,
      // the nearest place in range (7 extra words) scores a step below the other one (3). Beside
      // the other, the best in range once the far one is dropped, the two score nearly the same,
      // so the nearer goes first.
      const verde = (extra: number) => ["Verde", ...MORE_WORDS.slice(0, extra)].join(" ");
      const pool = buildIndexes([
        make(verde(1), north(40)),
        make(verde(3), north(3)),
        make(verde(7), north(1)),
        make("Other Place"),
        make("Another Place"),
        make("Third Place"),
      ]);
      expect(namesOf(search(pool, "verde", 25))).toEqual([verde(7), verde(3)]);
    });
  });

  describe("an empty query", () => {
    it("lists the places near the point, within the radius, or 25 km without one", () => {
      const idx = buildIndexes([make("Casa Perto", north(1)), make("Casa Longe", north(40))]);
      expect(namesOf(search(idx, ""))).toEqual(["Casa Perto"]);
      expect(namesOf(search(idx, "  \t\n "))).toEqual(["Casa Perto"]);
      expect(namesOf(search(idx, "", 50))).toEqual(["Casa Perto", "Casa Longe"]);
      expect(namesOf(search(idx, "", 0.5))).toEqual([]);
    });

    it("is the same as near", () => {
      expect(search(fixtureIndexes, "")).toEqual(fixtureIndexes.near(CENTER.lat, CENTER.lon, 25));
      expect(search(fixtureIndexes, " ", 0.3)).toEqual(fixtureIndexes.near(CENTER.lat, CENTER.lon, 0.3));
    });
  });

  it.each<[string, number, number]>([
    ["a latitude that is NaN", Number.NaN, CENTER.lon],
    ["a longitude that is NaN", CENTER.lat, Number.NaN],
    ["an infinite latitude", Number.POSITIVE_INFINITY, CENTER.lon],
    ["an infinite longitude", CENTER.lat, Number.NEGATIVE_INFINITY],
  ])("finds nothing from %s, with a query or without one", (_what, lat, lon) => {
    expect(fixtureIndexes.search("pizza", { lat, lon })).toEqual([]);
    expect(fixtureIndexes.search("pizza", { lat, lon, radiusKm: 25 })).toEqual([]);
    expect(fixtureIndexes.search("", { lat, lon })).toEqual([]);
  });

  it("finds nothing for a query with no words in it, and for no places", () => {
    expect(search(fixtureIndexes, "!!! ...")).toEqual([]);
    expect(search(buildIndexes([]), "pizza")).toEqual([]);
  });
});

describe("chains", () => {
  it("are the names that two or more places in a country share", () => {
    expect([...fixtureIndexes.chains.keys()].sort()).toEqual([
      "PT:a confeitaria coffee & bakery",
      "PT:loft brunch & cocktails",
    ]);
    const confeitaria = chainNamed(fixtureIndexes, "A Confeitaria Coffee & Bakery")!;
    expect(confeitaria.key).toBe("a confeitaria coffee & bakery");
    expect(confeitaria.country).toBe("PT");
    expect(confeitaria.name).toBe("A Confeitaria Coffee & Bakery");
    expect(confeitaria.places).toHaveLength(4);
    expect(chainNamed(fixtureIndexes, "Loft Brunch & Cocktails")!.places).toHaveLength(2);
  });

  it("keep each location its own place", () => {
    const confeitaria = chainNamed(fixtureIndexes, "A Confeitaria Coffee & Bakery")!;
    expect(new Set(confeitaria.places.map((place) => place.address)).size).toBe(4);
    expect(fixtureIndexes.byD.size).toBe(43);
    // The places are the ones in the list, in the list's order.
    const inList = places.filter((place) => place.name === "A Confeitaria Coffee & Bakery");
    expect(confeitaria.places).toEqual(inList);
    expect(confeitaria.places[0]).toBe(inList[0]);
  });

  it("do not include a name that one place has", () => {
    expect(chainNamed(fixtureIndexes, "Jacafé")).toBeUndefined();
    expect(chainNamed(fixtureIndexes, "A Confeitaria")).toBeUndefined();
  });

  it("group names that differ only as chainKey ignores", () => {
    const idx = buildIndexes([
      make("Steak 'n Shake", { ...north(1), country: "US" }),
      make("STEAK ’N SHAKE ", { ...north(2), country: "US" }),
      make("steak `n shake.", { ...north(3), country: "US" }),
    ]);
    expect(idx.chains.size).toBe(1);
    expect(chainNamed(idx, "Steak 'n Shake", "US")!.places).toHaveLength(3);
  });

  it("are called by the spelling most of their places use", () => {
    const idx = buildIndexes([
      make("PIZZA HUT"),
      make("Pizza Hut"),
      make("Pizza Hut"),
      make("pizza hut"),
    ]);
    expect([...idx.chains.values()].map((chain) => chain.name)).toEqual(["Pizza Hut"]);
  });

  it("are called by the first spelling seen when spellings tie", () => {
    const idx = buildIndexes([make("Pão Doce"), make("PÃO DOCE"), make("Pão Doce"), make("PÃO DOCE")]);
    expect([...idx.chains.values()].map((chain) => chain.name)).toEqual(["Pão Doce"]);
  });

  it("never include a name with no letters in it", () => {
    const idx = buildIndexes([make("!"), make("..."), make("  ")]);
    expect(idx.chains.size).toBe(0);
  });

  describe("in different countries", () => {
    const idx = buildIndexes([
      make("Pizza Hut", { country: "PT" }),
      make("Pizza Hut", { country: "PT" }),
      make("Pizza Hut", { country: "ES" }),
      make("Pizza Hut", { country: "ES" }),
      make("Pizza Hut", { country: "ES" }),
      make("Burger Town", { country: "PT" }),
      make("Burger Town", { country: "ES" }),
      make("Taco Casa"),
      make("Taco Casa"),
      make("Taco Casa", { country: "PT" }),
    ]);

    it("are one chain for each country", () => {
      expect(chainNamed(idx, "Pizza Hut", "PT")!.places).toHaveLength(2);
      expect(chainNamed(idx, "Pizza Hut", "ES")!.places).toHaveLength(3);
      expect(chainNamed(idx, "Pizza Hut", "PT")).not.toBe(chainNamed(idx, "Pizza Hut", "ES"));
      expect(chainNamed(idx, "Pizza Hut", "ES")!.country).toBe("ES");
    });

    it("do not join namesakes that are each alone in their country", () => {
      expect(chainNamed(idx, "Burger Town", "PT")).toBeUndefined();
      expect(chainNamed(idx, "Burger Town", "ES")).toBeUndefined();
      const burger = [...idx.byD.values()].filter((place) => place.name === "Burger Town");
      expect(burger).toHaveLength(2);
      for (const place of burger) expect(idx.chainOf(place)).toBeUndefined();
    });

    it("keep places with no country apart from those with one", () => {
      const noCountry = chainNamed(idx, "Taco Casa", "");
      expect(noCountry!.places).toHaveLength(2);
      expect(noCountry!.country).toBe("");
      expect(chainNamed(idx, "Taco Casa", "PT")).toBeUndefined();
    });

    it("read the country in any case, with spaces round it", () => {
      const spelled = buildIndexes([make("Foo", { country: "pt" }), make("Foo", { country: " PT " })]);
      expect(chainNamed(spelled, "Foo", "PT")!.places).toHaveLength(2);
    });
  });

  describe("with a name that stands for no name", () => {
    it.each(["Unnamed", "no name", "Sin Nombre", "SEM NOME", "Noname", "Unnamed.", "  No   Name  ", "Sem nome!"])(
      "never chain %j",
      (name) => {
        const idx = buildIndexes([make(name), make(name), make(name)]);
        expect(idx.chains.size).toBe(0);
        expect(idx.chainOf(make(name))).toBeUndefined();
      },
    );

    it("still chain a name that only contains those words", () => {
      const idx = buildIndexes([make("Sem Nome Bar"), make("Sem Nome Bar"), make("The No Name Cafe"), make("The No Name Cafe")]);
      expect(idx.chains.size).toBe(2);
    });
  });

  describe("chainOf", () => {
    it("is undefined for a name that is not shared", () => {
      expect(fixtureIndexes.chainOf(places.find((place) => place.name === "Jacafé")!)).toBeUndefined();
    });

    it("is the chain for any of its places", () => {
      const loft = places.filter((place) => place.name === "Loft Brunch & Cocktails");
      expect(loft).toHaveLength(2);
      for (const place of loft) expect(fixtureIndexes.chainOf(place)).toBe(chainNamed(fixtureIndexes, "Loft Brunch & Cocktails"));
    });
  });

  describe("slugs", () => {
    it("are URL-safe", () => {
      for (const chain of fixtureIndexes.chains.values()) {
        expect(chainSlug(chain)).toMatch(/^[A-Za-z0-9\-_.!~*'()%:]+$/);
        expect(chainSlug(chain)).not.toMatch(/[ &/?#]/);
      }
    });

    it("name the country and the name", () => {
      const chain = chainNamed(fixtureIndexes, "A Confeitaria Coffee & Bakery")!;
      expect(chainSlug(chain)).toBe(`PT:${encodeURIComponent(chain.key)}`);
    });

    it("find the chain they were made from", () => {
      for (const chain of fixtureIndexes.chains.values()) {
        expect(fixtureIndexes.chainBySlug(chainSlug(chain))).toBe(chain);
      }
    });

    it("also find it from the text a router has already decoded", () => {
      for (const chain of fixtureIndexes.chains.values()) {
        expect(fixtureIndexes.chainBySlug(decodeURIComponent(chainSlug(chain)))).toBe(chain);
      }
    });

    it("tell a name in one country from the same name in another", () => {
      const idx = buildIndexes([
        make("Pizza Hut", { country: "PT" }),
        make("Pizza Hut", { country: "PT" }),
        make("Pizza Hut", { country: "ES" }),
        make("Pizza Hut", { country: "ES" }),
        make("Pizza Hut"),
        make("Pizza Hut"),
      ]);
      expect(idx.chains.size).toBe(3);
      const slugs = [...idx.chains.values()].map((chain) => chainSlug(chain));
      expect(new Set(slugs).size).toBe(3);
      for (const chain of idx.chains.values()) {
        expect(idx.chainBySlug(chainSlug(chain))).toBe(chain);
        expect(idx.chainBySlug(decodeURIComponent(chainSlug(chain)))).toBe(chain);
      }
    });

    it("work for names with a colon, a slash, a percent sign and non-Latin letters", () => {
      const idx = buildIndexes([
        make("100% Pão/Café", { country: "PT" }), make("100% pão/café", { country: "PT" }),
        make("Café: The Original", { country: "PT" }), make("Café: The Original", { country: "PT" }),
        make("ペーパー・クレーン", { country: "JP" }), make("ペーパー・クレーン", { country: "JP" }),
        make("Pão: Doce"), make("Pão: Doce"),
      ]);
      expect(idx.chains.size).toBe(4);
      for (const chain of idx.chains.values()) {
        const slug = chainSlug(chain);
        expect(slug).toMatch(/^[A-Za-z0-9\-_.!~*'()%:]+$/);
        expect(idx.chainBySlug(slug)).toBe(chain);
        // A router gives the text back decoded; the key may hold a colon of its own.
        expect(idx.chainBySlug(decodeURIComponent(slug))).toBe(chain);
      }
    });

    it("read the country in the slug in any case", () => {
      const chain = chainNamed(fixtureIndexes, "Loft Brunch & Cocktails")!;
      expect(fixtureIndexes.chainBySlug(chainSlug(chain).replace("PT:", "pt:"))).toBe(chain);
    });

    it("find nothing for a name that is not a chain, a country it is not in, or a slug that cannot be read", () => {
      const loft = chainNamed(fixtureIndexes, "Loft Brunch & Cocktails")!;
      expect(fixtureIndexes.chainBySlug(chainSlug({ key: chainKey("Jacafé"), country: "PT" }))).toBeUndefined();
      expect(fixtureIndexes.chainBySlug(chainSlug({ key: loft.key, country: "ES" }))).toBeUndefined();
      expect(fixtureIndexes.chainBySlug(chainSlug({ key: loft.key, country: "" }))).toBeUndefined();
      expect(fixtureIndexes.chainBySlug(encodeURIComponent(loft.key))).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("")).toBeUndefined();
      expect(fixtureIndexes.chainBySlug(":")).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("PT:%E0%A4%A")).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("constructor")).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("PT:constructor")).toBeUndefined();
    });
  });
});

describe("groupForList", () => {
  const confeitaria = (n: number) => places.filter((place) => place.name === "A Confeitaria Coffee & Bakery")[n]!;
  const loft = (n: number) => places.filter((place) => place.name === "Loft Brunch & Cocktails")[n]!;
  const jacafe = places.find((place) => place.name === "Jacafé")!;
  const row = (place: Place, km: number) => ({ place, km });

  it("turns rows of one chain into one entry, where the nearer row was", () => {
    const rows = [row(jacafe, 0.1), row(loft(0), 0.2), row(places[3]!, 0.3), row(loft(1), 0.4)];
    const grouped = groupForList(rows, fixtureIndexes);
    expect(grouped).toEqual([
      rows[0],
      { chain: chainNamed(fixtureIndexes, "Loft Brunch & Cocktails"), nearby: [rows[1], rows[3]] },
      rows[2],
    ]);
    // The rows are the ones given, not copies.
    expect(grouped[0]).toBe(rows[0]);
    expect((grouped[1] as { nearby: unknown[] }).nearby[1]).toBe(rows[3]);
  });

  it("lists the rows of an entry in the order they were given", () => {
    const rows = [row(confeitaria(2), 0.5), row(jacafe, 0.6), row(confeitaria(0), 0.7), row(confeitaria(3), 0.8)];
    const grouped = groupForList(rows, fixtureIndexes);
    expect(grouped).toHaveLength(2);
    expect((grouped[0] as { nearby: unknown[] }).nearby).toEqual([rows[0], rows[2], rows[3]]);
    expect(grouped[1]).toBe(rows[1]);
  });

  it("leaves a chain that appears once in the rows as a plain row", () => {
    const rows = [row(jacafe, 0.1), row(loft(0), 0.2), row(places[3]!, 0.3)];
    const grouped = groupForList(rows, fixtureIndexes);
    expect(grouped).toEqual(rows);
    for (const [i, entry] of grouped.entries()) expect(entry).toBe(rows[i]);
  });

  it("groups more than one chain in the same list", () => {
    const rows = [
      row(loft(0), 0.1),
      row(confeitaria(0), 0.2),
      row(loft(1), 0.3),
      row(confeitaria(1), 0.4),
    ];
    const grouped = groupForList(rows, fixtureIndexes);
    expect(grouped).toHaveLength(2);
    expect((grouped[0] as { chain: Chain }).chain.key).toBe("loft brunch & cocktails");
    expect((grouped[1] as { chain: Chain }).chain.key).toBe("a confeitaria coffee & bakery");
  });

  it("gives back the whole chain, not only the rows listed", () => {
    const rows = [row(confeitaria(0), 0.2), row(confeitaria(1), 0.4)];
    const [entry] = groupForList(rows, fixtureIndexes) as { chain: Chain; nearby: unknown[] }[];
    expect(entry!.nearby).toHaveLength(2);
    expect(entry!.chain.places).toHaveLength(4);
  });

  it("works on a whole nearby list", () => {
    const rows = fixtureIndexes.near(CENTER.lat, CENTER.lon, 25);
    const grouped = groupForList(rows, fixtureIndexes);
    // Four Confeitaria rows become one entry, and two Loft rows become one: 43 - 3 - 1.
    expect(grouped).toHaveLength(39);
    const firstLoft = rows.findIndex((r) => r.place.name === "Loft Brunch & Cocktails");
    const groupAt = grouped.findIndex((entry) => "chain" in entry && entry.chain.key === "loft brunch & cocktails");
    expect(groupAt).toBe(firstLoft);
  });

  it("handles no rows", () => {
    expect(groupForList([], fixtureIndexes)).toEqual([]);
  });
});

describe("cities", () => {
  it("include Funchal in the fixtures, with its country and count", () => {
    const funchal = fixtureIndexes.cities.find((city) => city.name === "Funchal");
    expect(funchal).toBeDefined();
    expect(funchal!.count).toBeGreaterThanOrEqual(30);
    expect(funchal!.count).toBe(places.filter((place) => place.locality === "Funchal").length);
    expect(funchal!.country).toBe("PT");
  });

  it("are the median of their places' coordinates", () => {
    const inFunchal = places.filter((place) => place.locality === "Funchal");
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    };
    const funchal = fixtureIndexes.cities.find((city) => city.name === "Funchal")!;
    expect(funchal.lat).toBeCloseTo(median(inFunchal.map((place) => place.lat)), 9);
    expect(funchal.lon).toBeCloseTo(median(inFunchal.map((place) => place.lon)), 9);
  });

  it("take the middle of an odd count, and the mean of the two middle values of an even one", () => {
    const at = (lat: number, lon: number) => make("p", { locality: "Odd", country: "PT", lat, lon });
    const odd = buildIndexes([at(10, 20), at(10.1, 20.06), at(10.02, 20.03)]).cities;
    expect(odd).toHaveLength(1);
    expect(odd[0]!.count).toBe(3);
    expect(odd[0]!.lat).toBeCloseTo(10.02, 9);
    expect(odd[0]!.lon).toBeCloseTo(20.03, 9);

    const evenAt = (lat: number, lon: number) => make("p", { locality: "Even", country: "PT", lat, lon });
    const even = buildIndexes([evenAt(10, 20), evenAt(10.1, 20.06), evenAt(10.02, 20.1), evenAt(10.04, 20.03)]).cities;
    expect(even).toHaveLength(1);
    expect(even[0]!.count).toBe(4);
    expect(even[0]!.lat).toBeCloseTo(10.03, 9);
    expect(even[0]!.lon).toBeCloseTo(20.045, 9);
  });

  it("need three places", () => {
    expect(fixtureIndexes.cities.map((city) => city.name)).toEqual(["Funchal"]);
    const two = buildIndexes([make("a", { locality: "Two" }), make("b", { locality: "Two" })]);
    expect(two.cities).toEqual([]);
  });

  it("leave out the places with no locality", () => {
    const idx = buildIndexes([make("a"), make("b"), make("c"), make("d", { locality: "  " })]);
    expect(idx.cities).toEqual([]);
  });

  it("count a locality once, whatever its case and spacing, and are called by its commonest spelling", () => {
    const idx = buildIndexes([
      make("a", { locality: "FUNCHAL", country: "PT" }),
      make("b", { locality: "Funchal", country: "PT" }),
      make("c", { locality: " funchal ", country: "PT" }),
      make("d", { locality: "Funchal ", country: "PT" }),
    ]);
    expect(idx.cities.map((city) => [city.name, city.count])).toEqual([["Funchal", 4]]);
  });

  it("are called by the first spelling seen when spellings tie", () => {
    const idx = buildIndexes([
      make("a", { locality: "FUNCHAL", country: "PT" }),
      make("b", { locality: "Funchal", country: "PT" }),
      make("c", { locality: "FUNCHAL", country: "PT" }),
      make("d", { locality: "Funchal", country: "PT" }),
    ]);
    expect(idx.cities.map((city) => city.name)).toEqual(["FUNCHAL"]);
  });

  it("keep a locality in two countries as two cities", () => {
    const idx = buildIndexes([
      ...[1, 2, 3].map((n) => make(`es ${n}`, { locality: "Valencia", country: "ES" })),
      ...[1, 2, 3, 4].map((n) => make(`ve ${n}`, { locality: "Valencia", country: "VE" })),
    ]);
    expect(idx.cities.map((city) => [city.name, city.country, city.count])).toEqual([
      ["Valencia", "VE", 4],
      ["Valencia", "ES", 3],
    ]);
  });

  it("keep a locality that has no country", () => {
    const idx = buildIndexes([1, 2, 3].map((n) => make(`x ${n}`, { locality: "Nowhere" })));
    expect(idx.cities).toEqual([{ name: "Nowhere", country: "", lat: CENTER.lat, lon: CENTER.lon, count: 3 }]);
  });

  it("are sorted by count, largest first, then by name", () => {
    const three = (locality: string) => [1, 2, 3].map((n) => make(`${locality} ${n}`, { locality, country: "PT" }));
    const idx = buildIndexes([
      ...three("Zeta"),
      ...three("Alfa"),
      ...[1, 2, 3, 4, 5].map((n) => make(`m ${n}`, { locality: "Mid", country: "PT" })),
      ...three("Beta"),
    ]);
    expect(idx.cities.map((city) => [city.name, city.count])).toEqual([
      ["Mid", 5],
      ["Alfa", 3],
      ["Beta", 3],
      ["Zeta", 3],
    ]);
  });

  it("are sorted by name in English order, not by character code", () => {
    const three = (locality: string) => [1, 2, 3].map((n) => make(`${locality} ${n}`, { locality, country: "PT" }));
    const idx = buildIndexes([...three("Zeta"), ...three("Nube"), ...three("Ñandú"), ...three("Alfa")]);
    expect(idx.cities.map((city) => city.name)).toEqual(["Alfa", "Ñandú", "Nube", "Zeta"]);
  });

  describe("with a region", () => {
    /** `count` places of a locality about a kilometre apart, in a line north from a point. */
    const group = (locality: string, lat: number, lon: number, count: number, over: Partial<Place> = {}) =>
      Array.from({ length: count }, (_, i) => make(`${locality} ${made}`, { locality, country: "US", lat: lat + i * 0.01, lon, ...over }));

    it("keep the same name in two regions as two cities", () => {
      const idx = buildIndexes([
        ...group("Lexington", 38.04, -84.5, 3, { region: "KY" }),
        ...group("Lexington", 42.44, -71.22, 4, { region: "MA" }),
      ]);
      expect(idx.cities.map((city) => [city.name, city.region, city.count])).toEqual([
        ["Lexington", "MA", 4],
        ["Lexington", "KY", 3],
      ]);
    });

    it("read a region in any case, with spaces round it, and are called by its commonest spelling", () => {
      const idx = buildIndexes([
        ...group("Lexington", 38.04, -84.5, 1, { region: "ky" }),
        ...group("Lexington", 38.05, -84.5, 2, { region: " KY " }),
        ...group("Lexington", 38.06, -84.5, 1, { region: "Ky" }),
      ]);
      expect(idx.cities.map((city) => [city.region, city.count])).toEqual([["KY", 4]]);
    });

    it("keep places with a region apart from those without one", () => {
      const idx = buildIndexes([
        ...group("Lexington", 38.04, -84.5, 3, { region: "KY" }),
        ...group("Lexington", 38.04, -84.5, 3),
      ]);
      expect(idx.cities.map((city) => city.region).sort()).toEqual(["KY", undefined]);
    });

    it("have no region when their places have none", () => {
      const idx = buildIndexes(group("Lexington", 38.04, -84.5, 3));
      expect(idx.cities).toHaveLength(1);
      expect("region" in idx.cities[0]!).toBe(false);
    });
  });

  describe("of a name that many towns have", () => {
    const group = (locality: string, lat: number, lon: number, count: number, over: Partial<Place> = {}) =>
      Array.from({ length: count }, (_, i) => make(`${locality} ${made}`, { locality, country: "US", lat: lat + i * 0.01, lon, ...over }));
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    };

    it("are not centred between two groups of the name 500 km apart", () => {
      const a = group("Springfield", 38, -84.5, 4);
      const farAway = offset(38, -84.5, 500);
      const b = group("Springfield", farAway.lat, farAway.lon, 3);
      const idx = buildIndexes([...a, ...b]);
      // One city, where most of the places are, and not midway between the two groups.
      expect(idx.cities).toHaveLength(1);
      const [city] = idx.cities;
      expect(city!.count).toBe(4);
      expect(haversineKm(city!.lat, city!.lon, median(a.map((p) => p.lat)), median(a.map((p) => p.lon)))).toBeLessThan(1);
      expect(haversineKm(city!.lat, city!.lon, b[0]!.lat, b[0]!.lon)).toBeGreaterThan(450);
    });

    it("go to the group that comes first when two groups are as big as each other", () => {
      const a = group("Springfield", 38, -84.5, 3);
      const farAway = offset(38, -84.5, 500);
      const b = group("Springfield", farAway.lat, farAway.lon, 3);
      const first = buildIndexes([...a, ...b]).cities;
      const second = buildIndexes([...b, ...a]).cities;
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(haversineKm(first[0]!.lat, first[0]!.lon, a[0]!.lat, a[0]!.lon)).toBeLessThan(5);
      expect(haversineKm(second[0]!.lat, second[0]!.lon, b[0]!.lat, b[0]!.lon)).toBeLessThan(5);
    });

    it("count only the places near the busiest one, and take the median of those", () => {
      const near = group("Springfield", 38, -84.5, 5);
      const far = [
        make("far 1", { locality: "Springfield", country: "US", ...offset(38, -84.5, 300) }),
        make("far 2", { locality: "Springfield", country: "US", ...offset(38, -84.5, -300) }),
      ];
      const [city] = buildIndexes([far[0]!, ...near, far[1]!]).cities;
      expect(city!.count).toBe(5);
      expect(city!.lat).toBeCloseTo(median(near.map((p) => p.lat)), 9);
      expect(city!.lon).toBeCloseTo(median(near.map((p) => p.lon)), 9);
    });

    it("count the places within 25 km of the busiest one, and no farther", () => {
      const inside = group("Springfield", 38, -84.5, 4);
      const edge = (km: number) => make("edge", { locality: "Springfield", country: "US", ...offset(inside[0]!.lat, inside[0]!.lon, 0, km) });
      expect(buildIndexes([...inside, edge(24)]).cities[0]!.count).toBe(5);
      expect(buildIndexes([...inside, edge(26)]).cities[0]!.count).toBe(4);
    });

    it("are left out when no three of their places are within 25 km of one", () => {
      const spread = [0, 100, 200, 300].map((km) => make("s", { locality: "Springfield", country: "US", ...offset(38, -84.5, km) }));
      expect(buildIndexes(spread).cities).toEqual([]);
    });

    it("keep the Lexingtons of Kentucky, Massachusetts and Virginia apart, each centred on its own places", () => {
      const kentucky = group("Lexington", 38.04, -84.5, 5, { region: "KY" });
      const massachusetts = group("Lexington", 42.44, -71.22, 4, { region: "MA" });
      const virginia = group("Lexington", 37.78, -79.44, 3, { region: "VA" });
      const all = [...kentucky, ...massachusetts, ...virginia];

      // Taken as one town, the twelve have a median that is not within 25 km of any of them.
      // That is the case this test is for.
      const midLat = median(all.map((p) => p.lat));
      const midLon = median(all.map((p) => p.lon));
      expect(Math.min(...all.map((p) => haversineKm(midLat, midLon, p.lat, p.lon)))).toBeGreaterThan(25);

      // One more in Kentucky, 400 km off, and four with no region, far from each other: none of them counts.
      const stray = make("Paducah", { locality: "Lexington", region: "KY", country: "US", lat: 37.08, lon: -88.6 });
      const unplaced = [[32.3, -96.9], [40.2, -83.9], [38.9, -93.7], [35.5, -100.1]].map(([lat, lon]) =>
        make("Lexington", { locality: "Lexington", country: "US", lat: lat!, lon: lon! }),
      );
      const { cities } = buildIndexes([...kentucky, stray, ...massachusetts, ...virginia, ...unplaced]);

      expect(cities.map((city) => [city.name, city.region, city.count])).toEqual([
        ["Lexington", "KY", 5],
        ["Lexington", "MA", 4],
        ["Lexington", "VA", 3],
      ]);
      for (const [city, own] of [[cities[0]!, kentucky], [cities[1]!, massachusetts], [cities[2]!, virginia]] as const) {
        expect(city.lat).toBeCloseTo(median(own.map((p) => p.lat)), 9);
        expect(city.lon).toBeCloseTo(median(own.map((p) => p.lon)), 9);
        expect(Math.min(...own.map((p) => haversineKm(city.lat, city.lon, p.lat, p.lon)))).toBeLessThan(5);
      }
    });
  });
});

describe("cityLabel", () => {
  const city = (name: string, over: Partial<{ region: string; country: string }> = {}) => ({
    name,
    country: "US",
    lat: 0,
    lon: 0,
    count: 3,
    ...over,
  });

  it("is the name alone when no other city has it", () => {
    const all = [city("Lexington", { region: "KY" }), city("Boston", { region: "MA" })];
    expect(cityLabel(all[0]!, all)).toBe("Lexington");
    expect(cityLabel(all[1]!, all)).toBe("Boston");
    expect(cityLabel(all[0]!, [])).toBe("Lexington");
  });

  it("adds the region when another city has the same name", () => {
    const ky = city("Lexington", { region: "KY" });
    const ma = city("Lexington", { region: "MA" });
    const all = [ky, city("Boston", { region: "MA" }), ma];
    expect(cityLabel(ky, all)).toBe("Lexington, KY");
    expect(cityLabel(ma, all)).toBe("Lexington, MA");
    expect(cityLabel(all[1]!, all)).toBe("Boston");
  });

  it("compares names without regard to case or spaces", () => {
    const ky = city("Lexington", { region: "KY" });
    const ma = city(" lexington ", { region: "MA" });
    expect(cityLabel(ky, [ky, ma])).toBe("Lexington, KY");
  });

  it("does not take a copy of the city itself for another city", () => {
    const ky = city("Lexington", { region: "KY" });
    expect(cityLabel({ ...ky }, [ky])).toBe("Lexington");
  });

  it("names the country when the city has no region", () => {
    const es = city("Valencia", { country: "ES" });
    const ve = city("Valencia", { country: "VE" });
    expect(cityLabel(es, [es, ve])).toBe("Valencia, ES");
    expect(cityLabel(ve, [es, ve])).toBe("Valencia, VE");
  });

  it("is the name alone when it has neither region nor country to add", () => {
    const a = city("Valencia", { country: "" });
    const b = city("Valencia", { region: "X" });
    expect(cityLabel(a, [a, b])).toBe("Valencia");
  });

  it("labels the cities that are built from places", () => {
    const at = (lat: number, region: string) => [0, 1, 2].map((i) => make("p", { locality: "Lexington", country: "US", region, lat: lat + i * 0.01, lon: -80 }));
    const { cities } = buildIndexes([...at(38, "KY"), ...at(42, "MA"), ...[0, 1, 2].map((i) => make("p", { locality: "Funchal", country: "PT", lat: 32.65 + i * 0.01, lon: -16.9 }))]);
    expect(cities.map((c) => cityLabel(c, cities)).sort()).toEqual(["Funchal", "Lexington, KY", "Lexington, MA"]);
  });
});

describe("byD", () => {
  it("finds a place by its d", () => {
    expect(fixtureIndexes.byD.get("crafted-minimal")).toBe(places.find((place) => place.d === "crafted-minimal"));
    expect(fixtureIndexes.byD.get("osm-node-11330857543")?.name).toBe("Jacafé");
    expect(fixtureIndexes.byD.get("nothing-here")).toBeUndefined();
    expect(fixtureIndexes.byD.size).toBe(43);
  });
});

describe("formatDistance", () => {
  it.each<[number, string, string]>([
    [0.97, "en-US", "0.6 mi"],
    [1.1, "pt-PT", "1.1 km"],
    [0.25, "pt-PT", "250 m"],
  ])("shows %s km in %s as %s", (km, locale, shown) => {
    expect(formatDistance(km, locale)).toBe(shown);
  });

  describe("in miles", () => {
    it.each<[string, number, string]>([
      ["en-US", 1.609344, "1.0 mi"],
      ["en-LR", 1.609344, "1.0 mi"],
      ["my-MM", 1.609344, "1.0 mi"],
      ["es-US", 1.609344, "1.0 mi"],
      ["EN-us", 1.609344, "1.0 mi"],
      ["en-Latn-US", 1.609344, "1.0 mi"],
      // No region: the language's usual one, which for English is the US and for Burmese Myanmar.
      ["en", 1.609344, "1.0 mi"],
      ["my", 1.609344, "1.0 mi"],
    ])("for %s", (locale, km, shown) => {
      expect(formatDistance(km, locale)).toBe(shown);
    });

    it("is the same on every call for a locale", () => {
      for (let i = 0; i < 3; i += 1) {
        expect(formatDistance(1.609344, "en")).toBe("1.0 mi");
        expect(formatDistance(1.609344, "pt")).toBe("1.6 km");
      }
    });

    it.each<[number, string]>([
      [0, "0.1 mi"],
      [0.01, "0.1 mi"],
      [0.12, "0.1 mi"],
      [0.5, "0.3 mi"],
      [15.7, "9.8 mi"],
      [16.0, "9.9 mi"],
      // Rounds up to ten miles, so it reads as ten and not as "10.0".
      [16.05, "10 mi"],
      [16.1, "10 mi"],
      [19.3, "12 mi"],
      [20, "12 mi"],
      [200, "124 mi"],
    ])("rounds %s km to %s", (km, shown) => {
      expect(formatDistance(km, "en-US")).toBe(shown);
    });
  });

  describe("in kilometres", () => {
    it.each<string>(["pt-PT", "en-GB", "de-DE", "fr-CA", "ja-JP", "pt", "de", "en-AU", "", "not a locale", "en_US"])(
      "for %j",
      (locale) => {
        expect(formatDistance(2.3, locale)).toBe("2.3 km");
      },
    );

    it.each<[number, string]>([
      [0, "50 m"],
      [0.01, "50 m"],
      [0.074, "50 m"],
      [0.076, "100 m"],
      [0.25, "250 m"],
      [0.97, "950 m"],
      // Rounds up to a kilometre, so it reads as one and not as "1000 m".
      [0.99, "1.0 km"],
      [1, "1.0 km"],
      [1.1, "1.1 km"],
      [9.94, "9.9 km"],
      // Rounds up to ten kilometres, so it reads as ten and not as "10.0".
      [9.96, "10 km"],
      [10, "10 km"],
      [12.4, "12 km"],
      [12.6, "13 km"],
      [250, "250 km"],
    ])("rounds %s km to %s", (km, shown) => {
      expect(formatDistance(km, "pt-PT")).toBe(shown);
    });
  });
});

describe("formatDistance of a distance that is not a number", () => {
  it.each<number>([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("is empty for %s", (km) => {
    expect(formatDistance(km, "en-US")).toBe("");
    expect(formatDistance(km, "pt-PT")).toBe("");
  });
});

describe("buildIndexes at the size of the whole list", () => {
  /** A deterministic stream in [0, 1), so the places are the same on every run. */
  function stream(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The fixtures repeated with moved coordinates, unique `d` values, and mostly unique names. */
  function synthetic(count: number): Place[] {
    const random = stream(7);
    return Array.from({ length: count }, (_, i) => {
      const from = places[i % places.length]!;
      const d = `${from.d}-synthetic-${i}`;
      return {
        ...from,
        d,
        address: `${PLACE_KIND}:${from.pubkey}:${d}`,
        name: i % 4 === 0 ? from.name : `${from.name} ${i}`,
        lat: from.lat + (random() - 0.5) * 0.4,
        lon: from.lon + (random() - 0.5) * 0.4,
      };
    });
  }

  it("takes under a second for 8,000 places, and the indexes work", () => {
    const many = synthetic(8000);
    const started = performance.now();
    const idx = buildIndexes(many);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(idx.byD.size).toBe(8000);
    expect(idx.near(CENTER.lat, CENTER.lon, 25).length).toBeGreaterThan(1000);
    expect(search(idx, "pizza", 25).length).toBeGreaterThan(10);
    expect(idx.cities[0]!.name).toBe("Funchal");
    expect(idx.chains.size).toBeGreaterThan(0);
  });
});
