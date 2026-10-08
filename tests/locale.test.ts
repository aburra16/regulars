import { describe, expect, it } from "vitest";

import { formatInteger, LOCALE_FALLBACK, safeLocale } from "../src/locale";
import { formatDistance, usesMiles } from "../src/places/distance";

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

  it("keeps its decimals as they were: only the grouping follows the language", () => {
    expect(formatDistance(1.1, "pt-PT")).toBe("1.1 km");
    expect(formatDistance(0.97, "en-US")).toBe("0.6 mi");
  });
});
