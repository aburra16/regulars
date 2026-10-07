import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { readSaved, writeSaved } from "./cache.ts";
import { fetchHouseEvents, placesFromEvents, type RelayReader } from "./load.ts";
import type { Place } from "./place.ts";

/** Why the places could not be refreshed: a code, never a message. The screens choose the words. */
export type PlacesError = "network";

export interface PlacesState {
  status: "loading" | "ready" | "error";
  places: Place[];
  /** Where `places` came from: the copy saved on this device, or the relay just now. */
  source: "cache" | "network";
  /** When `places` were saved on this device, in milliseconds since the epoch. */
  savedAt?: number;
  /** Set when the last load from the relay failed. Any places shown are the saved ones. */
  error?: PlacesError;
}

export type PlacesValue = PlacesState & {
  /** Loads the places from the relay again. */
  retry(): void;
};

const LOADING: PlacesState = { status: "loading", places: [], source: "network" };

const PlacesContext = createContext<PlacesValue | null>(null);

/**
 * The app's reader. It is a separate chunk with Nostrify and what it brings (zod, websocket-ts,
 * nostr-tools), so saved places can show before it arrives. A test that passes a reader never
 * loads it.
 */
async function placesRelayReader(): Promise<RelayReader> {
  return (await import("./relayReader.ts")).relayReader;
}

/**
 * Loads the places for the screens below it. On mount it shows the copy saved on the device, if
 * there is one, then loads the list from the relay in the background and shows that instead.
 * A load that fails keeps the saved copy on screen; with no saved copy, it is an error.
 * `reader` is read once, on mount; without one, the provider reads the places relay.
 */
export function PlacesProvider({ children, reader }: { children: ReactNode; reader?: RelayReader }): JSX.Element {
  const [state, setState] = useState<PlacesState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const [givenReader] = useState(reader);
  // The saved copy is read once per mount. `count` is how many places it holds (undefined: none).
  const saved = useRef<{ read: boolean; count?: number }>({ read: false });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const fail = () =>
      setState((current) =>
        current.status === "ready"
          ? { ...current, error: "network" }
          : { status: "error", places: [], source: "network", error: "network" },
      );

    // Fetch the relay code while the saved copy is read. A failure surfaces where it is awaited.
    const readerReady = givenReader === undefined ? placesRelayReader() : Promise.resolve(givenReader);
    readerReady.catch(() => {});

    void (async () => {
      if (!saved.current.read) {
        const copy = await readSaved();
        if (signal.aborted) return;
        saved.current.read = true;
        const places = copy ? placesFromEvents(copy.events) : [];
        if (copy && places.length > 0) {
          saved.current.count = places.length;
          setState({ status: "ready", places, source: "cache", savedAt: copy.savedAt });
        }
      }

      try {
        const { events, complete } = await fetchHouseEvents(await readerReady, { signal });
        if (signal.aborted) return;
        const places = placesFromEvents(events);
        const before = saved.current.count;
        // The list is never empty, so no places means the read went wrong. An incomplete read
        // replaces a saved copy only if it holds at least as many places.
        if (places.length === 0 || (!complete && before !== undefined && places.length < before)) {
          fail();
          return;
        }
        const savedAt = Date.now();
        saved.current.count = places.length;
        setState({ status: "ready", places, source: "network", savedAt });
        void writeSaved({ events, savedAt });
      } catch {
        if (!signal.aborted) fail();
      }
    })();

    return () => controller.abort();
  }, [attempt, givenReader]);

  const retry = useCallback(() => {
    setState((current) => (current.status === "error" ? LOADING : current));
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo(() => ({ ...state, retry }), [state, retry]);
  return <PlacesContext value={value}>{children}</PlacesContext>;
}

/** The places and how they loaded. Use it inside a `PlacesProvider`. */
export function usePlaces(): PlacesValue {
  const value = useContext(PlacesContext);
  if (value === null) throw new Error("usePlaces must be used inside <PlacesProvider>.");
  return value;
}
