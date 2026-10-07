// geokdbush-tk ships no types. This is the part of its API that the app uses.
declare module "geokdbush-tk" {
  import type KDBush from "kdbush";

  /**
   * The ids of the points of `index` nearest to a location, nearest first. The index holds
   * points as (longitude, latitude). `maxDistance` is in kilometres.
   */
  export function around(
    index: KDBush,
    longitude: number,
    latitude: number,
    maxResults?: number,
    maxDistance?: number,
    predicate?: (id: number) => boolean,
  ): number[];

  /** The great-circle distance between two locations, in kilometres. */
  export function distance(longitude1: number, latitude1: number, longitude2: number, latitude2: number): number;
}
