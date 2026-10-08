import { useEffect, useMemo, useState } from "react";

import { config } from "../config.ts";
import { useHere } from "../location/useLocation.ts";
import { type Area, areaOf, type Bbox } from "../map/area.ts";
import type { Entry } from "../map/pins.ts";
import { distanceKm } from "../places/distance.ts";
import { groupForList, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { applyFilters, type Filters, widestKm } from "../search/filters.ts";
import { recallMapPage, rememberMapPage, type SearchState } from "./mapMemory.ts";

/** What a map page lists, and how the person moves it to where the map is. */
export interface SearchedArea {
  /** The circle the places are listed in: where the person is near, until they search an area of the map. */
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
 * city reaches, until they move the map and press "Search this area"; then it is what the map
 * shows. When the place they are near changes (they pick a town, or are found), it starts again there.
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

  const area = current.searched ?? { lat: here.lat, lon: here.lon, radiusKm: config.defaultCity.radiusKm };
  return {
    area,
    fromMap: current.searched !== undefined,
    canSearch: current.moved !== undefined,
    moved: (bbox) => setState({ ...current, moved: bbox }),
    search: () => {
      if (current.moved !== undefined) setState({ near, searched: areaOf(current.moved) });
    },
    reset: () => setState({ near }),
  };
}

/**
 * The places in an area, the same as Explore lists them: chains as one entry. Each has how far it
 * is from the person when the device has said where they are, nearest them first, wherever the area
 * is; otherwise how far it is from the area's centre, which is where the list is near.
 *
 * With `filters`, only those that pass them, in their sort; a distance is measured the same way.
 * The widest distance is no limit: the area is the limit, so an area searched far from the device
 * still lists its places. `rows` is every place that passed, before chains were gathered.
 */
export function useAreaEntries(area: Area, filters?: Filters): { nearby: PlaceDistance[]; rows: PlaceDistance[]; entries: Entry[] } {
  const indexes = useIndexes();
  const now = useNow();
  const here = useHere();
  const locale = useLocale();
  const { lat, lon, radiusKm } = area;
  const fromDevice = here.source === "device";
  const fromLat = fromDevice ? here.lat : lat;
  const fromLon = fromDevice ? here.lon : lon;
  const nearby = useMemo(() => {
    const rows = indexes?.near(lat, lon, radiusKm) ?? [];
    if (fromLat === lat && fromLon === lon) return rows;
    return rows
      .map(({ place }) => ({ place, km: distanceKm(fromLat, fromLon, place.lat, place.lon) }))
      .sort((a, b) => a.km - b.km);
  }, [indexes, lat, lon, radiusKm, fromLat, fromLon]);
  const widest = widestKm(locale);
  // The minute matters to the list only when it is asked which places are open.
  const openAt = filters?.open === true ? now : null;
  return useMemo(() => {
    if (indexes === undefined) return { nearby, rows: [], entries: [] };
    // Filter first, then group: a chain counts only the locations that stay.
    let rows = nearby;
    if (filters !== undefined) {
      const limit = filters.withinKm >= widest ? { ...filters, withinKm: Number.POSITIVE_INFINITY } : filters;
      rows = applyFilters(nearby, limit, now).rows;
    }
    return { nearby, rows, entries: groupForList(rows, indexes) };
    // `now` is a dependency through `openAt`: it changes the list only while Open now is on.
  }, [indexes, nearby, filters, widest, openAt]);
}
