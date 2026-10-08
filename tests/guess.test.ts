import { afterEach, describe, expect, it, vi } from "vitest";

import { deviceTimeZone, guessTown, languageCountry, startGuesser, townZone } from "../src/location/guess";
import type { City } from "../src/places/indexes";

// tz-lookup as it is, counted: a town's zone is worked out once, however often the towns are asked about.
const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock("@photostructure/tz-lookup", async (importOriginal) => {
  const actual = (await importOriginal<{ default: (lat: number, lon: number) => string }>()).default;
  return {
    default: (lat: number, lon: number) => {
      lookups.count += 1;
      return actual(lat, lon);
    },
  };
});

const town = (name: string, country: string, lat: number, lon: number, count: number, region?: string): City =>
  region === undefined ? { name, country, lat, lon, count } : { name, region, country, lat, lon, count };

// The towns as the indexes list them: those with the most places first.
const lisbon = town("Lisbon", "PT", 38.7223, -9.1393, 120);
const miami = town("Miami", "US", 25.7617, -80.1918, 90);
const porto = town("Porto", "PT", 41.1579, -8.6291, 80);
const newYork = town("New York", "US", 40.7128, -74.006, 60);
const chiangMai = town("Chiang Mai", "TH", 18.7883, 98.9853, 45);
const funchal = town("Funchal", "PT", 32.6507, -16.9084, 37);
const bangkok = town("Bangkok", "TH", 13.7563, 100.5018, 30);
const kolkata = town("Kolkata", "IN", 22.5726, 88.3639, 12);
const towns = [lisbon, miami, porto, newYork, chiangMai, funchal, bangkok, kolkata];

/** The device's time zone, as `Intl` says it; everything else `Intl` says is as it is. */
function zoneIs(zone: string | undefined) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone: zone as string };
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

describe("townZone", () => {
  it("is the time zone of the town's coordinates", () => {
    expect(townZone(lisbon)).toBe("Europe/Lisbon");
    expect(townZone(funchal)).toBe("Atlantic/Madeira");
    expect(townZone(newYork)).toBe("America/New_York");
    expect(townZone(chiangMai)).toBe("Asia/Bangkok");
  });

  it("is worked out once for each town", () => {
    const athens = town("Athens", "GR", 37.9838, 23.7275, 5);
    const before = lookups.count;
    expect(townZone(athens)).toBe("Europe/Athens");
    expect(townZone(athens)).toBe("Europe/Athens");
    expect(townZone({ lat: athens.lat, lon: athens.lon })).toBe("Europe/Athens");
    expect(lookups.count - before).toBe(1);
  });

  it("is undefined for coordinates that are not a place on Earth", () => {
    expect(townZone(town("Nowhere", "", 95, 0, 3))).toBeUndefined();
  });
});

describe("guessTown", () => {
  it("is the town with the most places in the device's time zone", () => {
    expect(guessTown(towns, "Europe/Lisbon", undefined)).toBe(lisbon);
    expect(guessTown(towns, "America/New_York", undefined)).toBe(miami);
    expect(guessTown(towns, "Asia/Bangkok", undefined)).toBe(chiangMai);
  });

  it("goes by the zone, not the country: Madeira's zone is Funchal, though Lisbon has more places", () => {
    expect(guessTown(towns, "Atlantic/Madeira", "PT")).toBe(funchal);
  });

  it("is the town with the most places in the language's country when no town is in the zone", () => {
    expect(guessTown(towns, "Asia/Tokyo", "PT")).toBe(lisbon);
    expect(guessTown(towns, "Asia/Tokyo", "TH")).toBe(chiangMai);
    expect(guessTown(towns, undefined, "US")).toBe(miami);
  });

  it("is undefined when no town is in the zone or the country", () => {
    expect(guessTown(towns, "Asia/Tokyo", "JP")).toBeUndefined();
    expect(guessTown(towns, "Asia/Tokyo", undefined)).toBeUndefined();
    expect(guessTown(towns, undefined, undefined)).toBeUndefined();
    expect(guessTown([], "Europe/Lisbon", "PT")).toBeUndefined();
  });

  it("stops at the first town in the zone, so a common zone looks up few towns", () => {
    const fresh = towns.map((each) => ({ ...each, lat: each.lat + 1e-7 }));
    const before = lookups.count;
    expect(guessTown(fresh, "Europe/Lisbon", undefined)?.name).toBe("Lisbon");
    expect(lookups.count - before).toBe(1);
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
  ])("reads the old name %s as %s, the name the towns' zones have", (old, current) => {
    zoneIs(old);
    expect(deviceTimeZone()).toBe(current);
  });

  it("finds a town in India from a browser that names the zone Asia/Calcutta", () => {
    zoneIs("Asia/Calcutta");
    expect(guessTown(towns, deviceTimeZone(), undefined)).toBe(kolkata);
  });

  it("is undefined when the browser does not say", () => {
    zoneIs(undefined);
    expect(deviceTimeZone()).toBeUndefined();
    zoneIs("");
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
  it("guesses from the device's zone, then the language's country", () => {
    zoneIs("Asia/Bangkok");
    languageIs("pt-PT");
    expect(startGuesser()(towns)).toBe(chiangMai);

    zoneIs("Asia/Tokyo");
    expect(startGuesser()(towns)).toBe(lisbon);

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

    // A new town elsewhere: the guess is Lisbon still, where it was, so the screen does not move.
    const grown = [...towns, town("Faro", "PT", 37.0194, -7.9322, 4)];
    expect(guess(grown)).toBe(lisbon);

    // A town in the zone with more places than Lisbon: that one now.
    const sintra = town("Sintra", "PT", 38.8029, -9.3817, 500);
    expect(guess([sintra, ...towns])).toBe(sintra);
  });

  it("guesses again when the device's zone changes", () => {
    zoneIs("Europe/Lisbon");
    const guess = startGuesser();
    expect(guess(towns)).toBe(lisbon);
    zoneIs("America/New_York");
    expect(guess(towns)).toBe(miami);
  });
});
