import { useMemo } from "react";

import { config } from "../config.ts";
import type { Entry } from "../map/pins.ts";
import type { PlaceScore } from "./score.ts";
import { type ShownScore, shownScore } from "./shown.ts";
import type { HouseState } from "./store.ts";
import { useScores } from "./useScore.ts";

/** What a list's cards, rows and pins show of their places' scores. */
export interface ListScores {
  /** What the place at `address` shows: "none" for a place the list did not ask about. */
  of(address: string): ShownScore;
  /**
   * Whether a place in the list has a score. Then a place others have rated, with none of them
   * inside House picks, is a dashed card (M1's `unrated-dashed`, Main.dc.html).
   */
  anyScored: boolean;
  /** Where the house's view stands. */
  house: HouseState;
}

const NONE: ShownScore = { kind: "none" };

/** The address of the place an entry is; undefined for a chain, which is not scored as one. */
const placeAddress = (entry: Entry): string | undefined => ("chain" in entry ? undefined : entry.place.address);

/**
 * `entries` best first by House picks: by each place's damped score (`orderKey`, brief § 5), with
 * the ones it has none for, and each chain, at the prior's mean. Places that tie keep the order they
 * came in, which is nearest first, or best match first for words. A chain is not scored as one: each
 * location is scored on its own, and the chain's card shows none.
 */
function byHousePicks<E extends Entry>(entries: readonly E[], scores: ReadonlyMap<string, PlaceScore>): E[] {
  const { priorMean } = config.scoring;
  const keyOf = (entry: E) => {
    const address = placeAddress(entry);
    return (address === undefined ? undefined : scores.get(address)?.orderKey) ?? priorMean;
  };
  // Array.prototype.sort is stable: what ties stays in the order it came in.
  return [...entries].sort((a, b) => keyOf(b) - keyOf(a));
}

/**
 * The scores of a list's places from the house's view, asked of the store in one go for the whole
 * list (its cards and its map's pins alike), and the list in order: as it came, or best first by
 * House picks when `byScore`. A chain's places are not asked about: its card and its pin show none.
 */
export function useListScores<E extends Entry>(entries: E[], byScore = false): { entries: E[]; scores: ListScores } {
  const addresses = useMemo(
    () => entries.flatMap((entry) => {
      const address = placeAddress(entry);
      return address === undefined ? [] : [address];
    }),
    [entries],
  );
  const { scores, pending, house } = useScores(addresses);

  const listScores = useMemo<ListScores>(() => {
    const shown = new Map<string, ShownScore>();
    let anyScored = false;
    for (const address of addresses) {
      const each = shownScore(scores.get(address), pending.has(address), house);
      shown.set(address, each);
      if (each.kind === "scored") anyScored = true;
    }
    return { of: (address) => shown.get(address) ?? NONE, anyScored, house };
  }, [addresses, scores, pending, house]);

  const ordered = useMemo(() => (byScore ? byHousePicks(entries, scores) : entries), [byScore, entries, scores]);
  return { entries: ordered, scores: listScores };
}
