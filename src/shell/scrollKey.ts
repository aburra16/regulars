import type { Location } from "react-router-dom";

/**
 * What a page's scroll position is kept under. The router gives each page the person goes to a key of
 * its own, and "default" to the first page of a tab, and to any page opened afresh (a link, a
 * reload). Kept under "default", the position of one such page would be the next one's, which would
 * then go to it instead of to the section its link names (`/about#signing-in`). So those are kept
 * under their address, which a reload of the same page still finds.
 */
export function scrollKey({ key, pathname, search, hash }: Pick<Location, "key" | "pathname" | "search" | "hash">): string {
  return key === "default" ? `${pathname}${search}${hash}` : key;
}

/** Where React Router's ScrollRestoration keeps the positions of the pages, in `sessionStorage`. */
export const SCROLL_POSITIONS_KEY = "react-router-scroll-positions";

/**
 * A page opened afresh (a link from elsewhere, an address typed in) starts where its address says:
 * its top, or the section its hash names. Its position is kept under its address, so a visit earlier
 * in the tab would put it back where that visit left it. This forgets that position, so only a
 * reload, and Back or Forward, put a page where it was. Call it before the router starts, which
 * reads the positions once.
 */
export function forgetScrollOfFreshVisit(): void {
  try {
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (entry?.type !== "navigate") return;
    const text = window.sessionStorage.getItem(SCROLL_POSITIONS_KEY);
    if (text === null) return;
    const positions: unknown = JSON.parse(text);
    if (typeof positions !== "object" || positions === null) return;
    const { pathname, search, hash } = window.location;
    const key = scrollKey({ key: "default", pathname, search, hash });
    if (!(key in positions)) return;
    delete (positions as Record<string, unknown>)[key];
    window.sessionStorage.setItem(SCROLL_POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // Storage blocked, or what it holds is not ours to read: the router copes the same way.
  }
}
