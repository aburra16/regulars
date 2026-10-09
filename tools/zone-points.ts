/*
 * Writes src/location/zones.ts: where each time zone's principal place is, from the time zone
 * database's zone.tab or zone1970.tab (both public domain), in tenths of a degree, and the country
 * the table gives the zone.
 *
 *   node tools/zone-points.ts [table...] [--version <tzdata version>]
 *     With no table, reads /usr/share/zoneinfo/zone.tab, and the version from the +VERSION file
 *     beside the first table. Node 22.18 or later runs the file as it is.
 *
 * zone.tab lists every zone a device may name, one per country and place (Europe/Amsterdam,
 * Europe/Oslo, Atlantic/Reykjavik). zone1970.tab folds such zones into another (Europe/Brussels,
 * Africa/Abidjan), whose point is far from where the device is; give it after zone.tab, if at all:
 * a later table only adds the zones the ones before it lack.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Degrees from one half of an ISO 6709 point: "+3843" or "-0740023", with `degreeDigits` digits of whole degrees. */
function degrees(text: string, degreeDigits: number): number {
  const sign = text.startsWith("-") ? -1 : 1;
  const digits = text.slice(1);
  const whole = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits, degreeDigits + 2));
  const seconds = Number(digits.slice(degreeDigits + 2) || "0");
  return sign * (whole + minutes / 60 + seconds / 3600);
}

/** A zone's point in degrees, and its country (ISO 3166 alpha-2, upper case) when the table gives it one. */
export type ZonePoint = [lat: number, lon: number, country?: string];

/**
 * Each zone's point in the text of a zone.tab or zone1970.tab, in degrees, with its country, in the
 * order of the file. zone.tab gives each zone one country; zone1970.tab may give several ("BE,LU,NL"),
 * and a zone of several countries is no one country's, so it has none.
 */
export function pointsOf(text: string): Map<string, ZonePoint> {
  const points = new Map<string, ZonePoint>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [codes, point, zone] = line.split("\t");
    const match = /^([+-]\d{4}(?:\d{2})?)([+-]\d{5}(?:\d{2})?)$/.exec(point ?? "");
    if (match === null || zone === undefined || !zone.includes("/")) throw new Error(`Cannot read the line: ${line}`);
    const where: ZonePoint = [degrees(match[1]!, 2), degrees(match[2]!, 3)];
    if (codes !== undefined && /^[A-Z]{2}$/.test(codes)) where.push(codes);
    points.set(zone, where);
  }
  return points;
}

/**
 * The points as one string, by area, the areas apart by ";": the area's name, ":", and its zones
 * apart by ",", each the rest of its name, its latitude and its longitude in whole tenths of a
 * degree, and its country when it has one, apart by spaces: "Europe:Lisbon 387 -92 PT,Madrid 404 -37 ES;…".
 * `unpackZones` (src/location/timeZone.ts) reads it back.
 */
export function pack(points: ReadonlyMap<string, Readonly<ZonePoint>>): string {
  const areas = new Map<string, string[]>();
  for (const zone of [...points.keys()].sort()) {
    const [lat, lon, country] = points.get(zone)!;
    const slash = zone.indexOf("/");
    const entry = [zone.slice(slash + 1), Math.round(lat * 10), Math.round(lon * 10), ...(country === undefined ? [] : [country])].join(" ");
    const area = zone.slice(0, slash);
    const list = areas.get(area);
    if (list === undefined) areas.set(area, [entry]);
    else list.push(entry);
  }
  return [...areas].map(([area, entries]) => `${area}:${entries.join(",")}`).join(";");
}

/** The module the app reads. */
export function zonesModule(points: ReadonlyMap<string, Readonly<ZonePoint>>, version: string, sources: string[]): string {
  return `// Written by tools/zone-points.ts from ${sources.join(" and ")} of the time zone database ${version}, which
// is in the public domain. Do not edit it: run the tool again.

/** The version of the time zone database the points come from. */
export const TZDATA_VERSION = "${version}";

/** Where each of ${points.size} time zones' principal place is, and its country, packed as \`pack\` in tools/zone-points.ts says. */
export const ZONE_POINTS =
  "${pack(points)}";
`;
}

function main(args: string[]): void {
  const at = args.indexOf("--version");
  const tables = at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const files = tables.length > 0 ? tables : ["/usr/share/zoneinfo/zone.tab"];
  const version = at < 0 ? readFileSync(join(dirname(files[0]!), "+VERSION"), "utf8").trim() : args[at + 1]!;

  const points = new Map<string, ZonePoint>();
  for (const file of files) {
    for (const [zone, point] of pointsOf(readFileSync(file, "utf8"))) if (!points.has(zone)) points.set(zone, point);
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "location", "zones.ts");
  writeFileSync(out, zonesModule(points, version, files.map((file) => basename(file))));
  console.log(`Wrote ${out}: ${points.size} zones from the time zone database ${version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
