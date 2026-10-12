import type { JSX } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { chainSlug } from "../places/indexes.ts";
import type { Place } from "../places/place.ts";
import { useIndexes } from "../places/useIndexes.ts";

/**
 * Under the card of a pin chosen on Explore's map, when the place is one of a chain's: the way to the
 * chain's page, "Part of Copper Kettle Coffee · 74 locations". A chain's places are each a pin of
 * their own on the map (decision 25), so this is how the map leads to the chain. Nothing for a place
 * in no chain. `className` places it as the page around it needs.
 */
export function PartOfChain({ place, className = "" }: { place: Place; className?: string }): JSX.Element | null {
  const chain = useIndexes()?.chainOf(place);
  if (chain === undefined) return null;
  return (
    <Link
      to={`/chain/${chainSlug(chain)}`}
      className={`inline-flex min-h-11 items-center text-secondary font-semibold text-ink underline hover:text-accent ${className}`}
    >
      {copy.map.partOfChain(chain.name, chain.places.length)}
    </Link>
  );
}
