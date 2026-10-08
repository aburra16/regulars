import { copy } from "../copy/en.ts";
import { formatInteger, safeLocale } from "../locale.ts";
import { distance } from "./geo.ts";

const KM_PER_MILE = 1.609344;

/** Regions whose people measure distance in miles. */
const MILE_REGIONS: ReadonlySet<string> = new Set(["US", "LR", "MM"]);

/** The great-circle distance between two places, in kilometres. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return distance(lon1, lat1, lon2, lat2);
}

const usesMilesByLocale = new Map<string, boolean>();

/**
 * Whether a locale reads distance in miles: its region is the US, Liberia or Myanmar. A locale
 * with no region is read as its language's usual one, so "en" is the US and "pt" is Brazil.
 */
export function usesMiles(locale: string): boolean {
  const known = usesMilesByLocale.get(locale);
  if (known !== undefined) return known;
  // A tag that is not a locale reads as the fallback, which has no country: metric.
  const region = new Intl.Locale(safeLocale(locale)).maximize().region;
  const miles = region !== undefined && MILE_REGIONS.has(region);
  usesMilesByLocale.set(locale, miles);
  return miles;
}

const tenthsFormats = new Map<string, Intl.NumberFormat>();

/** A number to one decimal place, with the language's decimal mark, in Latin digits: "1.5", "1,5". */
function formatTenths(n: number, locale: string): string {
  const tag = safeLocale(locale);
  let format = tenthsFormats.get(tag);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1, numberingSystem: "latn" });
    tenthsFormats.set(tag, format);
  }
  return format.format(n);
}

/**
 * `value` to one decimal place, or, when that is ten or more, to a whole number. Both are written the
 * way the language writes numbers, so its decimal mark and its grouping never read as each other:
 * "1.5 mi" and "3,494 mi" in the US, "1,5 km" and "3.494 km" in Germany.
 */
function tenths(value: number, unit: string, locale: string): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded < 10 ? `${formatTenths(rounded, locale)} ${unit}` : `${formatInteger(Math.round(value), locale)} ${unit}`;
}

/**
 * A distance for a person: "0.6 mi" in the US, Liberia and Myanmar, otherwise "1.1 km", or
 * "250 m" under a kilometre. Short distances round to 0.1 mi or 50 m, and long ones to the
 * whole mile or kilometre, because a more exact figure is not one a person can walk by. A
 * distance that is not a number is empty.
 */
export function formatDistance(km: number, locale: string): string {
  if (!Number.isFinite(km)) return "";
  if (usesMiles(locale)) return tenths(Math.max(0.1, km / KM_PER_MILE), copy.units.mi, locale);
  if (km < 1) {
    const metres = Math.max(50, Math.round(km * 20) * 50);
    // 0.99 km rounds to 1000 m: say it in kilometres.
    if (metres < 1000) return `${metres} ${copy.units.m}`;
  }
  return tenths(km, copy.units.km, locale);
}
