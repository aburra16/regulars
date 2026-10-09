import { afterEach, describe, expect, it, vi } from "vitest";

import { formatInteger, LOCALE_FALLBACK, safeLocale } from "../src/locale";
import { formatDistance, milesFor, readsMiles, usesMiles } from "../src/places/distance";
import { withinChoices } from "../src/search/filters";
import { zoneIs } from "./support/zone";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLocale", () => {
  it.each([
    ["en-US", "en-US"],
    ["EN-us", "en-US"],
    ["pt-PT", "pt-PT"],
    ["pt-PT-u-hc-h12", "pt-PT-u-hc-h12"],
    ["en", "en"],
    ["my", "my"],
  ])("gives %j as %j", (locale, safe) => {
    expect(safeLocale(locale)).toBe(safe);
  });

  it.each(["", "not a locale", "not a locale!", "en_US", "!!", " "])("gives %j the fallback", (locale) => {
    expect(safeLocale(locale)).toBe(LOCALE_FALLBACK);
  });

  it("falls back to a locale with no country and a 12-hour clock: metric, and the English way of telling the time", () => {
    expect(new Intl.Locale(LOCALE_FALLBACK).maximize().region).not.toBe("US");
    expect(usesMiles(LOCALE_FALLBACK)).toBe(false);
    expect(new Intl.DateTimeFormat(LOCALE_FALLBACK, { hour: "numeric" }).resolvedOptions().hourCycle).toBe("h12");
  });

  it("is a locale Intl accepts, whatever it was given", () => {
    for (const locale of ["", "x", "en_US", "not a locale", "pt-PT", "en-US-u-hc-h23"]) {
      expect(() => new Intl.NumberFormat(safeLocale(locale))).not.toThrow();
      expect(() => new Intl.DateTimeFormat(safeLocale(locale))).not.toThrow();
    }
  });
});

describe("formatInteger", () => {
  it.each([
    ["en-US", "3,494"],
    ["en-GB", "3,494"],
    ["de-DE", "3.494"],
    ["pt-BR", "3.494"],
    // Portuguese in Portugal groups four digits as well, with a no-break space.
    ["pt-PT", "3\u00a0494"],
    ["fr-FR", "3\u202f494"],
    // The app writes its numbers in Latin digits, whatever the language.
    ["my-MM", "3,494"],
    ["ar-EG", "3,494"],
    ["not a locale", "3,494"],
  ])("writes 3494 in %s as %j", (locale, shown) => {
    expect(formatInteger(3494, locale)).toBe(shown);
  });

  it("leaves a small number as it is, and groups a big one", () => {
    expect(formatInteger(7, "en-US")).toBe("7");
    expect(formatInteger(999, "pt-PT")).toBe("999");
    expect(formatInteger(7954, "en-US")).toBe("7,954");
    expect(formatInteger(1234567, "en-US")).toBe("1,234,567");
  });
});

describe("a distance as far as a person can go", () => {
  it.each<[number, string, string]>([
    [5623.1, "en-US", "3,494 mi"],
    [5636, "en-US", "3,502 mi"],
    [3494.4, "en-GB", "3,494 km"],
    [3494.4, "de-DE", "3.494 km"],
    [3494.4, "pt-PT", "3\u00a0494 km"],
    [3494.4, "my-MM", "2,171 mi"],
    [1000, "en-GB", "1,000 km"],
    [1000, "pt-PT", "1\u00a0000 km"],
    [999.4, "pt-PT", "999 km"],
    [12.4, "pt-PT", "12 km"],
    [3494.4, "not a locale", "3,494 km"],
  ])("shows %s km in %s as %j", (km, locale, shown) => {
    expect(formatDistance(km, locale)).toBe(shown);
  });

  it("writes its decimals the way the language does, as it groups the thousands, so neither reads as the other", () => {
    expect(formatDistance(1.5, "de-DE")).toBe("1,5 km");
    expect(formatDistance(3494.4, "de-DE")).toBe("3.494 km");
    expect(formatDistance(1.5 * 1.609344, "en-US")).toBe("1.5 mi");
    expect(formatDistance(5623.1, "en-US")).toBe("3,494 mi");
    expect(formatDistance(1.1, "pt-PT")).toBe("1,1 km");
    expect(formatDistance(0.97, "en-US")).toBe("0.6 mi");
  });

  it("writes the decimals in Latin digits, as every number the app writes, with the marks that go with them", () => {
    expect(formatDistance(1.5, "ar-EG")).toBe("1.5 km");
    expect(formatDistance(3494.4, "ar-EG")).toBe("3,494 km");
  });
});

describe("the unit, from where the device is (Avi, 2026-10-09)", () => {
  it.each<[string, string]>([
    // The United States, Alaska and Hawaii, and the territories, each its own country in zone.tab.
    ["America/New_York", "pt-BR"],
    ["America/Los_Angeles", "es-MX"],
    ["America/Anchorage", "en-GB"],
    ["Pacific/Honolulu", "ja-JP"],
    ["America/Puerto_Rico", "es-PR"],
    ["America/St_Thomas", "en-VI"],
    ["Pacific/Guam", "en-GU"],
    ["Pacific/Saipan", "en-MP"],
    ["Pacific/Pago_Pago", "en-AS"],
    ["Pacific/Midway", "en-UM"],
    // The United Kingdom, Liberia and Myanmar.
    ["Europe/London", "en-GB"],
    ["Africa/Monrovia", "en-LR"],
    ["Asia/Yangon", "my-MM"],
  ])("is miles on a device in %s, whatever its language (%s)", (zone, locale) => {
    expect(milesFor(zone, locale)).toBe(true);
  });

  it.each<[string, string]>([
    ["Europe/Prague", "en-US"],
    ["Europe/Lisbon", "en-US"],
    ["Atlantic/Madeira", "en"],
    ["America/Toronto", "en-US"],
    ["Asia/Tokyo", "en-US"],
    // Jersey, Guernsey and the Isle of Man are their own countries in zone.tab, not GB.
    ["Europe/Jersey", "en-GB"],
  ])("is kilometres on a device in %s, even in %s", (zone, locale) => {
    expect(milesFor(zone, locale)).toBe(false);
  });

  it.each<[string | undefined, string, boolean]>([
    ["Etc/UTC", "en-US", true],
    ["UTC", "en-US", true],
    ["Mars/Olympus", "my-MM", true],
    [undefined, "en", true],
    ["Etc/UTC", "pt-PT", false],
    [undefined, "en-GB", false],
  ])("is the language's on a device whose zone is no country's (%s, %s)", (zone, locale, miles) => {
    expect(milesFor(zone, locale)).toBe(miles);
    expect(usesMiles(locale)).toBe(miles);
  });

  it("follows the device's own zone: miles in New York, kilometres in Prague in American English, miles in London", () => {
    zoneIs("America/New_York");
    expect(readsMiles("pt-BR")).toBe(true);
    expect(formatDistance(1.609344, "pt-BR")).toBe("1,0 mi");
    zoneIs("Europe/Prague");
    expect(readsMiles("en-US")).toBe(false);
    expect(formatDistance(1.609344, "en-US")).toBe("1.6 km");
    zoneIs("Europe/London");
    expect(readsMiles("en-GB")).toBe(true);
    expect(formatDistance(1.609344, "en-GB")).toBe("1.0 mi");
  });

  it("reads an old name for a zone as the zone: Asia/Rangoon is Myanmar's", () => {
    zoneIs("Asia/Rangoon");
    expect(formatDistance(1.609344, "en")).toBe("1.0 mi");
  });

  it("falls back to the language when the device names no zone, or one in no country", () => {
    zoneIs(undefined);
    expect(formatDistance(1.609344, "en-US")).toBe("1.0 mi");
    expect(formatDistance(1.609344, "pt-PT")).toBe("1,6 km");
    zoneIs("Etc/UTC");
    expect(formatDistance(1.609344, "en-US")).toBe("1.0 mi");
    expect(formatDistance(1.609344, "de-DE")).toBe("1,6 km");
  });

  it("decides the choices of distance to limit a search to: kilometres in Prague, miles in Chicago", () => {
    zoneIs("Europe/Prague");
    expect(withinChoices("en-US").map((choice) => choice.label)).toEqual(["1 km", "2 km", "5 km", "10 km", "25 km"]);
    zoneIs("America/Chicago");
    expect(withinChoices("de-DE").map((choice) => choice.label)).toEqual(["0.5 mi", "1 mi", "3 mi", "5 mi", "15 mi"]);
  });
});
