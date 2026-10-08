import { type JSX, useCallback, useMemo, useState } from "react";

import { BaseMap, type BaseMapProps } from "../map/BaseMap.tsx";
import { type Pin, pinsFor, scorePins } from "../map/pins.ts";
import { distanceKm } from "../places/distance.ts";
import { openState } from "../places/hours.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import { type FamilyId, kindOf } from "../places/kinds.ts";
import { usePlaces } from "../places/store.tsx";
import { useIndexes } from "../places/useIndexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";

const NOTHING_DRAWN: readonly string[] = [];

/** Whether two lists hold the same addresses in the same order. */
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((each, i) => each === b[i]);

/** What the desktop's filters leave of the places on its map. */
export interface MapFilters {
  /** Only places of these kinds; none is every kind. */
  kinds?: readonly FamilyId[];
  /** Only places within `km` of `from`; Infinity, or none, is no limit. */
  within?: { km: number; from: { lat: number; lon: number } };
  /** Only places open now, among the pins drawn on their own (see `EveryPlaceMap`). */
  openNow?: boolean;
}

/**
 * Explore's map (the phone's Map tab, and the desktop's beside the list): every place is a pin, at
 * any zoom, whatever the list holds (decision 25). A chain's places are each a pin of their own, as
 * a bubble counts them.
 *
 * The map's source is every place, as points, sent once for as long as the places are the same:
 * where they crowd, the map gathers them into bubbles. A pin's words (its hours) are worked out only
 * when the map draws it on its own, or it is chosen or picked out: at most `MAX_MARKERS` at a time,
 * once a minute. Only those pins' scores are asked for, never every place's, and a new score or a new
 * minute changes those pins and nothing in the source.
 *
 * The desktop's filters narrow the map as they narrow the list (`filters`). The kinds and the distance
 * narrow the source itself, which is sent again only when they change. Open now is not: whether a
 * place is open needs its hours, which the map works out for the pins it draws and no others. So Open
 * now leaves out the closed pins drawn on their own, and a bubble's count still has the closed places
 * in it. The chosen pin is drawn whatever it is.
 */
export function EveryPlaceMap({
  filters,
  ...props
}: Omit<BaseMapProps, "pins" | "points" | "pinOf" | "onPinsDrawn"> & { filters?: MapFilters }): JSX.Element {
  const { places } = usePlaces();
  const indexes = useIndexes();
  const locale = useLocale();
  const now = useNow();
  const { selected } = props;

  // The places of the kinds and within the distance chosen: the same array while those are the same.
  const kindsKey = filters?.kinds?.join(",") ?? "";
  const withinKm = filters?.within?.km ?? Number.POSITIVE_INFINITY;
  // The point the distance is from matters only while there is a distance.
  const withinFrom = withinKm === Number.POSITIVE_INFINITY ? "" : `${filters?.within?.from.lat},${filters?.within?.from.lon}`;
  const points = useMemo(() => {
    if (kindsKey === "" && withinFrom === "") return places;
    const kinds = new Set(kindsKey.split(",").filter((kind) => kind !== ""));
    const [fromLat, fromLon] = withinFrom.split(",").map(Number);
    return places.filter(
      (place) =>
        (kinds.size === 0 || kinds.has(kindOf(place.category).family)) &&
        (withinFrom === "" || distanceKm(fromLat!, fromLon!, place.lat, place.lon) <= withinKm),
    );
  }, [places, kindsKey, withinKm, withinFrom]);

  // The pins the map draws now, by address, as the map says each time they change.
  const [drawn, setDrawn] = useState<readonly string[]>(NOTHING_DRAWN);
  const onPinsDrawn = useCallback(
    (addresses: readonly string[]) => setDrawn((last) => (sameList(last, addresses) ? last : addresses)),
    [],
  );

  // Whether each place drawn is closed now, worked out once a minute, and only while Open now is on.
  const openNow = filters?.openNow === true;
  const closed = useMemo(() => {
    const known = new Map<string, boolean>();
    return (address: string): boolean => {
      if (!openNow) return false;
      let shut = known.get(address);
      if (shut === undefined) {
        const place = indexes?.byAddress.get(address);
        shut = place !== undefined && openState(place, now).kind === "closed";
        known.set(address, shut);
      }
      return shut;
    };
  }, [openNow, indexes, now]);
  const leftOut = useCallback((address: string) => address !== selected && closed(address), [closed, selected]);

  // The drawn pins' scores, asked of the store in one go, as a list's are: not those Open now leaves out.
  const rows = useMemo<PlaceDistance[]>(
    () =>
      drawn.flatMap((address) => {
        const place = indexes?.byAddress.get(address);
        return place === undefined || leftOut(address) ? [] : [{ place, km: 0 }];
      }),
    [drawn, indexes, leftOut],
  );
  const { scores } = useListScores(rows);

  // Each pin's words, worked out the first time it is drawn, and kept while the minute and the
  // language are the same.
  const unscoredPinOf = useMemo(() => {
    const made = new Map<string, Pin>();
    return (address: string): Pin | undefined => {
      const kept = made.get(address);
      if (kept !== undefined) return kept;
      const place = indexes?.byAddress.get(address);
      if (place === undefined) return undefined;
      const [pin] = pinsFor([{ place, km: 0 }], locale, now);
      made.set(address, pin!);
      return pin;
    };
  }, [indexes, locale, now]);

  // With its score put to it: a pin whose score has not changed is the same pin (`scorePins`).
  const pinOf = useCallback(
    (address: string): Pin | undefined => {
      if (leftOut(address)) return undefined;
      const pin = unscoredPinOf(address);
      return pin === undefined ? undefined : scorePins([pin], scores.of)[0];
    },
    [leftOut, unscoredPinOf, scores],
  );

  return <BaseMap {...props} points={points} pinOf={pinOf} onPinsDrawn={onPinsDrawn} />;
}
