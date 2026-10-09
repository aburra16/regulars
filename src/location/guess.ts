import type { City } from "../places/indexes.ts";
import { distanceKm } from "../places/distance.ts";
import { ZONE_POINTS } from "./zones.ts";

/**
 * Where a first visit starts when the person has picked no town and the browser does not already
 * allow the device's location (docs/decisions.md #24): the main town near the place the device's
 * time zone is named for (Lisbon for Europe/Lisbon), or else the nearest, however far. When the zone is no place
 * (Etc/UTC, or a name the time zone database does not have), the town with the most places in
 * the country of the browser's language. It is worked out on the device from what the browser
 * says of itself; nothing is sent anywhere.
 */

/**
 * Time zones a browser may still call by an old name, by the name the time zone database now
 * gives them. Chrome and Node name them as CLDR does ("Asia/Calcutta"); `zones.ts`, as the
 * database does ("Asia/Kolkata").
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

/** The device's time zone as the time zone database names it ("Europe/Lisbon"); undefined when the browser will not say. */
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

/** The zones' points as `tools/zone-points.ts` packs them, read back: each zone's latitude and longitude, in degrees. */
export function unpackZones(packed: string): Map<string, [lat: number, lon: number]> {
  const points = new Map<string, [number, number]>();
  for (const area of packed.split(";")) {
    const colon = area.indexOf(":");
    for (const entry of area.slice(colon + 1).split(",")) {
      const [rest, lat, lon] = entry.split(" ");
      points.set(`${area.slice(0, colon)}/${rest}`, [Number(lat) / 10, Number(lon) / 10]);
    }
  }
  return points;
}

/** The zones' points, read the first time a guess needs them. */
let zonePoints: Map<string, [number, number]> | undefined;

/**
 * Where the place a time zone is named for is, to a tenth of a degree: Lisbon for Europe/Lisbon.
 * Undefined for a zone that is no place (Etc/UTC, UTC, Etc/GMT+5) or one the time zone database
 * does not have.
 */
export function zonePoint(zone: string | undefined): { lat: number; lon: number } | undefined {
  if (zone === undefined) return undefined;
  zonePoints ??= unpackZones(ZONE_POINTS);
  const point = zonePoints.get(zone);
  return point === undefined ? undefined : { lat: point[0], lon: point[1] };
}

/**
 * How far from the place a zone is named for its main town may be. The point is the zone's city
 * to a tenth of a degree, and the towns are each city's places and its suburbs' apart, so the
 * nearest is often a suburb: New York's point is nearer Jersey City than Manhattan.
 */
const ZONE_REACH_KM = 50;

/** How near the most places a capital's must be for it to be taken first: within a tenth. */
const CAPITAL_SHARE = 0.9;

/**
 * Of some towns, the one with the most places; but a capital within a tenth of the most is taken before
 * it (San Salvador, with 84, before Antiguo Cuscatlán beside it, with 88), and of two as good, the one
 * `nearer` puts first. Undefined for no towns.
 */
function biggest(towns: readonly City[], nearer: (a: City, b: City) => number = () => 0): City | undefined {
  const most = Math.max(...towns.map((city) => city.count));
  const capital = (city: City) => Number(city.capital === true && city.count >= CAPITAL_SHARE * most);
  return [...towns].sort((a, b) => capital(b) - capital(a) || b.count - a.count || nearer(a, b))[0];
}

/**
 * The biggest town (`biggest`) within `ZONE_REACH_KM` of the place `zone` is named for ("the biggest
 * nearby town with places", decision 24), the nearer of two as good. With none so near, the nearest
 * town, however far. When the zone is no place, the biggest town in `country`. Undefined when there is
 * none of these. `cities` is in the order `Indexes.cities` has, those with the most places first.
 */
export function guessTown(cities: readonly City[], zone: string | undefined, country: string | undefined): City | undefined {
  const point = zonePoint(zone);
  if (point !== undefined) {
    let nearest: { city: City; km: number } | undefined;
    const near = new Map<City, number>();
    for (const city of cities) {
      const km = distanceKm(point.lat, point.lon, city.lat, city.lon);
      if (nearest === undefined || km < nearest.km) nearest = { city, km };
      if (km <= ZONE_REACH_KM) near.set(city, km);
    }
    if (near.size === 0) return nearest?.city;
    return biggest([...near.keys()], (a, b) => near.get(a)! - near.get(b)!);
  }
  if (country !== undefined) return biggest(cities.filter((city) => city.country === country));
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
