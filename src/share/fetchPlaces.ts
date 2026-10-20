import { verifyEvent } from "nostr-tools/pure";

import type { RelayReader } from "../nostr/events.ts";
import { fetchHouseEvents, parsePlaces } from "../places/load.ts";
import type { Place } from "../places/place.ts";

/*
 * The places the pages a shared link opens are made from (./pages.ts), read from the hub when the
 * site is built. The app checks a sample of a fresh list's signatures, for speed on a phone
 * (src/places/signatures.ts); the build has the time to check every one.
 */

/**
 * The fewest places the hub's list may hold for the pages to be made from it. The list holds about
 * 8,000: fewer than this, and part of it did not come, so no page is made and the site already live
 * keeps its own.
 */
export const SHARE_FLOOR = 5_000;

/**
 * The places of the list as the hub has them: the curator's places under the list's header, read
 * from `reader` page by page as the app reads them (`fetchHouseEvents`: only events of
 * `config.houseHex`, the newest version at each address), each signature checked by nostr-tools,
 * and parsed as the app parses them (`parsePlaces`). A version whose signature fails is left out,
 * and no older version of it stands in its place, as in the app. Throws when the read fails or
 * `signal` aborts, when the paging stopped before the end of the list, and when fewer than
 * `SHARE_FLOOR` places are left: a list with part of it missing gives no pages.
 */
export async function fetchSharedPlaces(reader: RelayReader, signal: AbortSignal): Promise<Place[]> {
  const { events, complete } = await fetchHouseEvents(reader, { signal });
  if (!complete) {
    throw new Error(`The hub's list did not come to its end: its pages got no further back after ${events.length} places.`);
  }
  const places = parsePlaces(events.filter((event) => verifyEvent(event)));
  if (places.length < SHARE_FLOOR) {
    throw new Error(`The hub sent ${places.length} places of the list, fewer than ${SHARE_FLOOR}, the fewest the pages are made from.`);
  }
  return places;
}
