/*
 * Capitals that take in their districts: a reviewed list that tools/towns.ts reads. GeoNames lists the
 * districts of some capitals as towns of their own, and when the places there carry no locality, no
 * place says which city they are in, so nothing makes the districts parts of it (see `chooseTowns`).
 * Each capital here takes in, as parts, every GeoNames town in its own first-level area (`admin1`:
 * the province or special area that is the city) within `withinKm` of its point. A town of another
 * area that near stays a town of its own: Pak Kret, in Nonthaburi, beside Bangkok.
 *
 * Add a city only after looking at it: a capital with no places of its own, whose districts hold the
 * places around it, and whose first-level area is the city.
 */

/** A capital that takes in the towns of its own first-level area within `withinKm` of its point. */
export interface Absorbing {
  /** Its GeoNames id. */
  id: number;
  /** Its name, for the reader of this list. */
  name: string;
  withinKm: number;
}

export const ABSORBING: readonly Absorbing[] = [
  // Bangkok (PPLC, TH admin1 40, Krung Thep Maha Nakhon): GeoNames lists its khet (Chatuchak, Bang
  // Kapi, Lat Krabang, Bang Na, Pathum Wan ...) as towns, and 53 of the 58 places around it have no
  // locality, so they went to their khet and Bangkok had none. The province is the city.
  { id: 1609350, name: "Bangkok", withinKm: 25 },
];
