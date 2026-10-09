import type { NostrEvent } from "@nostrify/nostrify";
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

import type { RelayReader } from "../nostr/events.ts";
import { readSaved, writeSaved } from "./cache.ts";
import { debug, fetchHouseEvents, parsePlaces, sameStamps, savedEvents, type Stamps, stampsOf } from "./load.ts";
import type { Place } from "./place.ts";
import { loadTowns, type TownList } from "./towns.ts";

/** Why the places could not be refreshed: a code, never a message. The screens choose the words. */
export type PlacesError = "network";

export interface PlacesState {
  status: "loading" | "ready" | "error";
  places: Place[];
  /** Where `places` came from: the copy saved on this device, or the relay just now. */
  source: "cache" | "network";
  /** False when `places` may be short of the whole list: the load stopped before its end. */
  complete: boolean;
  /** When the places on this device were saved, in milliseconds since the epoch. */
  savedAt?: number;
  /** Set when the last load from the relay failed. Any places shown are the saved ones. */
  error?: PlacesError;
  /**
   * The towns the places are put in (src/data/towns.json), which come with them: places are not shown
   * before their towns. Null when the towns could not be loaded; absent while there are no places.
   */
  towns?: TownList | null;
}

export type PlacesValue = PlacesState & {
  /** Loads the places from the relay again. */
  retry(): void;
};

const LOADING: PlacesState = { status: "loading", places: [], source: "network", complete: false };

const PlacesContext = createContext<PlacesValue | null>(null);

/** The copy saved on this device, read back. */
interface SavedCopy {
  places: Place[];
  savedAt: number;
  complete: boolean;
  /** Each saved event's address and time, to tell whether the relay's are the same. */
  stamps: Stamps;
}

/** What one mount knows of the saved copy. */
interface Device {
  /** The one read of the saved copy. It never rejects, and answers once `copy` and `saved` are set. */
  read?: Promise<void>;
  /**
   * The saved copy, to show while the relay's places have not come; null: none, or the relay's are on
   * screen. Once they are, it is let go, with the indexes built for it: the app holds one list.
   */
  copy?: SavedCopy | null;
  /** The relay's places are on screen: the saved copy is not shown again, nor kept. */
  replaced?: boolean;
  /** The saved events' addresses and times, until the relay's places have been compared with them. */
  stamps?: Stamps;
  /** The saved copy's size, once the read has answered or a save has worked; null: none. */
  saved?: { count: number; savedAt: number; complete: boolean } | null;
}

/**
 * The app's reader. It is a separate chunk with Nostrify and what it brings (zod, websocket-ts,
 * nostr-tools), so saved places can show before it arrives. A test that passes a reader never
 * loads it.
 */
async function placesRelayReader(): Promise<RelayReader> {
  return (await import("./relayReader.ts")).relayReader;
}

/** The saved copy, or null when there is none, it holds no places, or it cannot be read. */
async function readSavedCopy(): Promise<SavedCopy | null> {
  try {
    const record = await readSaved();
    if (record === undefined) return null;
    const events = savedEvents(record.events);
    const places = parsePlaces(events);
    return places.length > 0
      ? { places, savedAt: record.savedAt, complete: record.complete, stamps: stampsOf(events) }
      : null;
  } catch (error) {
    debug("could not use the saved places", error);
    return null;
  }
}

/**
 * Whether places from the relay may replace the saved copy. The list is never empty, so no
 * places means the load went wrong. With nothing saved, anything else may. Over a saved copy,
 * only a complete load may, and only one that keeps at least half its places: a relay whose
 * limit fell below ours, or a partial re-import, must not shrink the list.
 */
function mayReplace(count: number, complete: boolean, saved: { count: number } | null): boolean {
  if (count === 0) return false;
  if (saved === null) return true;
  return complete && count * 2 >= saved.count;
}

/**
 * Loads the places for the screens below it. On mount it reads the copy saved on the device
 * and loads the list from the relay, side by side. The saved copy shows as soon as it is read,
 * unless the relay's places are on screen already; the relay's places replace it when they come.
 * A load that fails keeps the saved copy on screen; with no saved copy, it is an error.
 * `reader` is read once, on mount; without one, the provider reads the places relay.
 *
 * The towns load at the same time, from their own chunk (`loadTowns`), and either copy of the places
 * shows once they have come, or failed to: the screens never put the places in towns twice. `towns`,
 * read once on mount, gives them instead (null: as if they could not be loaded); a test that passes
 * them never loads the chunk.
 */
export function PlacesProvider({
  children,
  reader,
  towns,
}: {
  children: ReactNode;
  reader?: RelayReader;
  towns?: TownList | null;
}): JSX.Element {
  const [state, setState] = useState<PlacesState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const [givenReader] = useState(reader);
  const [givenTowns] = useState(towns);
  const deviceRef = useRef<Device>({});

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const device = deviceRef.current;

    const fail = () =>
      setState((current) =>
        current.status === "ready"
          ? { ...current, error: "network" }
          : { status: "error", places: [], source: "network", complete: false, error: "network" },
      );

    // The towns, from their chunk, at the same time as the rest. They never fail: null is none.
    const townsReady = givenTowns === undefined ? loadTowns() : Promise.resolve(givenTowns);

    // Read the saved copy once per mount. It shows unless places are on screen already: the
    // relay's, which win, or this same copy, shown by an earlier run.
    device.read ??= readSavedCopy().then((copy) => {
      if (device.saved === undefined) {
        device.saved = copy && { count: copy.places.length, savedAt: copy.savedAt, complete: copy.complete };
        device.stamps = copy?.stamps;
      }
      device.copy = device.replaced ? null : copy;
    });
    void Promise.all([device.read, townsReady]).then(([, loadedTowns]) => {
      const copy = device.copy;
      if (signal.aborted || copy === null || copy === undefined) return;
      setState((current) =>
        current.status === "ready"
          ? current
          : {
              status: "ready",
              places: copy.places,
              source: "cache",
              complete: copy.complete,
              savedAt: copy.savedAt,
              towns: loadedTowns,
              ...(current.status === "error" ? { error: "network" as const } : {}),
            },
      );
    });

    // Load from the relay at the same time. Its code loads while the saved copy is read.
    const readerReady = givenReader === undefined ? placesRelayReader() : Promise.resolve(givenReader);
    readerReady.catch(() => {});

    void (async () => {
      let loaded: { events: NostrEvent[]; complete: boolean; places: Place[] };
      try {
        const { events, complete } = await fetchHouseEvents(await readerReady, { signal });
        loaded = { events, complete, places: parsePlaces(events) };
      } catch {
        if (!signal.aborted) fail();
        return;
      }
      const { events, complete, places } = loaded;
      const towns = await townsReady;
      if (signal.aborted) return;

      // Judged against the saved copy if it has been read. If not, the relay has won the race.
      if (!mayReplace(places.length, complete, device.saved ?? null)) {
        fail();
        return;
      }
      // `savedAt` stays the saved copy's until these places are saved too.
      const before = device.saved?.savedAt;
      setState({ status: "ready", places, source: "network", complete, towns, ...(before === undefined ? {} : { savedAt: before }) });
      // The saved copy is off the screen for good: let it go, and the indexes built for it.
      device.replaced = true;
      device.copy = null;

      // Save only what may replace the saved copy, so wait for it to be read: a read that never
      // answers means nothing is saved, which is what a stuck device would do anyway.
      await device.read;
      if (signal.aborted || !mayReplace(places.length, complete, device.saved ?? null)) return;
      // The device has these already (the same version of each place, from a load that was as
      // complete): writing the 8.5 MB again would change nothing.
      const stamps = device.stamps;
      device.stamps = undefined;
      if (stamps !== undefined && device.saved?.complete === complete && sameStamps(stamps, events)) return;
      const savedAt = Date.now();
      if (!(await writeSaved({ events, savedAt, complete }))) return;
      device.saved = { count: places.length, savedAt, complete };
      if (signal.aborted) return;
      setState((current) => (current.places === places ? { ...current, savedAt } : current));
    })();

    return () => controller.abort();
  }, [attempt, givenReader, givenTowns]);

  const retry = useCallback(() => {
    setState((current) => (current.status === "error" ? LOADING : current));
    setAttempt((n) => n + 1);
  }, []);

  // Back on line: load again, unless the latest places are on screen already. A load that was
  // waiting on a connection that had gone is started again, not left to run out its time.
  const latestState = useRef(state);
  useEffect(() => {
    latestState.current = state;
  }, [state]);
  useEffect(() => {
    const onOnline = () => {
      const { status, source, error } = latestState.current;
      if (status !== "ready" || source !== "network" || error !== undefined) retry();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [retry]);

  const value = useMemo(() => ({ ...state, retry }), [state, retry]);
  return <PlacesContext value={value}>{children}</PlacesContext>;
}

/** The places and how they loaded. Use it inside a `PlacesProvider`. */
export function usePlaces(): PlacesValue {
  const value = useContext(PlacesContext);
  if (value === null) throw new Error("usePlaces must be used inside <PlacesProvider>.");
  return value;
}
