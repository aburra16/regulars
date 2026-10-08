import { useEffect, useMemo, useState } from "react";

import { config } from "../config.ts";
import { useHere } from "../location/useLocation.ts";
import { type Area, areaOf, type Bbox, placesInBox } from "../map/area.ts";
import type { Entry } from "../map/pins.ts";
import { distanceKm } from "../places/distance.ts";
import { groupForList, type Indexes, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { applyFilters, type Filters, widestKm } from "../search/filters.ts";
import { recallMapPage, rememberMapPage, type SearchState } from "./mapMemory.ts";

/**
 * The most places the list of an area searched on the map holds: the nearest the middle of the map
 * (decision 25). The map has every place; the list says how many are in view when it holds fewer.
 */
export const LIST_LIMIT = 50;

/** What a map page lists, and how the person moves it to where the map is. */
export interface SearchedArea {
  /** The places listed: where the person is near, until they search an area of the map; then the box it showed. */
  area: Area;
  /** Whether the area is one the person searched on the map, not where they are near. */
  fromMap: boolean;
  /** Whether the person has moved the map since, so there is an area to search: show "Search this area". */
  canSearch: boolean;
  /** The person moved the map; this is what it shows. */
  moved(bbox: Bbox): void;
  /** "Search this area": list the places where the map is now. */
  search(): void;
  /** Back to where the person is near, and nothing to search. */
  reset(): void;
}

/**
 * The area a map page lists the places of. It is where the person is near (`useHere`), as far as a
 * city reaches, until they move the map and press "Search this area"; then it is the box the map
 * shows, however far it reaches (decision 25). When the place they are near changes (they pick a
 * town, or are found), it starts again there.
 *
 * `memoryKey` is the page of the history it is on: Back to that page (from a place) finds the area
 * that was searched there (see mapMemory.ts).
 */
export function useSearchedArea(memoryKey: string): SearchedArea {
  const here = useHere();
  const near = `${here.lat},${here.lon}`;
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
    () => (searched !== undefined ? areaOf(searched) : { lat: here.lat, lon: here.lon, radiusKm: config.defaultCity.radiusKm }),
    [searched, here.lat, here.lon],
  );
  return {
    area,
    fromMap: searched !== undefined,
    canSearch: current.moved !== undefined,
    moved: (bbox) => setState({ ...current, moved: bbox }),
    search: () => {
      if (current.moved !== undefined) setState({ near, searched: current.moved });
    },
    reset: () => setState({ near }),
  };
}

/** Every place in an area, each with how far it is from (`fromLat`, `fromLon`), nearest first. */
function placesOf(indexes: Indexes, area: Area, fromLat: number, fromLon: number): PlaceDistance[] {
  if (area.box === undefined) {
    const rows = indexes.near(area.lat, area.lon, area.radiusKm);
    if (fromLat === area.lat && fromLon === area.lon) return rows;
    return rows
      .map(({ place }) => ({ place, km: distanceKm(fromLat, fromLon, place.lat, place.lon) }))
      .sort((a, b) => a.km - b.km);
  }
  return placesInBox(indexes, area.box)
    .map((place) => ({ place, km: distanceKm(fromLat, fromLon, place.lat, place.lon) }))
    .sort((a, b) => a.km - b.km);
}

/**
 * The `limit` rows nearest (`lat`, `lon`), in the order they came in (nearest first, by name...).
 * `measuredFrom` says the rows' own distances are from that point, so they need not be worked out again.
 */
function nearestTo<T extends PlaceDistance>(rows: readonly T[], lat: number, lon: number, limit: number, measuredFrom: boolean): T[] {
  const order = rows.map((row, i) => ({
    i,
    km: measuredFrom ? row.km : distanceKm(lat, lon, row.place.lat, row.place.lon),
  }));
  order.sort((a, b) => a.km - b.km || a.i - b.i);
  const kept = new Set(order.slice(0, limit).map(({ i }) => i));
  return rows.filter((_, i) => kept.has(i));
}

/** What an area lists. */
export interface AreaEntries {
  /** Every place in the area, before the filters, nearest `from` first. */
  nearby: PlaceDistance[];
  /** The list: chains as one entry, and, for an area searched on the map, the `LIST_LIMIT` places nearest its middle. */
  entries: Entry[];
  /** For an area searched on the map that has more places than the list holds: how many it has (after the filters). */
  inView?: number;
  /** Where each distance is from: the device, when it has said where the person is; otherwise the area's centre. */
  from: { lat: number; lon: number };
}

/**
 * The places in an area, the same as Explore lists them: chains as one entry. Each has how far it
 * is from the person when the device has said where they are, nearest them first, wherever the area
 * is; otherwise how far it is from the area's centre, which is where the list is near.
 *
 * With `filters`, only those that pass them, in their sort; a distance is measured the same way.
 * The widest distance is no limit: the area is the limit, so an area searched far from the device
 * still lists its places. An area searched on the map lists no more than `LIST_LIMIT` places, those
 * nearest the middle of the map, and says how many there are (`inView`); its filters are counted
 * first, so a chain counts only the locations that stay.
 */
export function useAreaEntries(area: Area, filters?: Filters): AreaEntries {
  const indexes = useIndexes();
  const now = useNow();
  const here = useHere();
  const locale = useLocale();
  const { lat, lon, radiusKm, box } = area;
  const fromDevice = here.source === "device";
  const fromLat = fromDevice ? here.lat : lat;
  const fromLon = fromDevice ? here.lon : lon;
  const from = useMemo(() => ({ lat: fromLat, lon: fromLon }), [fromLat, fromLon]);
  const nearby = useMemo(
    () => (indexes === undefined ? [] : placesOf(indexes, area, fromLat, fromLon)),
    // `area` is these: its centre, and its radius or its box.
    [indexes, lat, lon, radiusKm, box, fromLat, fromLon],
  );
  const widest = widestKm(locale);
  // The minute matters to the list only when it is asked which places are open.
  const openAt = filters?.open === true ? now : null;
  return useMemo(() => {
    if (indexes === undefined) return { nearby, entries: [], from };
    // Filter first, then group: a chain counts only the locations that stay.
    let rows = nearby;
    if (filters !== undefined) {
      const limit = filters.withinKm >= widest ? { ...filters, withinKm: Number.POSITIVE_INFINITY } : filters;
      rows = applyFilters(nearby, limit, now).rows;
    }
    if (box === undefined || rows.length <= LIST_LIMIT) return { nearby, entries: groupForList(rows, indexes), from };
    return { nearby, entries: groupForList(nearestTo(rows, lat, lon, LIST_LIMIT, !fromDevice), indexes), inView: rows.length, from };
    // `now` is a dependency through `openAt`: it changes the list only while Open now is on.
  }, [indexes, nearby, filters, widest, openAt, box, lat, lon, fromDevice, from]);
}
