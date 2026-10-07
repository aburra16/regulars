import type { NostrEvent } from "@nostrify/nostrify";
import { get, set } from "idb-keyval";

import { config } from "../config.ts";
import { debug } from "./load.ts";

/** Where the places are saved on the device (IndexedDB, through idb-keyval). */
export const CACHE_KEY = `places:v1:${config.headerCoordinate}`;

/**
 * The places as saved: the relay's events as they came, not parsed places, so a new version of
 * the app reads them with its own parser. Read back, the events are checked again.
 */
export interface SavedPlaces {
  events: NostrEvent[];
  /** When they were saved, in milliseconds since the epoch. */
  savedAt: number;
}

/** What a read gives back: the events are unchecked until `placesFromEvents` sees them. */
export interface SavedValues {
  events: readonly unknown[];
  savedAt: number;
}

/**
 * The saved places, or undefined when there are none, they have the wrong shape, or the device
 * cannot read them (IndexedDB can be missing or blocked, as in some private windows).
 */
export async function readSaved(): Promise<SavedValues | undefined> {
  try {
    const value: unknown = await get(CACHE_KEY);
    if (typeof value !== "object" || value === null) return undefined;
    const { events, savedAt } = value as Record<string, unknown>;
    if (!Array.isArray(events) || typeof savedAt !== "number" || !Number.isFinite(savedAt)) return undefined;
    return { events, savedAt };
  } catch (error) {
    debug("could not read the saved places", error);
    return undefined;
  }
}

/** Saves the places. A device that cannot save still shows them; it loads them again next time. */
export async function writeSaved(saved: SavedPlaces): Promise<void> {
  try {
    await set(CACHE_KEY, saved);
  } catch (error) {
    debug("could not save the places", error);
  }
}
