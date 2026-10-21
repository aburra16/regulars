import { configuredRelayAddress, publicRelayAddress } from "../account/writeRelays.ts";

/*
 * Where a list that a person keeps as one replaceable record is read and saved, and how many of the
 * app's relays for such a list must answer before their having nothing of the person is believed.
 * Saving such a list replaces the whole of it in every app the person uses, so its newest is looked
 * for on the relays the person writes to as well as on the app's own. Nothing here reads a relay or
 * the app's settings: the app's relays for the list, and how many relays there is room for, are
 * given by what reads or writes it (src/follow/read.ts for a follow list).
 */

/**
 * The fewest of the app's relays for a list whose having nothing of a person is ever believed, so
 * that a fresh list may be made for them. One relay's nothing proves nothing: some keep no lists,
 * and answer as if the person had none.
 */
export const NEW_LIST_QUORUM = 3;

/**
 * How many of the app's relays for a list must answer before their nothing is believed, when
 * `appRelays` of them were asked: more than half, and never fewer than `NEW_LIST_QUORUM`. Of six,
 * four: three that never held the person's list cannot stand for the three that hold it and did not
 * answer. Of four, three. Of fewer than three it is more than there are, and is never met.
 */
export function newListQuorum(appRelays: number): number {
  return Math.max(NEW_LIST_QUORUM, Math.floor(appRelays / 2) + 1);
}

/** Where a person's list is read and saved, and which of those relays the person writes to (`listRelaysWith`). */
export interface ListRelays {
  /** Where the list is read, and a changed one saved, as far as each answers. */
  relays: string[];
  /** Those of `relays` the person's relay list writes to, in its order: a changed list goes to them whether they answered or not. */
  writes: string[];
}

/**
 * Where a list of a person's is read and saved, given their relay list (as `readRelayList` found it;
 * null when they have none): the relays it writes to and then reads from, then `appRelays`, the app's
 * own relays for the list. Each address once, at its first place. The person's are `wss://` only and
 * public (`publicRelayAddress`); the app's own are as it is set up with them. At most `max`, and when
 * the person names more than there is room for, the app's own stay and the person's last give way.
 * With no relay list, the app's relays, and nowhere the person writes.
 */
export function listRelaysWith(
  theirList: { write: readonly string[]; read: readonly string[] } | null,
  appRelays: readonly string[],
  max: number,
): ListRelays {
  const writtenTo = new Set<string>();
  for (const url of theirList?.write ?? []) {
    const address = publicRelayAddress(url);
    if (address !== null) writtenTo.add(address);
  }
  const theirs = new Set(writtenTo);
  for (const url of theirList?.read ?? []) {
    const address = publicRelayAddress(url);
    if (address !== null) theirs.add(address);
  }
  const ours = new Set<string>();
  for (const url of appRelays) {
    const address = configuredRelayAddress(url);
    if (address !== null) ours.add(address);
  }

  let room = Math.max(0, max - ours.size);
  const relays: string[] = [];
  for (const address of new Set([...theirs, ...ours])) {
    if (ours.has(address)) relays.push(address);
    else if (room-- > 0) relays.push(address);
  }
  const kept = relays.slice(0, max);
  return { relays: kept, writes: kept.filter((address) => writtenTo.has(address)) };
}
