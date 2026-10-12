import { useLocation } from "react-router-dom";

import type { MapView } from "../map/BaseMap.tsx";
import type { Place } from "../places/place.ts";
import { useIndexes } from "../places/useIndexes.ts";

/**
 * What a link to the map carries, as the state of its page of the history, to open the map at one
 * place with its pin chosen: the place's `d` (the chain page's "See on map", at its nearest
 * location). It is the page's own, as where the map was left is (mapMemory.ts): Back to the page
 * finds it again, and a link typed in or reloaded opens the map as it always does.
 */
export interface MapFocus {
  focus: string;
}

/** The state of a link that opens the map at `place`, chosen. */
export function mapFocusOn(place: Pick<Place, "d">): MapFocus {
  return { focus: place.d };
}

/** The place a map page was opened at, once the places are in: undefined when it was opened plainly, or the place is not listed. */
export function useMapFocus(): Place | undefined {
  const { state } = useLocation();
  const indexes = useIndexes();
  const d: unknown = typeof state === "object" && state !== null && "focus" in state ? state.focus : undefined;
  return typeof d === "string" ? indexes?.byD.get(d) : undefined;
}

/** Where a map opened at a place starts: at the place, as close as a map page opens. */
export function viewAt(place: Pick<Place, "lat" | "lon">, zoom: number): MapView {
  return { center: [place.lon, place.lat], zoom };
}
