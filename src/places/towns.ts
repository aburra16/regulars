import KDBush from "kdbush";

import { foldText } from "./fold.ts";
import { nearestWithin } from "./geo.ts";

/*
 * The towns the places are put in: src/data/towns.json, which tools/towns.ts cuts down from GeoNames'
 * list of towns (cities1000, CC BY 4.0). The app reads the file as it is; it never asks GeoNames
 * anything. The file is a chunk of its own, loaded with the places (`loadTowns`), so the first
 * screen's code does not carry it.
 */

/** How far from a town's point a place may be and still be counted in it, in kilometres. */
export const TOWN_REACH_KM = 30;

/** A name as towns are matched by it: folded (`foldText`), with each run of spaces as one and none at either end. */
export const foldName = (name: string): string => foldText(name).replace(/\s+/g, " ").trim();

/**
 * A town as the file has it: its GeoNames id, its name as GeoNames gives it (most often the English
 * or international one: "Prague"), its point to four decimals, and its ASCII name when that is not
 * the name with its accents taken off ("Lodz" for "Łódź").
 */
export type TownRow = [id: number, name: string, lat: number, lon: number, ascii?: string];

/**
 * A part of a town: a GeoNames town that most of its places say is in a bigger one, by their
 * locality ("Santa Luzia", whose places say Funchal). Its GeoNames id, its point, and the id of the
 * town it is part of. A place nearest a part is counted in that town.
 */
export type PartRow = [id: number, lat: number, lon: number, of: number];

/** src/data/towns.json. */
export interface TownsFile {
  source: string;
  licence: string;
  date: string;
  regenerate: string;
  /** Each country's name in English, by its upper-case code, for the countries that have towns here. */
  countries: Record<string, string>;
  /** The towns, by the upper-case code of their country. */
  towns: Record<string, TownRow[]>;
  parts: PartRow[];
}

/** A town of the file. */
export interface Town {
  /** Its GeoNames id. */
  id: number;
  name: string;
  /** Its ASCII name, when that is not its name with the accents taken off. */
  ascii?: string;
  /** An upper-case country code. */
  country: string;
  lat: number;
  lon: number;
}

/** The towns of the file, read once and ready to put places in. */
export interface TownList {
  /** In the order of the file. */
  towns: readonly Town[];
  /** Every town's name and ASCII name, folded (`foldName`): the words that name a town of the list. */
  names: ReadonlySet<string>;
  /** A country's name in English ("Czechia"), or undefined for a code the file has no name for. */
  countryName(code: string): string | undefined;
  /**
   * The town a point is counted in: the town, or part of one, nearest to it, within `TOWN_REACH_KM`;
   * a part stands for its town. Undefined when none is that near, or for a point that is not one.
   */
  townAt(lat: number, lon: number): Town | undefined;
}

/** The towns of a file. The parts are found only through the towns they belong to. */
export function readTowns(file: TownsFile): TownList {
  const towns: Town[] = [];
  const byId = new Map<number, Town>();
  for (const [country, rows] of Object.entries(file.towns)) {
    for (const [id, name, lat, lon, ascii] of rows) {
      const town: Town = ascii === undefined ? { id, name, country, lat, lon } : { id, name, ascii, country, lat, lon };
      towns.push(town);
      byId.set(id, town);
    }
  }
  // A part whose town is not in the file is left out: it stands for nothing.
  const parts = file.parts.flatMap(([, lat, lon, of]) => {
    const town = byId.get(of);
    return town === undefined ? [] : [{ lat, lon, town }];
  });

  // One tree of the towns' points and the parts': each point stands for a town.
  const standsFor: Town[] = [...towns, ...parts.map((part) => part.town)];
  const tree = new KDBush(standsFor.length);
  for (const town of towns) tree.add(town.lon, town.lat);
  for (const part of parts) tree.add(part.lon, part.lat);
  tree.finish();

  const names = new Set<string>();
  for (const town of towns) {
    names.add(foldName(town.name));
    if (town.ascii !== undefined) names.add(foldName(town.ascii));
  }
  const countries = new Map(Object.entries(file.countries));

  return {
    towns,
    names,
    countryName: (code) => countries.get(code),
    townAt(lat, lon) {
      // The nearest as tools/towns.ts finds it (`around`), by a cheaper walk: about 8,000 places are put in towns at each load.
      const nearest = nearestWithin(tree, lon, lat, TOWN_REACH_KM);
      return nearest === undefined ? undefined : standsFor[nearest];
    },
  };
}

/** The towns once read, or the read under way: one for the app, however many ask. */
let loading: Promise<TownList | null> | undefined;

/**
 * The towns of src/data/towns.json, from its own chunk, fetched the first time this is called and
 * read once. Null when the chunk could not be loaded or read: the places then keep the towns their
 * localities name (see `buildIndexes`), and the next call tries again. It never rejects.
 */
export function loadTowns(): Promise<TownList | null> {
  loading ??= import("../data/towns.json")
    // The file is the tool's, and tests/towns.test.ts checks its shape: TypeScript reads JSON's arrays as lists, not rows.
    .then((module) => readTowns(module.default as unknown as TownsFile))
    .catch(() => {
      // The next places to load try again.
      loading = undefined;
      return null;
    });
  return loading;
}
