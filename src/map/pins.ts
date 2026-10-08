import type { FeatureCollection, Point } from "geojson";

import { copy } from "../copy/en.ts";
import { openLine, openState } from "../places/hours.ts";
import type { ChainGroup, PlaceDistance } from "../places/indexes.ts";
import { placeKindLabel } from "../places/kinds.ts";

/** A pin on a map: a place, or a chain at its nearest place. */
export interface Pin {
  /** The address of the place it stands at (`39999:<curator>:<d>`): what the map says was tapped. */
  address: string;
  lat: number;
  lon: number;
  /** The score it shows ("4.6"). Absent: a place nobody has rated, drawn as a ring. */
  label?: string;
  /** How many of a chain's places it stands for: drawn as "×3". Absent for a place. */
  chainCount?: number;
  /** What a screen reader calls it: "Dose, Cafe, Open until 6 pm, no reviews yet". */
  name: string;
  /** The place's category, for the icon on a chain's pin. */
  category?: string;
}

/** The map's source of pins. */
export const PIN_SOURCE = "pins";

/**
 * How the source gathers pins that are close together into one bubble with a count: those within
 * 50 px of each other, up to zoom 14. From zoom 15 every pin is drawn on its own.
 */
export const CLUSTER_OPTIONS = { cluster: true, clusterRadius: 50, clusterMaxZoom: 14 } as const;

/** The most pins a map draws at once. Past it, those in view are drawn first. */
export const MAX_MARKERS = 200;

/** A place in a list, or a chain of them as one: what Explore lists, and what the map pins. */
export type Entry = PlaceDistance | ChainGroup<PlaceDistance>;

const isChain = (entry: Entry): entry is ChainGroup<PlaceDistance> => "chain" in entry;

/** The address an entry's pin has: the place's own, or a chain's nearest place's. */
export function entryAddress(entry: Entry): string {
  return isChain(entry) ? entry.nearby[0]!.place.address : entry.place.address;
}

/**
 * A pin for each entry of a list: a place's at the place, a chain's at its nearest place with how
 * many of its places are in the list. Nobody has a score before sign in, so each place is a ring.
 * `locale` and `now` give the hours a screen reader hears.
 */
export function pinsFor(entries: readonly Entry[], locale: string, now: Date): Pin[] {
  return entries.map((entry) => {
    if (isChain(entry)) {
      const nearest = entry.nearby[0]!.place;
      return {
        address: nearest.address,
        lat: nearest.lat,
        lon: nearest.lon,
        chainCount: entry.nearby.length,
        name: copy.map.chainPin(entry.chain.name, entry.nearby.length),
        category: nearest.category,
      };
    }
    const { place } = entry;
    return {
      address: place.address,
      lat: place.lat,
      lon: place.lon,
      category: place.category,
      name: copy.map.placePin(
        place.name,
        placeKindLabel(place.category, place.cuisine),
        openLine(openState(place, now), locale, "card"),
      ),
    };
  });
}

/** What the map's source holds: a point for each pin, longitude first, with the pin's address and nothing else. */
export function pinsGeoJSON(pins: readonly Pin[]): FeatureCollection<Point, { address: string }> {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lon, pin.lat] },
      properties: { address: pin.address },
    })),
  };
}
