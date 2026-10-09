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
 * - the one town within that reach whose places give it that name (`City.aliases`), if it is within
 *   `KEPT_ALIAS_KM`: Prague for Praha. When two towns within reach have the name ("New York", which
 *   the places of New York City and of Weehawken give), or the one is farther, no town is surely it.
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
    } else if ((city.aliases ?? []).includes(name)) {
      byAlias.push({ city, km });
    }
  }
  const [only] = byAlias;
  const town = byName?.city ?? (byAlias.length === 1 && only!.km <= KEPT_ALIAS_KM ? only!.city : undefined);
  if (town === undefined) return undefined;
  const now = savedCityOf(town);
  return same(now, kept) ? undefined : now;
}
