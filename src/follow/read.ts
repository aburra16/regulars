import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { configuredRelayAddress, publicRelayAddress, type RelayListRead, readRelayList, readWithin } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type Readers, type ReadOptions } from "../nostr/events.ts";
import { PROFILE_KIND } from "../nostr/profiles.ts";
import { FOLLOW_KIND, names, newestList } from "./list.ts";

/*
 * Reading a person's follow list (kind 3) from several relays, and telling an account that has been
 * used from a new one. Nothing here writes: `changeFollow` (src/follow/change.ts) decides from what
 * these find. A list is one record that other apps replace too, so the newest of those several
 * relays hold is the one to build on, and a relay that did not answer is never taken for one with
 * no list. Lists are read from the person's own relays and the follow-list relays, not from the
 * review relays as such: the search relay keeps none (ruling R12). This reads through the `Readers`
 * it is given and loads nothing of Nostrify; they must check signatures (`readerFor` does), since
 * anyone can write a list naming anyone.
 *
 * A person's own list is read whole by one function, `readOwnList`, for the page and for a change
 * alike: their relay list, the relays it gives, their list on those, and whether what was found may
 * be acted on (rulings R43 to R45). A person's newest list is on the relays they write to. So a read
 * that could not learn of those relays, or that heard from none of them, has not read the person's
 * list: an older copy on one of the app's relays is not it, and nothing is built on it or shown from it.
 *
 * Every read here asks not to wait on a relay that is out (`OUT_IS_NO_ANSWER`, ruling R40): a relay
 * whose connection is refused or lost before it says anything fails at once, not when its time is
 * up. That is one more relay that did not answer, which every rule here and in `changeFollow`
 * already takes on the safe side: fewer answered, never a list that was guessed, and what a new
 * account needs (enough relays that answered with nothing) is harder to have, not easier.
 */

/** How long each relay has to answer, in milliseconds. One that takes longer is left out, as one that fails is. */
export const FOLLOW_READ_MS = 6_000;

/**
 * The most relays a follow list is read from and saved to: sixteen, so that the app's own
 * (`config.followListRelays`, six in production) leave room for ten of the person's, which are the
 * likeliest to hold their newest list (ruling R15).
 */
export const MAX_FOLLOW_RELAYS = 16;

/**
 * The fewest of the app's follow-list relays whose having nothing of a person is ever believed, so
 * that a fresh list may be made for them (ruling R7). One relay's nothing proves nothing: some keep
 * no lists, and answer as if the person had none.
 */
export const NEW_LIST_QUORUM = 3;

/**
 * How many of the app's follow-list relays must answer before their nothing is believed, when
 * `appRelays` of them were asked: more than half, and never fewer than `NEW_LIST_QUORUM` (ruling
 * R16). Of six, four: three that never held the person's list cannot stand for the three that hold
 * it and did not answer. Of four, three. Of fewer than three it is more than there are, and is
 * never met.
 */
export function newListQuorum(appRelays: number): number {
  return Math.max(NEW_LIST_QUORUM, Math.floor(appRelays / 2) + 1);
}

/** How every read for a follow list is made: a relay that is out is one that did not answer, at once (ruling R40). */
export const OUT_IS_NO_ANSWER: ReadOptions = Object.freeze({ failFast: true });

/**
 * What the relay at `url` sends for `filter`, as the events it is shaped like. Fails when the relay
 * does, at once when it is out (`OUT_IS_NO_ANSWER`), or does not finish within `FOLLOW_READ_MS`, or
 * `signal` aborts (the signal's reason), as `readWithin` does.
 */
async function ask(url: string, filter: NostrFilter, readers: Readers, signal: AbortSignal): Promise<NostrEvent[]> {
  const values = await readWithin(url, filter, readers, signal, FOLLOW_READ_MS, OUT_IS_NO_ANSWER);
  return values.flatMap((value) => {
    const event = asEvent(value);
    return event === null ? [] : [event];
  });
}

/** Where a person's follow list is read and saved, and which of those relays the person writes to (`followRelaysWith`). */
export interface FollowRelays {
  /** Where the list is read, and a changed one saved, as far as each answers. */
  relays: string[];
  /** Those of `relays` the person's relay list writes to, in its order: a changed list goes to them whether they answered or not. */
  writes: string[];
}

/**
 * Where the follow list of a person is read and saved, given their relay list (as `readRelayList`
 * found it; null when they have none): the relays it writes to and then reads from, then
 * `config.followListRelays`. Each address once, at its first place. Not the review relays as such
 * (ruling R12): the search relay keeps no follow lists, and answers as if the person had none; one
 * is among these only when it is a follow-list relay too, or the person's own list names it. The
 * person's are `wss://` only and public (`publicRelayAddress`); the app's own are as it is set up
 * with them. At most `MAX_FOLLOW_RELAYS`, and when the person names more than there is room for, the
 * app's own stay and the person's last give way. With no relay list, the follow-list relays, and
 * nowhere the person writes.
 */
export function followRelaysWith(theirList: { write: readonly string[]; read: readonly string[] } | null): FollowRelays {
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
  for (const url of config.followListRelays) {
    const address = configuredRelayAddress(url);
    if (address !== null) ours.add(address);
  }

  let room = Math.max(0, MAX_FOLLOW_RELAYS - ours.size);
  const relays: string[] = [];
  for (const address of new Set([...theirs, ...ours])) {
    if (ours.has(address)) relays.push(address);
    else if (room-- > 0) relays.push(address);
  }
  const kept = relays.slice(0, MAX_FOLLOW_RELAYS);
  return { relays: kept, writes: kept.filter((address) => writtenTo.has(address)) };
}

/**
 * The review relays that are not among `relays`, a person's follow relays (`followRelaysWith`), each
 * once, as addresses. No follow list is read from them or saved to them (ruling R12), but they keep
 * profiles, and a profile is a sign that an account has been used: `accountShowsUse` asks them
 * besides.
 */
export function reviewRelaysBeside(relays: readonly string[]): string[] {
  const among = new Set(relays);
  const beside = new Set<string>();
  for (const url of config.reviewRelays) {
    const address = configuredRelayAddress(url);
    if (address !== null && !among.has(address)) beside.add(address);
  }
  return [...beside];
}

/** What the relays hold of a person's follow list: the newest, if any has one, and the relays that answered. */
export interface FollowRead {
  /** The newest list among those the relays sent; null when none sent one. */
  list: NostrEvent | null;
  /** The relays that answered in time, with a list or without one, in the order they were given, each once. */
  answered: string[];
}

/**
 * The newest follow list of `pubkey` across `relays` (by time, then the lower id: NIP-01), read side
 * by side, each relay once however often it is named. A relay that fails or is slow is left out of
 * `answered`, and the others still count. An event by another author or of another kind is ignored.
 * Throws only when `signal` aborts.
 */
export async function readFollowList(
  pubkey: string,
  relays: readonly string[],
  readers: Readers,
  signal: AbortSignal,
): Promise<FollowRead> {
  signal.throwIfAborted();
  // A list is replaceable: a relay keeps one per person, so one is all there is to ask for.
  const filter: NostrFilter = { kinds: [FOLLOW_KIND], authors: [pubkey], limit: 1 };
  // Each relay once, at its first place: one named twice is one relay, with one answer.
  const each = [...new Set(relays)];
  const reads = await Promise.allSettled(each.map((url) => ask(url, filter, readers, signal)));
  signal.throwIfAborted();

  const answered: string[] = [];
  const events: NostrEvent[] = [];
  reads.forEach((read, at) => {
    if (read.status !== "fulfilled") return;
    answered.push(each[at]!);
    events.push(...read.value);
  });
  return { list: newestList(events, pubkey), answered };
}

/** What the relays say of a person's own follow list, and whether it may be acted on (`readOwnList`). */
export interface OwnListRead extends FollowRead {
  /** Their relay list: found, none, or not known (`readRelayList`). */
  relayList: RelayListRead;
  /** Where their list was read, and where a changed one is saved, as far as each answers (`followRelaysWith`). None when the relay list is not known: nothing was read. */
  relays: string[];
  /** Those of `relays` the person's relay list writes to, in its order. */
  writes: string[];
  /**
   * Whether what was found is the person's list as far as it can be known, so that it may be shown
   * and built on. It is when their relay list is known to be none; and when it was found, and
   * either names no relay to write to that the app can use (`writes` is empty: the read stands on
   * the app's relays) or at least one of those answered (rulings R43 and R44). Never when the relay
   * list is not known. Not trusted, `list` is whatever the relays that did answer sent, and is no
   * base for anything.
   */
  trusted: boolean;
}

/**
 * The whole read of the follow list of the person `pubkey`, their own, as the relays hold it now
 * (ruling R45). Their relay list first (NIP-65), asked of the review relays and the relay-list
 * relays; then their list, from the relays that gives (`followRelaysWith`). Every relay has
 * `FOLLOW_READ_MS` for each, and one that is out is left at once (`OUT_IS_NO_ANSWER`), so that one
 * stalled relay costs neither what another sent (ruling R11).
 *
 * `trusted` says whether what came back may be acted on. A person keeps their newest list on the
 * relays they write to, and other relays may hold a copy years old. So:
 * - their relay list not known (a relay-list relay did not answer, and no relay sent one): not
 *   trusted, and no relay is asked for their list, as it is not known where it is;
 * - their relay list found, and none of the relays it writes to answered: not trusted;
 * - their relay list found, and it names no relay to write to that the app can use: trusted, on
 *   the app's relays;
 * - their relay list known to be none: trusted, on the app's relays.
 * Whether no list at all means the person has none is not said here: that needs enough relays to
 * have answered (`newListQuorum`), and for a list to be started, an account that shows no use
 * (`accountShowsUse`).
 *
 * The page's read and a change's fresh read are both this, with the same times. A read is never
 * kept for a change: a change calls it anew. Throws only when `signal` aborts.
 */
export async function readOwnList(pubkey: string, readers: Readers, signal: AbortSignal): Promise<OwnListRead> {
  signal.throwIfAborted();
  const relayList = await readRelayList(pubkey, readers, signal, FOLLOW_READ_MS, OUT_IS_NO_ANSWER);
  if (relayList.is === "unknown") return { relayList, relays: [], writes: [], list: null, answered: [], trusted: false };
  const { relays, writes } = followRelaysWith(relayList.is === "found" ? relayList : null);
  const { list, answered } = await readFollowList(pubkey, relays, readers, signal);
  // With relays of their own to write to, one of those must have been heard from (ruling R44).
  const trusted = writes.length === 0 || writes.some((url) => answered.includes(url));
  return { relayList, relays, writes, list, answered, trusted };
}

/**
 * Whether the account `pubkey` shows any use: a profile (kind 0) by it, or a follow list by anyone
 * that names it, on any of `relays` or of `besides`. A sign anywhere is a yes, though the other
 * relays fail, and it is the answer as soon as it is found: whatever the relays still asked would
 * say, the account has been used, so their reads are stopped and none is waited for. A no needs
 * `atLeast` of `relays` that each answered both questions (one, unless more are asked for), every
 * relay having answered or run out of time, and throws when there are fewer: a relay that answered
 * one is no proof of the other, one relay's nothing proves little (some keep no lists, and answer as
 * if the person had none), and a wrong no lets a new list replace a list that was not found.
 * `besides` are asked the same, and count only for a yes: relays that keep profiles and no follow
 * lists, as the search relay does, whose nothing about who follows the account says nothing. Throws
 * too when `signal` aborts.
 */
export async function accountShowsUse(
  pubkey: string,
  relays: readonly string[],
  readers: Readers,
  signal: AbortSignal,
  atLeast = 1,
  besides: readonly string[] = [],
): Promise<boolean> {
  signal.throwIfAborted();
  const profile: NostrFilter = { kinds: [PROFILE_KIND], authors: [pubkey], limit: 1 };
  const follower: NostrFilter = { kinds: [FOLLOW_KIND], "#p": [pubkey], limit: 1 };
  const isProfile = (event: NostrEvent) => event.kind === PROFILE_KIND && event.pubkey === pubkey;
  const isFollower = (event: NostrEvent) => event.kind === FOLLOW_KIND && names(event, pubkey);

  // Aborts once a sign is found: every read still under way is stopped, and ends at once.
  const found = new AbortController();
  const until = AbortSignal.any([signal, found.signal]);
  /** Whether the relay at `url` answered the question `filter` asks. A sign in its answer (`isSign`) ends the asking. */
  const answers = async (url: string, filter: NostrFilter, isSign: (event: NostrEvent) => boolean): Promise<boolean> => {
    try {
      const events = await ask(url, filter, readers, until);
      if (events.some(isSign)) found.abort(new DOMException("A sign of the account's use was found", "AbortError"));
      return true;
    } catch {
      return false;
    }
  };
  const asked = await Promise.all(
    [...relays, ...besides].map((url) => Promise.all([answers(url, profile, isProfile), answers(url, follower, isFollower)])),
  );
  signal.throwIfAborted();
  if (found.signal.aborted) return true;

  // The first `relays.length` are of `relays`; the rest were asked besides, and stand behind no no.
  const answeredBoth = asked.slice(0, relays.length).filter(([profiles, followers]) => profiles && followers).length;
  // At least one, whatever is asked: no relay's answer is never a no.
  if (answeredBoth < Math.max(1, atLeast)) throw new Error("Too few relays answered whether the account has been used.");
  return false;
}
