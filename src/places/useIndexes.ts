import { useMemo } from "react";

import { buildIndexes, type Indexes } from "./indexes.ts";
import { usePlaces } from "./store.tsx";

/**
 * The indexes of the places on screen, built once for each list of places and not again while
 * the list is the same. Undefined while there are no places. Use it inside a `PlacesProvider`.
 */
export function useIndexes(): Indexes | undefined {
  const { places } = usePlaces();
  return useMemo(() => (places.length === 0 ? undefined : buildIndexes(places)), [places]);
}
