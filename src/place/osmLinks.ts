import type { Place } from "../places/place.ts";

const OSM = "https://www.openstreetmap.org";

/** What a place's `osm-id` looks like: `node:123`, `way:123` or `relation:123`. */
const OSM_ID = /^(node|way|relation):(\d+)$/;

/**
 * The page of a place's record on OpenStreetMap, from its `osm-id` ("node:123"). Nothing for text
 * that is not an id: the id comes from a relay, and only the three kinds of thing OpenStreetMap
 * has, with a number, make a link.
 */
export function osmUrl(osmId: string): string | undefined {
  const match = OSM_ID.exec(osmId);
  return match === null ? undefined : `${OSM}/${match[1]}/${match[2]}`;
}

/**
 * OpenStreetMap's form for a note on the map at a point, zoomed in: where a person says a place
 * is missing or wrong. The coordinates are to six decimals, about ten centimetres. Empty for a
 * point that is not a point (a coordinate that is not a finite number): the caller leaves the link out.
 */
export function osmNoteUrl(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `${OSM}/note/new#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/**
 * Directions to a place, from wherever the person is, in the map app they have. The coordinates
 * are to six decimals. Empty for a place that is not a point: the caller leaves the link out.
 */
export function goUrl(place: Pick<Place, "lat" | "lon">): string {
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat.toFixed(6)},${place.lon.toFixed(6)}`;
}
