import { config } from "../config.ts";
import { distanceKm } from "../places/distance.ts";

/** What a map shows, as MapLibre gives it: west, south, east and north, in degrees. */
export type Bbox = [west: number, south: number, east: number, north: number];

/** A circle of places to list: its centre and how far it reaches. */
export interface Area {
  lat: number;
  lon: number;
  radiusKm: number;
}

/** A longitude on the Earth: the map gives one past ±180° when it has been turned round the globe. */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * The places a map shows, as a circle: the middle of the view, and half its diagonal, which reaches
 * its corners. A view wider than a city reaches no farther than a city does (`config.defaultCity`).
 */
export function areaOf([west, south, east, north]: Bbox): Area {
  const lat = (south + north) / 2;
  const lon = wrapLon((west + east) / 2);
  const radiusKm = Math.min(distanceKm(south, west, north, east) / 2, config.defaultCity.radiusKm);
  return { lat, lon, radiusKm };
}
