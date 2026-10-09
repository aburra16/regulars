/*
 * Writes src/data/towns.json: the towns the places are put in, cut down from GeoNames' list of
 * towns of a thousand people or more (cities1000, under CC BY 4.0) to the ones the places need.
 *
 *   node tools/towns.ts <cities1000.txt> <places-live.jsonl> [--date YYYY-MM-DD] [--out <file>]
 *     cities1000.txt is from https://download.geonames.org/export/dump/ (unzip cities1000.zip
 *     first). places-live.jsonl is the live list, the places the app loads, read from the places
 *     relay one event to a line, as `nak req` prints them (`REGENERATE` says how). `--date` is the day
 *     the GeoNames file was downloaded; without it, today in Greenwich. `--out` writes the file
 *     elsewhere than src/data/towns.json. Node 22.18 or later runs the file as it is. The tool reads
 *     only these files: it asks no relay and no server anything.
 *
 * Every file is read as text: the GeoNames file as rows of tab-separated fields, the places as one
 * JSON event to a line. Nothing in them is run. Of the events, only places count (kind 39999), and of
 * two versions of one place, the newer.
 *
 * Which towns: the populated places of GeoNames (feature class P), leaving out districts (PPLX) and
 * abandoned, destroyed, historical and religious places (PPLQ, PPLW, PPLH, PPLCH). A place is in the
 * town its locality names, within 30 km (`TOWN_REACH_KM`); else in the nearest town within 30 km.
 * GeoNames lists many parts of cities as towns of their own (the parishes of Funchal, the quarters of
 * Lisbon, the districts of Bangkok), so a town whose places name a bigger town within their reach is
 * a part of that town, as is a district of a capital on the reviewed list of tools/towns-absorb.ts: the
 * file keeps its point, and the app counts its places in the bigger town (see `chooseTowns`). The file
 * holds the towns that are some place's, filed by country (and by state or province in the United
 * States and Canada), and the parts the app needs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import KDBush from "kdbush";

import { isNewer } from "../src/nostr/events.ts";
import { around, distance } from "../src/places/geo.ts";
import { PLACE_KIND } from "../src/places/place.ts";
import { foldName, type PartRow, TOWN_REACH_KM, type TownRow, type TownsFile } from "../src/places/towns.ts";
import { ABSORBING } from "./towns-absorb.ts";

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
  /** GeoNames' code of its first-level area: the state, the province ("MO", "08", "40"). */
  admin1: string;
  population: number;
}

/** A place as the tool reads it: where it is, the town its locality names, and its country, if it has them. */
export interface PlacePoint {
  lat: number;
  lon: number;
  locality?: string;
  /** Upper case. */
  country?: string;
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
    const [id, name, ascii, alternates, lat, lon, featureClass, code, country, , admin1, , , , population] = fields;
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
      admin1: (admin1 ?? "").trim(),
      population: WHOLE.test(population ?? "") ? Number(population) : 0,
    });
  }
  return towns;
}

/**
 * The places in the text of the live list: one event to a line, each place's point and locality from
 * its tags. A line that is not JSON, an event that is not a place (kind 39999), and a place without a
 * point are skipped and counted (`skipped`). Of two versions of one place (its author and `d`), the
 * newer counts, as NIP-01 says and the app reads them; the older are counted (`older`).
 */
export function readPlaces(text: string): { places: PlacePoint[]; skipped: number; older: number } {
  const newest = new Map<string, { id: string; created_at: number; place: PlacePoint }>();
  let skipped = 0;
  let older = 0;
  text.split("\n").forEach((line, at) => {
    if (line.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      skipped += 1;
      return;
    }
    const fields = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
    const tags = fields.tags;
    const tag = (name: string): string | undefined => {
      if (!Array.isArray(tags)) return undefined;
      const found = tags.find((each): each is string[] => Array.isArray(each) && each[0] === name && typeof each[1] === "string");
      return found?.[1];
    };
    const lat = degrees(tag("lat"), 90);
    const lon = degrees(tag("lon"), 180);
    if (fields.kind !== PLACE_KIND || lat === undefined || lon === undefined) {
      skipped += 1;
      return;
    }
    const locality = tag("locality")?.trim();
    const country = tag("country")?.trim().toUpperCase();
    const place: PlacePoint = { lat, lon };
    if (locality !== undefined && locality !== "") place.locality = locality;
    if (country !== undefined && country !== "") place.country = country;
    const version = {
      id: typeof fields.id === "string" ? fields.id : "",
      created_at: typeof fields.created_at === "number" ? fields.created_at : 0,
      place,
    };
    // A place with no `d` is no version of another: its line stands for it.
    const d = tag("d");
    const address = d === undefined ? `line ${at}` : `${String(fields.pubkey)}:${d}`;
    const kept = newest.get(address);
    if (kept !== undefined) older += 1;
    if (kept === undefined || isNewer(version, kept)) newest.set(address, version);
  });
  return { places: [...newest.values()].map(({ place }) => place), skipped, older };
}

/** A town's own names, folded as the app folds them (`foldName`): its name and its ASCII name. */
function ownNamesOf(town: GeoTown): Set<string> {
  return new Set([foldName(town.name), foldName(town.ascii)]);
}

/** GeoNames' other names for a town, folded, but for its own names: "praha" for Prague. */
function otherNamesOf(town: GeoTown): Set<string> {
  const own = ownNamesOf(town);
  return new Set(town.alternates.map(foldName).filter((name) => name !== "" && !own.has(name)));
}

/**
 * The names a locality may mean, folded: as it is, without a district's number after it ("Praha 10"
 * is in Praha; "Budapest XIII." in Budapest), and its part before a comma ("San Salvador, El Salvador").
 */
function localityKeys(locality: string): string[] {
  const folded = foldName(locality);
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
  /**
   * How many places the app, reading the file, would put in another town than the tool chose for them
   * (`TownList.townAt`): none, unless a place names a district of a capital that takes it in, and a
   * town of that name is farther off.
   */
  astray: number;
  /** The localities of their own (see `chooseTowns`), each with its country, which may be "". */
  localities: { country: string; locality: string }[];
}

/** How far from the point of the town its places are in a locality of their own must be, in kilometres (as src/places/indexes.ts groups localities, 25 km for a cluster). */
const OWN_LOCALITY_KM = 5;
const CLUSTER_KM = 25;

/** The median of some numbers. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The points of `group` within `CLUSTER_KM` of the one that has the most of them that near (the first
 * of them on a tie), as src/places/indexes.ts finds a locality's busiest cluster.
 */
function busiest<T extends { lat: number; lon: number }>(group: readonly T[]): T[] {
  let centre = group[0]!;
  let most = -1;
  for (const each of group) {
    const near = group.filter((other) => distance(each.lon, each.lat, other.lon, other.lat) <= CLUSTER_KM).length;
    if (near > most) {
      centre = each;
      most = near;
    }
  }
  return group.filter((other) => distance(centre.lon, centre.lat, other.lon, other.lat) <= CLUSTER_KM);
}

/** The fewest places that must name a bigger town for a town to be a part of it. */
const PART_VOTES_MIN = 2;

/**
 * The towns the places need, in four steps.
 *
 * 1. A place whose locality is the name or ASCII name of a town within `TOWN_REACH_KM`, folded, is in
 *    that town, the nearest of the name: "Glendale" is Glendale, though Burbank is nearer.
 * 2. Otherwise it is in the town nearest to it within reach, unless that town is a part of a bigger
 *    one. A town is a part when at least two of the places nearest to it name one bigger town (more
 *    people) within their reach by their locality, and those are more than half of its places with a
 *    locality, and more than name it. A locality names a town first by its name or ASCII name, then by
 *    GeoNames' other names for it ("Praha" is Prague); a town's own name comes before a bigger town's,
 *    and a bigger town's before the town's other names: the City of London's places that say London
 *    are London's. A town that some place names (step 1) is never a part.
 * 3. A capital of `absorbing` takes in every town of its own first-level area within its reach as a
 *    part, whatever its places say (tools/towns-absorb.ts).
 * 4. A part's places are its town's; a part of a part goes to the town at the end of the chain.
 * 5. A locality is one of its own when three or more places name it, close together (as the app groups
 *    localities), more than 5 km from the point of the town most of them are in, and no town within
 *    reach of their middle is called it, by any of GeoNames' names for it, with a district's number
 *    off or not: El Zonte, a beach whose places are nearest La Libertad's point, is; Saint Louis,
 *    which GeoNames also calls St. Louis, and Praha 10, in Praha, are not. The app keeps such a
 *    locality a town of its own, at the middle of its places.
 *
 * The file holds each place's town, and the parts the app needs to put each place where the tool did
 * (see `astray`): those that some place is nearer to than to any other point of the file.
 */
export function chooseTowns(rows: readonly GeoTown[], places: readonly PlacePoint[], absorbing: readonly { id: number; withinKm: number }[] = []): TownChoice {
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

  const own = new Map<GeoTown, Set<string>>();
  const other = new Map<GeoTown, Set<string>>();
  const ownNames = (town: GeoTown) => own.get(town) ?? own.set(town, ownNamesOf(town)).get(town)!;
  const otherNames = (town: GeoTown) => other.get(town) ?? other.set(town, otherNamesOf(town)).get(town)!;

  // 1. The town each place's locality names, if any.
  const named = places.map((place, i) => {
    const locality = foldName(place.locality ?? "");
    return locality === "" ? undefined : reach[i]!.find((town) => ownNames(town).has(locality));
  });
  const namedTowns = new Set(named.filter((town): town is GeoTown => town !== undefined));

  // 3. The towns the capitals take in.
  const partOf = new Map<GeoTown, GeoTown>();
  const byIdOf = new Map(rows.map((row) => [row.id, row]));
  const absorbed = new Set<GeoTown>();
  for (const { id, withinKm } of absorbing) {
    const capital = byIdOf.get(id);
    if (capital === undefined) continue;
    for (const at of around(tree, capital.lon, capital.lat, undefined, withinKm)) {
      const town = rows[at]!;
      if (town === capital || town.country !== capital.country || town.admin1 !== capital.admin1) continue;
      partOf.set(town, capital);
      absorbed.add(town);
    }
  }

  // 2. Which other towns are parts of which, each judged by the places nearest to it.
  for (const [town, nearest] of nearestTo) {
    if (absorbed.has(town) || namedTowns.has(town)) continue;
    let located = 0;
    let ownVotes = 0;
    const votes = new Map<GeoTown, number>();
    for (const i of nearest) {
      const locality = places[i]!.locality;
      if (locality === undefined) continue;
      located += 1;
      const keys = localityKeys(locality);
      const names = (set: Set<string>) => keys.some((key) => set.has(key));
      const bigger = (by: (town: GeoTown) => Set<string>) =>
        reach[i]!.find((each) => each !== town && each.population > town.population && names(by(each)));
      let vote: GeoTown | undefined;
      if (names(ownNames(town))) ownVotes += 1;
      else if ((vote = bigger(ownNames)) !== undefined) votes.set(vote, (votes.get(vote) ?? 0) + 1);
      else if (names(otherNames(town))) ownVotes += 1;
      else if ((vote = bigger(otherNames)) !== undefined) votes.set(vote, (votes.get(vote) ?? 0) + 1);
    }
    let best: GeoTown | undefined;
    let most = 0;
    for (const [each, count] of votes) {
      if (best === undefined || count > most || (count === most && (each.population > best.population || (each.population === best.population && each.id < best.id)))) {
        best = each;
        most = count;
      }
    }
    if (best !== undefined && most >= PART_VOTES_MIN && most * 2 > located && most > ownVotes) partOf.set(town, best);
  }

  // 4. Each part's town is at the end of its chain. A town is bigger than its part, and a capital takes
  // in only the towns around it, so there is an end; a step past any town seen ends it all the same.
  const townOf = (town: GeoTown) => {
    const seen = new Set<GeoTown>([town]);
    let at = town;
    for (let next = partOf.get(at); next !== undefined && !seen.has(next); next = partOf.get(at)) {
      seen.add(next);
      at = next;
    }
    return at;
  };

  // Each place's town.
  const chosen = places.map((_, i) => {
    const name = named[i];
    if (name !== undefined) return absorbed.has(name) ? townOf(name) : name;
    const nearest = reach[i]![0];
    return nearest === undefined ? undefined : townOf(nearest);
  });
  const towns = new Set(chosen.filter((town): town is GeoTown => town !== undefined));

  // The parts: every part within some place's reach, then all but those the app needs are left out.
  const partsOf = new Map<GeoTown, GeoTown>();
  const withinReachOf = new Map<GeoTown, number[]>();
  reach.forEach((within, i) => {
    for (const town of within) {
      if (towns.has(town) || !partOf.has(town)) continue;
      partsOf.set(town, townOf(town));
      const list = withinReachOf.get(town);
      if (list === undefined) withinReachOf.set(town, [i]);
      else list.push(i);
    }
  });

  // Where the app puts each place with the file as it stands (`TownList.townAt`): the nearest town of
  // the file with the name its locality says, else the town of the nearest point of the file.
  const inFile = new Set<GeoTown>([...towns, ...partsOf.keys()]);
  const appTown = (i: number) => {
    const locality = foldName(places[i]!.locality ?? "");
    const byName = locality === "" ? undefined : reach[i]!.find((town) => towns.has(town) && ownNames(town).has(locality));
    if (byName !== undefined) return byName;
    const nearest = reach[i]!.find((town) => inFile.has(town));
    return nearest === undefined ? undefined : (partsOf.get(nearest) ?? nearest);
  };
  // A part that changes no place's town is left out: tried one by one, by id, each against the file as
  // the ones before it left it, and kept if leaving it out would put a place anywhere but its town.
  for (const part of [...partsOf.keys()].sort(byId)) {
    const affected = withinReachOf.get(part) ?? [];
    const before = affected.map(appTown);
    inFile.delete(part);
    if (affected.some((i, k) => before[k] === chosen[i] && appTown(i) !== chosen[i])) inFile.add(part);
  }
  const parts = [...partsOf].filter(([part]) => inFile.has(part)).map(([part, of]) => ({ part, of }));
  const astray = places.filter((_, i) => appTown(i) !== chosen[i]).length;

  // 5. The localities of their own.
  const groups = new Map<string, number[]>();
  places.forEach((place, i) => {
    const locality = foldName(place.locality ?? "");
    const town = chosen[i];
    if (locality === "" || town === undefined || ownNames(town).has(locality)) return;
    const key = `${place.country ?? ""}\n${locality}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [i]);
    else list.push(i);
  });
  const localities: TownChoice["localities"] = [];
  for (const [key, members] of groups) {
    if (members.length < 3) continue;
    const cluster = busiest(members.map((i) => ({ i, lat: places[i]!.lat, lon: places[i]!.lon })));
    if (cluster.length < 3) continue;
    const lat = median(cluster.map((each) => each.lat));
    const lon = median(cluster.map((each) => each.lon));
    const counts = new Map<GeoTown, number>();
    for (const { i } of cluster) counts.set(chosen[i]!, (counts.get(chosen[i]!) ?? 0) + 1);
    const [town] = [...counts].sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))[0]!;
    if (!(distance(lon, lat, town.lon, town.lat) > OWN_LOCALITY_KM)) continue;
    const [country = "", locality = ""] = key.split("\n");
    const keys = localityKeys(locality);
    const named = around(tree, lon, lat, undefined, TOWN_REACH_KM).some((at) => {
      const each = rows[at]!;
      return keys.some((name) => ownNames(each).has(name) || otherNames(each).has(name));
    });
    if (!named) localities.push({ country, locality });
  }

  const placed = chosen.filter((town) => town !== undefined).length;
  return { towns: [...towns], parts, placed, unplaced: places.length - placed, astray, localities };
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

/**
 * How to make the file again, as it says it. The house's key and the list's coordinate are
 * `config.houseHex` and `config.headerCoordinate` in src/config.ts; the places relay is
 * `config.placesRelay`, which sends up to 10,000 events to a request.
 */
export const REGENERATE =
  "Read the live list from the places relay, one event to a line: nak req -k 39999 -a <house key> -t z=<list coordinate> -l 10000 wss://dcosl.brainstorm.world > places-live.jsonl (the key and the coordinate are config.houseHex and config.headerCoordinate in src/config.ts). Download cities1000.zip from GeoNames and unzip it. Then: node tools/towns.ts cities1000.txt places-live.jsonl --date <download day>. Do not edit this file by hand.";

/** Degrees to four decimals, about eleven metres. */
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** By id, which GeoNames never gives two towns. */
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

/** The provinces and territories of Canada by GeoNames' codes, as Canadians write them ("ON"). */
const CANADA: Readonly<Record<string, string>> = {
  "01": "AB",
  "02": "BC",
  "03": "MB",
  "04": "NB",
  "05": "NL",
  "07": "NS",
  "08": "ON",
  "09": "PE",
  "10": "QC",
  "11": "SK",
  "12": "YT",
  "13": "NT",
  "14": "NU",
};

/**
 * What a town is filed under: its country, and for the United States and Canada its state or
 * province after a hyphen ("US-MO", "CA-ON"), which the app labels it by, since many towns there share
 * a name. Any other country's towns are filed under the country alone.
 */
function fileKey(town: GeoTown): string {
  if (town.country === "US" && /^[A-Z]{2}$/.test(town.admin1)) return `US-${town.admin1}`;
  const province = town.country === "CA" ? CANADA[town.admin1] : undefined;
  return province === undefined ? town.country : `CA-${province}`;
}

/** The file for a choice of towns. */
export function townsFile(choice: TownChoice, { date, places }: { date: string; places: number }): TownsFile {
  const towns: Record<string, TownRow[]> = {};
  const keyed = choice.towns.map((town) => ({ town, key: fileKey(town) }));
  for (const { town, key } of keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : byId(a.town, b.town)))) {
    const row: TownRow = [town.id, town.name, round4(town.lat), round4(town.lon)];
    if (foldName(town.ascii) !== foldName(town.name)) row.push(town.ascii);
    (towns[key] ??= []).push(row);
  }
  const parts: PartRow[] = [...choice.parts]
    .sort((a, b) => byId(a.part, b.part))
    .map(({ part, of }) => [part.id, round4(part.lat), round4(part.lon), of.id]);
  const localities: Record<string, string[]> = {};
  for (const { country, locality } of [...choice.localities].sort((a, b) => (a.country < b.country ? -1 : a.country > b.country ? 1 : a.locality < b.locality ? -1 : 1))) {
    (localities[country] ??= []).push(locality);
  }
  return {
    source: `GeoNames' towns of 1,000 people or more (cities1000.txt, https://download.geonames.org/export/dump/), cut down by tools/towns.ts to the towns of the ${places.toLocaleString("en")} places of the live list, the food and drink places the app loads, read from the places relay.`,
    licence: "Town names from GeoNames (geonames.org), CC BY 4.0: https://creativecommons.org/licenses/by/4.0/",
    date,
    regenerate: REGENERATE,
    towns,
    parts,
    localities,
  };
}

/**
 * The file as text: JSON with one town, and one part, to a line, so that a refresh's changes read as
 * lines in a diff. The same file gives the same text.
 */
export function formatTownsFile(file: TownsFile): string {
  const head = (["source", "licence", "date", "regenerate"] as const).map((key) => `${JSON.stringify(key)}: ${JSON.stringify(file[key])}`);
  const towns = Object.entries(file.towns).map(
    ([key, rows]) => `${JSON.stringify(key)}: [\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]`,
  );
  const parts = file.parts.map((row) => JSON.stringify(row));
  const localities = Object.entries(file.localities).map(([country, names]) => `${JSON.stringify(country)}: ${JSON.stringify(names)}`);
  return [
    "{",
    head.map((line) => `${line},`).join("\n"),
    `"towns": {\n${towns.join(",\n")}\n},`,
    `"parts": [\n${parts.join(",\n")}\n],`,
    `"localities": {\n${localities.join(",\n")}\n}`,
    "}",
    "",
  ].join("\n");
}

/** The value of an option (`--date 2026-10-09`), and the arguments without it. */
function option(args: string[], name: string): { value: string | undefined; rest: string[] } {
  const at = args.indexOf(name);
  return at < 0 ? { value: undefined, rest: args } : { value: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

function main(args: string[]): void {
  const dated = option(args, "--date");
  const written = option(dated.rest, "--out");
  const files = written.rest;
  const date = dated.value ?? new Date().toISOString().slice(0, 10);
  if (files.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Usage: node tools/towns.ts <cities1000.txt> <places-live.jsonl> [--date YYYY-MM-DD] [--out <file>]");
  }
  const [geoPath, placesPath] = files as [string, string];

  const rows = readGeoNames(readFileSync(geoPath, "utf8"));
  const { places, skipped, older } = readPlaces(readFileSync(placesPath, "utf8"));
  const choice = chooseTowns(rows, places, ABSORBING);
  const text = formatTownsFile(townsFile(choice, { date, places: places.length }));

  const out = written.value ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "towns.json");
  writeFileSync(out, text);

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`Read ${rows.length} towns from GeoNames and ${places.length} places (${skipped} lines skipped, ${older} older versions of a place left out).`);
  console.log(`Wrote ${out}: ${choice.towns.length} towns and ${choice.parts.length} parts, ${kb(Buffer.byteLength(text))}.`);
  console.log(`${choice.placed} places have a town within ${TOWN_REACH_KM} km; ${choice.unplaced} have none.`);
  if (choice.astray > 0) console.log(`${choice.astray} places would be put in another town by the app than by this tool.`);
  console.log(`${choice.localities.length} localities of their own: ${choice.localities.map(({ country, locality }) => `${locality} (${country})`).join(", ")}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
