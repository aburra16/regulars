import { useMemo } from "react";

import { buildIndexes, type Indexes } from "./indexes.ts";
import type { Place } from "./place.ts";
import { usePlaces } from "./store.tsx";
import type { TownList } from "./towns.ts";

/**
 * The indexes built for each list of places, kept for as long as the list is. Every component
 * that asks for the indexes of a list gets the same ones, including a component that mounts
 * later, and the indexes go when the list does. A list comes with its towns, which are the same
 * for every list (the app's one copy of src/data/towns.json); they are checked all the same.
 */
const built = new WeakMap<readonly Place[], { towns: TownList | null; indexes: Indexes }>();

function indexesOf(places: readonly Place[], towns: TownList | null): Indexes {
  const kept = built.get(places);
  if (kept !== undefined && kept.towns === towns) return kept.indexes;
  const indexes = buildIndexes(places, towns);
  built.set(places, { towns, indexes });
  return indexes;
}

/**
 * The indexes of the places on screen, built once for each list of places however many
 * components use them, with the towns that loaded with the places. Undefined while there are no
 * places. Use it inside a `PlacesProvider`.
 */
export function useIndexes(): Indexes | undefined {
  const { places, towns = null } = usePlaces();
  return useMemo(() => (places.length === 0 ? undefined : indexesOf(places, towns)), [places, towns]);
}
