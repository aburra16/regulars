import { useMemo, useState } from "react";

import { config } from "../config.ts";
import { useHere } from "../location/useLocation.ts";
import { type Area, areaOf, type Bbox } from "../map/area.ts";
import type { Entry } from "../map/pins.ts";
import { groupForList, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useNow } from "../shell/useNow.ts";
import { applyFilters, type Filters } from "../search/filters.ts";

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

interface State {
  /** Where the person was near when this was set; a new place starts over. */
  near: string;
  searched?: Area;
  moved?: Bbox;
}

/**
 * The area a map page lists the places of. It is where the person is near (`useHere`), as far as a
 * city reaches, until they move the map and press "Search this area"; then it is what the map
 * shows. When the place they are near changes (they pick a town, or are found), it starts again there.
 */
export function useSearchedArea(): SearchedArea {
  const here = useHere();
  const near = `${here.lat},${here.lon}`;
  const [state, setState] = useState<State>({ near });
  const current: State = state.near === near ? state : { near };

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
 * The places in an area, nearest its centre first, each with how far it is from there, and the same
 * as Explore lists them: chains as one entry. With `filters`, only those that pass them (a distance
 * is from the centre too), in their sort. `rows` is every place that passed, before chains were
 * gathered.
 */
export function useAreaEntries(area: Area, filters?: Filters): { nearby: PlaceDistance[]; rows: PlaceDistance[]; entries: Entry[] } {
  const indexes = useIndexes();
  const now = useNow();
  const { lat, lon, radiusKm } = area;
  const nearby = useMemo(() => indexes?.near(lat, lon, radiusKm) ?? [], [indexes, lat, lon, radiusKm]);
  // The minute matters to the list only when it is asked which places are open.
  const openAt = filters?.open === true ? now : null;
  return useMemo(() => {
    if (indexes === undefined) return { nearby, rows: [], entries: [] };
    // Filter first, then group: a chain counts only the locations that stay.
    const rows = filters === undefined ? nearby : applyFilters(nearby, filters, now).rows;
    return { nearby, rows, entries: groupForList(rows, indexes) };
    // `now` is a dependency through `openAt`: it changes the list only while Open now is on.
  }, [indexes, nearby, filters, openAt]);
}
