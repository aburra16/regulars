import type { City } from "../places/indexes.ts";
import { distance } from "../places/geo.ts";
import { foldName, TOWN_REACH_KM } from "../places/towns.ts";
import { type SavedCity, savedCityOf } from "./useLocation.ts";

/**
 * How near a town must be to a kept pick for the pick to be moved to it through a name the town's
 * places give it ("Praha" for Prague), in kilometres. By its own name, a town within a town's reach
 * (`TOWN_REACH_KM`) will do.
 */
export const KEPT_ALIAS_KM = 10;

/**
 * How many times the places of the next a town must have to be the one a name its places give is
 * taken for, when more than one has it: Prague's 29 places that say Praha, and the one of Radotín.
 */
export const KEPT_ALIAS_LEAD = 3;

/** Whether two kept towns are the same, field for field. */
const same = (a: SavedCity, b: SavedCity) =>
  a.name === b.name && a.region === b.region && a.country === b.country && a.lat === b.lat && a.lon === b.lon;

/**
 * The town a pick kept on this device is now, as the device should keep it; undefined when it is
 * kept so already, or when no town is surely it. Before the towns of src/data/towns.json, a town was
 * named by its places' locality ("Praha", "Lisboa") and was at the middle of them. Now it is a town of
 * the file (one with a GeoNames id: never a town of a locality, and so nothing while the towns could
 * not be loaded), in the same country:
 *
 * - the nearest within `TOWN_REACH_KM` of where it was kept that has its name ("Funchal"); else
 * - of the towns within `KEPT_ALIAS_KM` whose places give it that name (`City.aliases`), the one with
 *   the most places, when it has `KEPT_ALIAS_LEAD` times the places of the next: Prague for Praha,
 *   which one place of Radotín gives too; New York City for New York, which one place of Weehawken
 *   gives. When none of them has that lead, or none is that near, no town is surely it.
 */
export function keptTownNow(kept: SavedCity, cities: readonly City[]): SavedCity | undefined {
  const name = foldName(kept.name);
  if (name === "") return undefined;
  let byName: { city: City; km: number } | undefined;
  const byAlias: { city: City; km: number }[] = [];
  for (const city of cities) {
    if (city.geonameId === undefined || (kept.country !== "" && city.country !== kept.country)) continue;
    const km = distance(kept.lon, kept.lat, city.lon, city.lat);
    if (!(km <= TOWN_REACH_KM)) continue;
    if (foldName(city.name) === name) {
      if (byName === undefined || km < byName.km) byName = { city, km };
    } else if (km <= KEPT_ALIAS_KM && (city.aliases ?? []).includes(name)) {
      byAlias.push({ city, km });
    }
  }
  const [first, second] = byAlias.sort((a, b) => b.city.count - a.city.count);
  const byAliasTown = first !== undefined && first.city.count >= KEPT_ALIAS_LEAD * (second?.city.count ?? 0) ? first.city : undefined;
  const town = byName?.city ?? byAliasTown;
  if (town === undefined) return undefined;
  const now = savedCityOf(town);
  return same(now, kept) ? undefined : now;
}
