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
