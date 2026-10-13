import type { NostrEvent } from "@nostrify/nostrify";
import { get, update } from "idb-keyval";

import { LAST_MOMENT_S } from "../locale.ts";
import { asEvent } from "../nostr/events.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { FOLLOW_KIND } from "./list.ts";

/*
 * Copies of a person's follow list (kind 3), kept in this browser: before a changed list is signed,
 * the list it was built on is kept here, as the relays sent it (src/follow/change.ts). A follow list
 * is one record that saving replaces everywhere, so a change built on the wrong list loses follows
 * for good; a kept copy is what they can be had back from (`putBackList`).
 *
 * What is kept is the event itself, its seven fields and its signature untouched: the signature is
 * what later shows that a copy is the person's own list, and nothing that fails that check is ever
 * given back (`keptCopies`). A follow list is public, and a copy stays through sign-out; it is shown
 * only to the person whose list it is, signed in.
 *
 * The copies are in the device's own storage (IndexedDB, through idb-keyval, as the places are:
 * src/places/cache.ts), one entry for each person. Nothing here signs, sends or reads a relay, and
 * nothing here throws: a storage that is absent, full or will not answer is a copy that was not
 * kept, which a change goes on without. Nothing is logged: a list and who it names are the person's.
 */

/** How many copies are kept for a person: the newest ten. */
export const KEPT_COPIES = 10;

/**
 * How long the storage has to keep a copy, in milliseconds. A change waits for its copy before the
 * person is asked to approve it, and a storage that never answers must not hold it up for ever: past
 * this, the copy counts as not kept.
 */
export const KEEP_WAIT_MS = 2_000;

/**
 * What a copy was kept for: the change that was about to be made to the list. A follow, an unfollow
 * or an Undo, of `who` (their public key, 64 hex digits in lower case); or a kept copy about to be
 * put back, which replaces the whole list.
 */
export type KeptFor = { did: "follow" | "unfollow" | "undo"; who: string } | { did: "put-back" };

/** A kept copy: the list as the relays sent it, when it was kept (in seconds), and what for. */
export interface Kept {
  list: NostrEvent;
  at: number;
  for: KeptFor;
}

/** Where the copies of the person `pubkey` are, in the device's storage. */
const placeOf = (pubkey: string) => `regulars.follow.kept.${pubkey}`;

/** `value` as what a copy was kept for, with nothing beside it; null when it is none. */
function asKeptFor(value: unknown): KeptFor | null {
  if (typeof value !== "object" || value === null) return null;
  const { did, who } = value as { did?: unknown; who?: unknown };
  if (did === "put-back") return { did };
  if (did !== "follow" && did !== "unfollow" && did !== "undo") return null;
  return typeof who === "string" && isHex64(who) ? { did, who } : null;
}

/**
 * `value` as a copy of the follow list of the person `pubkey`, by its shape: an event of kind 3 by
 * them (its seven fields, and nothing beside them), a time, and what it was kept for. Null for
 * anything else. The time is when it was kept, by the device's clock: a whole number of seconds
 * that a date can hold, as the page that lists the copies writes it as one, and a copy with any
 * other is none. Its signature is not checked here (`keptCopies` does).
 */
function asKept(value: unknown, pubkey: string): Kept | null {
  if (typeof value !== "object" || value === null) return null;
  const { list, at, for: why } = value as { list?: unknown; at?: unknown; for?: unknown };
  const event = asEvent(list);
  if (event === null || event.kind !== FOLLOW_KIND || event.pubkey !== pubkey) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || at > LAST_MOMENT_S) return null;
  const reason = asKeptFor(why);
  return reason === null ? null : { list: event, at, for: reason };
}

/** What the storage holds for a person, as their copies: those that have a copy's shape, in their order. */
function copiesIn(stored: unknown, pubkey: string): Kept[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value: unknown) => {
    const copy = asKept(value, pubkey);
    return copy === null ? [] : [copy];
  });
}

/** Whether two events are the same one, field for field: every tag, value for value, in its order. */
function sameEvent(a: NostrEvent, b: NostrEvent): boolean {
  return (
    a.id === b.id &&
    a.sig === b.sig &&
    a.pubkey === b.pubkey &&
    a.kind === b.kind &&
    a.created_at === b.created_at &&
    a.content === b.content &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, at) => tag.length === b.tags[at]!.length && tag.every((value, i) => value === b.tags[at]![i]))
  );
}

/**
 * `copy` as the newest of `copies`, which are newest first, and no more than `KEPT_COPIES` in all:
 * the oldest give way, but for a copy of the list whose id is `spare`, in whose place the oldest
 * other one goes. The rest stay in their order.
 */
function withRoomFor(copy: Kept, copies: readonly Kept[], spare: string | undefined): Kept[] {
  const kept = [copy, ...copies];
  while (kept.length > KEPT_COPIES) {
    // The oldest that may go. The newest never does: it is the one being kept.
    let goes = kept.length - 1;
    while (goes > 1 && kept[goes]!.list.id === spare) goes -= 1;
    kept.splice(goes, 1);
  }
  return kept;
}

/** Thrown out of a write that has nothing to write: the newest copy kept is this very list already. */
const ALREADY_KEPT = Symbol("already kept");

/** `work`, or a failure once `ms` milliseconds have passed without it. No timer is left behind. */
function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException("The storage did not answer in time", "TimeoutError")), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Keeps `list` as the newest copy of the follow list of the person `pubkey`, with when (`now`, in
 * seconds) and what it is kept for (`why`), and says whether it is kept. False when it could not be:
 * the storage is absent, full, refuses, or does not answer within `KEEP_WAIT_MS`. Never throws.
 *
 * Only a follow list by that person is kept (kind 3, their key), and what is kept of it is its seven
 * fields as they were given, the signature whole: nothing is rebuilt. Anything else is not kept, and
 * nothing is written. Its signature is not checked here, as checking brings code a change must not
 * wait for at this point; it is checked whenever a copy is read back (`keptCopies`).
 *
 * The newest ten are kept (`KEPT_COPIES`), and the oldest gives way. A list that is the newest copy
 * already, field for field, is not kept twice: that copy stays as it was, with its own time and
 * reason, and this counts as kept.
 *
 * `spare` is the id of a kept list that does not give way to this keeping: the copy that is about to
 * be put back, when `list` is the list it will replace. Were that copy the oldest of ten, keeping
 * the list it replaces would push it out, and a putting back that then did not save (the signer
 * said no) would have lost the very copy it was asked for. So the oldest other copy goes, and the
 * spared one stays where it was among the rest.
 *
 * The copies are read and written back in one transaction of the storage's (idb-keyval's `update`),
 * and the browser lets one such transaction at a time touch them, in whichever tab: so two tabs
 * keeping at once each keep theirs, and neither writes over the other's. (A change, which is what
 * keeps, holds the follow lock across tabs besides.)
 */
export async function keepCopy(pubkey: string, list: NostrEvent, why: KeptFor, now: number, spare?: string): Promise<boolean> {
  try {
    const copy = asKept({ list, at: now, for: why }, pubkey);
    if (copy === null) return false;
    await inTime(
      update(placeOf(pubkey), (stored: unknown) => {
        const copies = copiesIn(stored, pubkey);
        if (copies[0] !== undefined && sameEvent(copies[0].list, copy.list)) throw ALREADY_KEPT;
        return withRoomFor(copy, copies, spare);
      }),
      KEEP_WAIT_MS,
    );
    return true;
  } catch (error) {
    return error === ALREADY_KEPT;
  }
}

/**
 * The copies kept of the follow list of the person `pubkey`, newest first: only those that are a
 * valid event of kind 3 by them, its id the hash of its fields and its signature theirs. Whatever
 * else is in their place in the storage is left out. None when the storage is absent or cannot be
 * read, or when the check cannot be had: a copy that was not checked is not given. Never throws.
 *
 * The check is nostr-tools' own (`verifyEvent`), fetched when copies are first read, as the curve it
 * brings is no part of the first screen (tests/relay-chunk.test.ts). It is given a copy of each
 * event, as nostr-tools notes its verdict on what it checks.
 */
export async function keptCopies(pubkey: string): Promise<Kept[]> {
  try {
    const copies = copiesIn(await get(placeOf(pubkey)), pubkey);
    if (copies.length === 0) return [];
    const { verifyEvent } = await import("nostr-tools/pure");
    return copies.filter((copy) => verifyEvent({ ...copy.list }));
  } catch {
    return [];
  }
}
