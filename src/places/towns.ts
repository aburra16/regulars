import KDBush from "kdbush";

import { foldText } from "./fold.ts";
// geo.ts's distance, not distance.ts's: this module is tools/towns.ts's too, which runs in Node, where the copy and the config do not load.
import { distance, nearestWithin } from "./geo.ts";

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
 * A part of a town: a GeoNames town that its places say is in a bigger one, by their locality
 * ("Santa Luzia", whose places say Funchal), or a district of a capital that takes its districts in
 * (Chatuchak, in Bangkok). Its GeoNames id, its point, and the id of the town it is part of. A place
 * nearest a part is counted in that town.
 */
export type PartRow = [id: number, lat: number, lon: number, of: number];

/** src/data/towns.json. */
export interface TownsFile {
  source: string;
  licence: string;
  date: string;
  regenerate: string;
  /**
   * The towns, by the upper-case code of their country, and in the United States and Canada by the
   * code of their state or province after a hyphen: "PT", "US-MO", "CA-ON".
   */
  towns: Record<string, TownRow[]>;
  parts: PartRow[];
  /**
   * Localities that are towns of their own, folded (`foldName`), by the upper-case code of their
   * places' country ("" for none): places whose locality is one of these, three or more close
   * together, are a town by their locality (El Zonte), not in the town of the file around them.
   */
  localities: Record<string, string[]>;
  /** The GeoNames ids of the towns here that are their country's capital (PPLC). */
  capitals: number[];
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
  /** In the United States and Canada, its state or province: "MO", "ON". */
  region?: string;
  /** True for its country's capital. */
  capital?: true;
  lat: number;
  lon: number;
}

/** The towns of the file, read once and ready to put places in. */
export interface TownList {
  /** In the order of the file. */
  towns: readonly Town[];
  /** Every town's name and ASCII name, folded (`foldName`): the words that name a town of the list. */
  names: ReadonlySet<string>;
  /** Whether a place's locality, in its country (upper case, "" for none), is one of its own (`TownsFile.localities`). */
  ownLocality(country: string, locality: string): boolean;
  /**
   * The town a place at a point is counted in, as tools/towns.ts puts it there: the town within
   * `TOWN_REACH_KM` whose name or ASCII name, folded, is the place's locality, the nearest of them;
   * else the town, or part of one, nearest to the point within that reach, a part standing for its
   * town. Undefined when none is that near, or for a point that is not one.
   */
  townAt(lat: number, lon: number, locality?: string): Town | undefined;
}

/** The towns of a file. The parts are found only through the towns they belong to. */
export function readTowns(file: TownsFile): TownList {
  const towns: Town[] = [];
  const byId = new Map<number, Town>();
  for (const [key, rows] of Object.entries(file.towns)) {
    const [country = "", region] = key.split("-");
    for (const [id, name, lat, lon, ascii] of rows) {
      const town: Town = { id, name, country, lat, lon };
      if (ascii !== undefined) town.ascii = ascii;
      if (region !== undefined) town.region = region;
      towns.push(town);
      byId.set(id, town);
    }
  }
  for (const id of file.capitals ?? []) {
    const town = byId.get(id);
    if (town !== undefined) town.capital = true;
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

  // The towns by each of their names, folded, for a place's locality to find.
  const named = new Map<string, Town[]>();
  for (const town of towns) {
    for (const name of new Set([foldName(town.name), ...(town.ascii === undefined ? [] : [foldName(town.ascii)])])) {
      const list = named.get(name);
      if (list === undefined) named.set(name, [town]);
      else list.push(town);
    }
  }

  const own = new Set(Object.entries(file.localities ?? {}).flatMap(([country, names]) => names.map((name) => `${country}\n${name}`)));

  return {
    towns,
    names: new Set(named.keys()),
    ownLocality: (country, locality) => own.has(`${country}\n${foldName(locality)}`),
    townAt(lat, lon, locality) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
      let byName: { town: Town; km: number } | undefined;
      for (const town of named.get(foldName(locality ?? "")) ?? []) {
        const km = distance(lon, lat, town.lon, town.lat);
        if (km <= TOWN_REACH_KM && (byName === undefined || km < byName.km)) byName = { town, km };
      }
      if (byName !== undefined) return byName.town;
      // The nearest as tools/towns.ts finds it (`around`), by a cheaper walk: about 8,000 places are put in towns at each load.
      const nearest = nearestWithin(tree, lon, lat, TOWN_REACH_KM);
      return nearest === undefined ? undefined : standsFor[nearest];
    },
  };
}

/**
 * A reader of the towns that `load` gives (a module whose default export is the file), once, however
 * many ask: what it gives is the towns, or null when `load` failed or its file could not be read. A
 * call after a failure loads again. It never rejects.
 */
export function townsLoader(load: () => Promise<{ default: unknown }>): () => Promise<TownList | null> {
  let loading: Promise<TownList | null> | undefined;
  return () => {
    loading ??= load()
      // The file is the tool's, and tests/towns.test.ts checks its shape: TypeScript reads JSON's arrays as lists, not rows.
      .then((module) => readTowns(module.default as TownsFile))
      .catch(() => {
        loading = undefined;
        return null;
      });
    return loading;
  };
}

/**
 * The towns of src/data/towns.json, from its own chunk, fetched the first time this is called and
 * read once. Null when the chunk could not be loaded or read: the places then keep the towns their
 * localities name (see `buildIndexes`), and the next call tries again. It never rejects.
 */
export const loadTowns: () => Promise<TownList | null> = townsLoader(() => import("../data/towns.json"));
