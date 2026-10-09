import { distanceKm } from "../places/distance.ts";
import type { City } from "../places/indexes.ts";
import { foldName, TOWN_REACH_KM } from "../places/towns.ts";
import { type SavedCity, savedCityOf } from "./useLocation.ts";

/** Whether two kept towns are the same, field for field. */
const same = (a: SavedCity, b: SavedCity) =>
  a.name === b.name && a.region === b.region && a.country === b.country && a.lat === b.lat && a.lon === b.lon;

/**
 * The town a pick kept on this device is now, as the device should keep it; undefined when it is
 * kept so already, or when no town is it. Before the towns of src/data/towns.json, a town was named
 * by its places' locality ("Praha", "Lisboa") and was at the middle of them. Now it is the town of the
 * same country within a town's reach (`TOWN_REACH_KM`) of where it was kept that has its name, or
 * else that its places give that name to (`City.aliases`): Prague for Praha, at GeoNames' point. The
 * nearer of two such towns, and a town by its own name before one by another name, is the one.
 */
export function keptTownNow(kept: SavedCity, cities: readonly City[]): SavedCity | undefined {
  const name = foldName(kept.name);
  if (name === "") return undefined;
  let best: { city: City; km: number; own: boolean } | undefined;
  for (const city of cities) {
    if (kept.country !== "" && city.country !== kept.country) continue;
    const own = foldName(city.name) === name;
    if (!own && !(city.aliases ?? []).includes(name)) continue;
    const km = distanceKm(kept.lat, kept.lon, city.lat, city.lon);
    if (!(km <= TOWN_REACH_KM)) continue;
    if (best === undefined || (own && !best.own) || (own === best.own && km < best.km)) best = { city, km, own };
  }
  if (best === undefined) return undefined;
  const now = savedCityOf(best.city);
  return same(now, kept) ? undefined : now;
}
