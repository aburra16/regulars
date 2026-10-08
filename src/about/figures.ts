import { formatInteger, safeLocale } from "../locale.ts";
import type { Place } from "../places/place.ts";

/** What the About page says of the places the app has. */
export interface AboutFigures {
  places: number;
  /** How many countries the places are in. A place with no country is in none. */
  countries: number;
  /** When the newest place was written, in seconds since the epoch: the last refresh. Undefined with no places. */
  refreshedAt: number | undefined;
}

/**
 * The figures of the data, worked out from the places themselves, so the page never says what the
 * list does not hold. Every place of a refresh is written at the refresh, so the newest place's time
 * is when the list was last refreshed. A country is counted once however its code is cased or spaced.
 */
export function aboutFigures(places: readonly Pick<Place, "country" | "createdAt">[]): AboutFigures {
  const countries = new Set<string>();
  let refreshedAt: number | undefined;
  for (const { country, createdAt } of places) {
    const code = country?.trim().toUpperCase();
    if (code !== undefined && code !== "") countries.add(code);
    if (refreshedAt === undefined || createdAt > refreshedAt) refreshedAt = createdAt;
  }
  return { places: places.length, countries: countries.size, refreshedAt };
}

/** A count in the browser's language: "7,954", "7.954", "7 954". */
export function formatCount(n: number, locale: string): string {
  return formatInteger(n, locale);
}

/**
 * A date in the browser's language, long: "5 October 2026", "October 5, 2026", in Latin digits like
 * every number the app writes. It is the day in Greenwich, so the same list says the same day to
 * everyone; a refresh at 23:25 UTC is not a day later for a person in Madeira.
 */
export function formatRefreshed(seconds: number, locale: string): string {
  return new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: "long", timeZone: "UTC", numberingSystem: "latn" }).format(
    new Date(seconds * 1000),
  );
}
