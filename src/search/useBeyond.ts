import { useMemo } from "react";

import { useHere } from "../location/useLocation.ts";
import { type City, cityLabeller, type Indexes, type PlaceDistance } from "../places/indexes.ts";
import type { Place } from "../places/place.ts";
import { townFinder } from "../places/townSearch.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { useLocale } from "../shell/useLocale.ts";
import { widestKm } from "./filters.ts";

/** How many towns the search shows above the places near. */
export const TOWNS_SHOWN = 3;

/** How many places the search shows from elsewhere, below the places near. */
export const ELSEWHERE_SHOWN = 5;

/** A town the words name, with where it is as its row says it: "Prague, Czechia". */
export interface TownFound {
  city: City;
  where: string;
}

/** A place farther away whose name has the words, with how far it is and where: "Prague, Czechia". */
export interface PlaceElsewhere extends PlaceDistance {
  where: string;
}

/** A country's name, or its code when the towns name none ("" for none). */
const countryOf = (indexes: Indexes, code: string | undefined) => {
  const upper = (code ?? "").trim().toUpperCase();
  return upper === "" ? "" : (indexes.countryName(upper) ?? upper);
};

/** A town and its country: "Prague, Czechia", or "Lexington, KY, United States" where its name alone is another town's too. */
function townWhere(indexes: Indexes, city: City, label: string): string {
  const parts = [city.name];
  if (label !== city.name && city.region !== undefined) parts.push(city.region);
  parts.push(countryOf(indexes, city.country));
  return parts.filter((part) => part !== "").join(", ");
}

/** Where a place is: its town and that town's country, or its own locality and country when it is in no town. */
function placeWhere(indexes: Indexes, place: Place): string {
  const town = indexes.townOf(place);
  const parts = town === undefined ? [place.locality?.trim() ?? "", countryOf(indexes, place.country)] : [town.name, countryOf(indexes, town.country)];
  return parts.filter((part) => part !== "").join(", ");
}

/**
 * What a search for the words `q` finds beyond the places near "here", which `useResults` lists:
 * the towns the words name (`TOWNS_SHOWN` at most, best match first, the town with more places first
 * among equals; see `townFinder`), and the places farther than the widest distance the filters offer
 * whose names have the words (`ELSEWHERE_SHOWN` at most, best match first; see `Indexes.elsewhere`).
 * Neither for a kind of place ("coffee"), which is a search of the places near, nor for no words; the
 * filters apply to neither.
 */
export function useBeyond(q: string): { towns: TownFound[]; elsewhere: PlaceElsewhere[] } {
  const indexes = useIndexes();
  const { lat, lon } = useHere();
  const locale = useLocale();

  // The towns' names are folded once for the list of towns, not at each search.
  const finder = useMemo(() => {
    if (indexes === undefined) return undefined;
    const label = cityLabeller(indexes.cities);
    return { label, find: townFinder(indexes.cities, label) };
  }, [indexes]);

  const words = q.trim() !== "" && indexes !== undefined && !indexes.isKindQuery(q);
  const towns = useMemo<TownFound[]>(() => {
    if (!words || indexes === undefined || finder === undefined) return [];
    return finder.find(q, TOWNS_SHOWN).map((city) => ({ city, where: townWhere(indexes, city, finder.label(city)) }));
  }, [words, indexes, finder, q]);

  const beyondKm = widestKm(locale);
  const elsewhere = useMemo<PlaceElsewhere[]>(() => {
    if (!words || indexes === undefined) return [];
    return indexes
      .elsewhere(q, { lat, lon, beyondKm, limit: ELSEWHERE_SHOWN })
      .map((row) => ({ ...row, where: placeWhere(indexes, row.place) }));
  }, [words, indexes, q, lat, lon, beyondKm]);

  return { towns, elsewhere };
}
