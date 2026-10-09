import { afterEach, describe, expect, it, vi } from "vitest";

import { deviceTimeZone, guessTown, languageCountry, startGuesser, unpackZones, zonePoint } from "../src/location/guess";
import { TZDATA_VERSION, ZONE_POINTS } from "../src/location/zones";
import type { City } from "../src/places/indexes";
import { pack, pointsOf } from "../tools/zone-points";

const town = (name: string, country: string, lat: number, lon: number, count: number): City => ({ name, country, lat, lon, count });

// The towns as the indexes list them: those with the most places first.
const lisbon = town("Lisbon", "PT", 38.7223, -9.1393, 120);
const miami = town("Miami", "US", 25.7617, -80.1918, 90);
const porto = town("Porto", "PT", 41.1579, -8.6291, 80);
const newYork = town("New York", "US", 40.7128, -74.006, 60);
const chiangMai = town("Chiang Mai", "TH", 18.7883, 98.9853, 45);
const funchal = town("Funchal", "PT", 32.6507, -16.9084, 37);
const bangkok = town("Bangkok", "TH", 13.7563, 100.5018, 30);
const kolkata = town("Kolkata", "IN", 22.5726, 88.3639, 12);
const minato = town("Minato", "JP", 35.6581, 139.7516, 3);
const towns = [lisbon, miami, porto, newYork, chiangMai, funchal, bangkok, kolkata];

// The real `resolvedOptions`, taken once, before any test stands in for it: a test that sets the
// zone twice wraps this, not its own stand-in, which would call itself until the stack ran out.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

/** The device's time zone, as `Intl` says it; everything else `Intl` says is as it is. */
function zoneIs(zone: string | undefined) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...realResolvedOptions.call(this), timeZone: zone as string };
  });
}

/** The browser's language, as `navigator.language` says it. */
function languageIs(tag: string) {
  Object.defineProperty(navigator, "language", { configurable: true, get: () => tag });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "language");
});

describe("the test's stand-in for the device's zone", () => {
  it("can be set again in the same test, and says what was set last", () => {
    zoneIs("Europe/Lisbon");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Europe/Lisbon");
    zoneIs("Asia/Tokyo");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Asia/Tokyo");
    // Only the zone: the rest is what the browser says.
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe(realResolvedOptions.call(Intl.DateTimeFormat()).locale);
  });
});

describe("zonePoint", () => {
  it.each<[string, number, number]>([
    ["Europe/Lisbon", 38.7, -9.1],
    ["America/New_York", 40.7, -74],
    ["Asia/Tokyo", 35.7, 139.7],
    ["Australia/Sydney", -33.9, 151.2],
    ["Atlantic/Madeira", 32.6, -16.9],
    // Zones that zone1970.tab folds into another are where they are: Amsterdam, not Brussels.
    ["Europe/Amsterdam", 52.4, 4.9],
    ["Atlantic/Reykjavik", 64.2, -21.8],
  ])("is where %s's principal place is, to a tenth of a degree", (zone, lat, lon) => {
    expect(zonePoint(zone)).toEqual({ lat, lon });
  });

  it.each([["Etc/UTC"], ["Etc/GMT+5"], ["UTC"], ["GMT"], ["Mars/Olympus"], ["Europe"], [""], [undefined]])(
    "is undefined for %s, which is no place",
    (zone) => {
      expect(zonePoint(zone)).toBeUndefined();
    },
  );
});

describe("guessTown", () => {
  it("is the town near the place the device's zone is named for, not the one with the most places anywhere", () => {
    expect(guessTown(towns, "America/New_York", undefined)).toBe(newYork);
    expect(guessTown(towns, "Asia/Bangkok", undefined)).toBe(bangkok);
    expect(guessTown(towns, "Atlantic/Madeira", "PT")).toBe(funchal);
    expect(guessTown(towns, "Europe/Lisbon", undefined)).toBe(lisbon);
  });

  describe("within 50 km of the zone's place", () => {
    // Towns round New York and Los Angeles as the places have them: the city, and smaller ones nearer the zone's point.
    const jerseyCity = town("Jersey City", "US", 40.7178, -74.0431, 3);
    const manhattan = town("New York", "US", 40.758, -73.9855, 5);
    const princeton = town("Princeton", "US", 40.3573, -74.6672, 100);
    const alhambra = town("Alhambra", "US", 34.0953, -118.127, 3);
    const pasadena = town("Pasadena", "US", 34.1478, -118.1445, 11);
    const glendale = town("Glendale", "US", 34.1425, -118.2551, 4);
    const losAngeles = town("Los Angeles", "US", 34.0522, -118.3, 81);
    const santaMonica = town("Santa Monica", "US", 34.0195, -118.4912, 6);

    it("is the town with the most places: New York, not Jersey City, which is nearer", () => {
      expect(guessTown([manhattan, jerseyCity], "America/New_York", undefined)).toBe(manhattan);
    });

    it("is Los Angeles, not Alhambra, Pasadena or Glendale, which are nearer", () => {
      const round = [pasadena, santaMonica, glendale, alhambra, losAngeles].sort((a, b) => b.count - a.count);
      expect(guessTown(round, "America/Los_Angeles", undefined)).toBe(losAngeles);
    });

    it("counts no town farther than 50 km, however many places it has", () => {
      // Princeton is 68 km from New York's point.
      expect(guessTown([princeton, manhattan, jerseyCity], "America/New_York", undefined)).toBe(manhattan);
    });

    it("takes the nearer of two towns with as many places", () => {
      const twin = town("Hoboken", "US", 40.744, -74.0324, 5);
      expect(guessTown([manhattan, twin], "America/New_York", undefined)).toBe(twin);
      expect(guessTown([twin, manhattan], "America/New_York", undefined)).toBe(twin);
    });

    it("falls back to the nearest town anywhere when there is none, not the one with the most places", () => {
      // Kolkata is 649 km from Kathmandu, Chiang Mai 1,711 km with more places.
      expect(guessTown(towns, "Asia/Kathmandu", undefined)).toBe(kolkata);
      // Princeton, 68 km from New York's point, when it is the only town near.
      expect(guessTown([lisbon, princeton], "America/New_York", undefined)).toBe(princeton);
    });
  });

  describe("towns close together", () => {
    // San Salvador, the capital, and two towns beside it, as the places have them.
    const sanSalvador: City = { ...town("San Salvador", "SV", 13.6894, -89.1872, 84), capital: true };
    const antiguo = town("Antiguo Cuscatlán", "SV", 13.6733, -89.2401, 88);
    const santaTecla = town("Santa Tecla", "SV", 13.6769, -89.2797, 30);

    it("takes the capital when its places are within a tenth of the most", () => {
      expect(guessTown([antiguo, sanSalvador, santaTecla], "America/El_Salvador", undefined)).toBe(sanSalvador);
      // Without the capital among them, the one with the most places.
      expect(guessTown([antiguo, santaTecla], "America/El_Salvador", undefined)).toBe(antiguo);
    });

    it("takes the town with the most places when the capital has more than a tenth fewer", () => {
      const smaller: City = { ...sanSalvador, count: 79 };
      expect(guessTown([antiguo, smaller, santaTecla], "America/El_Salvador", undefined)).toBe(antiguo);
      // 80 is within a tenth of 88.
      expect(guessTown([antiguo, { ...sanSalvador, count: 80 }, santaTecla], "America/El_Salvador", undefined)?.name).toBe("San Salvador");
    });

    it("takes the capital the same way in the language's country when the zone is no place", () => {
      expect(guessTown([antiguo, sanSalvador, santaTecla], "Etc/UTC", "SV")).toBe(sanSalvador);
      expect(guessTown([antiguo, { ...sanSalvador, count: 79 }, santaTecla], "Etc/UTC", "SV")).toBe(antiguo);
    });
  });

  it("goes as far as it takes: the zone need have no town of its own", () => {
    expect(guessTown(towns, "Asia/Kathmandu", undefined)).toBe(kolkata);
    expect(guessTown(towns, "Australia/Sydney", undefined)).toBe(bangkok);
    expect(guessTown(towns, "America/Chicago", undefined)).toBe(newYork);
  });

  it("goes by the zone, not the language, when the zone is a place", () => {
    expect(guessTown(towns, "Asia/Bangkok", "PT")).toBe(bangkok);
    expect(guessTown([...towns, minato], "Asia/Tokyo", "PT")).toBe(minato);
  });

  it("is the town with the most places in the language's country when the zone is no place", () => {
    expect(guessTown(towns, "Etc/UTC", "PT")).toBe(lisbon);
    expect(guessTown(towns, "Mars/Olympus", "TH")).toBe(chiangMai);
    expect(guessTown(towns, undefined, "US")).toBe(miami);
  });

  it("is undefined when the zone is no place and no town is in the language's country", () => {
    expect(guessTown(towns, "Etc/UTC", "JP")).toBeUndefined();
    expect(guessTown(towns, "UTC", undefined)).toBeUndefined();
    expect(guessTown(towns, undefined, undefined)).toBeUndefined();
  });

  it("is undefined when there are no towns", () => {
    expect(guessTown([], "Europe/Lisbon", "PT")).toBeUndefined();
  });
});

describe("deviceTimeZone", () => {
  it("is the zone the browser says the device is in", () => {
    zoneIs("America/Los_Angeles");
    expect(deviceTimeZone()).toBe("America/Los_Angeles");
  });

  it.each([
    ["Asia/Calcutta", "Asia/Kolkata"],
    ["Asia/Saigon", "Asia/Ho_Chi_Minh"],
    ["Europe/Kiev", "Europe/Kyiv"],
    ["America/Buenos_Aires", "America/Argentina/Buenos_Aires"],
    ["America/Indianapolis", "America/Indiana/Indianapolis"],
  ])("reads the old name %s as %s, the name the zones' points have", (old, current) => {
    zoneIs(old);
    expect(deviceTimeZone()).toBe(current);
    expect(zonePoint(deviceTimeZone())).toBeDefined();
  });

  it("finds Kolkata from a browser that names the zone Asia/Calcutta", () => {
    zoneIs("Asia/Calcutta");
    expect(guessTown(towns, deviceTimeZone(), undefined)).toBe(kolkata);
  });

  it("is undefined when the browser says no zone, or an empty one", () => {
    zoneIs("Europe/Lisbon");
    expect(deviceTimeZone()).toBe("Europe/Lisbon");
    zoneIs("");
    expect(deviceTimeZone()).toBeUndefined();
    zoneIs(undefined);
    expect(deviceTimeZone()).toBeUndefined();
  });

  it("is undefined when asking throws", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new RangeError("No.");
    });
    expect(deviceTimeZone()).toBeUndefined();
  });
});

describe("languageCountry", () => {
  it.each([
    ["pt-PT", "PT"],
    ["pt-BR", "BR"],
    ["en-US", "US"],
    ["th-TH", "TH"],
    ["zh-Hant-TW", "TW"],
    ["de-de", "DE"],
  ])("is the country of %s: %s", (tag, country) => {
    languageIs(tag);
    expect(languageCountry()).toBe(country);
  });

  it.each([
    ["a language with no country", "en"],
    ["a region that is not a country", "es-419"],
    ["no language", ""],
    ["a tag that is not one", "not a tag!"],
  ])("is undefined for %s", (_what, tag) => {
    languageIs(tag);
    expect(languageCountry()).toBeUndefined();
  });
});

describe("startGuesser", () => {
  it("guesses from the device's zone, and from the language's country only when the zone is no place", () => {
    languageIs("pt-PT");
    zoneIs("Asia/Bangkok");
    expect(startGuesser()([...towns, minato])).toBe(bangkok);

    zoneIs("Asia/Tokyo");
    expect(startGuesser()([...towns, minato])).toBe(minato);

    zoneIs("Etc/UTC");
    expect(startGuesser()([...towns, minato])).toBe(lisbon);

    languageIs("ja-JP");
    expect(startGuesser()(towns)).toBeUndefined();
  });

  it("gives the same town, as it was, when the places refresh with the same towns", () => {
    zoneIs("Europe/Lisbon");
    const guess = startGuesser();
    expect(guess(towns)).toBe(lisbon);

    // The same towns from the relay a moment later, each a new object, Lisbon's middle a little moved.
    const refreshed = towns.map((each) => ({ ...each, lat: each.lat + 0.0001 }));
    expect(guess(refreshed)).toBe(lisbon);
  });

  it("guesses again when the towns change, and keeps the town it had when the guess is the same", () => {
    zoneIs("Europe/Lisbon");
    const guess = startGuesser();
    expect(guess(towns)).toBe(lisbon);

    // A new town far away: the guess is Lisbon still, where it was, so the screen does not move.
    const grown = [...towns, town("Faro", "PT", 37.0194, -7.9322, 4)];
    expect(guess(grown)).toBe(lisbon);

    // A town nearer the zone's point, with fewer places: Lisbon still.
    const graca = town("Graça", "PT", 38.7163, -9.1305, 2);
    expect(guess([...towns, graca])).toBe(lisbon);

    // A town near the zone's point with more places than Lisbon: that one now.
    const sintra = town("Sintra", "PT", 38.8029, -9.3817, 500);
    expect(guess([sintra, ...towns])).toBe(sintra);
  });

  it("guesses again when the device's zone changes", () => {
    zoneIs("Europe/Lisbon");
    const guess = startGuesser();
    expect(guess(towns)).toBe(lisbon);
    zoneIs("America/New_York");
    // New York, which only the zone gives: the language's country (US) would give Miami.
    expect(guess(towns)).toBe(newYork);
  });
});

describe("the zones' points", () => {
  it("come from a named version of the time zone database", () => {
    expect(TZDATA_VERSION).toMatch(/^\d{4}[a-z]$/);
  });

  it("are a few hundred zones, in a few kilobytes", () => {
    const points = unpackZones(ZONE_POINTS);
    expect(points.size).toBeGreaterThan(400);
    expect(ZONE_POINTS.length).toBeLessThan(10_000);
  });

  it("are read from zone.tab and zone1970.tab lines, both ways of writing a point", () => {
    const text = [
      "# A comment",
      "PT\t+3843-00908\tEurope/Lisbon\tPortugal (mainland)",
      "US\t+404251-0740023\tAmerica/New_York\tEastern (most areas)",
      "BE,LU,NL\t+5050+00420\tEurope/Brussels",
      "AR\t-3436-05827\tAmerica/Argentina/Buenos_Aires\tBuenos Aires (BA, CF)",
      "",
    ].join("\n");
    const points = pointsOf(text);
    expect([...points.keys()]).toEqual(["Europe/Lisbon", "America/New_York", "Europe/Brussels", "America/Argentina/Buenos_Aires"]);
    expect(points.get("Europe/Lisbon")![0]).toBeCloseTo(38 + 43 / 60, 6);
    expect(points.get("America/New_York")![1]).toBeCloseTo(-(74 + 0 / 60 + 23 / 3600), 6);

    // Packed, then read back as the app reads it: to a tenth of a degree.
    const unpacked = unpackZones(pack(points));
    expect(unpacked.get("Europe/Lisbon")).toEqual([38.7, -9.1]);
    expect(unpacked.get("America/New_York")).toEqual([40.7, -74]);
    expect(unpacked.get("America/Argentina/Buenos_Aires")).toEqual([-34.6, -58.4]);
  });

  it("throw on a line that is not a zone", () => {
    expect(() => pointsOf("PT\tsomewhere\tEurope/Lisbon")).toThrow(/Cannot read/);
  });
});
