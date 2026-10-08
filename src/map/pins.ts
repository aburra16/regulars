import type { FeatureCollection, Point } from "geojson";

import { copy } from "../copy/en.ts";
import { openLine, openState } from "../places/hours.ts";
import type { ChainGroup, PlaceDistance } from "../places/indexes.ts";
import { placeKindLabel } from "../places/kinds.ts";
import { formatScore } from "../score/score.ts";
import type { ShownScore } from "../score/shown.ts";

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
  /** What a screen reader calls it: "Dose, Cafe, Open until 6 pm, 4.6 out of 5, rated by 3 people the house trusts". */
  name: string;
  /** The place's category, for the icon on a chain's pin. */
  category?: string;
  /**
   * `drop`: the design's marker for the one place a map is about (Place.dc.html, DeskPlace.dc.html),
   * an accent drop with a white dot whose tip is on the place. Absent: a ring, a score pill or a chain's pill.
   */
  look?: "drop";
}

/**
 * A point the map's source holds: an address at a place on the Earth, and nothing more. A `Pin` is
 * one, and so is a `Place`: Explore's maps give the source every place as it is (decision 25), and
 * work out a pin only for a place the map draws on its own.
 */
export interface PinPoint {
  address: string;
  lat: number;
  lon: number;
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
 * What a place's pin says of its score to a screen reader, as the pill or the ring says it to the
 * eye: its score, and whose view it is from, or why it has none. Nothing while its reviews are being read.
 */
function scoreWords(score: ShownScore): string | undefined {
  switch (score.kind) {
    case "scored":
      return score.circle
        ? copy.map.pinScoredCircle(formatScore(score.score), score.counted)
        : copy.map.pinScored(formatScore(score.score), score.counted);
    case "pending":
      return copy.map.pinCounting;
    case "unscored":
    case "unavailable":
      return copy.map.pinNoScore;
    case "failed":
      return copy.map.pinFailed;
    case "none":
      return copy.map.unrated;
    case "reading":
      return undefined;
  }
}

/** The words a place's pin is named by, before its score: kept so a score can be put to them without working out the hours again. */
const spokenParts = new WeakMap<Pin, { name: string; kind: string; hours: string }>();

/** Each place's pin with its score put to it, by the pin it was put to: the same pin for the same score. */
const withScore = new WeakMap<Pin, { score: ShownScore; pin: Pin }>();

/**
 * `pins` (from `pinsFor`) with each place's score from the view on screen (`scoreOf`) put to it: a
 * scored place is a pill with its score, any other a ring, and each says which to a screen reader.
 * The hours are not worked out again, and a pin whose score is the same object as last time is the
 * same pin, so a map is redrawn only where a score changed.
 */
export function scorePins(pins: readonly Pin[], scoreOf: (address: string) => ShownScore): Pin[] {
  return pins.map((pin) => {
    const parts = spokenParts.get(pin);
    // A chain's pin has no score of its own.
    if (parts === undefined) return pin;
    const score = scoreOf(pin.address);
    if (score.kind === "none") return pin;
    const last = withScore.get(pin);
    if (last?.score === score) return last.pin;
    const scored: Pin = { ...pin, name: copy.map.placePin(parts.name, parts.kind, parts.hours, scoreWords(score)) };
    if (score.kind === "scored") scored.label = formatScore(score.score);
    withScore.set(pin, { score, pin: scored });
    return scored;
  });
}

/**
 * A pin for each entry of a list: a place's at the place, a chain's at its nearest place with how
 * many of its places are in the list. Each place is a ring that says nobody has reviewed it, until
 * its score is put to it (`scorePins`, or `scoreOf` here). `locale` and `now` give the hours a
 * screen reader hears.
 */
export function pinsFor(
  entries: readonly Entry[],
  locale: string,
  now: Date,
  scoreOf?: (address: string) => ShownScore,
): Pin[] {
  const pins = entries.map((entry): Pin => {
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
    const parts = {
      name: place.name,
      kind: placeKindLabel(place.category, place.cuisine),
      hours: openLine(openState(place, now), locale, "card"),
    };
    const pin: Pin = {
      address: place.address,
      lat: place.lat,
      lon: place.lon,
      category: place.category,
      name: copy.map.placePin(parts.name, parts.kind, parts.hours, copy.map.unrated),
    };
    spokenParts.set(pin, parts);
    return pin;
  });
  return scoreOf === undefined ? pins : scorePins(pins, scoreOf);
}

/** What the map's source holds: a point for each pin, longitude first, with the pin's address and nothing else. */
export function pinsGeoJSON(pins: readonly PinPoint[]): FeatureCollection<Point, { address: string }> {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lon, pin.lat] },
      properties: { address: pin.address },
    })),
  };
}
