/**
 * What the browser's language is read for in code that is not a screen: a locale that `Intl` can
 * use. English as it is spoken in the world, "en-001": no country, so distances are metric, and the
 * clock is the 12-hour one English reads. It is where a tag that is not a locale ("", "en_US") goes.
 */
export const LOCALE_FALLBACK = "en-001";

const safe = new Map<string, string>();

/**
 * `locale` as `Intl` takes it: the canonical form of a good tag ("EN-us" is "en-US"), and
 * `LOCALE_FALLBACK` for anything that is not one. It never throws, so each use of a locale needs no
 * guard of its own. The browser's language is a good tag, but a test, a setting or a user agent may
 * give any text.
 */
export function safeLocale(locale: string): string {
  let known = safe.get(locale);
  if (known === undefined) {
    try {
      known = Intl.getCanonicalLocales(locale)[0] ?? LOCALE_FALLBACK;
    } catch {
      known = LOCALE_FALLBACK;
    }
    safe.set(locale, known);
  }
  return known;
}

/**
 * The latest moment a date can hold, in seconds since the epoch; the earliest is as far the other
 * way. A record may claim a time past either, which no date can be made of.
 */
export const LAST_MOMENT_S = 8_640_000_000_000;

/**
 * The moment `seconds` (whole seconds since the epoch, as a record carries one) as a date: one past
 * what a date can hold is the last moment a date can, or the first, so that what writes it never
 * throws for it.
 */
const momentOf = (seconds: number): Date => new Date(Math.min(Math.max(seconds, -LAST_MOMENT_S), LAST_MOMENT_S) * 1000);

/*
 * Days and times are written here and nowhere else: a day alone (`formatDay`), and a day with its
 * time (`formatDayAndTime`). Both are long, in the browser's language, in Latin digits like every
 * number the app writes, and neither throws for a time no date can hold.
 */

/**
 * A day in the browser's language, long, with no time of day: "5 October 2026", "October 5, 2026".
 * `seconds` is a moment as a record carries one, in whole seconds since the epoch; one past what a
 * date can hold is written as the last day a date can.
 *
 * `zone` says whose day it is. Left out, it is the day on the device's own clock, as the person
 * reckons their days: for a moment in their own doings, which a day reckoned elsewhere could put a
 * day early or late. "UTC" is the day in Greenwich, the same for everyone: for a moment that is not
 * theirs, as when the places were last refreshed (src/about/figures.ts).
 */
export function formatDay(seconds: number, locale: string, zone?: string): string {
  return new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: "long", timeZone: zone, numberingSystem: "latn" }).format(momentOf(seconds));
}

/**
 * A day with its time of day, in the browser's language and by the device's own clock, as the
 * person reckons both: "4 March 2027 at 09:05", "March 4, 2027 at 9:05 AM". For a moment of their
 * own doings of which there may be several in a day. `seconds` as for `formatDay`.
 */
export function formatDayAndTime(seconds: number, locale: string): string {
  return new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: "long", timeStyle: "short", numberingSystem: "latn" }).format(momentOf(seconds));
}

const integers = new Map<string, Intl.NumberFormat>();

/**
 * A whole number the way the language groups it, in Latin digits like every other number the app
 * writes: "3,494", "3.494", "3 494" (a no-break space). Four digits are grouped too, which Portuguese
 * in Portugal and Spanish leave alone, so a distance does not read as a year.
 */
export function formatInteger(n: number, locale: string): string {
  const tag = safeLocale(locale);
  let format = integers.get(tag);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag, { useGrouping: "always", numberingSystem: "latn", maximumFractionDigits: 0 });
    integers.set(tag, format);
  }
  return format.format(n);
}
