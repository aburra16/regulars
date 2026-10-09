/*
 * Capitals that take in their districts: a reviewed list that tools/towns.ts reads. GeoNames lists the
 * districts of some capitals as towns of their own, and when the places there carry no locality, no
 * place says which city they are in, so nothing makes the districts parts of it (see `chooseTowns`).
 * Each capital here takes in, as parts, every GeoNames town in its own first-level area (`admin1`:
 * the province or special area that holds the city) within `withinKm` of its point: 25 km where the
 * area is the city, less where it holds other cities too. A town of another
 * area that near stays a town of its own: Pak Kret, in Nonthaburi, beside Bangkok.
 *
 * Add a city only after looking at it: a capital with no places of its own, whose districts hold the
 * places around it, with a reach that takes in only its districts.
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
  // Tokyo (PPLC, JP admin1 40, Tokyo-to): GeoNames lists the special wards' neighbourhoods (Minato
  // City, Sakuragaokachō, Ichigaya-honmurachō, Hatchōbori ...) as towns, and the 40 places around its
  // point name their ward only in Japanese (港区, 渋谷区, 千代田区), so they went to those and Tokyo had
  // none. Tokyo-to is wider than the city: it holds the Tama cities too. Every town within 10 km of
  // Tokyo's point is in a special ward; Kichijōji-honchō, in Musashino, is 10.5 km off, and Mitaka 11.9.
  { id: 1850147, name: "Tokyo", withinKm: 10 },
];
