import { useMemo } from "react";

import { useHere } from "../location/useLocation.ts";
import { type ChainGroup, groupForList, type PlaceDistance, placeCount } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useNow } from "../shell/useNow.ts";
import { applyFilters, type Filters, sortInUse } from "./filters.ts";

/** A place in the results, or a chain of them as one. */
export type Entry = PlaceDistance | ChainGroup<PlaceDistance>;

export const isChain = (entry: Entry): entry is ChainGroup<PlaceDistance> => "chain" in entry;

/** How the results are ordered, for the line that says so. */
export type Order = "score" | "distance" | "name" | "relevance";

/**
 * What the search page lists for the words `q` (none: the places near) under `filters`, around the
 * place the list is near: the places that match, filtered, sorted and grouped, a chain as one
 * entry; how many places those are (`placeCount`: a chain counts each of its locations); how many
 * closed places Open now left out; and what order they are in. The filters page
 * counts with the same, so the button that says "Show 5 places" is right.
 *
 * With no sort chosen the order is the index's own: nearest first for nothing typed and for a kind
 * of place (it lists them by distance), best match first for any other words. For House picks'
 * score, the entries are in that order, which the page sorts by the scores it reads for them
 * (`useListScores`); `order` says "score".
 */
export function useResults(
  q: string,
  filters: Filters,
): { entries: Entry[]; count: number; hiddenClosed: number; order: Order } {
  const indexes = useIndexes();
  const { lat, lon } = useHere();
  const now = useNow();

  const found = useMemo(
    () => indexes?.search(q, { lat, lon, radiusKm: filters.withinKm }) ?? [],
    [indexes, q, lat, lon, filters.withinKm],
  );
  const chosen = sortInUse(filters);
  const order: Order = useMemo(() => {
    if (chosen !== undefined) return chosen;
    return q !== "" && indexes !== undefined && !indexes.isKindQuery(q) ? "relevance" : "distance";
  }, [chosen, q, indexes]);

  // The minute matters to the results only when it is asked which places are open.
  const openAt = filters.open ? now : null;
  const { entries, count, hiddenClosed } = useMemo(() => {
    if (indexes === undefined) return { entries: [], count: 0, hiddenClosed: 0 };
    // Filter first, then group: a chain counts only the locations that stay.
    const kept = applyFilters(found, filters, now);
    const grouped = groupForList(kept.rows, indexes);
    return { entries: grouped, count: placeCount(grouped), hiddenClosed: kept.hiddenClosed };
    // `now` is a dependency through `openAt`: it changes the results only while Open now is on.
  }, [indexes, found, filters, openAt]);
  return { entries, count, hiddenClosed, order };
}
