import file from "../../src/data/towns.json";
import { readTowns, type Town, type TownList, type TownsFile } from "../../src/places/towns";

/** The app's towns, src/data/towns.json, read as the app reads them when they load with the places. */
export const appTowns: TownList = readTowns(file as unknown as TownsFile);

/**
 * A list of towns made for a test: these towns (in country CZ unless one says otherwise) and these
 * parts, each the point of a part and the id of its town; Czechia and the other countries named.
 */
export function townsOf(towns: (Omit<Town, "country"> & { country?: string })[], parts: [lat: number, lon: number, of: number][] = []): TownList {
  const byCountry: TownsFile["towns"] = {};
  for (const { id, name, ascii, country = "CZ", lat, lon } of towns) {
    (byCountry[country] ??= []).push(ascii === undefined ? [id, name, lat, lon] : [id, name, lat, lon, ascii]);
  }
  return readTowns({
    source: "test",
    licence: "test",
    date: "2026-10-09",
    regenerate: "test",
    countries: { CZ: "Czechia", PT: "Portugal", US: "United States", SV: "El Salvador" },
    towns: byCountry,
    parts: parts.map(([lat, lon, of], i) => [900_000_000 + i, lat, lon, of]),
  });
}
