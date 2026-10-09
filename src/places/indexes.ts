import KDBush from "kdbush";
import MiniSearch from "minisearch";

import { config } from "../config.ts";
import { distanceKm } from "./distance.ts";
import { foldText } from "./fold.ts";
import { around, HALF_EARTH_KM, withinCounter } from "./geo.ts";
import { cuisinesOf, KIND_VOCABULARY, kindQueryReader, termsOfCategory } from "./kindQuery.ts";
import { cuisineLabel, FAMILY_SEARCH_TERMS, kindOf } from "./kinds.ts";
import type { Place } from "./place.ts";
import { foldName, type Town, type TownList } from "./towns.ts";

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

/**
 * A town the places are in: one of src/data/towns.json (GeoNames'), or, for places no town of it is
 * near, a locality that three or more of them name (see `Indexes.cities`).
 */
export interface City {
  /** GeoNames' name for it ("Prague"), or the locality's commonest spelling. */
  name: string;
  /** An upper-case country code; empty when its places have none. */
  country: string;
  /** The region its places name, when they do: "KY" for Lexington, Kentucky. */
  region?: string;
  /** The town's point in GeoNames; for a locality, the median of the coordinates of the places in its main cluster. */
  lat: number;
  lon: number;
  /** The places in it. */
  count: number;
  /** Its GeoNames id; absent for a locality. */
  geonameId?: number;
  /** True for a country's capital (GeoNames' PPLC); absent for any other town. */
  capital?: true;
  /**
   * The other names it is found by, folded (`foldName`), and never shown: its ASCII name where that
   * is not its name without accents ("lodz"), the names of the towns and districts it takes in
   * ("areeiro" for Lisbon, "shibuya" for Tokyo), and the localities its places give it that are not the
   * name of another town of the file ("praha", "praha 10" for Prague). Absent for a locality.
   */
  aliases?: string[];
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
   * The places from `west` to `east` and from `south` to `north`, in degrees, edges included, in no
   * order: a box on the Earth that does not cross the 180th meridian (`placesInBox`, in
   * src/map/area.ts, reads a map's box as these). Nothing for a box that is not one.
   */
  inRange(west: number, south: number, east: number, north: number): Place[];
  /**
   * The `limit` places nearest a point that `keep` keeps, nearest first, walking out from the point:
   * `keep` is asked about the places the walk reaches, not every place, so a costly test (whether a
   * place is open) is asked of few when many pass. It is asked once of each place of each part of the
   * tree the walk opens (up to 64 at a time), as it opens it: of more places than it keeps, and, when
   * fewer than `limit` pass, of every place. A caller with a costly test counts, and stops asking.
   * Nothing for a point that is not a place on Earth.
   */
  nearestWhere(lat: number, lon: number, limit: number, keep: (place: Place) => boolean): Place[];
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
  /**
   * The towns the places are in, those with the most places first. A place is in the town of
   * src/data/towns.json that its locality names within 30 km (`TOWN_REACH_KM`), else the one nearest to
   * it within 30 km (a part of a town stands for the town); but a locality the file lists as one of
   * its own, that three or more places name, close together, is a town of its own, as El Zonte is.
   * The places no town of the file is near are grouped by their locality, as are all the places when
   * the towns could not be loaded: a locality that three or more of them name, close together, is a
   * town. A town with no places is not here.
   */
  cities: City[];
  /** The town of `cities` a place is in; undefined for a place in none. */
  townOf(place: Place): City | undefined;
  /**
   * The places farther than `beyondKm` from a point whose names have every word of `q` (each word the
   * start of a word of the name), best match first and, among matches that are about as good, nearest
   * first; at most `limit`. Nothing for a kind query (`isKindQuery`), for no words, or for a point that
   * is not a place on Earth. Only the name is searched: a place is found here by what it is called.
   */
  elsewhere(q: string, opts: { lat: number; lon: number; beyondKm: number; limit: number }): PlaceDistance[];
  /** Places by their `d`, the last part of the route `/place/:d`. */
  byD: Map<string, Place>;
  /** Places by their address (`39999:<curator>:<d>`), which a map's pin is known by. */
  byAddress: Map<string, Place>;
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

/** A town named by its places' locality: those of `cluster`, which share one, close together. */
function localityCity(cluster: readonly Place[]): City {
  const regions = cluster.flatMap((place) => (place.region?.trim() ? [place.region.trim()] : []));
  const city: City = {
    name: commonest(cluster.map((place) => place.locality!.trim())),
    country: countryOf(cluster[0]!),
    lat: median(cluster.map((place) => place.lat)),
    lon: median(cluster.map((place) => place.lon)),
    count: cluster.length,
  };
  if (regions.length > 0) city.region = commonest(regions);
  return city;
}

/**
 * Towns by locality. Places are grouped by locality, region and country, since many towns share a
 * name; of each group only its busiest cluster counts, since a group can be spread over a continent.
 * Each place of a town is put in `townOf`. In no order.
 */
function localityTowns(places: readonly Place[], townOf: Map<Place, City>): City[] {
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
    const city = localityCity(cluster);
    cities.push(city);
    for (const place of cluster) townOf.set(place, city);
  }
  return cities;
}

/**
 * Localities that stay towns of their own, as they were before the towns of the file: those the file
 * lists (`TownList.ownLocality`; tools/towns.ts lists El Zonte, a beach whose places are nearest La
 * Libertad's point, 13 km away). Their places in the towns of the file are grouped by locality and
 * country, and three or more close together are a town as a locality is (`localityCity`); they are
 * taken out of the towns they were in (`inTown`, which this changes) and put in `townOf`.
 */
function ownLocalities(inTown: Map<Town, Place[]>, towns: TownList, townOf: Map<Place, City>): City[] {
  const groups = new Map<string, Place[]>();
  for (const own of inTown.values()) {
    for (const place of own) {
      const locality = place.locality?.trim() ?? "";
      if (locality !== "" && towns.ownLocality(countryOf(place), locality)) push(groups, `${foldName(locality)}\n${countryOf(place)}`, place);
    }
  }

  const cities: City[] = [];
  const moved = new Set<Place>();
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const cluster = busiestCluster(group);
    if (cluster.length < 3) continue;
    const city = localityCity(cluster);
    cities.push(city);
    for (const place of cluster) {
      townOf.set(place, city);
      moved.add(place);
    }
  }
  if (moved.size > 0) {
    for (const [town, own] of inTown) {
      const left = own.filter((place) => !moved.has(place));
      if (left.length > 0) inTown.set(town, left);
      else inTown.delete(town);
    }
  }
  return cities;
}

/**
 * The town of src/data/towns.json that `own` are in: called by GeoNames' name, at GeoNames' point,
 * with its state or province in the United States and Canada, else the region most of its places name,
 * and the other names it is found by (see `City.aliases`): the names of the towns and districts it
 * takes in, and its places' localities. A locality that is the name of another town
 * of the file, or that name and more after a comma, is that town's, never this one's: one odd tag does
 * not make two towns one.
 */
function fileTown(town: Town, own: readonly Place[], towns: TownList): City {
  const names = new Set([foldName(town.name)]);
  const aliases = new Set<string>();
  if (town.ascii !== undefined) {
    const ascii = foldName(town.ascii);
    names.add(ascii);
    aliases.add(ascii);
  }
  // The names of the towns and districts it takes in ("Areeiro" for Lisbon, "Shibuya" for Tokyo), but
  // never one that is another listed town's name: a Glendale Denver took in is not the Glendale listed.
  for (const name of town.takenIn ?? []) if (!names.has(name) && !towns.names.has(name)) aliases.add(name);
  for (const place of own) {
    const locality = foldName(place.locality ?? "");
    if (locality === "" || names.has(locality)) continue;
    // Another town's name, or one with its country after a comma ("San Salvador, El Salvador"), is that town's.
    const beforeComma = locality.split(",")[0]!.trim();
    if (!towns.names.has(locality) && !towns.names.has(beforeComma)) aliases.add(locality);
  }
  const city: City = { name: town.name, country: town.country, lat: town.lat, lon: town.lon, count: own.length, geonameId: town.id };
  if (town.capital === true) city.capital = true;
  const regions = own.flatMap((place) => (place.region?.trim() ? [place.region.trim()] : []));
  if (town.region !== undefined) city.region = town.region;
  else if (regions.length > 0) city.region = commonest(regions);
  city.aliases = [...aliases].sort();
  return city;
}

/**
 * The towns the places are in, and the town of each place that is in one (see `Indexes.cities`):
 * with `towns`, each place's town of the file (`TownList.townAt`), but for the localities that are
 * towns of their own (`ownLocalities`), and towns by locality for the places no town of the file is
 * near; without, towns by locality for all of them.
 */
function buildCities(places: readonly Place[], towns: TownList | null | undefined): { cities: City[]; townOf: Map<Place, City> } {
  const townOf = new Map<Place, City>();
  const cities: City[] = [];
  let rest: readonly Place[] = places;
  if (towns !== null && towns !== undefined) {
    const inTown = new Map<Town, Place[]>();
    const far: Place[] = [];
    for (const place of places) {
      const town = towns.townAt(place.lat, place.lon, place.locality);
      if (town === undefined) far.push(place);
      else push(inTown, town, place);
    }
    cities.push(...ownLocalities(inTown, towns, townOf));
    for (const [town, own] of inTown) {
      const city = fileTown(town, own, towns);
      cities.push(city);
      for (const place of own) townOf.set(place, city);
    }
    rest = far;
  }
  cities.push(...localityTowns(rest, townOf));
  cities.sort(
    (a, b) =>
      b.count - a.count ||
      collator.compare(a.name, b.name) ||
      collator.compare(a.region ?? "", b.region ?? "") ||
      collator.compare(a.country, b.country) ||
      (a.geonameId ?? 0) - (b.geonameId ?? 0),
  );
  return { cities, townOf };
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

/** A place the relevance search found, how far it is, and how well it matched. */
interface ScoredHit {
  place: Place;
  km: number;
  score: number;
}

/**
 * Hits that come best first, in bands of their scores against the best of them (`SCORE_BANDS`),
 * nearest first within a band.
 */
function bestFirst(found: readonly ScoredHit[]): PlaceDistance[] {
  const top = found[0]?.score ?? 0;
  const band = (score: number) => (top > 0 ? Math.ceil((score / top) * SCORE_BANDS) : 0);
  return found
    .map(({ place, km, score }) => ({ place, km, band: band(score) }))
    .sort((a, b) => b.band - a.band || a.km - b.km)
    .map(({ place, km }) => ({ place, km }));
}

/**
 * A cuisine makes a query a kind query only when at least this many places carry it, among any
 * of their cuisines. Free text in the data puts a stray tag on a place or two ("beer" on a
 * restaurant), and a word like that must still be searched for like any other, so that it finds
 * the breweries too. A cuisine below this is still found by the relevance search.
 */
export const KIND_CUISINE_MIN = 5;

/**
 * Everything the screens look places up by, built once for a list of places, with the towns of
 * src/data/towns.json when they are given (`loadTowns`). Without them (none given, or null: they could
 * not be loaded), the towns are the places' localities.
 */
export function buildIndexes(places: readonly Place[], towns?: TownList | null): Indexes {
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
  const byAddress = new Map<string, Place>();
  for (const place of places) if (!byAddress.has(place.address)) byAddress.set(place.address, place);

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

  function inRange(west: number, south: number, east: number, north: number): Place[] {
    // The tree takes any numbers; a box with an edge that is not a number holds nothing.
    if (![west, south, east, north].every(Number.isFinite) || west > east || south > north) return [];
    return tree.range(west, south, east, north).map((id) => places[id]!);
  }

  function nearestWhere(lat: number, lon: number, limit: number, keep: (place: Place) => boolean): Place[] {
    if (!isLocation(lat, lon) || !(limit > 0)) return [];
    return around(tree, lon, lat, limit, undefined, (id) => keep(places[id]!)).map((id) => places[id]!);
  }

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

    const found: ScoredHit[] = [];
    for (const hit of finder.search(q)) {
      const place = places[hit.id]!;
      const km = distanceKm(lat, lon, place.lat, place.lon);
      if (radiusKm === undefined || km <= radiusKm) found.push({ place, km, score: hit.score });
    }
    return bestFirst(found);
  }

  function elsewhere(
    q: string,
    { lat, lon, beyondKm, limit }: { lat: number; lon: number; beyondKm: number; limit: number },
  ): PlaceDistance[] {
    if (!isLocation(lat, lon) || q.trim() === "" || !(limit > 0) || readKindQuery(q) !== undefined) return [];
    const found: ScoredHit[] = [];
    // A word of the name that starts with each word asked for; a word a letter away does not count.
    for (const hit of finder.search(q, { fields: ["name"], fuzzy: false })) {
      const place = places[hit.id]!;
      const km = distanceKm(lat, lon, place.lat, place.lon);
      if (km > beyondKm) found.push({ place, km, score: hit.score });
    }
    return bestFirst(found).slice(0, limit);
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

  const { cities, townOf } = buildCities(places, towns);

  return {
    near,
    inRange,
    nearestWhere,
    search,
    elsewhere,
    isKindQuery,
    chainOf,
    chainBySlug,
    chains,
    cities,
    townOf: (place) => townOf.get(place),
    byD,
    byAddress,
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

/**
 * How many places a list holds: a chain shown as one entry counts each of its locations in the list.
 * It is the one way the app counts "N places": the results' line, the filters' button and the desktop's line.
 */
export function placeCount<T extends { place: Place }>(entries: readonly (T | ChainGroup<T>)[]): number {
  let count = 0;
  for (const entry of entries) count += "chain" in entry ? entry.nearby.length : 1;
  return count;
}
