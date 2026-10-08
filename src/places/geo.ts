/*
 * The nearest-first search of `around`, and `distance`, are taken from geokdbush-tk 2.0.5, Tomas
 * Kafka's fork of geokdbush (https://github.com/mourner/geokdbush) for kdbush 4. They are here,
 * in TypeScript, rather than as a dependency, because that package is no longer supported.
 * Their behaviour is the original's. `withinCounter` is new, and written for this app.
 *
 * ISC License
 *
 * Copyright (c) 2017, Vladimir Agafonkin
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 *
 * geokdbush-tk is by Tomas Kafka <tk@tomaskafka.com>, original by Vladimir Agafonkin
 * <agafonkin@gmail.com>.
 */
import type KDBush from "kdbush";
import TinyQueue from "tinyqueue";

const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

/** Half the way round the Earth, in kilometres: a distance that reaches every place on it. */
export const HALF_EARTH_KM = Math.PI * EARTH_RADIUS_KM;

/** A point waiting in the queue, with its distance as a haversine (half the versine of the angle). */
interface Hit {
  item: number;
  dist: number;
}

/** A part of the tree waiting in the queue: a range of the index and the box that holds it. */
interface Box {
  left: number;
  right: number;
  /** 0 for longitude, 1 for latitude: the axis this node splits on. */
  axis: 0 | 1;
  /** A lower bound of the distances from the query point to everything in the box. */
  dist: number;
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  item?: undefined;
}

function compareDist(a: Hit | Box, b: Hit | Box): number {
  return a.dist - b.dist;
}

/**
 * The ids of the points of `index` nearest to a location, nearest first. The index holds
 * points as (longitude, latitude). `maxResults` is a count and `maxDistance` is in kilometres;
 * `predicate` leaves out the ids it refuses.
 */
export function around(
  index: KDBush,
  longitude: number,
  latitude: number,
  maxResults?: number,
  maxDistance?: number,
  predicate?: (id: number) => boolean,
): number[] {
  let maxHaverSinDist = 1;
  const result: number[] = [];

  if (maxResults === undefined) maxResults = Number.POSITIVE_INFINITY;
  if (maxDistance !== undefined) maxHaverSinDist = haverSin(maxDistance / EARTH_RADIUS_KM);

  // A distance-sorted priority queue that holds both points and parts of the tree.
  const queue = new TinyQueue<Hit | Box>([], compareDist);

  // The top of the tree: the whole Earth.
  let node: Box | undefined = {
    left: 0,
    right: index.ids.length - 1,
    axis: 0,
    dist: 0,
    minLng: -180,
    minLat: -90,
    maxLng: 180,
    maxLat: 90,
  };

  const cosLat = Math.cos(latitude * RAD);

  while (node) {
    const right = node.right;
    const left = node.left;

    if (right - left <= index.nodeSize) {
      // A leaf: put all its points in the queue.
      for (let i = left; i <= right; i++) {
        const itemId = index.ids[i]!;
        if (!predicate || predicate(itemId)) {
          queue.push({
            item: itemId,
            dist: haverSinDist(longitude, latitude, index.coords[2 * i]!, index.coords[2 * i + 1]!, cosLat),
          });
        }
      }
    } else {
      // Not a leaf: it has two children.
      const mid = (left + right) >> 1;
      const midLng = index.coords[2 * mid]!;
      const midLat = index.coords[2 * mid + 1]!;

      // The middle point goes in the queue.
      const itemId = index.ids[mid]!;
      if (!predicate || predicate(itemId)) {
        queue.push({ item: itemId, dist: haverSinDist(longitude, latitude, midLng, midLat, cosLat) });
      }

      const [leftNode, rightNode] = children(node, left, mid, right, midLng, midLat);
      leftNode.dist = boxDist(longitude, latitude, cosLat, leftNode);
      rightNode.dist = boxDist(longitude, latitude, cosLat, rightNode);

      queue.push(leftNode);
      queue.push(rightNode);
    }

    // Take the closest points from the queue. They are the nearest of all that remain, points
    // and parts of the tree alike, because a part's distance is a lower bound for its children.
    while (queue.length > 0 && queue.peek()!.item !== undefined) {
      const candidate = queue.pop() as Hit;
      if (candidate.dist > maxHaverSinDist) return result;
      result.push(candidate.item);
      if (result.length === maxResults) return result;
    }

    // The next closest part of the tree.
    node = queue.pop() as Box | undefined;
  }

  return result;
}

/** The great-circle distance between two locations, in kilometres. */
export function distance(longitude1: number, latitude1: number, longitude2: number, latitude2: number): number {
  const h = haverSinDist(longitude1, latitude1, longitude2, latitude2, Math.cos(latitude1 * RAD));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** The two halves of `node`, split at the middle point (`midLng`, `midLat`). Their `dist` is not set. */
function children(node: Box, left: number, mid: number, right: number, midLng: number, midLat: number): [Box, Box] {
  const nextAxis = node.axis === 0 ? 1 : 0;
  return [
    {
      left,
      right: mid - 1,
      axis: nextAxis,
      dist: 0,
      minLng: node.minLng,
      minLat: node.minLat,
      maxLng: node.axis === 0 ? midLng : node.maxLng,
      maxLat: node.axis === 1 ? midLat : node.maxLat,
    },
    {
      left: mid + 1,
      right,
      axis: nextAxis,
      dist: 0,
      minLng: node.axis === 0 ? midLng : node.minLng,
      minLat: node.axis === 1 ? midLat : node.minLat,
      maxLng: node.maxLng,
      maxLat: node.maxLat,
    },
  ];
}

/** A lower bound for the distance from a location to the points inside a box. */
function boxDist(lng: number, lat: number, cosLat: number, node: Box): number {
  const minLng = node.minLng;
  const maxLng = node.maxLng;
  const minLat = node.minLat;
  const maxLat = node.maxLat;

  // The query point is between the least and greatest longitudes.
  if (lng >= minLng && lng <= maxLng) {
    if (lat < minLat) return haverSin((lat - minLat) * RAD);
    if (lat > maxLat) return haverSin((lat - maxLat) * RAD);
    return 0;
  }

  // The query point is west or east of the box. Find the extremum of the great-circle
  // distance from the query point to the nearest longitude.
  const haverSinDLng = Math.min(haverSin((lng - minLng) * RAD), haverSin((lng - maxLng) * RAD));
  const extremumLat = vertexLat(lat, haverSinDLng);

  // If the extremum is inside the box, that is the distance.
  if (extremumLat > minLat && extremumLat < maxLat) {
    return haverSinDistPartial(haverSinDLng, cosLat, lat, extremumLat);
  }
  // Otherwise it is the distance to whichever corner of the box is closer.
  return Math.min(
    haverSinDistPartial(haverSinDLng, cosLat, lat, minLat),
    haverSinDistPartial(haverSinDLng, cosLat, lat, maxLat),
  );
}

function haverSin(theta: number): number {
  const s = Math.sin(theta / 2);
  return s * s;
}

function haverSinDistPartial(haverSinDLng: number, cosLat1: number, lat1: number, lat2: number): number {
  return cosLat1 * Math.cos(lat2 * RAD) * haverSinDLng + haverSin((lat1 - lat2) * RAD);
}

function haverSinDist(lng1: number, lat1: number, lng2: number, lat2: number, cosLat1: number): number {
  const haverSinDLng = haverSin((lng1 - lng2) * RAD);
  return haverSinDistPartial(haverSinDLng, cosLat1, lat1, lat2);
}

function vertexLat(lat: number, haverSinDLng: number): number {
  const cosDLng = 1 - 2 * haverSinDLng;
  if (cosDLng <= 0) return lat > 0 ? 90 : -90;
  return Math.atan(Math.tan(lat * RAD) / cosDLng) / RAD;
}

// What follows is not from geokdbush.

/** The greatest distance, in kilometres, from the centre of a box to anything in it, or Infinity for a box that is too big to say. */
function reachOfBox(node: Box): number {
  // Within 45 degrees of the centre either way, the farthest point is a corner. Beyond that it may not be.
  if (node.maxLng - node.minLng > 90 || node.maxLat - node.minLat > 90) return Number.POSITIVE_INFINITY;
  const centreLng = (node.minLng + node.maxLng) / 2;
  const centreLat = (node.minLat + node.maxLat) / 2;
  return Math.max(
    distance(centreLng, centreLat, node.minLng, node.minLat),
    distance(centreLng, centreLat, node.minLng, node.maxLat),
  );
}

/**
 * A function that counts the points of `index` within a distance of a location, for many
 * locations. It counts a part of the tree as a whole when all of it is in range, and looks at
 * single points only along the edge of the range, so a count costs about the square root of the
 * number of points, not all of them. The result is what `around(index, ...).length` would be.
 */
export function withinCounter(index: KDBush): (longitude: number, latitude: number, maxDistance: number) => number {
  const total = index.ids.length;
  // The box that holds every point. A part of the tree is bounded by this, not by the whole Earth,
  // so that parts at the edge of the points can be counted whole.
  const all: Box = { left: 0, right: total - 1, axis: 0, dist: 0, minLng: 180, minLat: 90, maxLng: -180, maxLat: -90 };
  for (let i = 0; i < total; i++) {
    const lng = index.coords[2 * i]!;
    const lat = index.coords[2 * i + 1]!;
    if (lng < all.minLng) all.minLng = lng;
    if (lng > all.maxLng) all.maxLng = lng;
    if (lat < all.minLat) all.minLat = lat;
    if (lat > all.maxLat) all.maxLat = lat;
  }

  return (longitude, latitude, maxDistance) => {
    // Not a distance (NaN or below zero), or a location that is not one, counts nothing.
    if (total === 0 || !(maxDistance >= 0) || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return 0;
    // Half the way round the Earth reaches everything; the haversine would wrap round past it.
    if (maxDistance >= HALF_EARTH_KM) return total;

    const maxHaverSinDist = haverSin(maxDistance / EARTH_RADIUS_KM);
    const cosLat = Math.cos(latitude * RAD);
    const here = (node: Box) => distance(longitude, latitude, (node.minLng + node.maxLng) / 2, (node.minLat + node.maxLat) / 2);

    let count = 0;
    const pending: Box[] = [all];
    while (pending.length > 0) {
      const node = pending.pop()!;
      const { left, right } = node;
      if (right < left) continue;
      // None of it is in range.
      if (boxDist(longitude, latitude, cosLat, node) > maxHaverSinDist) continue;
      // All of it is in range: the centre is that far, and nothing in the box is farther from the centre than its reach.
      if (here(node) + reachOfBox(node) <= maxDistance) {
        count += right - left + 1;
        continue;
      }
      if (right - left <= index.nodeSize) {
        for (let i = left; i <= right; i++) {
          if (haverSinDist(longitude, latitude, index.coords[2 * i]!, index.coords[2 * i + 1]!, cosLat) <= maxHaverSinDist) count++;
        }
        continue;
      }
      const mid = (left + right) >> 1;
      const midLng = index.coords[2 * mid]!;
      const midLat = index.coords[2 * mid + 1]!;
      if (haverSinDist(longitude, latitude, midLng, midLat, cosLat) <= maxHaverSinDist) count++;
      pending.push(...children(node, left, mid, right, midLng, midLat));
    }
    return count;
  };
}
