import { createContext, type JSX, type ReactNode, useContext, useEffect, useState } from "react";

import type { RelayReader } from "../nostr/events.ts";
import { usePlaces } from "../places/store.tsx";
import { ScoresStore } from "./store.ts";

export type { HouseState, ReadState } from "./store.ts";

const ScoresContext = createContext<ScoresStore | null>(null);

/**
 * Holds the session's reviews, house ranks and reviewer names for the pages below it, which ask
 * through the hooks in ./useScore.ts. It reads nothing until a page asks. It must be inside a
 * `PlacesProvider`: from the places it knows which are filed more than once (brief § 4.3).
 * `readers` gives each relay's reader, and is read once, on mount; without it, the app's readers,
 * which load the relay code when they first read.
 */
export function ScoresProvider({
  children,
  readers,
}: {
  children: ReactNode;
  readers?: (url: string) => RelayReader;
}): JSX.Element {
  const [store] = useState(() => new ScoresStore(readers));
  const { places } = usePlaces();

  useEffect(() => store.setPlaces(places), [store, places]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  return <ScoresContext value={store}>{children}</ScoresContext>;
}

/** The store, for the hooks in ./useScore.ts; `hook` names the one that asks, for its error. */
export function useScoresStore(hook: string): ScoresStore {
  const store = useContext(ScoresContext);
  if (store === null) throw new Error(`${hook} must be used inside <ScoresProvider>.`);
  return store;
}
