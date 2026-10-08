import { copy } from "../copy/en.ts";
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
function usesMiles(locale: string): boolean {
  const known = usesMilesByLocale.get(locale);
  if (known !== undefined) return known;
  let miles = false;
  try {
    const region = new Intl.Locale(locale).maximize().region;
    miles = region !== undefined && MILE_REGIONS.has(region);
  } catch {
    // Not a locale. Nobody should see a broken distance for it.
  }
  usesMilesByLocale.set(locale, miles);
  return miles;
}

/** `value` to one decimal place, or, when that is ten or more, to a whole number. */
function tenths(value: number, unit: string): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded < 10 ? `${rounded.toFixed(1)} ${unit}` : `${Math.round(value)} ${unit}`;
}

/**
 * A distance for a person: "0.6 mi" in the US, Liberia and Myanmar, otherwise "1.1 km", or
 * "250 m" under a kilometre. Short distances round to 0.1 mi or 50 m, and long ones to the
 * whole mile or kilometre, because a more exact figure is not one a person can walk by. A
 * distance that is not a number is empty.
 */
export function formatDistance(km: number, locale: string): string {
  if (!Number.isFinite(km)) return "";
  if (usesMiles(locale)) return tenths(Math.max(0.1, km / KM_PER_MILE), copy.units.mi);
  if (km < 1) {
    const metres = Math.max(50, Math.round(km * 20) * 50);
    // 0.99 km rounds to 1000 m: say it in kilometres.
    if (metres < 1000) return `${metres} ${copy.units.m}`;
  }
  return tenths(km, copy.units.km);
}

/**
 * A search distance as a chip says it, from kilometres: "5 km", or, where distance is read in
 * miles, the same distance as `formatDistance` writes it: "3.1 mi". The kilometres are what the
 * filter keeps, so the miles are what they come to, not a rounder number that would be less.
 */
export function formatRadius(km: number, locale: string): string {
  return usesMiles(locale) ? formatDistance(km, locale) : `${km} ${copy.units.km}`;
}
