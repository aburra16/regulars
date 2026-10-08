import { copy } from "../copy/en.ts";
import { usesMiles } from "../places/distance.ts";
import { openState } from "../places/hours.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import { FAMILIES, type FamilyId, kindOf } from "../places/kinds.ts";

export const SORTS = ["score", "distance", "name"] as const;
export type Sort = (typeof SORTS)[number];

export interface Filters {
  /** Only the places that are open now. A place with no hours, or hours that cannot be read, stays: there is no telling. */
  open: boolean;
  /** Only places of these kinds, any of them; none chosen is every kind. */
  families: FamilyId[];
  /**
   * Only places within this many kilometres. It is one of the person's `withinChoices`; the address
   * always holds kilometres, whatever unit the person reads.
   */
  withinKm: number;
  /**
   * How the places are ordered. Missing is automatic, and is not in the address: a kind of place
   * ("cafe") is nearest first, words are best match first, as the index gives them. "distance" and
   * "name" are the person's own choice.
   */
  sort?: Sort;
}

/** One of the distances a person can limit a search to. */
export interface WithinChoice {
  /** What the address and the filter hold. */
  km: number;
  /** What the person reads, in their own unit: "3 mi", "5 km". */
  label: string;
}

const KILOMETRES: readonly WithinChoice[] = [1, 2, 5, 10, 25].map((km) => ({ km, label: `${km} ${copy.units.km}` }));

/** Half a mile, 1, 3, 5 and 15; each is kept as the kilometres it comes to, to a tenth. */
const MILES: readonly WithinChoice[] = [
  { km: 0.8, mi: 0.5 },
  { km: 1.6, mi: 1 },
  { km: 4.8, mi: 3 },
  { km: 8, mi: 5 },
  { km: 24, mi: 15 },
].map(({ km, mi }) => ({ km, label: `${mi} ${copy.units.mi}` }));

/**
 * The distances to choose from for a person's language, narrowest first: 1, 2, 5, 10 and 25
 * kilometres, or half a mile, 1, 3, 5 and 15 miles where distance is read in miles. The same list
 * each time for a unit.
 */
export function withinChoices(locale: string): readonly WithinChoice[] {
  return usesMiles(locale) ? MILES : KILOMETRES;
}

/** The widest choice, and the default: no limit short of a city's own radius. */
export function widestKm(locale: string): number {
  return withinChoices(locale).at(-1)!.km;
}

/**
 * The choice an address's distance stands for: the nearest one that is at least that far, so a
 * link made in another unit never shows fewer places than it meant; the widest when none is that
 * far, and when it is not a distance at all.
 */
export function snapWithin(km: number, locale: string): number {
  const choices = withinChoices(locale);
  if (!Number.isFinite(km) || km <= 0) return widestKm(locale);
  return (choices.find((choice) => choice.km >= km) ?? choices.at(-1)!).km;
}

/** A distance as the person reads it: its choice's label, or that of the choice it snaps to. */
export function withinLabel(km: number, locale: string): string {
  const snapped = snapWithin(km, locale);
  return withinChoices(locale).find((choice) => choice.km === snapped)!.label;
}

/** Whether anyone has a score to sort by. Not before sign in, which is all of M1. */
const SCORES_EXIST = false;

/**
 * The sort the person chose, if it can be had. My circle's score cannot while nobody has a score,
 * so it reads as no choice, and the page picks (see `Filters.sort`).
 */
export function sortInUse(filters: Filters): Sort | undefined {
  return filters.sort === "score" && !SCORES_EXIST ? undefined : filters.sort;
}

/** The filters when none is chosen: the widest distance, the sort left to the page. A new object each time. */
export function noFilters(locale: string): Filters {
  return { open: false, families: [], withinKm: widestKm(locale) };
}

/** Where each filter is kept in the address: `?open=1&kinds=cafes,bars&within=8&sort=name`. */
const PARAM = { open: "open", families: "kinds", withinKm: "within", sort: "sort" } as const;

const FAMILY_IDS: ReadonlySet<string> = new Set(FAMILIES.map((family) => family.id));

const isFamily = (id: string): id is FamilyId => FAMILY_IDS.has(id);
const isSort = (value: string | null): value is Sort => (SORTS as readonly (string | null)[]).includes(value);

/**
 * The filters an address holds, for a person who reads `locale`. Anything it gets wrong (a kind
 * that is not one of the ten, a sort that is not offered) is the default for that filter, since an
 * address can be typed or shared by anyone; a distance snaps to one of the person's choices.
 */
export function filtersFromParams(params: URLSearchParams, locale: string): Filters {
  const within = params.get(PARAM.withinKm);
  const sort = params.get(PARAM.sort);
  const kinds = (params.get(PARAM.families) ?? "").split(",").filter(isFamily);
  const filters: Filters = {
    open: params.get(PARAM.open) === "1",
    // Once each, in the order the address named them.
    families: [...new Set(kinds)],
    withinKm: within === null ? widestKm(locale) : snapWithin(Number(within), locale),
  };
  if (isSort(sort)) filters.sort = sort;
  return filters;
}

/** The address's text for these filters: only what is not the default, so no filters is no text. */
export function filtersToParams(filters: Filters, locale: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.open) params.set(PARAM.open, "1");
  if (filters.families.length > 0) params.set(PARAM.families, filters.families.join(","));
  if (filters.withinKm !== widestKm(locale)) params.set(PARAM.withinKm, String(filters.withinKm));
  if (filters.sort !== undefined) params.set(PARAM.sort, filters.sort);
  return params;
}

/** A copy of an address with these filters in it, whatever filters it had; the rest of it (the words searched for ...) is as it was. */
export function withFilters(params: URLSearchParams, filters: Filters, locale: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const wanted = filtersToParams(filters, locale);
  // A filter that was in the address stays where it was in it; one that is new goes at the end.
  for (const name of Object.values(PARAM)) {
    const value = wanted.get(name);
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  return next;
}

/** How many filters are on, as the Filters chip counts them: Open now, each kind and a distance. The sort is not one. */
export function filterCount(filters: Filters, locale: string): number {
  return Number(filters.open) + filters.families.length + Number(filters.withinKm !== widestKm(locale));
}

/**
 * What the filters page leaves in the history for the search page it returns to (as the `state` of
 * the navigation): the person has just been in a page of controls, not at a keyboard, so the search
 * field must not take the cursor and raise one over the results.
 */
export const FROM_FILTERS = { from: "filters" } as const;

export const cameFromFilters = (state: unknown): boolean =>
  typeof state === "object" && state !== null && "from" in state && state.from === FROM_FILTERS.from;

/** English reads names with accents and capitals as the same letters; the code order does not. */
const collator = new Intl.Collator("en");

/**
 * The rows that pass the filters, and how many closed places Open now left out: of the places that
 * pass every other filter, those that are closed at `now`. Rows are in the order of the sort:
 * "name" is A to Z (nearest first for places with one name), "distance" is nearest first (the
 * order they came in for places the same distance away). With no sort, and for My circle's score
 * while nobody has one, they stay in the order they came in, which is the index's: nearest first
 * for a kind of place, best match first for words. The rows it is given are not changed.
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
  const sort = sortInUse(filters);
  if (sort === "name") {
    kept.sort((a, b) => collator.compare(a.place.name, b.place.name) || a.km - b.km);
  } else if (sort === "distance") {
    kept.sort((a, b) => a.km - b.km);
  }
  return { rows: kept, hiddenClosed };
}
