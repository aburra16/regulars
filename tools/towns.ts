/*
 * Writes src/data/towns.json: the towns the places are put in, cut down from GeoNames' list of
 * towns of a thousand people or more (cities1000, under CC BY 4.0) to the ones the places need.
 *
 *   node tools/towns.ts <cities1000.txt> <countryInfo.txt> <signed.jsonl> [--date YYYY-MM-DD]
 *     cities1000.txt and countryInfo.txt are from https://download.geonames.org/export/dump/ (unzip
 *     cities1000.zip first); signed.jsonl is the importer's run of the places (mise-en-place's
 *     out/<run>/signed.jsonl). `--date` is the day the GeoNames files were downloaded; without it,
 *     today in Greenwich. Node 22.18 or later runs the file as it is.
 *
 * Every file is read as text: the GeoNames files as rows of tab-separated fields, the places as one
 * JSON event to a line. Nothing in them is run.
 *
 * Which towns: the populated places of GeoNames (feature class P), leaving out districts (PPLX) and
 * abandoned, destroyed, historical and religious places (PPLQ, PPLW, PPLH, PPLCH). Each place's town is the
 * nearest of these within 30 km (`TOWN_REACH_KM`). GeoNames lists many parts of cities as towns of
 * their own (the parishes of Funchal, the quarters of Lisbon), so a town most of whose places name a
 * bigger town within their reach, by their locality, is a part of that town: the file keeps its point,
 * and the app counts its places in the bigger town (see `chooseTowns`). The file holds the towns that
 * are some place's, and the parts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import KDBush from "kdbush";

import { foldText } from "../src/places/fold.ts";
import { around } from "../src/places/geo.ts";
import { type PartRow, TOWN_REACH_KM, type TownRow, type TownsFile } from "../src/places/towns.ts";

/** Kinds of populated place that are no town: districts, and abandoned, destroyed, historical and religious places. */
export const EXCLUDED_CODES: ReadonlySet<string> = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);

/** A town of GeoNames, as the tool reads it. */
export interface GeoTown {
  id: number;
  name: string;
  ascii: string;
  /** GeoNames' other names for it, in other languages and spellings ("Praha" for Prague). Not written to the file. */
  alternates: string[];
  lat: number;
  lon: number;
  /** Its feature code: PPL, PPLA, PPLC ... */
  code: string;
  /** An upper-case country code. */
  country: string;
  population: number;
}

/** A place as the tool reads it: where it is, and the town its locality names, if it has one. */
export interface PlacePoint {
  lat: number;
  lon: number;
  locality?: string;
}

/** A whole number written as one: "123", not "1e3" or "12.0". */
const WHOLE = /^\d+$/;

/** A number of degrees, or undefined for anything that is not one within `limit` of zero. */
function degrees(text: string | undefined, limit: number): number | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

/**
 * The towns in the text of cities1000.txt: one to a line, 19 fields apart by tabs. A line that is
 * not one (too few fields, an id or a point that is not a number) is skipped, as is every row that
 * is not a populated place or is one of `EXCLUDED_CODES`.
 */
export function readGeoNames(text: string): GeoTown[] {
  const towns: GeoTown[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 19) continue;
    const [id, name, ascii, alternates, lat, lon, featureClass, code, country, , , , , , population] = fields;
    if (featureClass !== "P" || code === undefined || EXCLUDED_CODES.has(code)) continue;
    const latitude = degrees(lat, 90);
    const longitude = degrees(lon, 180);
    if (!WHOLE.test(id ?? "") || latitude === undefined || longitude === undefined) continue;
    if (name === undefined || name.trim() === "" || !/^[A-Z]{2}$/.test(country ?? "")) continue;
    towns.push({
      id: Number(id),
      name: name.trim(),
      ascii: (ascii ?? "").trim() || name.trim(),
      alternates: (alternates ?? "").split(",").filter((each) => each.trim() !== ""),
      lat: latitude,
      lon: longitude,
      code,
      country: country!,
      population: WHOLE.test(population ?? "") ? Number(population) : 0,
    });
  }
  return towns;
}

/** Each country's name by its code, from the text of countryInfo.txt: tab-separated, the code first and the name fifth; lines that start with # are comments. */
export function readCountries(text: string): Map<string, string> {
  const countries = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const fields = line.split("\t");
    const code = fields[0] ?? "";
    const name = fields[4]?.trim() ?? "";
    if (/^[A-Z]{2}$/.test(code) && name !== "") countries.set(code, name);
  }
  return countries;
}

/**
 * The places in the text of the importer's signed.jsonl: one event to a line, its point and its
 * locality from its tags. A line that is not JSON, or an event without a point, is skipped and counted.
 */
export function readPlaces(text: string): { places: PlacePoint[]; skipped: number } {
  const places: PlacePoint[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const tags = typeof event === "object" && event !== null ? (event as { tags?: unknown }).tags : undefined;
    const tag = (name: string): string | undefined => {
      if (!Array.isArray(tags)) return undefined;
      const found = tags.find((each): each is string[] => Array.isArray(each) && each[0] === name && typeof each[1] === "string");
      return found?.[1];
    };
    const lat = degrees(tag("lat"), 90);
    const lon = degrees(tag("lon"), 180);
    if (lat === undefined || lon === undefined) {
      skipped += 1;
      continue;
    }
    const locality = tag("locality")?.trim();
    places.push(locality === undefined || locality === "" ? { lat, lon } : { lat, lon, locality });
  }
  return { places, skipped };
}

/** The names a town answers to, folded: its name, its ASCII name and GeoNames' other names for it. */
function namesOf(town: GeoTown): Set<string> {
  return new Set([town.name, town.ascii, ...town.alternates].map((name) => foldText(name).trim()));
}

/**
 * The names a locality may mean, folded: as it is, without a district's number after it ("Praha 10"
 * is in Praha; "Budapest XIII." in Budapest), and its part before a comma ("San Salvador, El Salvador").
 */
function localityKeys(locality: string): string[] {
  const folded = foldText(locality).replace(/\s+/g, " ").trim();
  const keys = new Set([folded, folded.replace(/\s+(?:\d+|[ivxlc]+)\.?$/, ""), folded.split(",")[0]!.trim()]);
  return [...keys].filter((key) => key !== "");
}

/** What `chooseTowns` keeps. */
export interface TownChoice {
  /** The towns of the file: each the town of at least one place. */
  towns: GeoTown[];
  /** The parts of towns, each with the town it is part of, which is in `towns`. */
  parts: { part: GeoTown; of: GeoTown }[];
  /** How many places have a town within reach, and how many have none. */
  placed: number;
  unplaced: number;
}

/**
 * The towns the places need. Each place's nearest town within `TOWN_REACH_KM` is its town, unless
 * that town is a part of a bigger one: a town is a part when, of its places that have a locality, more
 * than half name one bigger town (more people) that is within their reach, and more name that town
 * than name it (by GeoNames' name, ASCII name or other names: "Praha" is Prague). A part's places are
 * that town's; a part of a part goes to the town at the end of the chain. The towns are each place's
 * town, which may be a town that no place is nearest to (Funchal, whose places are nearest its parishes).
 */
export function chooseTowns(rows: readonly GeoTown[], places: readonly PlacePoint[]): TownChoice {
  const tree = new KDBush(rows.length);
  for (const row of rows) tree.add(row.lon, row.lat);
  tree.finish();

  // Each place's towns within reach, nearest first, and the places each town is nearest to.
  const reach = places.map((place) => around(tree, place.lon, place.lat, undefined, TOWN_REACH_KM).map((id) => rows[id]!));
  const nearestTo = new Map<GeoTown, number[]>();
  reach.forEach((towns, i) => {
    const [nearest] = towns;
    if (nearest === undefined) return;
    const list = nearestTo.get(nearest);
    if (list === undefined) nearestTo.set(nearest, [i]);
    else list.push(i);
  });

  const names = new Map<GeoTown, Set<string>>();
  const answersTo = (town: GeoTown, keys: readonly string[]) => {
    let set = names.get(town);
    if (set === undefined) {
      set = namesOf(town);
      names.set(town, set);
    }
    return keys.some((key) => set.has(key));
  };

  // Which towns are parts of which, each judged by the places nearest to it.
  const partOf = new Map<GeoTown, GeoTown>();
  for (const [town, nearest] of nearestTo) {
    let located = 0;
    let own = 0;
    const votes = new Map<GeoTown, number>();
    for (const i of nearest) {
      const locality = places[i]!.locality;
      if (locality === undefined) continue;
      located += 1;
      const keys = localityKeys(locality);
      if (answersTo(town, keys)) {
        own += 1;
        continue;
      }
      const bigger = reach[i]!.find((other) => other !== town && other.population > town.population && answersTo(other, keys));
      if (bigger !== undefined) votes.set(bigger, (votes.get(bigger) ?? 0) + 1);
    }
    let best: GeoTown | undefined;
    let most = 0;
    for (const [other, count] of votes) {
      if (best === undefined || count > most || (count === most && (other.population > best.population || (other.population === best.population && other.id < best.id)))) {
        best = other;
        most = count;
      }
    }
    if (best !== undefined && most * 2 > located && most > own) partOf.set(town, best);
  }

  // Each part's town is at the end of its chain. A town is bigger than its part, so there is an end.
  const townOf = (town: GeoTown) => {
    let at = town;
    for (let next = partOf.get(at); next !== undefined; next = partOf.get(at)) at = next;
    return at;
  };

  const towns = new Set<GeoTown>();
  const partsOf = new Map<GeoTown, GeoTown>();
  for (const town of nearestTo.keys()) {
    const of = townOf(town);
    towns.add(of);
    if (of !== town) partsOf.set(town, of);
  }

  // A part that puts no place in another town than the next nearest point of the file would is left
  // out: the parishes of Funchal that have Funchal, or another of its parishes, next nearest. The parts
  // are tried one by one, by id, each against the file as the ones before it left it.
  const inFile = new Set<GeoTown>([...towns, ...partsOf.keys()]);
  const standsFor = (entry: GeoTown) => partsOf.get(entry) ?? entry;
  const withinReachOf = new Map<GeoTown, number[]>();
  reach.forEach((within, i) => {
    for (const town of within) {
      if (!partsOf.has(town)) continue;
      const list = withinReachOf.get(town);
      if (list === undefined) withinReachOf.set(town, [i]);
      else list.push(i);
    }
  });
  for (const part of [...partsOf.keys()].sort(byId)) {
    inFile.delete(part);
    const needed = (withinReachOf.get(part) ?? []).some((i) => {
      if (reach[i]!.find((town) => town === part || inFile.has(town)) !== part) return false;
      const next = reach[i]!.find((town) => inFile.has(town));
      return next === undefined || standsFor(next) !== partsOf.get(part);
    });
    if (needed) inFile.add(part);
  }
  const parts = [...partsOf].filter(([part]) => inFile.has(part)).map(([part, of]) => ({ part, of }));

  const placed = reach.filter((within) => within.length > 0).length;
  return { towns: [...towns], parts, placed, unplaced: places.length - placed };
}

/**
 * The towns of at least `population` people within reach of a place that the choice does not have:
 * the margin the brief asked to weigh, so that a place added at the next refresh finds its town.
 * The tool reports what it would cost; the file does not carry it.
 */
export function marginTowns(rows: readonly GeoTown[], places: readonly PlacePoint[], choice: TownChoice, population: number): GeoTown[] {
  const big = rows.filter((row) => row.population >= population);
  const tree = new KDBush(big.length);
  for (const row of big) tree.add(row.lon, row.lat);
  tree.finish();
  const taken = new Set<GeoTown>([...choice.towns, ...choice.parts.map(({ part }) => part)]);
  const margin = new Set<GeoTown>();
  for (const place of places) {
    for (const id of around(tree, place.lon, place.lat, undefined, TOWN_REACH_KM)) {
      const town = big[id]!;
      if (!taken.has(town)) margin.add(town);
    }
  }
  return [...margin];
}

/** Degrees to four decimals, about eleven metres. */
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** By id, which GeoNames never gives two towns. */
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

/** The file for a choice of towns, with the name of each of their countries. */
export function townsFile(choice: TownChoice, countries: ReadonlyMap<string, string>, { date, places }: { date: string; places: number }): TownsFile {
  const towns: Record<string, TownRow[]> = {};
  for (const town of [...choice.towns].sort((a, b) => (a.country < b.country ? -1 : a.country > b.country ? 1 : byId(a, b)))) {
    const row: TownRow = [town.id, town.name, round4(town.lat), round4(town.lon)];
    if (foldText(town.ascii) !== foldText(town.name)) row.push(town.ascii);
    (towns[town.country] ??= []).push(row);
  }
  const named: Record<string, string> = {};
  for (const country of Object.keys(towns)) {
    const name = countries.get(country);
    if (name !== undefined) named[country] = name;
  }
  const parts: PartRow[] = [...choice.parts]
    .sort((a, b) => byId(a.part, b.part))
    .map(({ part, of }) => [part.id, round4(part.lat), round4(part.lon), of.id]);
  return {
    source: `GeoNames' towns of 1,000 people or more (cities1000.txt and countryInfo.txt, https://download.geonames.org/export/dump/), cut down by tools/towns.ts to the towns of ${places.toLocaleString("en")} places.`,
    licence: "Town names from GeoNames (geonames.org), CC BY 4.0: https://creativecommons.org/licenses/by/4.0/",
    date,
    regenerate:
      "Download and unzip cities1000.zip, and countryInfo.txt, from GeoNames, then: node tools/towns.ts cities1000.txt countryInfo.txt <importer run>/signed.jsonl --date <download day>. Do not edit this file by hand.",
    countries: named,
    towns,
    parts,
  };
}

/**
 * The file as text: JSON with one town, and one part, to a line, so that a refresh's changes read as
 * lines in a diff. The same file gives the same text.
 */
export function formatTownsFile(file: TownsFile): string {
  const head = (["source", "licence", "date", "regenerate"] as const).map((key) => `${JSON.stringify(key)}: ${JSON.stringify(file[key])}`);
  const countries = Object.entries(file.countries).map(([code, name]) => `${JSON.stringify(code)}: ${JSON.stringify(name)}`);
  const towns = Object.entries(file.towns).map(
    ([code, rows]) => `${JSON.stringify(code)}: [\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]`,
  );
  const parts = file.parts.map((row) => JSON.stringify(row));
  return [
    "{",
    head.map((line) => `${line},`).join("\n"),
    `"countries": {\n${countries.join(",\n")}\n},`,
    `"towns": {\n${towns.join(",\n")}\n},`,
    `"parts": [\n${parts.join(",\n")}\n]`,
    "}",
    "",
  ].join("\n");
}

/** The population of the margin `main` weighs: the brief's 15,000. */
const MARGIN_POPULATION = 15_000;

function main(args: string[]): void {
  const at = args.indexOf("--date");
  const files = at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const date = at < 0 ? new Date().toISOString().slice(0, 10) : args[at + 1]!;
  if (files.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Usage: node tools/towns.ts <cities1000.txt> <countryInfo.txt> <signed.jsonl> [--date YYYY-MM-DD]");
  }
  const [geoPath, countriesPath, placesPath] = files as [string, string, string];

  const rows = readGeoNames(readFileSync(geoPath, "utf8"));
  const countries = readCountries(readFileSync(countriesPath, "utf8"));
  const { places, skipped } = readPlaces(readFileSync(placesPath, "utf8"));
  const choice = chooseTowns(rows, places);
  const text = formatTownsFile(townsFile(choice, countries, { date, places: places.length }));

  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "towns.json");
  writeFileSync(out, text);

  const margin = marginTowns(rows, places, choice, MARGIN_POPULATION);
  const marginText = formatTownsFile(townsFile({ ...choice, towns: [...choice.towns, ...margin] }, countries, { date, places: places.length }));
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`Read ${rows.length} towns from GeoNames and ${places.length} places (${skipped} lines skipped).`);
  console.log(`Wrote ${out}: ${choice.towns.length} towns and ${choice.parts.length} parts, ${kb(Buffer.byteLength(text))}.`);
  console.log(`${choice.placed} places have a town within ${TOWN_REACH_KM} km; ${choice.unplaced} have none.`);
  console.log(
    `A margin of the towns of ${MARGIN_POPULATION.toLocaleString("en")} people or more within reach of a place would add ${margin.length} towns, ` +
      `${kb(Buffer.byteLength(marginText) - Buffer.byteLength(text))}. It is left out.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
