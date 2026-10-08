import tzLookup from "@photostructure/tz-lookup";

import type { City } from "../places/indexes.ts";

/**
 * Where a first visit starts when the person has picked no town and the browser does not already
 * allow the device's location (docs/decisions.md #24): the town with the most places in the
 * device's time zone, or else in the country of the browser's language. It is worked out on the
 * device from what the browser says of itself; nothing is sent anywhere.
 */

/**
 * Time zones a browser may still call by an old name, by the name tz-lookup gives them. Chrome and
 * Node name them as CLDR does ("Asia/Calcutta"); tz-lookup, as the time zone database now does
 * ("Asia/Kolkata"). These are the zones tz-lookup gives that Chrome names otherwise.
 */
const RENAMED: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Godthab": "America/Nuuk",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Rangoon": "Asia/Yangon",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
};

/** The device's time zone as tz-lookup names it ("Europe/Lisbon"); undefined when the browser will not say. */
export function deviceTimeZone(): string | undefined {
  try {
    const zone: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== "string" || zone === "") return undefined;
    return RENAMED[zone] ?? zone;
  } catch {
    return undefined;
  }
}

/**
 * The country the browser's language names, upper case: "PT" for pt-PT. Undefined for a language
 * with none ("en"), for a region that is not a country ("es-419", Latin America), and for a tag
 * that is not one.
 */
export function languageCountry(): string | undefined {
  try {
    const region = new Intl.Locale(navigator.language).region;
    return region !== undefined && /^[A-Z]{2}$/.test(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

/** Each town's time zone, by its coordinates, once worked out; null for coordinates that have none. */
const zones = new Map<string, string | null>();

/** The time zone of a town's middle, worked out once for each town. Undefined when the coordinates are not a place on Earth. */
export function townZone({ lat, lon }: Pick<City, "lat" | "lon">): string | undefined {
  const key = `${lat},${lon}`;
  let zone = zones.get(key);
  if (zone === undefined) {
    try {
      zone = tzLookup(lat, lon);
    } catch {
      // tz-lookup throws for coordinates off the Earth.
      zone = null;
    }
    zones.set(key, zone);
  }
  return zone ?? undefined;
}

/**
 * The town with the most places in `zone`, or else the one with the most in `country`; undefined
 * when there is neither. `cities` is in the order `Indexes.cities` has, those with the most places
 * first, so the first town that matches is the one, and only the towns before it are looked up.
 */
export function guessTown(cities: readonly City[], zone: string | undefined, country: string | undefined): City | undefined {
  if (zone !== undefined) {
    for (const city of cities) if (townZone(city) === zone) return city;
  }
  if (country !== undefined) {
    for (const city of cities) if (city.country === country) return city;
  }
  return undefined;
}

/** What tells one town from another: its name, region and country. */
const townKey = (city: Pick<City, "name" | "region" | "country">) => `${city.name}\u0001${city.region ?? ""}\u0001${city.country}`;

/**
 * Guesses where to start from the towns, for one `HereProvider`. The guess is worked out again only
 * when the towns are not the same towns in the same order, or the device's zone or language has
 * changed: places that refresh with the same towns give the same town, the very object, so the
 * screen does not move. A new guess that is the same town also gives the town it had.
 */
export function startGuesser(): (cities: readonly City[]) => City | undefined {
  let last: { towns: string; zone: string | undefined; country: string | undefined; town: City | undefined } | undefined;
  return (cities) => {
    const zone = deviceTimeZone();
    const country = languageCountry();
    const towns = cities.map(townKey).join("\u0000");
    if (last !== undefined && last.towns === towns && last.zone === zone && last.country === country) return last.town;
    let town = guessTown(cities, zone, country);
    if (town !== undefined && last?.town !== undefined && townKey(town) === townKey(last.town)) town = last.town;
    last = { towns, zone, country, town };
    return town;
  };
}
