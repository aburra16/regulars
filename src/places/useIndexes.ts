import { useMemo } from "react";

import { buildIndexes, type Indexes } from "./indexes.ts";
import type { Place } from "./place.ts";
import { usePlaces } from "./store.tsx";

/**
 * The indexes built for each list of places, kept for as long as the list is. Every component
 * that asks for the indexes of a list gets the same ones, including a component that mounts
 * later, and the indexes go when the list does.
 */
const built = new WeakMap<readonly Place[], Indexes>();

function indexesOf(places: readonly Place[]): Indexes {
  let indexes = built.get(places);
  if (indexes === undefined) {
    indexes = buildIndexes(places);
    built.set(places, indexes);
  }
  return indexes;
}

/**
 * The indexes of the places on screen, built once for each list of places however many
 * components use them. Undefined while there are no places. Use it inside a `PlacesProvider`.
 */
export function useIndexes(): Indexes | undefined {
  const { places } = usePlaces();
  return useMemo(() => (places.length === 0 ? undefined : indexesOf(places)), [places]);
}
