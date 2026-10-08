import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { type City, cityLabel } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import {
  DEVICE_OPTIONS,
  HereContext,
  type HereValue,
  isPlaceOnEarth,
  PERMISSION_DENIED,
  readSavedCity,
  type SavedCity,
  savedCityOf,
  writeSavedCity,
} from "./useLocation.ts";

type Choice =
  | { source: "default" }
  | { source: "city"; city: SavedCity }
  | { source: "device"; lat: number; lon: number };

interface State {
  choice: Choice;
  /** Why the last ask for the device's location got nowhere; the choice is what it was before. */
  problem?: "denied" | "unavailable";
  /** The last ask for the device's location has not been answered yet. */
  pending?: true;
}

function firstState(): State {
  const city = readSavedCity();
  return { choice: city === undefined ? { source: "default" } : { source: "city", city } };
}

/**
 * Where the places are near, for every screen below it, so the header and the pages agree. It
 * starts at the city the person last picked on this device, or the default city. The device's own
 * position is held in memory only, so a reload goes back to the picked city. Use it inside a
 * `PlacesProvider`, whose towns it names the picked city from.
 */
export function HereProvider({ children }: { children: ReactNode }): JSX.Element {
  const cities = useIndexes()?.cities;
  const [state, setState] = useState<State>(firstState);

  // Each ask for the device and each pick takes a number. An answer is for the latest only, so
  // a position that comes after the person picked a city, or after the page went, is dropped.
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current += 1;
    },
    [],
  );

  const pickCity = useCallback((picked: City) => {
    latest.current += 1;
    const city = savedCityOf(picked);
    writeSavedCity(city);
    setState({ choice: { source: "city", city } });
  }, []);

  const useDevice = useCallback(() => {
    const mine = (latest.current += 1);
    const fail = (problem: "denied" | "unavailable") => {
      if (latest.current === mine) setState((current) => ({ choice: current.choice, problem }));
    };
    // A new ask makes what the last one said old news. Every answer below replaces the whole
    // state, so it ends the wait too; a pick does as well.
    setState((current) => ({ choice: current.choice, pending: true }));
    try {
      const geolocation = navigator.geolocation as Geolocation | undefined;
      if (geolocation === undefined) return fail("unavailable");
      geolocation.getCurrentPosition(
        ({ coords }) => {
          if (latest.current !== mine) return;
          if (!isPlaceOnEarth(coords.latitude, coords.longitude)) return fail("unavailable");
          setState({ choice: { source: "device", lat: coords.latitude, lon: coords.longitude } });
        },
        (error) => fail(error.code === PERMISSION_DENIED ? "denied" : "unavailable"),
        DEVICE_OPTIONS,
      );
    } catch {
      // A browser that refuses to look: the same as one that cannot find the person.
      fail("unavailable");
    }
  }, []);

  const value = useMemo<HereValue>(() => {
    const { choice, problem, pending } = state;
    const where =
      choice.source === "city"
        ? { label: cityLabel(choice.city, cities ?? []), lat: choice.city.lat, lon: choice.city.lon }
        : choice.source === "device"
          ? { label: copy.location.you, lat: choice.lat, lon: choice.lon }
          : { label: config.defaultCity.name, lat: config.defaultCity.lat, lon: config.defaultCity.lon };
    return {
      ...where,
      source: choice.source,
      pending: pending === true,
      ...(problem === "denied" && { denied: true }),
      ...(problem === "unavailable" && { unavailable: true }),
      useDevice,
      pickCity,
    };
  }, [state, cities, useDevice, pickCity]);

  return <HereContext value={value}>{children}</HereContext>;
}
