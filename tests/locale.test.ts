import { afterEach, describe, expect, it, vi } from "vitest";

import { formatRefreshed } from "../src/about/figures";
import { formatDay, formatDayAndTime, formatInteger, LAST_MOMENT_S, LOCALE_FALLBACK, safeLocale } from "../src/locale";
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

describe("formatDay", () => {
  /** 6 March 2027, at six in the evening in Los Angeles: two in the morning of the 7th in Greenwich. */
  const EVENING = Date.UTC(2027, 2, 7, 2, 0, 0) / 1000;

  it.each([
    ["en-US", "March 7, 2027"],
    ["en-GB", "7 March 2027"],
    ["pt-PT", "7 de março de 2027"],
    ["de-DE", "7. März 2027"],
    ["not a locale", "7 March 2027"],
  ])("writes a day in %s as %j: long, with no time of day", (locale, shown) => {
    expect(formatDay(EVENING, locale)).toBe(shown);
  });

  it("writes the day on the device's own clock, as the person reckons their days: the tests' clock is Greenwich's", () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
    expect(formatDay(EVENING, "en-US")).toBe(formatDay(EVENING, "en-US", "UTC"));
  });

  it("writes the day it was where the zone says, when it is given one: an evening in Los Angeles is not the next day, as it is in Greenwich", () => {
    expect(formatDay(EVENING, "en-US", "America/Los_Angeles")).toBe("March 6, 2027");
    expect(formatDay(EVENING, "en-US", "UTC")).toBe("March 7, 2027");
    expect(formatDay(EVENING, "en-US", "Asia/Tokyo")).toBe("March 7, 2027");
  });

  it("writes its numbers in Latin digits, whatever the language", () => {
    const shown = formatDay(EVENING, "ar-EG");
    expect(shown).toMatch(/\b7\b/);
    expect(shown).toContain("2027");
    expect(shown).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
  });

  it("writes a time past what a date can hold as the last day one can, and never throws for it", () => {
    for (const seconds of [8_640_000_000_001, Number.MAX_SAFE_INTEGER]) {
      expect(() => formatDay(seconds, "en-US")).not.toThrow();
      expect(formatDay(seconds, "en-US", "UTC")).toBe(formatDay(8_640_000_000_000, "en-US", "UTC"));
    }
    expect(formatDay(8_640_000_000_000, "en-US", "UTC")).toMatch(/275760$/);
    expect(() => formatDay(-Number.MAX_SAFE_INTEGER, "en-US")).not.toThrow();
  });

  it("is what the About page's date is written by, for the day in Greenwich", () => {
    for (const locale of ["en-US", "pt-PT", "ar-EG", "ja-JP"]) expect(formatRefreshed(EVENING, locale)).toBe(formatDay(EVENING, locale, "UTC"));
  });
});

describe("formatDayAndTime", () => {
  /** Five past nine on a morning in March, in Greenwich, as the tests' clock is. */
  const MORNING = Date.UTC(2027, 2, 4, 9, 5, 0) / 1000;

  it.each<[string, RegExp]>([
    ["en-US", /^March 4, 2027 at 9:05\sAM$/],
    ["en-GB", /^4 March 2027 at 09:05$/],
    ["pt-PT", /^4 de março de 2027 às 09:05$/],
    ["not a locale", /^4 March 2027 at 9:05\sam$/i],
  ])("writes a moment in %s as its day, long, with its time of day: by the device's own clock", (locale, shown) => {
    expect(formatDayAndTime(MORNING, locale)).toMatch(shown);
  });

  it("writes its numbers in Latin digits, whatever the language", () => {
    const shown = formatDayAndTime(MORNING, "ar-EG");
    expect(shown).toContain("2027");
    expect(shown).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
  });

  it("writes a time past what a date can hold as the last moment one can, and never throws for it: as the day alone is written", () => {
    for (const seconds of [LAST_MOMENT_S + 1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) expect(() => formatDayAndTime(seconds, "en-US")).not.toThrow();
    expect(formatDayAndTime(Number.MAX_SAFE_INTEGER, "en-US")).toBe(formatDayAndTime(LAST_MOMENT_S, "en-US"));
    expect(formatDayAndTime(LAST_MOMENT_S, "en-US")).toContain("275760");
    expect(LAST_MOMENT_S).toBe(8_640_000_000_000);
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

describe("the unit, from where the device is", () => {
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
    // The United Kingdom, and the Crown dependencies, each its own country in zone.tab.
    ["Europe/London", "en-GB"],
    ["Europe/Jersey", "en-GB"],
    ["Europe/Guernsey", "en-GB"],
    ["Europe/Isle_of_Man", "en-GB"],
    // Liberia and Myanmar.
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
    // Ireland, beside the United Kingdom, reads kilometres.
    ["Europe/Dublin", "en-GB"],
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
