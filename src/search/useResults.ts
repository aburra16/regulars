import { useMemo } from "react";

import { useHere } from "../location/useLocation.ts";
import { type ChainGroup, groupForList, type PlaceDistance } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useNow } from "../shell/useNow.ts";
import { applyFilters, type Filters } from "./filters.ts";

/** A place in the results, or a chain of them as one. */
export type Entry = PlaceDistance | ChainGroup<PlaceDistance>;

export const isChain = (entry: Entry): entry is ChainGroup<PlaceDistance> => "chain" in entry;

/**
 * What the search page lists for the words `q` (none: the places near) under `filters`, around the
 * place the list is near: the places that match, filtered, sorted and grouped, a chain as one
 * entry, and how many closed places Open now left out. The filters page counts with the same, so
 * the button that says "Show 5 places" is right.
 */
export function useResults(q: string, filters: Filters): { entries: Entry[]; hiddenClosed: number } {
  const indexes = useIndexes();
  const { lat, lon } = useHere();
  const now = useNow();

  const found = useMemo(
    () => indexes?.search(q, { lat, lon, radiusKm: filters.withinKm }) ?? [],
    [indexes, q, lat, lon, filters.withinKm],
  );
  // The minute matters to the results only when it is asked which places are open.
  const openAt = filters.open ? now : null;
  return useMemo(() => {
    if (indexes === undefined) return { entries: [], hiddenClosed: 0 };
    // Filter first, then group: a chain counts only the locations that stay.
    const { rows, hiddenClosed } = applyFilters(found, filters, now);
    return { entries: groupForList(rows, indexes), hiddenClosed };
    // `now` is a dependency through `openAt`: it changes the results only while Open now is on.
  }, [indexes, found, filters, openAt]);
}
