import { type JSX, useCallback, useMemo, useState } from "react";

import { BaseMap, type BaseMapProps } from "../map/BaseMap.tsx";
import { type Pin, pinsFor, scorePins } from "../map/pins.ts";
import type { PlaceDistance } from "../places/indexes.ts";
import { usePlaces } from "../places/store.tsx";
import { useIndexes } from "../places/useIndexes.ts";
import { useListScores } from "../score/useListScores.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";

const NOTHING_DRAWN: readonly string[] = [];

/** Whether two lists hold the same addresses in the same order. */
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((each, i) => each === b[i]);

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
 */
export function EveryPlaceMap(props: Omit<BaseMapProps, "pins" | "points" | "pinOf" | "onPinsDrawn">): JSX.Element {
  const { places } = usePlaces();
  const indexes = useIndexes();
  const locale = useLocale();
  const now = useNow();

  // The pins the map draws now, by address, as the map says each time they change.
  const [drawn, setDrawn] = useState<readonly string[]>(NOTHING_DRAWN);
  const onPinsDrawn = useCallback(
    (addresses: readonly string[]) => setDrawn((last) => (sameList(last, addresses) ? last : addresses)),
    [],
  );

  // Their scores, asked of the store in one go, as a list's are.
  const rows = useMemo<PlaceDistance[]>(
    () =>
      drawn.flatMap((address) => {
        const place = indexes?.byAddress.get(address);
        return place === undefined ? [] : [{ place, km: 0 }];
      }),
    [drawn, indexes],
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
      const pin = unscoredPinOf(address);
      return pin === undefined ? undefined : scorePins([pin], scores.of)[0];
    },
    [unscoredPinOf, scores],
  );

  return <BaseMap {...props} points={places} pinOf={pinOf} onPinsDrawn={onPinsDrawn} />;
}
