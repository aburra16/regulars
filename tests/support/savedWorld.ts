import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { config } from "../../src/config.ts";
import { DIRECTORY, REVIEWS, type Relay, relay, type RelayOptions, world, type World } from "./followWorld.ts";

/*
 * The relays a person's saved places are read from and saved to, held in memory, for the tests of
 * the change that writes the list (tests/savedChange.test.ts). Each is one of followWorld's relays,
 * which keep what they are sent whatever its kind, so a list a change saved is the list the next
 * read finds. Nothing opens a socket.
 */

/** The app's five saved-list relays, in the order the app is set up with them (`setUpSavedRelays`). */
export const ONE = "wss://one.example.test";
export const TWO = "wss://two.example.test";
export const THREE = "wss://three.example.test";
export const FOUR = "wss://four.example.test";
export const FIVE = "wss://five.example.test";
export const SAVED_RELAYS = [ONE, TWO, THREE, FOUR, FIVE] as const;

/**
 * The app's relays for these tests: a review relay and the directory, which are asked for people's
 * relay lists and keep no saved lists, and five saved-list relays, so that more than half of them can
 * answer for a first list.
 */
export function setUpSavedRelays(app: typeof config): void {
  app.reviewRelays = [REVIEWS];
  app.relayListRelays = [DIRECTORY];
  app.savedListRelays = [...SAVED_RELAYS];
}

/** Whether a request is for a saved list (kind 30003). */
export const asksForSaved = (filter: NostrFilter) => filter.kinds?.includes(30003) === true;

/**
 * A world of the five saved-list relays, each holding `events` and each as `opts` says, unless
 * `others` gives one of its own; and the directory, holding `relayLists`. `others` may add relays of
 * the person's own besides.
 */
export function savedWorld(events: NostrEvent[] = [], opts: RelayOptions = {}, others: Record<string, Relay> = {}, relayLists: NostrEvent[] = []): World {
  const relays: Record<string, Relay> = { [DIRECTORY]: relay(relayLists) };
  for (const url of SAVED_RELAYS) relays[url] = relay(events, opts);
  return world({ ...relays, ...others });
}
