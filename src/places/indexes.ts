import { around } from "geokdbush-tk";
import KDBush from "kdbush";
import MiniSearch from "minisearch";

import { config } from "../config.ts";
import { distanceKm } from "./distance.ts";
import { cuisineLabel, kindOf } from "./kinds.ts";
import type { Place } from "./place.ts";

export { formatDistance } from "./distance.ts";

/** A place and how far it is from the point that was asked about, in kilometres. */
export interface PlaceDistance {
  place: Place;
  km: number;
}

/** Places that share a name. Each location is still its own place; the chain is for display. */
export interface Chain {
  /** `chainKey` of the name. It is what the chain's page is found by (see `chainSlug`). */
  key: string;
  /** The spelling most of its places use. */
  name: string;
  /** In the order of the list of places. */
  places: Place[];
}

export interface City {
  name: string;
  /** An upper-case country code; empty when its places have none. */
  country: string;
  /** The median of its places' coordinates. */
  lat: number;
  lon: number;
  count: number;
}

/** Rows of one chain, shown as one entry. */
export interface ChainGroup<T> {
  chain: Chain;
  nearby: T[];
}

export interface Indexes {
  /** The places within `radiusKm` of a point, nearest first; at most `limit` of them. */
  near(lat: number, lon: number, radiusKm: number, limit?: number): PlaceDistance[];
  /**
   * The places that match every word of `q`, best match first and, among matches that are
   * about as good, nearest first. With `radiusKm`, only those within it. An empty query lists
   * the places near the point, as `near` does.
   */
  search(q: string, opts: { lat: number; lon: number; radiusKm?: number }): PlaceDistance[];
  /** The chain a place belongs to; undefined unless two or more places share its name. */
  chainOf(place: Place): Chain | undefined;
  /**
   * The chain a page is for: `slug` as `chainSlug` made it, or the same after a router has
   * decoded it. Undefined for a slug that is not a chain's.
   */
  chainBySlug(slug: string): Chain | undefined;
  /** Every chain, by `Chain.key`. */
  chains: Map<string, Chain>;
  /** Localities with three or more places, those with the most first. */
  cities: City[];
  /** Places by their `d`, the last part of the route `/place/:d`. */
  byD: Map<string, Place>;
}

/**
 * What makes two names the same chain: case, quotes, spacing and trailing punctuation do not.
 * The quotes are the right and left single quotation marks and the backtick; they read as '.
 */
export function chainKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!]+$/, "")
    .trim();
}

/** A chain's key as a piece of a URL. */
export function chainSlug(key: string): string {
  return encodeURIComponent(key);
}

/** The value that comes up most often; the first of them to come up if there is a tie. */
function commonest(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0] ?? "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Adds `value` to the list at `key`, making the list when there is none. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function buildChains(places: readonly Place[]): Map<string, Chain> {
  const groups = new Map<string, Place[]>();
  for (const place of places) {
    const key = chainKey(place.name);
    // A name of nothing but punctuation says nothing about what two places have in common.
    if (key !== "") push(groups, key, place);
  }
  const chains = new Map<string, Chain>();
  for (const [key, group] of groups) {
    if (group.length >= 2) chains.set(key, { key, name: commonest(group.map((place) => place.name.trim())), places: group });
  }
  return chains;
}

function buildCities(places: readonly Place[]): City[] {
  const groups = new Map<string, { country: string; places: Place[] }>();
  for (const place of places) {
    const locality = place.locality?.trim();
    if (locality === undefined || locality === "") continue;
    const country = (place.country ?? "").trim().toUpperCase();
    const key = `${locality.toLowerCase()}\n${country}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { country, places: [place] });
    else group.places.push(place);
  }
  const cities: City[] = [];
  for (const { country, places: group } of groups.values()) {
    if (group.length < 3) continue;
    cities.push({
      name: commonest(group.map((place) => place.locality!.trim())),
      country,
      lat: median(group.map((place) => place.lat)),
      lon: median(group.map((place) => place.lon)),
      count: group.length,
    });
  }
  return cities.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * A word as the search sees it: lower case, with the accents of Latin letters taken off, so
 * "Sao" finds "São". Only the marks in the Combining Diacritical Marks block go. The marks
 * of other scripts stay: taking them off would make ペ the same as ヘ. Words are searched for
 * in this form on both sides, so nobody sees it.
 */
function searchTerm(term: string): string {
  return term
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** What a place is found by. The `id` is its position in the list of places. */
interface SearchDoc {
  id: number;
  name: string;
  kind: string;
  cuisine: string;
  locality: string;
  keywords: string;
}

function searchDoc(place: Place, id: number): SearchDoc {
  return {
    id,
    name: place.name,
    kind: kindOf(place.category).label,
    cuisine: place.cuisine === undefined ? "" : cuisineLabel(place.cuisine),
    locality: place.locality ?? "",
    keywords: place.keywords.join(" "),
  };
}

/**
 * Scores are rounded to a tenth of the best score, and matches in the same tenth are put in
 * order of distance: a match within about 10% of the best is as good as the best.
 */
const SCORE_BANDS = 10;

/** Everything the screens look places up by, built once for a list of places. */
export function buildIndexes(places: Place[]): Indexes {
  const tree = new KDBush(places.length);
  for (const place of places) tree.add(place.lon, place.lat);
  tree.finish();

  const finder = new MiniSearch<SearchDoc>({
    fields: ["name", "kind", "cuisine", "locality", "keywords"],
    storeFields: [],
    processTerm: searchTerm,
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: "AND", boost: { name: 3 } },
  });
  finder.addAll(places.map(searchDoc));

  const byD = new Map<string, Place>();
  for (const place of places) if (!byD.has(place.d)) byD.set(place.d, place);

  const chains = buildChains(places);

  function near(lat: number, lon: number, radiusKm: number, limit?: number): PlaceDistance[] {
    // The tree reads a negative radius as its size, and a limit of zero as no limit.
    if (!(radiusKm >= 0) || (limit !== undefined && !(limit > 0))) return [];
    return around(tree, lon, lat, limit, radiusKm)
      .map((id) => {
        const place = places[id]!;
        return { place, km: distanceKm(lat, lon, place.lat, place.lon) };
      })
      // The tree orders by its own arithmetic; this is the order the caller was promised.
      .sort((a, b) => a.km - b.km);
  }

  function search(q: string, { lat, lon, radiusKm }: { lat: number; lon: number; radiusKm?: number }): PlaceDistance[] {
    if (q.trim() === "") return near(lat, lon, radiusKm ?? config.defaultCity.radiusKm);

    const found: { place: Place; km: number; score: number }[] = [];
    for (const hit of finder.search(q)) {
      const place = places[hit.id]!;
      const km = distanceKm(lat, lon, place.lat, place.lon);
      if (radiusKm === undefined || km <= radiusKm) found.push({ place, km, score: hit.score });
    }
    // The hits come best first. Band the scores against the best one that is still in range.
    const top = found[0]?.score ?? 0;
    const band = (score: number) => (top > 0 ? Math.round((score / top) * SCORE_BANDS) : 0);
    return found
      .map(({ place, km, score }) => ({ place, km, band: band(score) }))
      .sort((a, b) => b.band - a.band || a.km - b.km)
      .map(({ place, km }) => ({ place, km }));
  }

  function chainBySlug(slug: string): Chain | undefined {
    const decoded = chains.get(slug);
    if (decoded !== undefined) return decoded;
    try {
      return chains.get(decodeURIComponent(slug));
    } catch {
      return undefined;
    }
  }

  return {
    near,
    search,
    chainOf: (place) => chains.get(chainKey(place.name)),
    chainBySlug,
    chains,
    cities: buildCities(places),
    byD,
  };
}

/**
 * Turns the rows of one chain into one entry, at the place of the first of them, which is
 * the nearest when the rows are by distance. A chain that has one row stays a plain row.
 */
export function groupForList<T extends { place: Place }>(rows: T[], idx: Indexes): (T | ChainGroup<T>)[] {
  const chainOfRow = rows.map((row) => idx.chainOf(row.place));
  const rowsOfChain = new Map<Chain, T[]>();
  rows.forEach((row, i) => {
    const chain = chainOfRow[i];
    if (chain !== undefined) push(rowsOfChain, chain, row);
  });

  const entries: (T | ChainGroup<T>)[] = [];
  const placed = new Set<Chain>();
  rows.forEach((row, i) => {
    const chain = chainOfRow[i];
    const nearby = chain === undefined ? undefined : rowsOfChain.get(chain);
    if (chain === undefined || nearby === undefined || nearby.length < 2) {
      entries.push(row);
    } else if (!placed.has(chain)) {
      placed.add(chain);
      entries.push({ chain, nearby });
    }
  });
  return entries;
}
