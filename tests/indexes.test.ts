import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import { parsePlaces } from "../src/places/load";
import { PLACE_KIND, type Place } from "../src/places/place";
import {
  buildIndexes,
  type Chain,
  chainKey,
  chainSlug,
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

const namesOf = (rows: { place: Place }[]) => rows.map((row) => row.place.name);
const search = (idx: Indexes, q: string, radiusKm?: number) =>
  idx.search(q, { ...CENTER, ...(radiusKm === undefined ? {} : { radiusKm }) });

const fixtureIndexes = buildIndexes(places);

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
    expect(namesOf(search(idx, "cafe"))).toEqual([]);

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

  describe("order", () => {
    it("puts the nearer place first when two match equally well", () => {
      const idx = buildIndexes([
        make("Casa Verde", north(3)),
        make("Casa Verde", north(1)),
        make("Casa Verde", north(2)),
      ]);
      const km = search(idx, "verde").map((row) => Math.round(row.km));
      expect(km).toEqual([1, 2, 3]);
    });

    it("puts the better match first, however far it is", () => {
      const idx = buildIndexes([
        make("Zed", { ...north(0.5), keywords: ["verde"] }),
        make("Tasca Verde", north(9)),
      ]);
      expect(namesOf(search(idx, "verde"))).toEqual(["Tasca Verde", "Zed"]);
    });

    it("puts the nearer place first among matches within about 10% of the best", () => {
      // Scores for "verde" are 1.59, 1.52 and 1.47 (ratios 1, 0.96 and 0.92): the first two
      // are close enough to be ordered by distance, the third is not.
      const idx = buildIndexes([
        make("Verde do Mar Azul Bar Grill", north(4)),
        make("Verde do Mar Azul Bar Grill Cafe", north(1)),
        make("Verde do Mar Azul Bar Grill Cafe Bistro", north(0.5)),
        make("Other Place", north(0.1)),
      ]);
      expect(namesOf(search(idx, "verde"))).toEqual([
        "Verde do Mar Azul Bar Grill Cafe",
        "Verde do Mar Azul Bar Grill",
        "Verde do Mar Azul Bar Grill Cafe Bistro",
      ]);
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
      // Scores for "verde" are 1.59, 1.52 and 1.47. The 40 km one is dropped, and the 1.52 is then
      // the best. The 1.47 is within 10% of it, so the nearer of the two goes first. Judged
      // against the dropped 1.59 it would be in a band below, and the order would be the other way.
      const pool = buildIndexes([
        make("Verde do Mar Azul Bar Grill", north(40)),
        make("Verde do Mar Azul Bar Grill Cafe", north(3)),
        make("Verde do Mar Azul Bar Grill Cafe Bistro", north(1)),
        make("Other Place", north(0.1)),
      ]);
      expect(namesOf(search(pool, "verde", 25))).toEqual([
        "Verde do Mar Azul Bar Grill Cafe Bistro",
        "Verde do Mar Azul Bar Grill Cafe",
      ]);
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

  it("finds nothing for a query with no words in it, and for no places", () => {
    expect(search(fixtureIndexes, "!!! ...")).toEqual([]);
    expect(search(buildIndexes([]), "pizza")).toEqual([]);
  });
});

describe("chains", () => {
  it("are the names that two or more places share", () => {
    expect([...fixtureIndexes.chains.keys()].sort()).toEqual([
      "a confeitaria coffee & bakery",
      "loft brunch & cocktails",
    ]);
    const confeitaria = fixtureIndexes.chains.get(chainKey("A Confeitaria Coffee & Bakery"))!;
    expect(confeitaria.key).toBe("a confeitaria coffee & bakery");
    expect(confeitaria.name).toBe("A Confeitaria Coffee & Bakery");
    expect(confeitaria.places).toHaveLength(4);
    expect(fixtureIndexes.chains.get(chainKey("Loft Brunch & Cocktails"))!.places).toHaveLength(2);
  });

  it("keep each location its own place", () => {
    const confeitaria = fixtureIndexes.chains.get(chainKey("A Confeitaria Coffee & Bakery"))!;
    expect(new Set(confeitaria.places.map((place) => place.address)).size).toBe(4);
    expect(fixtureIndexes.byD.size).toBe(43);
    // The places are the ones in the list, in the list's order.
    const inList = places.filter((place) => place.name === "A Confeitaria Coffee & Bakery");
    expect(confeitaria.places).toEqual(inList);
    expect(confeitaria.places[0]).toBe(inList[0]);
  });

  it("do not include a name that one place has", () => {
    expect(fixtureIndexes.chains.has(chainKey("Jacafé"))).toBe(false);
    expect(fixtureIndexes.chains.has(chainKey("A Confeitaria"))).toBe(false);
  });

  it("group names that differ only as chainKey ignores", () => {
    const idx = buildIndexes([
      make("Steak 'n Shake", north(1)),
      make("STEAK ’N SHAKE ", north(2)),
      make("steak `n shake.", north(3)),
    ]);
    expect(idx.chains.size).toBe(1);
    expect(idx.chains.get(chainKey("Steak 'n Shake"))!.places).toHaveLength(3);
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

  describe("chainOf", () => {
    it("is undefined for a name that is not shared", () => {
      expect(fixtureIndexes.chainOf(places.find((place) => place.name === "Jacafé")!)).toBeUndefined();
    });

    it("is the chain for any of its places", () => {
      const loft = places.filter((place) => place.name === "Loft Brunch & Cocktails");
      expect(loft).toHaveLength(2);
      for (const place of loft) expect(fixtureIndexes.chainOf(place)).toBe(fixtureIndexes.chains.get("loft brunch & cocktails"));
    });
  });

  describe("slugs", () => {
    it("are URL-safe", () => {
      const key = chainKey("A Confeitaria Coffee & Bakery");
      expect(chainSlug(key)).toBe(encodeURIComponent(key));
      expect(chainSlug(key)).not.toMatch(/[ &/?#]/);
    });

    it("find the chain they were made from", () => {
      for (const chain of fixtureIndexes.chains.values()) {
        expect(fixtureIndexes.chainBySlug(chainSlug(chain.key))).toBe(chain);
      }
    });

    it("also find it from the text a router has already decoded", () => {
      const key = chainKey("A Confeitaria Coffee & Bakery");
      expect(fixtureIndexes.chainBySlug(key)).toBe(fixtureIndexes.chains.get(key));
    });

    it("work for a name with a slash, a percent sign and non-Latin letters", () => {
      const idx = buildIndexes([
        make("100% Pão/Café"), make("100% pão/café"),
        make("ペーパー・クレーン"), make("ペーパー・クレーン"),
      ]);
      expect(idx.chains.size).toBe(2);
      for (const chain of idx.chains.values()) {
        expect(chainSlug(chain.key)).toMatch(/^[A-Za-z0-9\-_.!~*'()%]+$/);
        expect(idx.chainBySlug(chainSlug(chain.key))).toBe(chain);
        expect(idx.chainBySlug(chain.key)).toBe(chain);
      }
    });

    it("find nothing for a name that is not a chain, or a slug that cannot be read", () => {
      expect(fixtureIndexes.chainBySlug(chainSlug(chainKey("Jacafé")))).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("")).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("%E0%A4%A")).toBeUndefined();
      expect(fixtureIndexes.chainBySlug("constructor")).toBeUndefined();
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
      { chain: fixtureIndexes.chains.get("loft brunch & cocktails"), nearby: [rows[1], rows[3]] },
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
    const odd = buildIndexes([
      make("a", { locality: "Odd", country: "PT", lat: 1, lon: 10 }),
      make("b", { locality: "Odd", country: "PT", lat: 80, lon: 30 }),
      make("c", { locality: "Odd", country: "PT", lat: 3, lon: 20 }),
    ]);
    expect(odd.cities).toEqual([{ name: "Odd", country: "PT", lat: 3, lon: 20, count: 3 }]);

    const even = buildIndexes([
      make("a", { locality: "Even", country: "PT", lat: 1, lon: 10 }),
      make("b", { locality: "Even", country: "PT", lat: 80, lon: 30 }),
      make("c", { locality: "Even", country: "PT", lat: 3, lon: 20 }),
      make("d", { locality: "Even", country: "PT", lat: 5, lon: 40 }),
    ]);
    expect(even.cities).toEqual([{ name: "Even", country: "PT", lat: 4, lon: 25, count: 4 }]);
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
    ])("for %s", (locale, km, shown) => {
      expect(formatDistance(km, locale)).toBe(shown);
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
    it.each<string>(["pt-PT", "en-GB", "de-DE", "fr-CA", "ja-JP", "en", "my", "pt", "", "not a locale", "en_US"])(
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
