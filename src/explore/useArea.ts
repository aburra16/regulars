import { useEffect, useMemo, useState } from "react";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { type Area, areaOf, type Bbox, boxHolds, placesInBox } from "../map/area.ts";
import type { Entry } from "../map/pins.ts";
import { distanceKm } from "../places/distance.ts";
import { openState } from "../places/hours.ts";
import { type City, cityLabel, groupForList } from "../places/indexes.ts";
import { type FamilyId, kindOf } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { TOWN_REACH_KM } from "../places/towns.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { applyFilters, type Filters, widestKm } from "../search/filters.ts";
import { recallMapPage, rememberMapPage, type SearchState } from "./mapMemory.ts";

/**
 * The most places the list of an area searched on the map holds: the nearest the middle of the map
 * (decision 25). The map has every place; the list says how many the area has when it holds fewer.
 */
export const LIST_LIMIT = 50;

/**
 * The most places whose hours a searched area's list reads with Open now, each time it is worked out
 * (a search, a filter, every minute). A place's hours take tens of microseconds to read (some places'
 * many more), so this keeps a pass within about a tenth of a second on a desktop, however many places
 * near the middle are closed (the middle of the night there).
 */
export const OPEN_NOW_HOURS_LIMIT = 2000;

/** What a map page lists, and how the person moves it to where the map is. */
export interface SearchedArea {
  /** The places listed: where the person is near, until they search an area of the map; then the box it showed. */
  area: Area;
  /** Whether the area is one the person searched on the map, not where they are near. */
  fromMap: boolean;
  /** Whether the person has moved the map since, so there is an area to search: show "Search this area". */
  canSearch: boolean;
  /** The person moved the map; this is what it shows, and its centre (the middle of the map as drawn). */
  moved(bbox: Bbox, centre: [lon: number, lat: number]): void;
  /** "Search this area": list the places where the map is now. */
  search(): void;
  /** Back to where the person is near, and nothing to search. */
  reset(): void;
}

/**
 * The area a map page lists the places of. It is where the person is near (`useHere`), as far as a
 * city reaches, until they move the map and press "Search this area"; then it is the box the map
 * shows, however far it reaches, around the map's centre (decision 25). When the place they are near
 * is chosen again (they pick a town, or are found), it starts again there, even at the same point.
 *
 * `memoryKey` is the page of the history it is on: Back to that page (from a place) finds the area
 * that was searched there (see mapMemory.ts).
 */
export function useSearchedArea(memoryKey: string): SearchedArea {
  const here = useHere();
  const near = `${here.lat},${here.lon},${here.choices}`;
  const [state, setState] = useState<SearchState>(() => {
    const saved = recallMapPage(memoryKey)?.search;
    return saved?.near === near ? saved : { near };
  });
  const current: SearchState = state.near === near ? state : { near };

  useEffect(() => {
    rememberMapPage(memoryKey, { search: current });
    // `current` is `state` while the person is near the same place, and a fresh start when not.
  }, [memoryKey, state, near]);

  const { searched } = current;
  const area = useMemo<Area>(
    () =>
      searched !== undefined
        ? areaOf(searched.box, searched.centre)
        : { lat: here.lat, lon: here.lon, radiusKm: config.defaultCity.radiusKm },
    [searched, here.lat, here.lon],
  );
  return {
    area,
    fromMap: searched !== undefined,
    canSearch: current.moved !== undefined,
    moved: (box, centre) => setState({ ...current, moved: { box, centre } }),
    search: () => {
      if (current.moved !== undefined) setState({ near, searched: current.moved });
    },
    reset: () => setState({ near }),
  };
}

/**
 * What the "Near …" control calls an area searched on the map, whose middle is at `lat`, `lon`: the
 * listed town nearest the middle within a town's reach (`TOWN_REACH_KM`), as the town picker names it
 * ("Lisbon"); or, with none so near, "this map area".
 */
export function areaName(lat: number, lon: number, cities: readonly City[]): string {
  let nearest: { city: City; km: number } | undefined;
  for (const city of cities) {
    const km = distanceKm(lat, lon, city.lat, city.lon);
    if (km <= TOWN_REACH_KM && (nearest === undefined || km < nearest.km)) nearest = { city, km };
  }
  return nearest === undefined ? copy.map.thisMapArea : cityLabel(nearest.city, cities);
}

/**
 * Has the "Near …" control name the area while it is one the person searched on the map (`areaName`),
 * since every distance on its list is from the area's middle; and where the person is near again once
 * the list is near there, or the page goes.
 */
export function useNameSearchedArea({ area, fromMap }: SearchedArea): void {
  const { nameArea } = useHere();
  const cities = useIndexes()?.cities;
  const name = useMemo(
    () => (fromMap && cities !== undefined ? areaName(area.lat, area.lon, cities) : undefined),
    [fromMap, cities, area.lat, area.lon],
  );
  useEffect(() => nameArea(name), [nameArea, name]);
  useEffect(() => () => nameArea(undefined), [nameArea]);
}

/** What an area lists. */
export interface AreaEntries {
  /** How many places the area has, before the filters: none says there is nothing in it at all. */
  placesInArea: number;
  /** The list: chains as one entry, and, for an area searched on the map, the `LIST_LIMIT` places nearest its middle. */
  entries: Entry[];
  /**
   * For an area searched on the map that has more places than the list holds: how many places it has
   * of the kinds, and within the distance, chosen. Open now is not counted: that would need every
   * place's hours, so the count is of places, open or not.
   */
  inArea?: number;
  /**
   * With Open now, the list stopped reading hours (`OPEN_NOW_HOURS_LIMIT`) before it found as many open
   * places as it holds: it has the open places nearest the middle, and there may be more farther out.
   */
  nearestOnly?: boolean;
  /** Where each distance is from: the area's centre, the place the "Near …" control names. */
  from: { lat: number; lon: number };
}

/**
 * Whether a place is of the kinds chosen and within the distance chosen from `from`: the filters that
 * cost nothing to ask, as `applyFilters` asks them. Open now is asked apart, of fewer places.
 */
function cheapFilter(families: readonly FamilyId[], withinKm: number, from: { lat: number; lon: number }): (place: Place) => boolean {
  const kinds = new Set(families);
  return (place) =>
    (kinds.size === 0 || kinds.has(kindOf(place.category).family)) &&
    (withinKm === Number.POSITIVE_INFINITY || distanceKm(from.lat, from.lon, place.lat, place.lon) <= withinKm);
}

/**
 * The places in an area, the same as Explore lists them: chains as one entry. Each has how far it is
 * from the area's centre, nearest it first: where the person is near (the device, or the town), or,
 * for an area searched on the map, the middle of the map, which the "Near …" control then names
 * (`Here.area`). Every distance is from the place the control names (Avi, 2026-10-09).
 *
 * With `filters`, only those that pass them, in their sort; a distance is measured the same way.
 * The widest distance is no limit: the area is the limit, so an area searched far away still lists
 * its places.
 *
 * An area searched on the map lists no more than `LIST_LIMIT` places: those nearest the middle of the
 * map that pass the filters, found by walking out from the middle and stopping at the first that many,
 * so Open now asks the hours of the places the walk reaches and not of every place in the area (the
 * whole world, zoomed out), and no more than `OPEN_NOW_HOURS_LIMIT` of them (`nearestOnly` says when it
 * stopped there). When there are more, it says how many places the area has (`inArea`), of the kinds
 * and within the distance chosen. A chain counts only the locations listed.
 */
export function useAreaEntries(area: Area, filters?: Filters): AreaEntries {
  const indexes = useIndexes();
  const now = useNow();
  const locale = useLocale();
  const { lat, lon, radiusKm, box } = area;
  const from = useMemo(() => ({ lat, lon }), [lat, lon]);
  const widest = widestKm(locale);
  const withinKm = filters === undefined || filters.withinKm >= widest ? Number.POSITIVE_INFINITY : filters.withinKm;
  const familiesKey = filters?.families.join(",") ?? "";

  // Where the person is near: every place within a city's reach, nearest first, filtered as a whole.
  const nearby = useMemo(
    () => (indexes === undefined || radiusKm === undefined ? [] : indexes.near(lat, lon, radiusKm)),
    [indexes, lat, lon, radiusKm],
  );

  // A searched box: its places, and how many pass the filters that cost nothing. Not hung on the minute.
  const boxed = useMemo(() => {
    if (indexes === undefined || box === undefined) return undefined;
    const places = placesInBox(indexes, box);
    const keeps = cheapFilter(familiesKey === "" ? [] : (familiesKey.split(",") as FamilyId[]), withinKm, from);
    let passing = 0;
    for (const place of places) if (keeps(place)) passing += 1;
    return { places: places.length, passing, keeps, holds: boxHolds(box) };
  }, [indexes, box, familiesKey, withinKm, from]);

  // The minute matters to the list only when it is asked which places are open.
  const openAt = filters?.open === true ? now : null;
  return useMemo(() => {
    if (indexes === undefined) return { placesInArea: 0, entries: [], from };
    if (boxed === undefined) {
      // Filter first, then group: a chain counts only the locations that stay.
      const rows = filters === undefined ? nearby : applyFilters(nearby, { ...filters, withinKm }, now).rows;
      return { placesInArea: nearby.length, entries: groupForList(rows, indexes), from };
    }
    // Walk out from the middle of the map, one more than the list holds, to know whether it holds them all.
    // The walk asks the test of each place it reaches: `around` asks it of every place of each part of
    // the tree it opens, as it opens it, so it is asked of more places than it keeps. Hence a count of the
    // hours read, and a limit: past it, a place is not read, and not kept, and the walk goes on through
    // the rest at the cost of the box and the cheap filters alone.
    const { keeps, holds } = boxed;
    let hoursRead = 0;
    const found = indexes.nearestWhere(lat, lon, LIST_LIMIT + 1, (place) => {
      if (!holds(place.lat, place.lon) || !keeps(place)) return false;
      if (openAt === null) return true;
      if (hoursRead >= OPEN_NOW_HOURS_LIMIT) return false;
      hoursRead += 1;
      return openState(place, openAt).kind !== "closed";
    });
    const stopped = openAt !== null && hoursRead >= OPEN_NOW_HOURS_LIMIT && found.length <= LIST_LIMIT;
    const rows = found
      .slice(0, LIST_LIMIT)
      .map((place) => ({ place, km: distanceKm(lat, lon, place.lat, place.lon) }))
      .sort((a, b) => a.km - b.km);
    // Nearest first, as the walk found them, unless the sort says otherwise (A to Z; House picks' is the page's).
    const sorted = filters?.sort === "name" ? applyFilters(rows, { open: false, families: [], withinKm: Number.POSITIVE_INFINITY, sort: "name" }, now).rows : rows;
    const entries = groupForList(sorted, indexes);
    if (found.length > LIST_LIMIT) return { placesInArea: boxed.places, entries, inArea: boxed.passing, from };
    return stopped ? { placesInArea: boxed.places, entries, nearestOnly: true, from } : { placesInArea: boxed.places, entries, from };
    // `now` is a dependency through `openAt`: it changes the list only while Open now is on.
  }, [indexes, nearby, boxed, filters, withinKm, openAt, lat, lon, from]);
}
