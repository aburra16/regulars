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
