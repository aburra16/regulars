import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { configuredRelayAddress, type RelayListRead, readRelayList, readWithin } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type Readers, type ReadOptions } from "../nostr/events.ts";
import { type ListRelays, listRelaysWith, newListQuorum } from "../nostr/listRelays.ts";
import { newestSaved, SAVED_D, SAVED_KIND } from "./list.ts";

/*
 * Reading a person's saved places from several relays. Nothing here writes: what writes the list
 * decides from what this finds. A list is one record that other apps replace too, so the newest of
 * those several relays hold is the one to build on, and a relay that did not answer is never taken
 * for one with no list. The list is read from the relays the person's own relay list names and the
 * app's saved-list relays (`config.savedListRelays`), side by side. When the person's relay list
 * could not be read, or they have none, the app's relays alone are read: every list the app writes
 * is on them. But a first list is made only once their relay list is known: one that could not be
 * read may name relays that hold a list of theirs which the app's do not (`mayStartList`). This
 * reads through the `Readers` it is given and loads nothing of Nostrify; they must check signatures
 * (`readerFor` does), since anyone can write a list naming anyone.
 */

/** How long each relay has to answer, in milliseconds, for the relay list and for the saved list. One that takes longer is left out, as one that fails is. */
export const SAVED_READ_MS = 6_000;

/**
 * The most relays the list is read from and saved to: sixteen, so that the app's own five leave room
 * for eleven of the person's. When the person names more, the app's are kept and the person's last
 * give way (`listRelaysWith`), so this must be no fewer than the app's own.
 */
export const MAX_SAVED_RELAYS = 16;

/**
 * How every read here is made: a relay whose connection is refused or lost before it says anything
 * fails at once, not when its time is up. It is one more relay that did not answer, which is taken
 * on the safe side: fewer answered, never a list that was guessed.
 */
const OUT_IS_NO_ANSWER: ReadOptions = Object.freeze({ failFast: true });

/**
 * Where the list of a person is read and saved, given their relay list (as `readRelayList` found it;
 * null when they have none, or it could not be read), as `listRelaysWith` chooses them, with the
 * saved-list relays (`config.savedListRelays`) as the app's own and at most `MAX_SAVED_RELAYS`.
 */
export function savedRelaysWith(theirList: { write: readonly string[]; read: readonly string[] } | null): ListRelays {
  return listRelaysWith(theirList, config.savedListRelays, MAX_SAVED_RELAYS);
}

/** What the relays hold of a person's saved places, and where they were read (`readSavedList`). */
export interface SavedRead {
  /** The newest list among those the relays sent; null when none sent one. */
  list: NostrEvent | null;
  /** The relays that answered in time, with a list or without one, in the order of `relays`, each once. */
  answered: string[];
  /** Where the list was read, and where a changed one is saved, as far as each answers (`savedRelaysWith`). */
  relays: string[];
  /** Those of `relays` the person's relay list writes to, in its order: a changed list goes to them whether they answered or not. */
  writes: string[];
  /**
   * The person's relay list, as `readRelayList` found it: `found`; `none`, when every relay-list relay
   * answered without one; or `unknown`, when it could not be read. Only the app's relays were read
   * then, and the person's own may hold a list of theirs.
   */
  relayList: RelayListRead["is"];
}

/**
 * What the relay at `url` sends for `filter`, as the events it is shaped like. Fails when the relay
 * does, at once when it is out (`OUT_IS_NO_ANSWER`), or does not finish within `SAVED_READ_MS`, or
 * `signal` aborts (the signal's reason), as `readWithin` does.
 */
async function ask(url: string, filter: NostrFilter, readers: Readers, signal: AbortSignal): Promise<NostrEvent[]> {
  const values = await readWithin(url, filter, readers, signal, SAVED_READ_MS, OUT_IS_NO_ANSWER);
  return values.flatMap((value) => {
    const event = asEvent(value);
    return event === null ? [] : [event];
  });
}

/**
 * The newest list of saved places of `pubkey` across `relays` (by time, then the lower id: NIP-01),
 * read side by side, each relay once however often it is named, and the relays that answered. A
 * relay that fails or is slow is left out of those, and the others still count. An event that is
 * not the person's list is ignored, whatever a relay sends. Throws only when `signal` aborts.
 */
async function readLists(
  pubkey: string,
  relays: readonly string[],
  readers: Readers,
  signal: AbortSignal,
): Promise<{ list: NostrEvent | null; answered: string[] }> {
  signal.throwIfAborted();
  // The list is addressable: a relay keeps one per person and name, so it is asked for by both.
  const filter: NostrFilter = { kinds: [SAVED_KIND], authors: [pubkey], "#d": [SAVED_D] };
  // Each relay once, at its first place: one named twice is one relay, with one answer.
  const each = [...new Set(relays)];
  const reads = await Promise.allSettled(each.map((url) => ask(url, filter, readers, signal)));
  signal.throwIfAborted();

  const answered: string[] = [];
  const sent: NostrEvent[] = [];
  reads.forEach((read, at) => {
    if (read.status !== "fulfilled") return;
    answered.push(each[at]!);
    sent.push(...read.value);
  });
  return { list: newestSaved(sent, pubkey), answered };
}

/**
 * The saved places of the person `pubkey`, as the relays hold them now. Their relay list first
 * (NIP-65), asked of the review relays and the relay-list relays; then their list, from the relays
 * that gives (`savedRelaysWith`): the person's own and the app's when it was found, and the app's
 * alone when it was not, or could not be read. Every relay has `SAVED_READ_MS` for each, and one
 * that is out is left at once (`OUT_IS_NO_ANSWER`), so that one stalled relay costs neither what
 * another sent. Whether no list at all means the person has none is not said here: that needs their
 * relay list known, and enough of the app's relays to have answered (`mayStartList`). Throws only
 * when `signal` aborts.
 */
export async function readSavedList(pubkey: string, readers: Readers, signal: AbortSignal): Promise<SavedRead> {
  signal.throwIfAborted();
  const relayList = await readRelayList(pubkey, readers, signal, SAVED_READ_MS, OUT_IS_NO_ANSWER);
  const { relays, writes } = savedRelaysWith(relayList.is === "found" ? relayList : null);
  const { list, answered } = await readLists(pubkey, relays, readers, signal);
  return { list, answered, relays, writes, relayList: relayList.is };
}

/**
 * Whether a first list may be made for the person whose list `read` is: their relay list was found,
 * or is known to be none, and as many of the app's saved-list relays (`config.savedListRelays`, each
 * once, as `configuredRelayAddress` writes it) are among those that answered as must answer before
 * their having no list of the person is believed (`newListQuorum`: more than half of them, and no
 * fewer than three). Never while their relay list is not known, however many answered: it may name
 * relays that hold a list of theirs, and the app's relays alone were read. The person's own relays
 * do not make up the number: only the app's are counted, wherever the list was read. It says nothing
 * of what they answered.
 */
export function mayStartList(read: SavedRead): boolean {
  if (read.relayList === "unknown") return false;
  const ours = new Set<string>();
  for (const url of config.savedListRelays) {
    const address = configuredRelayAddress(url);
    if (address !== null) ours.add(address);
  }
  return read.answered.filter((url) => ours.has(url)).length >= newListQuorum(ours.size);
}
