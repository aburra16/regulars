import { openState } from "../places/hours.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import { FAMILIES, type FamilyId, kindOf } from "../places/kinds.ts";

/** The distances a search can be limited to, in kilometres. The widest is the default: it is the radius of a city. */
export const WITHIN_KM = [1, 2, 5, 10, 25] as const;
export type WithinKm = (typeof WITHIN_KM)[number];

export const SORTS = ["score", "distance", "name"] as const;
export type Sort = (typeof SORTS)[number];

export interface Filters {
  /** Only the places that are open now. A place with no hours, or hours that cannot be read, stays: there is no telling. */
  open: boolean;
  /** Only places of these kinds, any of them; none chosen is every kind. */
  families: FamilyId[];
  withinKm: WithinKm;
  sort: Sort;
}

/** The widest distance, and the default: no limit short of the city's own radius. */
export const WIDEST_KM: WithinKm = 25;

/** Whether anyone has a score to sort by. Not before sign in, which is all of M1. */
const SCORES_EXIST = false;

/**
 * In M1 nobody has a score, so the list starts from the nearest place. Once a person has signed in
 * it starts from My circle's score, and this is the one place that says so.
 */
const DEFAULT_SORT: Sort = "distance";

/** The sort that is in use: the one asked for, but My circle's score only when anyone has one. */
export function sortInUse(filters: Filters): Sort {
  return filters.sort === "score" && !SCORES_EXIST ? "distance" : filters.sort;
}

/** The filters when none is chosen. A new object each time, so a caller can keep and change it. */
export function noFilters(): Filters {
  return { open: false, families: [], withinKm: WIDEST_KM, sort: DEFAULT_SORT };
}

/** Where each filter is kept in the address: `?open=1&kinds=cafes,bars&within=5&sort=name`. */
const PARAM = { open: "open", families: "kinds", withinKm: "within", sort: "sort" } as const;

const FAMILY_IDS: ReadonlySet<string> = new Set(FAMILIES.map((family) => family.id));

const isFamily = (id: string): id is FamilyId => FAMILY_IDS.has(id);
const isWithin = (km: number): km is WithinKm => (WITHIN_KM as readonly number[]).includes(km);
const isSort = (value: string | null): value is Sort => (SORTS as readonly (string | null)[]).includes(value);

/**
 * The filters an address holds. Anything it gets wrong (a distance that is not one of the five, a
 * kind that is not one of the ten, a sort that is not offered) is the default for that filter,
 * since an address can be typed or shared by anyone.
 */
export function filtersFromParams(params: URLSearchParams): Filters {
  const within = Number(params.get(PARAM.withinKm));
  const sort = params.get(PARAM.sort);
  const kinds = (params.get(PARAM.families) ?? "").split(",").filter(isFamily);
  return {
    open: params.get(PARAM.open) === "1",
    // Once each, in the order the address named them.
    families: [...new Set(kinds)],
    withinKm: isWithin(within) ? within : WIDEST_KM,
    sort: isSort(sort) ? sort : DEFAULT_SORT,
  };
}

/** The address's text for these filters: only what is not the default, so no filters is no text. */
export function filtersToParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.open) params.set(PARAM.open, "1");
  if (filters.families.length > 0) params.set(PARAM.families, filters.families.join(","));
  if (filters.withinKm !== WIDEST_KM) params.set(PARAM.withinKm, String(filters.withinKm));
  if (filters.sort !== DEFAULT_SORT) params.set(PARAM.sort, filters.sort);
  return params;
}

/** A copy of an address with these filters in it, whatever filters it had; the rest of it (the words searched for ...) is as it was. */
export function withFilters(params: URLSearchParams, filters: Filters): URLSearchParams {
  const next = new URLSearchParams(params);
  const wanted = filtersToParams(filters);
  // A filter that was in the address stays where it was in it; one that is new goes at the end.
  for (const name of Object.values(PARAM)) {
    const value = wanted.get(name);
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  return next;
}

/** How many filters are on, as the Filters chip counts them: Open now, each kind and a distance. The sort is not one. */
export function filterCount(filters: Filters): number {
  return Number(filters.open) + filters.families.length + Number(filters.withinKm !== WIDEST_KM);
}

/** English reads names with accents and capitals as the same letters; the code order does not. */
const collator = new Intl.Collator("en");

/**
 * The rows that pass the filters, and how many closed places Open now left out: of the places that
 * pass every other filter, those that are closed at `now`. Rows are in the order of the sort
 * ("name" is A to Z, nearest first for places with one name; "distance", and "score" while nobody
 * has one, is nearest first, the order they came in for places the same distance away). The rows
 * it is given are not changed.
 */
export function applyFilters(
  rows: readonly PlaceDistance[],
  filters: Filters,
  now: Date,
): { rows: PlaceDistance[]; hiddenClosed: number } {
  const families = new Set<FamilyId>(filters.families);
  const kept: PlaceDistance[] = [];
  let hiddenClosed = 0;
  for (const row of rows) {
    if (families.size > 0 && !families.has(kindOf(row.place.category).family)) continue;
    if (row.km > filters.withinKm) continue;
    if (filters.open && openState(row.place, now).kind === "closed") {
      hiddenClosed += 1;
      continue;
    }
    kept.push(row);
  }
  const byName = (a: PlaceDistance, b: PlaceDistance) => collator.compare(a.place.name, b.place.name) || a.km - b.km;
  return { rows: kept.sort(filters.sort === "name" ? byName : (a, b) => a.km - b.km), hiddenClosed };
}
