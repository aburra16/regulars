import type { LngLat, MapView } from "../map/BaseMap.tsx";

/** A point on the Earth. */
interface Point {
  lat: number;
  lon: number;
}

/** How close the map is for one location: a street and the blocks around it. */
const ONE_PLACE_ZOOM = 15;

/** Where the map looks for no points at all. A page does not ask; this is only so the answer is always a view. */
const WORLD: MapView = { center: [0, 0], zoom: 1 };

/** The farthest out the map goes for points that are far apart, and how far in a close group is allowed. */
const MIN_ZOOM = 1;
const MAX_ZOOM = ONE_PLACE_ZOOM;

/**
 * The room the points have in the rail's map, in pixels. The map is 320 by 220 (DeskPlace.dc.html);
 * a pin is 44 px across and centred on its point, so the room is less 40 px on each side, and less
 * 50 above and below, since the attribution takes the foot of the map.
 */
const ROOM = { width: 240, height: 120 };

/** MapLibre draws the world 512 px across at zoom 0, and twice that for each zoom after. */
const WORLD_PX = 512;

/** Where a latitude is on the map from its top (0) to its foot (1), in Web Mercator. */
function mercatorY(lat: number): number {
  const sine = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
}

/** The latitude that is `y` of the way down the map. */
function latitudeAt(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;
}

/**
 * Where a map looks to show `points`. One point, or points that are all in one place, is centred
 * and close in. Several are fitted: the middle of the span they cover, at the closest zoom, in a
 * tenth of a level, at which all of them are still within the room a map has (less a margin for the
 * pins). The longitudes are read as they come, so points on both sides of the 180th meridian are
 * read as spanning the world; a country's chain is not.
 */
export function fitView(points: readonly Point[]): MapView {
  const first = points[0];
  if (first === undefined) return WORLD;

  let west = first.lon;
  let east = first.lon;
  let top = mercatorY(first.lat);
  let foot = top;
  for (const { lat, lon } of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    const y = mercatorY(lat);
    top = Math.min(top, y);
    foot = Math.max(foot, y);
  }

  const wide = (east - west) / 360;
  const tall = foot - top;
  if (wide === 0 && tall === 0) return { center: [first.lon, first.lat], zoom: ONE_PLACE_ZOOM };

  const zoomToFit = (fraction: number, room: number) => (fraction === 0 ? Infinity : Math.log2(room / (WORLD_PX * fraction)));
  const fitted = Math.min(zoomToFit(wide, ROOM.width), zoomToFit(tall, ROOM.height));
  // Down to a tenth, so the points never come to the edge.
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(fitted * 10) / 10));
  const center: LngLat = [(west + east) / 2, latitudeAt((top + foot) / 2)];
  return { center, zoom };
}
