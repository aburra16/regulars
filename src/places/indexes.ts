import KDBush from "kdbush";
import MiniSearch from "minisearch";

import { config } from "../config.ts";
import { distanceKm } from "./distance.ts";
import { foldText } from "./fold.ts";
import { around, HALF_EARTH_KM, withinCounter } from "./geo.ts";
import { cuisinesOf, KIND_VOCABULARY, kindQueryReader, termsOfCategory } from "./kindQuery.ts";
import { cuisineLabel, FAMILY_SEARCH_TERMS, kindOf } from "./kinds.ts";
import type { Place } from "./place.ts";

export { formatDistance } from "./distance.ts";

/** A place and how far it is from the point that was asked about, in kilometres. */
export interface PlaceDistance {
  place: Place;
  km: number;
}

/** Places that share a name in a country. Each location is still its own place; the chain is for display. */
export interface Chain {
  /** `chainKey` of the name. With the country, it is what the chain's page is found by (see `chainSlug`). */
  key: string;
  /** An upper-case country code; empty for places that have none. */
  country: string;
  /** The spelling most of its places use. */
  name: string;
  /** In the order of the list of places. */
  places: Place[];
}

export interface City {
  name: string;
  /** An upper-case country code; empty when its places have none. */
  country: string;
  /** The region its places name, when they do: "KY" for Lexington, Kentucky. */
  region?: string;
  /** The median of the coordinates of the places in its main cluster. */
  lat: number;
  lon: number;
  /** The places in its main cluster. */
  count: number;
}

/** Rows of one chain, shown as one entry. */
export interface ChainGroup<T> {
  chain: Chain;
  nearby: T[];
}

export interface Indexes {
  /** The places within `radiusKm` of a point, nearest first; at most `limit` of them. Nothing for a point that is not a place on Earth. */
  near(lat: number, lon: number, radiusKm: number, limit?: number): PlaceDistance[];
  /**
   * The places that match every word of `q`, best match first and, among matches that are
   * about as good, nearest first. With `radiusKm`, only those within it. An empty query lists
   * the places near the point, as `near` does. Nothing for a point that is not a place on Earth.
   *
   * A kind query (see `isKindQuery`) lists every place of that kind, family or cuisine, and any
   * place with the words in its name, once each, purely by distance.
   */
  search(q: string, opts: { lat: number; lon: number; radiusKm?: number }): PlaceDistance[];
  /**
   * Whether every word of `q` names a kind of place or a family of them ("cafe", "bakeries", "ice
   * cream"), a word that means a family ("coffee", "bread"), or a cuisine that many places have
   * ("pizza", "coffee shop"; see `KIND_CUISINE_MIN`), ignoring case and accents. A label of
   * several words is one term. For these `search` goes by distance, since people who search so
   * mean the places near them.
   */
  isKindQuery(q: string): boolean;
  /** The chain a place belongs to; undefined unless two or more places in its country share its name. */
  chainOf(place: Place): Chain | undefined;
  /**
   * The chain a page is for: `slug` as `chainSlug` made it, or the same after a router has
   * decoded it. Undefined for a slug that is not a chain's.
   */
  chainBySlug(slug: string): Chain | undefined;
  /** Every chain, by `chainId(chain.key, chain.country)`. */
  chains: Map<string, Chain>;
  /** Towns with three or more places close together, those with the most first. */
  cities: City[];
  /** Places by their `d`, the last part of the route `/place/:d`. */
  byD: Map<string, Place>;
}

/** Names that stand for no name. A shared one says nothing about what two places have in common. */
const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set(["unnamed", "no name", "sin nombre", "sem nome", "noname"]);

const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([".", ",", ";", ":", "!"]);

/**
 * What makes two names the same chain: case, quotes, spacing and trailing punctuation do not.
 * The quotes are the right and left single quotation marks and the backtick; they read as '.
 */
export function chainKey(name: string): string {
  const text = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ");
  // A loop, not a pattern: a pattern for a trailing run is tried from every start, and a long
  // run of punctuation that is not at the end would take time in proportion to its square.
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || TRAILING_PUNCTUATION.has(text[end - 1]!))) end -= 1;
  return text.slice(0, end).trim();
}

/** A place's country as chains and cities read it: upper case, trimmed, empty when it has none. */
function countryOf(place: Place): string {
  return (place.country ?? "").trim().toUpperCase();
}

/** What a chain is found by in `Indexes.chains`: its country, a colon, and its key. */
export function chainId(key: string, country: string): string {
  return `${country}:${key}`;
}

/**
 * A chain as a piece of a URL: its country and its key, each encoded, with a colon between.
 * A colon in either is encoded, so the first one is always the one between them.
 */
export function chainSlug(chain: Pick<Chain, "key" | "country">): string {
  return `${encodeURIComponent(chain.country)}:${encodeURIComponent(chain.key)}`;
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

/** Orders names the way an English reader expects, whatever the machine's own language. */
const collator = new Intl.Collator("en");

function buildChains(places: readonly Place[]): Map<string, Chain> {
  const groups = new Map<string, { key: string; country: string; places: Place[] }>();
  for (const place of places) {
    const key = chainKey(place.name);
    if (key === "" || PLACEHOLDER_KEYS.has(key)) continue;
    const country = countryOf(place);
    const id = chainId(key, country);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, { key, country, places: [place] });
    else group.places.push(place);
  }
  const chains = new Map<string, Chain>();
  for (const [id, group] of groups) {
    if (group.places.length < 2) continue;
    chains.set(id, { ...group, name: commonest(group.places.map((place) => place.name.trim())) });
  }
  return chains;
}

/** How far a town reaches: places farther than this from its busiest spot are not counted in it. */
const CITY_RADIUS_KM = 25;

/** The places of `group` that are within the city radius of the one that has the most of them within it. */
function busiestCluster(group: readonly Place[]): Place[] {
  const tree = new KDBush(group.length);
  for (const place of group) tree.add(place.lon, place.lat);
  tree.finish();

  const countNear = withinCounter(tree);
  let busiest = 0;
  let most = -1;
  group.forEach((place, i) => {
    const count = countNear(place.lon, place.lat, CITY_RADIUS_KM);
    if (count > most) {
      busiest = i;
      most = count;
    }
  });

  const centre = group[busiest]!;
  return around(tree, centre.lon, centre.lat, undefined, CITY_RADIUS_KM)
    .sort((a, b) => a - b)
    .map((id) => group[id]!);
}

/**
 * Towns. Places are grouped by locality, region and country, since many towns share a name; of
 * each group only its busiest cluster counts, since a group can be spread over a continent.
 */
function buildCities(places: readonly Place[]): City[] {
  const groups = new Map<string, Place[]>();
  for (const place of places) {
    const locality = place.locality?.trim();
    if (locality === undefined || locality === "") continue;
    const region = place.region?.trim() ?? "";
    push(groups, [locality.toLowerCase(), region.toLowerCase(), countryOf(place)].join("\n"), place);
  }

  const cities: City[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const cluster = busiestCluster(group);
    if (cluster.length < 3) continue;
    const regions = cluster.flatMap((place) => (place.region?.trim() ? [place.region.trim()] : []));
    const city: City = {
      name: commonest(cluster.map((place) => place.locality!.trim())),
      country: countryOf(cluster[0]!),
      lat: median(cluster.map((place) => place.lat)),
      lon: median(cluster.map((place) => place.lon)),
      count: cluster.length,
    };
    if (regions.length > 0) city.region = commonest(regions);
    cities.push(city);
  }
  return cities.sort(
    (a, b) =>
      b.count - a.count ||
      collator.compare(a.name, b.name) ||
      collator.compare(a.region ?? "", b.region ?? "") ||
      collator.compare(a.country, b.country),
  );
}

/** What `cityLabel` reads of a city; a city saved on a device has no more than this and its coordinates. */
type CityName = Pick<City, "name" | "region" | "country">;

/**
 * `cityLabel` for every city of one list, which it reads once. Use it to label a whole list; for
 * one city, `cityLabel` is the same.
 */
export function cityLabeller(all: readonly City[]): (city: CityName) => string {
  const byName = new Map<string, City[]>();
  for (const other of all) push(byName, other.name.trim().toLowerCase(), other);
  return (city) => {
    const shared = byName
      .get(city.name.trim().toLowerCase())
      ?.some(
        (other) => !(other.name === city.name && other.region === city.region && other.country === city.country),
      );
    if (!shared) return city.name;
    const where = city.region ?? (city.country === "" ? undefined : city.country);
    return where === undefined ? city.name : `${city.name}, ${where}`;
  };
}

/**
 * What to call a city in a list of cities: its name, or, when another city in `all` has the
 * same name, the name and where it is: "Lexington, KY". That is the region, or the country
 * for a city with no region. A city that has neither is called by its name alone.
 */
export function cityLabel(city: CityName, all: readonly City[]): string {
  return cityLabeller(all)(city);
}

/** What a place is found by. The `id` is its position in the list of places. */
interface SearchDoc {
  id: number;
  name: string;
  kind: string;
  /** Words for the kind of place that its label does not say: "coffee" for a cafe. */
  terms: string;
  cuisine: string;
  locality: string;
  keywords: string;
}

function searchDoc(place: Place, id: number): SearchDoc {
  const kind = kindOf(place.category);
  return {
    id,
    name: place.name,
    kind: kind.label,
    terms: FAMILY_SEARCH_TERMS[kind.family] ?? "",
    cuisine: place.cuisine === undefined ? "" : cuisineLabel(place.cuisine),
    locality: place.locality ?? "",
    keywords: place.keywords.join(" "),
  };
}

/**
 * Scores are put in this many bands, each a part of the best score, and matches in the same
 * band are put in order of distance: a match that is almost as good as the best is as good.
 */
const SCORE_BANDS = 4;

/**
 * A cuisine makes a query a kind query only when at least this many places carry it, among any
 * of their cuisines. Free text in the data puts a stray tag on a place or two ("beer" on a
 * restaurant), and a word like that must still be searched for like any other, so that it finds
 * the breweries too. A cuisine below this is still found by the relevance search.
 */
export const KIND_CUISINE_MIN = 5;

/** Everything the screens look places up by, built once for a list of places. */
export function buildIndexes(places: readonly Place[]): Indexes {
  const tree = new KDBush(places.length);
  for (const place of places) tree.add(place.lon, place.lat);
  tree.finish();

  const finder = new MiniSearch<SearchDoc>({
    fields: ["name", "kind", "terms", "cuisine", "locality", "keywords"],
    storeFields: [],
    processTerm: foldText,
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: "AND", boost: { name: 3, cuisine: 2 } },
  });
  finder.addAll(places.map(searchDoc));

  const byD = new Map<string, Place>();
  for (const place of places) if (!byD.has(place.d)) byD.set(place.d, place);

  const chains = buildChains(places);

  // The places that answer to each term of a kind query, by their position in the list.
  const placesByTerm = new Map<string, number[]>();
  const placesWithCuisine = new Map<string, number>();
  places.forEach((place, id) => {
    const cuisines = cuisinesOf(place);
    for (const cuisine of cuisines) placesWithCuisine.set(cuisine, (placesWithCuisine.get(cuisine) ?? 0) + 1);
    for (const term of new Set([...termsOfCategory(place.category), ...cuisines])) push(placesByTerm, term, id);
  });
  // The words of a kind query: the kinds and families, and each cuisine that enough places have.
  const vocabulary = new Set(KIND_VOCABULARY);
  for (const [cuisine, count] of placesWithCuisine) if (count >= KIND_CUISINE_MIN) vocabulary.add(cuisine);
  const readKindQuery = kindQueryReader(vocabulary);

  const isLocation = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon);

  function near(lat: number, lon: number, radiusKm: number, limit?: number): PlaceDistance[] {
    // The tree reads a negative radius as its size, and a limit of zero as no limit.
    if (!isLocation(lat, lon) || !(radiusKm >= 0) || (limit !== undefined && !(limit > 0))) return [];
    // A distance with no end, or past the other side of the Earth, reaches every place.
    const reach = radiusKm >= HALF_EARTH_KM ? undefined : radiusKm;
    return around(tree, lon, lat, limit, reach)
      .map((id) => {
        const place = places[id]!;
        return { place, km: distanceKm(lat, lon, place.lat, place.lon) };
      })
      // The tree orders by its own arithmetic; this is the order the caller was promised.
      .sort((a, b) => a.km - b.km);
  }

  /** The places that answer to every term, and those with the query's words in their name, nearest first. */
  function searchKind(terms: string[], q: string, lat: number, lon: number, radiusKm: number | undefined): PlaceDistance[] {
    const [first = [], ...rest] = terms.map((term) => placesByTerm.get(term) ?? []);
    let ids = first;
    for (const list of rest) {
      const listed = new Set(list);
      ids = ids.filter((id) => listed.has(id));
    }
    const found = new Set(ids);
    // A name counts when a word of it starts with the word asked for; a word a letter away does not.
    for (const hit of finder.search(q, { fields: ["name"], fuzzy: false })) found.add(hit.id);

    const rows: PlaceDistance[] = [];
    for (const id of [...found].sort((a, b) => a - b)) {
      const place = places[id]!;
      const km = distanceKm(lat, lon, place.lat, place.lon);
      if (radiusKm === undefined || km <= radiusKm) rows.push({ place, km });
    }
    return rows.sort((a, b) => a.km - b.km);
  }

  function search(q: string, { lat, lon, radiusKm }: { lat: number; lon: number; radiusKm?: number }): PlaceDistance[] {
    if (!isLocation(lat, lon)) return [];
    if (q.trim() === "") return near(lat, lon, radiusKm ?? config.defaultCity.radiusKm);

    const kindTerms = readKindQuery(q);
    if (kindTerms !== undefined) return searchKind(kindTerms, q, lat, lon, radiusKm);

    const found: { place: Place; km: number; score: number }[] = [];
    for (const hit of finder.search(q)) {
      const place = places[hit.id]!;
      const km = distanceKm(lat, lon, place.lat, place.lon);
      if (radiusKm === undefined || km <= radiusKm) found.push({ place, km, score: hit.score });
    }
    // The hits come best first. Band the scores against the best one that is still in range.
    const top = found[0]?.score ?? 0;
    const band = (score: number) => (top > 0 ? Math.ceil((score / top) * SCORE_BANDS) : 0);
    return found
      .map(({ place, km, score }) => ({ place, km, band: band(score) }))
      .sort((a, b) => b.band - a.band || a.km - b.km)
      .map(({ place, km }) => ({ place, km }));
  }

  function chainBySlug(slug: string): Chain | undefined {
    const colon = slug.indexOf(":");
    if (colon < 0) return undefined;
    const lookup = (country: string, key: string) => chains.get(chainId(key, country.trim().toUpperCase()));
    // As a router gives it back, decoded. The key may hold colons of its own, but not the country.
    const decoded = lookup(slug.slice(0, colon), slug.slice(colon + 1));
    if (decoded !== undefined) return decoded;
    // As `chainSlug` made it, with both parts encoded.
    try {
      return lookup(decodeURIComponent(slug.slice(0, colon)), decodeURIComponent(slug.slice(colon + 1)));
    } catch {
      return undefined;
    }
  }

  const chainOf = (place: Place) => chains.get(chainId(chainKey(place.name), countryOf(place)));

  const isKindQuery = (q: string) => readKindQuery(q) !== undefined;

  return { near, search, isKindQuery, chainOf, chainBySlug, chains, cities: buildCities(places), byD };
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
