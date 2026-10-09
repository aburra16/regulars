import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { type City, cityLabel } from "../places/indexes.ts";
import { useIndexes } from "../places/useIndexes.ts";
import { startGuesser } from "./guess.ts";
import { keptTownNow } from "./keptTown.ts";
import {
  DEVICE_OPTIONS,
  DEVICE_WAIT_MS,
  type Here,
  HereContext,
  type HereValue,
  isPlaceOnEarth,
  locationAllowed,
  PERMISSION_DENIED,
  QUIET_DEVICE_OPTIONS,
  readSavedCity,
  type SavedCity,
  savedCityOf,
  writeSavedCity,
} from "./useLocation.ts";

type Choice =
  /** Nothing picked, and the device not found: the guess from the towns, once they are known. */
  | { source: "start" }
  | { source: "city"; city: SavedCity }
  | { source: "device"; lat: number; lon: number };

interface State {
  choice: Choice;
  /** Why the last ask for the device's location got nowhere; the choice is what it was before. */
  problem?: "denied" | "unavailable";
  /** The last ask for the device's location has not been answered yet. */
  pending?: true;
  /** The pages wait for that answer: the ask on load, for `DEVICE_WAIT_MS` at most. */
  waiting?: true;
}

function firstState(): State {
  const city = readSavedCity();
  return { choice: city === undefined ? { source: "start" } : { source: "city", city } };
}

/**
 * Where the places are near, for every screen below it, so the header and the pages agree
 * (docs/decisions.md #24). It starts at the city the person last picked on this device. With
 * none, it starts at the device's position when the browser already allows it, so nobody is
 * asked: the pages wait for it for `DEVICE_WAIT_MS` at most. Until it comes, and when the browser
 * does not allow it, it is the main town near the place the device's time zone is named for, or
 * else the one with the most places in the language's country (`guess.ts`), once the places have
 * loaded; and with none of those, the default city. The device's own position is held in memory
 * only. A city kept before the towns of GeoNames, by its places' locality ("Praha"), is the town it is
 * now ("Prague") once the towns load, and the device keeps that (`keptTownNow`). Use it inside a
 * `PlacesProvider`, whose towns it guesses from and names the picked city from.
 */
export function HereProvider({ children }: { children: ReactNode }): JSX.Element {
  const cities = useIndexes()?.cities;
  const [state, setState] = useState<State>(firstState);
  const [guess] = useState(startGuesser);

  // Each ask for the device and each pick takes a number. An answer is for the latest only, so
  // a position that comes after the person picked a city, or after the page went, is dropped.
  const latest = useRef(0);
  // The end of the pages' wait for the ask on load. Whatever ends the wait first stops it.
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopWaiting = useCallback(() => {
    clearTimeout(waitTimer.current);
    waitTimer.current = undefined;
  }, []);
  useEffect(
    () => () => {
      latest.current += 1;
      stopWaiting();
    },
    [stopWaiting],
  );

  const pickCity = useCallback((picked: City) => {
    latest.current += 1;
    stopWaiting();
    const city = savedCityOf(picked);
    writeSavedCity(city);
    setState({ choice: { source: "city", city } });
  }, [stopWaiting]);

  /**
   * Asks the browser for the device's location. `quiet`: the ask on load, which the person did
   * not make. The pages wait for it a moment, and when it gets nowhere it says nothing.
   */
  const ask = useCallback((quiet: boolean) => {
    const mine = (latest.current += 1);
    stopWaiting();
    const fail = (problem: "denied" | "unavailable") => {
      if (latest.current !== mine) return;
      stopWaiting();
      setState((current) => (quiet ? { choice: current.choice } : { choice: current.choice, problem }));
    };
    // A new ask makes what the last one said old news. Every answer below replaces the whole
    // state, so it ends the wait too; a pick does as well.
    setState((current) => ({ choice: current.choice, pending: true, ...(quiet && { waiting: true as const }) }));
    if (quiet) {
      waitTimer.current = setTimeout(() => {
        waitTimer.current = undefined;
        if (latest.current === mine) setState((current) => ({ ...current, waiting: undefined }));
      }, DEVICE_WAIT_MS);
    }
    try {
      const geolocation = navigator.geolocation as Geolocation | undefined;
      if (geolocation === undefined) return fail("unavailable");
      geolocation.getCurrentPosition(
        ({ coords }) => {
          if (latest.current !== mine) return;
          if (!isPlaceOnEarth(coords.latitude, coords.longitude)) return fail("unavailable");
          stopWaiting();
          setState({ choice: { source: "device", lat: coords.latitude, lon: coords.longitude } });
        },
        (error) => fail(error.code === PERMISSION_DENIED ? "denied" : "unavailable"),
        quiet ? QUIET_DEVICE_OPTIONS : DEVICE_OPTIONS,
      );
    } catch {
      // A browser that refuses to look: the same as one that cannot find the person.
      fail("unavailable");
    }
  }, [stopWaiting]);

  const useDevice = useCallback(() => ask(false), [ask]);

  // Nothing picked: when the browser already lets the page have the device's location, that is
  // where to start, and the browser asks the person nothing. When it would ask, it is not asked.
  // A pick, an ask of the person's own, or the page going, before the browser says, comes first.
  // The browser says within a moment, long before the places are read from the device, so the
  // pages' wait for the device starts before there is a list to show.
  const unpicked = state.choice.source === "start";
  useEffect(() => {
    if (!unpicked) return;
    const mine = latest.current;
    void locationAllowed().then((allowed) => {
      if (allowed && latest.current === mine) ask(true);
    });
  }, [unpicked, ask]);

  // A city kept by a name the towns no longer have is the town it is now, as soon as the towns are
  // known: before anything shows it there, so the list does not start at the old point and move.
  const kept = state.choice.source === "city" ? state.choice.city : undefined;
  const keptNow = useMemo(() => (kept === undefined || cities === undefined ? undefined : keptTownNow(kept, cities)), [kept, cities]);
  useEffect(() => {
    if (keptNow !== undefined) writeSavedCity(keptNow);
  }, [keptNow]);

  // The guess, only while it is needed, and once there are towns to guess from.
  const town = useMemo(
    () => (unpicked && cities !== undefined ? guess(cities) : undefined),
    [unpicked, cities, guess],
  );

  const value = useMemo<HereValue>(() => {
    const { choice, problem, pending, waiting } = state;
    let where: Pick<Here, "label" | "lat" | "lon" | "source">;
    if (choice.source === "city") {
      const city = keptNow ?? choice.city;
      where = { label: cityLabel(city, cities ?? []), lat: city.lat, lon: city.lon, source: "city" };
    } else if (choice.source === "device") {
      where = { label: copy.location.you, lat: choice.lat, lon: choice.lon, source: "device" };
    } else if (town !== undefined) {
      where = { label: cityLabel(town, cities ?? []), lat: town.lat, lon: town.lon, source: "guess" };
    } else {
      where = { label: config.defaultCity.name, lat: config.defaultCity.lat, lon: config.defaultCity.lon, source: "default" };
    }
    return {
      ...where,
      settling: choice.source === "start" && (cities === undefined || waiting === true),
      pending: pending === true,
      ...(problem === "denied" && { denied: true }),
      ...(problem === "unavailable" && { unavailable: true }),
      useDevice,
      pickCity,
    };
  }, [state, cities, keptNow, town, useDevice, pickCity]);

  return <HereContext value={value}>{children}</HereContext>;
}
