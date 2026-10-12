import type { Indexes } from "../places/indexes.ts";
import type { Place } from "../places/place.ts";

/** What a map shows, as MapLibre gives it: west, south, east and north, in degrees. */
export type Bbox = [west: number, south: number, east: number, north: number];

/**
 * The places a list is of, and the point they are nearest: where the person is near, as far as
 * `radiusKm` reaches; or an area searched on the map, which is the `box` it showed, as far as the
 * view reached (decision 25). `lat` and `lon` are the circle's centre, or the middle of the box.
 */
export type Area =
  | { lat: number; lon: number; radiusKm: number; box?: undefined }
  | { lat: number; lon: number; box: Bbox; radiusKm?: undefined };

/** A longitude on the Earth: the map gives one past ±180° when it has been turned round the globe. */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** The farthest north or south a Mercator map draws, in degrees. */
const MERCATOR_LIMIT = 85.051129;

/**
 * The latitude halfway up a map between two latitudes, as a Mercator map draws them: the middle of a
 * view from 35°N to 70°N is near 56.3°N, not 52.5°N, since the map stretches what is farther north.
 */
function mercatorMiddle(south: number, north: number): number {
  const y = (lat: number) => {
    const clamped = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
    return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  };
  return (Math.atan(Math.sinh((y(south) + y(north)) / 2)) * 180) / Math.PI;
}

/**
 * The area a map shows: its box, however wide, and the middle of the map as its centre. `centre` is
 * the map's own (`getCenter`), longitude first; without one, the middle of the box as the map draws
 * it. A view zoomed out to the world is the world.
 */
export function areaOf(box: Bbox, centre?: readonly [lon: number, lat: number]): Area {
  const [west, south, east, north] = box;
  const lat = centre?.[1] ?? mercatorMiddle(south, north);
  return { lat, lon: wrapLon(centre?.[0] ?? (west + east) / 2), box };
}

/**
 * Whether a point is in a box of the map, read on the Earth as `placesInBox` reads it: across the 180th
 * meridian, and the whole way round for a view that holds the Earth more than once.
 */
export function boxHolds([west, south, east, north]: Bbox): (lat: number, lon: number) => boolean {
  const low = Math.min(south, north);
  const high = Math.max(south, north);
  if (!(east - west < 360)) return (lat) => lat >= low && lat <= high;
  const from = wrapLon(west);
  const to = wrapLon(east);
  if (from <= to) return (lat, lon) => lat >= low && lat <= high && lon >= from && lon <= to;
  return (lat, lon) => lat >= low && lat <= high && (lon >= from || lon <= to);
}

/**
 * The places in a box of the map, in no order. The map gives longitudes past ±180° when its view
 * crosses the 180th meridian, or holds the Earth more than once (zoomed all the way out): the box
 * is read on the Earth, so each place is in it once.
 */
export function placesInBox(indexes: Indexes, [west, south, east, north]: Bbox): Place[] {
  const low = Math.max(-90, Math.min(south, north));
  const high = Math.min(90, Math.max(south, north));
  if (!(east - west < 360)) return indexes.inRange(-180, low, 180, high);
  const from = wrapLon(west);
  const to = wrapLon(east);
  if (from <= to) return indexes.inRange(from, low, to, high);
  // Across the 180th meridian: the part east of `from`, and the part west of `to`.
  return [...indexes.inRange(from, low, 180, high), ...indexes.inRange(-180, low, to, high)];
}

/**
 * The box that holds every point, as a map takes one, or undefined for no points. Longitudes are
 * read as they come, as `fitView` reads them (src/chain/fit.ts): a city's places do not cross the
 * 180th meridian.
 */
export function boundsOf(points: readonly { lat: number; lon: number }[]): Bbox | undefined {
  const [first] = points;
  if (first === undefined) return undefined;
  const box: Bbox = [first.lon, first.lat, first.lon, first.lat];
  for (const { lat, lon } of points) {
    box[0] = Math.min(box[0], lon);
    box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lon);
    box[3] = Math.max(box[3], lat);
  }
  return box;
}
