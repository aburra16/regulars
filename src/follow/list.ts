import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { isNewer } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";

/*
 * The rules of a follow list (kind 3): which of several is the newest, who one names, the one entry
 * a follow or an unfollow changes, and what Undo puts back. A list is one record that saving
 * replaces everywhere, and other clients write it in many shapes, so a change touches one entry and
 * keeps the rest exactly as it was: every other tag in its order, tags that are not follows, entries
 * this app cannot read, and the `content` old clients filled with a map of relays. Everything here
 * is pure; reading a list from relays and writing one is `changeFollow` (src/follow/change.ts), the
 * only place that does.
 */

/** The kind of a follow list (NIP-02). */
export const FOLLOW_KIND = 3;

/** Whether `tag` is a `p` tag naming `key`, a lower-case key; the tag's own hex is compared in lower case, as some clients write it in upper. */
function namesKey(tag: readonly string[], key: string): boolean {
  return tag[0] === "p" && tag[1]?.toLowerCase() === key;
}

/**
 * `who` as a key, in lower case, or null when it is not one (64 hex digits). Only a key names a
 * person: a list may hold entries that are not follows (`["p", ""]`, a word, hex of another length),
 * and something that is no key must never be taken to name one of them.
 */
function keyOf(who: string): string | null {
  const key = who.toLowerCase();
  return isHex64(key) ? key : null;
}

/** The newest kind 3 by `pubkey` among `events` (created_at, then the lower id, as `isNewer`); null when none. */
export function newestList(events: readonly NostrEvent[], pubkey: string): NostrEvent | null {
  let newest: NostrEvent | null = null;
  for (const event of events) {
    if (event.kind !== FOLLOW_KIND || event.pubkey !== pubkey) continue;
    if (newest === null || isNewer(event, newest)) newest = event;
  }
  return newest;
}

/** Whether `list` names `who` in a `p` tag (hex compared in lower case). A `who` that is not a key names nobody. */
export function names(list: Pick<NostrEvent, "tags"> | null, who: string): boolean {
  const key = keyOf(who);
  if (list === null || key === null) return false;
  return list.tags.some((tag) => namesKey(tag, key));
}

/**
 * The pubkeys `list` names, valid 64-hex only, in order, each once. A key written in upper-case hex
 * is the same person and comes back in lower case; entries that are not keys are left out.
 */
export function followed(list: Pick<NostrEvent, "tags"> | null): string[] {
  if (list === null) return [];
  const keys = new Set<string>();
  for (const tag of list.tags) {
    const key = tag[0] === "p" ? tag[1]?.toLowerCase() : undefined;
    if (key !== undefined && isHex64(key)) keys.add(key);
  }
  return [...keys];
}

/** `now`, or one second after `list` was made if that is later, so that the new list is the newer of the two everywhere. */
function timeAfter(list: NostrEvent, now: number): number {
  return Math.max(now, list.created_at + 1);
}

/**
 * `list` with `who` added at the end, in lower case, or null when it names them already. `list` null:
 * a fresh list. Every other tag and the `content` stay as they were; the result is made at `now`, or
 * one second after `list` when that is later. Throws a TypeError for a `who` that is not a key:
 * nothing but a key is ever added to a list.
 */
export function withFollow(list: NostrEvent | null, who: string, now: number): EventTemplate | null {
  const key = keyOf(who);
  if (key === null) throw new TypeError("Not a public key");
  if (list === null) return { kind: FOLLOW_KIND, created_at: now, tags: [["p", key]], content: "" };
  if (names(list, key)) return null;
  return {
    kind: FOLLOW_KIND,
    created_at: timeAfter(list, now),
    tags: [...list.tags.map((tag) => [...tag]), ["p", key]],
    content: list.content,
  };
}

/**
 * `list` without any `p` tag naming `who`, or null when it names them nowhere (or `list` is null).
 * Every other tag stays, in its order, with the `content`; the result is made at `now`, or one second
 * after `list` when that is later. A `who` that is not a key names nobody, so nothing is taken out:
 * an entry that is not a follow stays, whatever is asked.
 */
export function withoutFollow(list: NostrEvent | null, who: string, now: number): EventTemplate | null {
  const key = keyOf(who);
  if (list === null || key === null || !names(list, key)) return null;
  return {
    kind: FOLLOW_KIND,
    created_at: timeAfter(list, now),
    tags: list.tags.filter((tag) => !namesKey(tag, key)).map((tag) => [...tag]),
    content: list.content,
  };
}

/** An entry an unfollow takes out of a list: the tag as the list wrote it, and its place among the list's tags. */
export interface Removed {
  index: number;
  tag: string[];
}

/**
 * What an unfollow of `who` takes out of `list` (`withoutFollow`): every `p` tag naming them, each
 * as the list wrote it, its relay hint and petname with it, and its place in `list.tags`, in order.
 * Nothing when the list names them nowhere, there is no list, or `who` is not a key. For Undo, which
 * puts them back (`withRestored`).
 */
export function removedBy(list: Pick<NostrEvent, "tags"> | null, who: string): Removed[] {
  const key = keyOf(who);
  if (list === null || key === null) return [];
  return list.tags.flatMap((tag, index) => (namesKey(tag, key) ? [{ index, tag: [...tag] }] : []));
}

/**
 * The key that every one of `removed` names, in lower case. Throws a TypeError unless they are one
 * or more `p` tags that all name one key, each with a place a list can have (a whole number, zero or
 * more): nothing but one person's own entries is ever put back into a list.
 */
function personOf(removed: readonly Removed[]): string {
  const first = removed[0]?.tag[1];
  const key = typeof first === "string" ? keyOf(first) : null;
  const theirs = ({ index, tag }: Removed) =>
    Number.isSafeInteger(index) && index >= 0 && Array.isArray(tag) && tag.every((value) => typeof value === "string") && key !== null && namesKey(tag, key);
  if (key === null || !removed.every(theirs)) throw new TypeError("Not one person's entries in a follow list");
  return key;
}

/**
 * `list` with the entries an unfollow took out put back (`removed`, as `removedBy` gave them), or
 * null when it names that person already, or there is no list. `left` is the id of the list that
 * unfollow left. When `list` is that very list, each entry goes back to the place it had, so that
 * the tags are as they were before the unfollow, entry for entry. When it is any other list,
 * something has changed it since, and a place counted in the old one may be among other neighbours
 * now: the entries go at the end, in the order they had. So do they when a place is past the end of
 * the list, or two share one. `list` null: nothing, as there is no list to put anything back into,
 * and what was taken out of one list is no list of its own. Every other tag and the `content` stay
 * as they were; the result is made at `now`, or one second after `list` when that is later. Throws
 * a TypeError unless `removed` is one or more `p` tags that all name one person, each with a place.
 */
export function withRestored(list: NostrEvent | null, removed: readonly Removed[], now: number, left: string): EventTemplate | null {
  const key = personOf(removed);
  if (list === null || names(list, key)) return null;
  // In the order they had in the list: by place, and as given where two have the same one.
  const entries = [...removed].sort((a, b) => a.index - b.index);
  const theirs = entries.map(({ tag }) => [...tag]);

  const tags = list.tags.map((tag) => [...tag]);
  // Each goes in before the next is counted: its place must be in the list as it is by then, or at its end.
  const eachHasItsPlace = entries.every(
    ({ index }, at) => index <= list.tags.length + at && (at === 0 || index > entries[at - 1]!.index),
  );
  if (list.id === left && eachHasItsPlace) entries.forEach(({ index }, at) => tags.splice(index, 0, theirs[at]!));
  else tags.push(...theirs);
  return { kind: FOLLOW_KIND, created_at: timeAfter(list, now), tags, content: list.content };
}
