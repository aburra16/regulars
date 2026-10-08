import { createContext, type JSX, type ReactNode, useContext, useEffect, useState } from "react";

import { ForgetOnSignOut } from "../account/forgetOnSignOut.ts";
import type { RelayReader, RelayWriter } from "../nostr/events.ts";
import { appReaders, appWriters } from "../nostr/relayCode.ts";
import { usePlaces } from "../places/store.tsx";
import { ScoresStore } from "./store.ts";

export type { HouseState, ReadState } from "./store.ts";

/** How the app reaches each relay, by its URL: to read from it, and to send it a review. */
export interface Relays {
  readers: (url: string) => RelayReader;
  writers: (url: string) => RelayWriter;
}

const ScoresContext = createContext<{ store: ScoresStore; relays: Relays } | null>(null);

/**
 * Holds the session's reviews, house ranks and reviewer names for the pages below it, which ask
 * through the hooks in ./useScore.ts, and the person's own reviews, shown before the relays send them
 * back (kept for the tab, so a reload shows them too, and let go of when the person signs out:
 * `ForgetOnSignOut`). It reads nothing until a page asks. It must be
 * inside a `PlacesProvider`: from the places it knows which are filed more than once (brief § 4.3).
 * `readers` gives each relay's reader and `writers` each relay's writer, for posting a review
 * (`useRelays`); both are read once, on mount. Without them, the app's own, which load the relay
 * code when they are first used.
 */
export function ScoresProvider({
  children,
  readers,
  writers,
}: {
  children: ReactNode;
  readers?: (url: string) => RelayReader;
  writers?: (url: string) => RelayWriter;
}): JSX.Element {
  const [value] = useState(() => ({
    store: new ScoresStore(readers),
    relays: { readers: readers ?? appReaders, writers: writers ?? appWriters },
  }));
  const { store } = value;
  const { places } = usePlaces();

  useEffect(() => store.setPlaces(places), [store, places]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  // Signing out lets go of the person's own reviews held for the tab (the account provider is inside this one).
  return (
    <ForgetOnSignOut value={store.forgetHeld}>
      <ScoresContext value={value}>{children}</ScoresContext>
    </ForgetOnSignOut>
  );
}

/** The store, for the hooks in ./useScore.ts; `hook` names the one that asks, for its error. */
export function useScoresStore(hook: string): ScoresStore {
  const value = useContext(ScoresContext);
  if (value === null) throw new Error(`${hook} must be used inside <ScoresProvider>.`);
  return value.store;
}

/**
 * How the app reaches each relay, for posting a review: the readers it reads the person's relay list
 * with, and the writers it sends the review with. Raw: no read extras added (writeRelaysOf adds its own).
 */
export function useRelays(): Relays {
  const value = useContext(ScoresContext);
  if (value === null) throw new Error("useRelays must be used inside <ScoresProvider>.");
  return value.relays;
}
