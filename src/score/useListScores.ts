import { useMemo } from "react";

import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import type { Entry } from "../map/pins.ts";
import type { View } from "../view/ViewProvider.tsx";
import type { PlaceScore } from "./score.ts";
import { reviewOf, seenBy, type ShownScore, shownScore } from "./shown.ts";
import type { ViewState } from "./store.ts";
import { useScores } from "./useScore.ts";

/** What a list's cards, rows and pins show of their places' scores, from the view on screen. */
export interface ListScores {
  /** What the place at `address` shows: "none" for a place the list did not ask about. */
  of(address: string): ShownScore;
  /**
   * Whether a place in the list has a score. Then a place others have rated, with none of them
   * inside the view, is a dashed card (M1's `unrated-dashed`, Main.dc.html).
   */
  anyScored: boolean;
  /** Whose scores they are: House picks', or My circle's. */
  view: View;
  /** Where that view's ranks stand. */
  state: ViewState;
}

const NONE: ShownScore = { kind: "none" };

/** The address of the place an entry is; undefined for a chain, which is not scored as one. */
const placeAddress = (entry: Entry): string | undefined => ("chain" in entry ? undefined : entry.place.address);

/** How far an entry is: a place's distance, a chain's nearest place's. */
const kmOf = (entry: Entry): number => ("chain" in entry ? (entry.nearby[0]?.km ?? Number.POSITIVE_INFINITY) : entry.km);

/**
 * `entries` best first by the view's `scores`: first the places with a score, by their damped score
 * (`orderKey`, brief § 5), the nearer first when two are the same; then every other entry, nearest
 * first, whatever order they came in (best match first for words). A place with no score is not given
 * the prior's mean to sort by: it follows every place with one. A chain is not scored as one: each
 * location is scored on its own, and the chain's card shows none, so it is among the others.
 */
function byScore<E extends Entry>(entries: readonly E[], scores: ReadonlyMap<string, PlaceScore>): E[] {
  const scored: { entry: E; key: number }[] = [];
  const others: E[] = [];
  for (const entry of entries) {
    const address = placeAddress(entry);
    const score = address === undefined ? undefined : scores.get(address);
    if (score !== undefined && score.score !== null && score.counted > 0) scored.push({ entry, key: score.orderKey });
    else others.push(entry);
  }
  // Array.prototype.sort is stable: what ties stays in the order it came in.
  scored.sort((a, b) => b.key - a.key || kmOf(a.entry) - kmOf(b.entry));
  others.sort((a, b) => kmOf(a) - kmOf(b));
  return [...scored.map(({ entry }) => entry), ...others];
}

/**
 * The scores of a list's places from the view on screen, asked of the store in one go for the whole
 * list (its cards and its map's pins alike), and the list in order: as it came, or best first by the
 * view's scores when `sorted`. A chain's places are not asked about: its card and its pin show none.
 * Toggling the view asks for nothing: the same reviews are scored from the other view's ranks.
 */
export function useListScores<E extends Entry>(entries: E[], sorted = false): { entries: E[]; scores: ListScores } {
  const addresses = useMemo(
    () => entries.flatMap((entry) => {
      const address = placeAddress(entry);
      return address === undefined ? [] : [address];
    }),
    [entries],
  );
  const { scores, pending, reads, view, state } = useScores(addresses);
  const me = useOwnPubkey();

  const listScores = useMemo<ListScores>(() => {
    // Each place's is the same object while its score is (`shownScore`, `seenBy`): a card given it is
    // not drawn again. The person signed in is never one of the others (ruling R16).
    const shown = new Map<string, ShownScore>();
    let anyScored = false;
    for (const address of addresses) {
      const score = scores.get(address);
      const each = seenBy(shownScore(score, pending.has(address), state, reads.get(address), view), score, reviewOf(score, me));
      shown.set(address, each);
      if (each.kind === "scored") anyScored = true;
    }
    return { of: (address) => shown.get(address) ?? NONE, anyScored, view, state };
  }, [addresses, scores, pending, reads, view, state, me]);

  const ordered = useMemo(() => (sorted ? byScore(entries, scores) : entries), [sorted, entries, scores]);
  return { entries: ordered, scores: listScores };
}
