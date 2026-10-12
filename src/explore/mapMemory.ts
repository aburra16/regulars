import { useCallback, useEffect, useRef, useState } from "react";

import type { Bbox } from "../map/area.ts";
import type { MapView } from "../map/BaseMap.tsx";

/** What a map showed: its box, and its centre, longitude first (the middle of the map as drawn). */
export interface MapArea {
  box: Bbox;
  centre: [lon: number, lat: number];
}

/** What a map page's "Search this area" holds: where the person was near, what of the map they searched, and how they last moved it. */
export interface SearchState {
  near: string;
  searched?: MapArea;
  moved?: MapArea;
}

interface Remembered {
  view?: MapView;
  search?: SearchState;
}

/**
 * Where each map page's map was, and the area searched on it, by its page of the history. Back to
 * a page (from a place) finds its map as it was left. It is a variable of the page and no more: a
 * reload, or a new visit, starts where the person is near.
 */
const remembered = new Map<string, Remembered>();

export function recallMapPage(key: string): Remembered | undefined {
  return remembered.get(key);
}

export function rememberMapPage(key: string, part: Remembered): void {
  remembered.set(key, { ...remembered.get(key), ...part });
}

/** Forgets every page's map, as a reload does; tests call it between one test and the next. */
export function forgetMapPages(): void {
  remembered.clear();
}

/**
 * Where a page's map starts (where it was left, on Back; otherwise undefined, and the page's own
 * centre), and what to call as it moves. `key` is the page of the history, and the map's place is
 * kept under each one the page is at: a filter on a desktop is a new page with the same map.
 */
export function useRememberedView(key: string): { initialView: MapView | undefined; onViewChange(view: MapView): void } {
  const [initialView] = useState(() => recallMapPage(key)?.view);
  const latest = useRef({ key, view: initialView });
  useEffect(() => {
    latest.current.key = key;
    if (latest.current.view !== undefined) rememberMapPage(key, { view: latest.current.view });
  }, [key]);
  const onViewChange = useCallback((view: MapView) => {
    latest.current.view = view;
    rememberMapPage(latest.current.key, { view });
  }, []);
  return { initialView, onViewChange };
}
