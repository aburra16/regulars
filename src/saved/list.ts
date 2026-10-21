import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { config } from "../config.ts";
import { isNewer } from "../nostr/events.ts";
import { PLACE_KIND, type Place } from "../places/place.ts";

/*
 * The rules of a person's saved places: one bookmark set (NIP-51, kind 30003) named
 * `regulars-saved`, each place in it an `a` tag with the place's address and the list hub as its
 * hint. Which of several lists is the newest, the places one holds, and the one entry a save or an
 * unsave changes. A list is one record that saving replaces everywhere, and another app may keep its
 * own entries in the same record, or private ones encrypted in its `content`. So a change touches the
 * entries of one place and keeps the rest exactly as it was: every other tag in its order, and the
 * `content` byte for byte, never read. Everything here is pure; reading a list from relays is
 * src/saved/read.ts.
 */

/** The kind of a bookmark set (NIP-51), of which a person's saved places are one. */
export const SAVED_KIND = 30003;

/** The name (`d`) of the one bookmark set that holds a person's saved places, the same on every device. */
export const SAVED_D = "regulars-saved";

/** The title a list is given when it is first made. A title it has been given since, in another app, is kept. */
export const SAVED_TITLE = "Saved places";

/** Whether `event` is a list of saved places by `pubkey`: its kind, and its first `d` (as relays read it) the list's name. */
function isSavedList(event: NostrEvent, pubkey: string): boolean {
  return event.kind === SAVED_KIND && event.pubkey === pubkey && event.tags.find((tag) => tag[0] === "d")?.[1] === SAVED_D;
}

/**
 * Whether `address` is the address of a place of the list the app shows: `39999:<the house>:<d>`,
 * with a `d` that is not blank, as every place has. An entry of another curator or another kind is
 * someone else's, and is never shown, added or taken out.
 */
function isPlaceAddress(address: string | undefined): address is string {
  const prefix = `${PLACE_KIND}:${config.houseHex}:`;
  return address !== undefined && address.startsWith(prefix) && address.slice(prefix.length).trim() !== "";
}

/** Whether `tag` is an `a` tag whose address is `address`, whatever hint it gives. */
const isEntryOf = (tag: readonly string[], address: string) => tag[0] === "a" && tag[1] === address;

/** The newest list of saved places by `pubkey` among `events` (created_at, then the lower id, as `isNewer`); null when none. Any other event is ignored. */
export function newestSaved(events: readonly NostrEvent[], pubkey: string): NostrEvent | null {
  let newest: NostrEvent | null = null;
  for (const event of events) {
    if (!isSavedList(event, pubkey)) continue;
    if (newest === null || isNewer(event, newest)) newest = event;
  }
  return newest;
}

/**
 * The addresses of the places `list` holds, newest saved first (a place is added at the end, so the
 * last tag comes first), each once. Only places of the list the app shows (`isPlaceAddress`): another
 * app's entries are left out.
 */
export function savedAddresses(list: Pick<NostrEvent, "tags"> | null): string[] {
  if (list === null) return [];
  const addresses = new Set<string>();
  for (let at = list.tags.length - 1; at >= 0; at--) {
    const tag = list.tags[at]!;
    if (tag[0] === "a" && isPlaceAddress(tag[1])) addresses.add(tag[1]);
  }
  return [...addresses];
}

/** `now`, or one second after `list` was made if that is later, so that the new list is the newer of the two everywhere. */
function timeAfter(list: NostrEvent, now: number): number {
  return Math.max(now, list.created_at + 1);
}

/**
 * `list` with `place` added at the end, its hint the list hub (`config.placesRelay`), or null when the
 * list holds it already, with whatever hint. `list` null: a first list, of its name, its title and the
 * place. Every other tag stays, in its order, with the `content`; the result is made at `now`, or one
 * second after `list` when that is later. Throws a TypeError for an address that is not a place's
 * (`isPlaceAddress`): nothing else is ever added to the list.
 */
export function withSaved(list: NostrEvent | null, place: Pick<Place, "address">, now: number): EventTemplate | null {
  const { address } = place;
  if (!isPlaceAddress(address)) throw new TypeError("Not the address of a place");
  const entry = ["a", address, config.placesRelay];
  if (list === null) return { kind: SAVED_KIND, created_at: now, tags: [["d", SAVED_D], ["title", SAVED_TITLE], entry], content: "" };
  if (list.tags.some((tag) => isEntryOf(tag, address))) return null;
  return {
    kind: SAVED_KIND,
    created_at: timeAfter(list, now),
    tags: [...list.tags.map((tag) => [...tag]), entry],
    content: list.content,
  };
}

/**
 * `list` without any `a` tag for the place at `address`, whatever its hint, or null when it holds
 * none (or `list` is null). Every other tag stays, in its order, with the `content`, so a list whose
 * last place is taken out keeps its name and its title; the result is made at `now`, or one second
 * after `list` when that is later. An address that is not a place's (`isPlaceAddress`) takes nothing
 * out: another app's entry stays, whatever is asked.
 */
export function withoutSaved(list: NostrEvent | null, address: string, now: number): EventTemplate | null {
  if (list === null || !isPlaceAddress(address) || !list.tags.some((tag) => isEntryOf(tag, address))) return null;
  return {
    kind: SAVED_KIND,
    created_at: timeAfter(list, now),
    tags: list.tags.filter((tag) => !isEntryOf(tag, address)).map((tag) => [...tag]),
    content: list.content,
  };
}
