import { ZONE_POINTS } from "./zones.ts";

/*
 * The device's time zone, and what the time zone database says of each zone: where the place it is
 * named for is, and which country it is in (zone.tab). The first visit's town is guessed from the
 * place (`guess.ts`), and distances are written in the unit of the country (`places/distance.ts`).
 * It is all worked out on the device from what the browser says of itself; nothing is sent anywhere.
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

/**
 * The device's time zone as the time zone database names it ("Europe/Lisbon"); undefined when the
 * browser will not say. It is read from `clock`, a formatter made in the device's zone, when one is
 * given: making one is the slow part, for a caller that asks often. Otherwise from one made now.
 */
export function deviceTimeZone(clock?: Intl.DateTimeFormat): string | undefined {
  try {
    const zone: unknown = (clock ?? Intl.DateTimeFormat()).resolvedOptions().timeZone;
    if (typeof zone !== "string" || zone === "") return undefined;
    return RENAMED[zone] ?? zone;
  } catch {
    return undefined;
  }
}

/** A zone's principal place, in degrees, and its country (upper case) when zone.tab gives it one. */
export type ZoneRow = [lat: number, lon: number, country?: string];

/** The zones' points as `tools/zone-points.ts` packs them, read back: each zone's latitude and longitude, in degrees, and its country. */
export function unpackZones(packed: string): Map<string, ZoneRow> {
  const zones = new Map<string, ZoneRow>();
  for (const area of packed.split(";")) {
    const colon = area.indexOf(":");
    for (const entry of area.slice(colon + 1).split(",")) {
      const [rest, lat, lon, country] = entry.split(" ");
      const row: ZoneRow = [Number(lat) / 10, Number(lon) / 10];
      if (country !== undefined) row.push(country);
      zones.set(`${area.slice(0, colon)}/${rest}`, row);
    }
  }
  return zones;
}

/** The zones, read the first time something asks about one. */
let zoneRows: Map<string, ZoneRow> | undefined;

/** What the time zone database says of `zone`, or undefined for a zone it does not have. */
function rowOf(zone: string | undefined): ZoneRow | undefined {
  if (zone === undefined) return undefined;
  zoneRows ??= unpackZones(ZONE_POINTS);
  return zoneRows.get(zone);
}

/**
 * Where the place a time zone is named for is, to a tenth of a degree: Lisbon for Europe/Lisbon.
 * Undefined for a zone that is no place (Etc/UTC, UTC, Etc/GMT+5) or one the time zone database
 * does not have.
 */
export function zonePoint(zone: string | undefined): { lat: number; lon: number } | undefined {
  const row = rowOf(zone);
  return row === undefined ? undefined : { lat: row[0], lon: row[1] };
}

/**
 * The country a time zone is in, as zone.tab gives it, upper case: "US" for America/New_York, "GB"
 * for Europe/London, "PR" for America/Puerto_Rico (a territory is a country of its own there).
 * Undefined for a zone that is in no country (Etc/UTC, UTC) or one the database does not have.
 */
export function zoneCountry(zone: string | undefined): string | undefined {
  return rowOf(zone)?.[2];
}
