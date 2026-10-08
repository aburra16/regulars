import { createContext, useContext } from "react";

import type { City } from "../places/indexes.ts";

/** Where the places on screen are near. */
export interface Here {
  /** The word after "Near" in the header: a town's label, or "you" when it is the device. */
  label: string;
  lat: number;
  lon: number;
  /**
   * Where it came from: a city the person picked, the device, the town guessed from the device's
   * time zone or language when there is neither (`guess.ts`), or the app's default city when
   * nothing could be guessed.
   */
  source: "default" | "city" | "device" | "guess";
  /**
   * Where to start is not known yet: no town was picked, and the towns to guess from have not
   * loaded. Until it is, `label`, `lat` and `lon` are the default city's, and nothing shows them:
   * the pages wait for the places, and the header names no town. Absent: false.
   */
  settling?: boolean;
  /** The person said no to the device's location. The place shown is the one it was before. */
  denied?: boolean;
  /** The device's location could not be found, and it was not a no. The place shown is the one it was before. */
  unavailable?: boolean;
  /** The device's location has been asked for and has not answered yet. The place shown is the one it was before. */
  pending: boolean;
}

export type HereValue = Here & {
  /**
   * Asks the browser for the device's location. Call it when the person asks, never on load: the
   * browser asks them for permission. The answer comes later, as a new `Here`. (On load the
   * provider looks only when the browser already allows it, so nobody is asked then.)
   */
  useDevice(): void;
  /** Moves to a city and keeps it on this device. */
  pickCity(c: City): void;
};

export const HereContext = createContext<HereValue | null>(null);

/** Where the places are near, and how to change that. Use it inside a `HereProvider`. */
export function useHere(): HereValue {
  const value = useContext(HereContext);
  if (value === null) throw new Error("useHere must be used inside <HereProvider>.");
  return value;
}

/** What is kept on the device of the city the person picked. The device's own position is never kept. */
export type SavedCity = Omit<City, "count">;

/** Where the picked city is kept, in `localStorage`. */
export const HERE_STORAGE_KEY = "regulars.here";

/** What to ask the browser for: an answer within ten seconds, from a position up to five minutes old. */
export const DEVICE_OPTIONS = { timeout: 10_000, maximumAge: 300_000 } as const;

/** The code of a `GeolocationPositionError` for a person who said no. */
export const PERMISSION_DENIED = 1;

/**
 * Whether the browser already lets the page have the device's location, so that asking for it
 * shows the person no prompt. False when it would ask them, when they said no, and when it cannot
 * say: no Permissions API, or one that does not know this permission (an older Safari).
 */
export async function locationAllowed(): Promise<boolean> {
  try {
    const permissions = (navigator as Partial<Navigator>).permissions;
    if (permissions === undefined) return false;
    const status = await permissions.query({ name: "geolocation" });
    return status.state === "granted";
  } catch {
    return false;
  }
}

/** Whether the numbers are a place on Earth. */
export function isPlaceOnEarth(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

/** The city kept on this device, or undefined when there is none or it cannot be trusted. */
export function readSavedCity(): SavedCity | undefined {
  try {
    const text = window.localStorage.getItem(HERE_STORAGE_KEY);
    if (text === null) return undefined;
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const { name, region, country, lat, lon } = value as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "" || typeof country !== "string") return undefined;
    if (region !== undefined && typeof region !== "string") return undefined;
    if (typeof lat !== "number" || typeof lon !== "number" || !isPlaceOnEarth(lat, lon)) return undefined;
    return savedCityOf({ name, region, country, lat, lon });
  } catch {
    // Storage that is blocked or full, or text that is not JSON: start from the default.
    return undefined;
  }
}

/** Keeps a city on this device; nothing else of it but what `SavedCity` holds. A device that will not keep it is no loss. */
export function writeSavedCity(city: SavedCity): void {
  try {
    window.localStorage.setItem(HERE_STORAGE_KEY, JSON.stringify(city));
  } catch {
    // Blocked or full. The choice still holds until the page is closed.
  }
}

/** The part of a city that is kept. */
export function savedCityOf({ name, region, country, lat, lon }: SavedCity): SavedCity {
  return region === undefined ? { name, country, lat, lon } : { name, region, country, lat, lon };
}
