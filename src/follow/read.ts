import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { configuredRelayAddress, type RelayListRead, readRelayList, readWithin } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type Readers, type ReadOptions } from "../nostr/events.ts";
import { type ListRelays, listRelaysWith, NEW_LIST_QUORUM, newListQuorum } from "../nostr/listRelays.ts";
import { PROFILE_KIND } from "../nostr/profiles.ts";
import { FOLLOW_KIND, names, newestList } from "./list.ts";

/*
 * Reading a person's follow list (kind 3) from several relays, and telling an account that has been
 * used from a new one. Nothing here writes: what writes a list (src/follow/change.ts) decides from
 * what these find. A list is one record that other apps replace too, so the newest of those several
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
 * list: an older copy on one of the app's relays is not it, and nothing is built on it by the app's
 * own say.
 *
 * One such read may be put to the person: their relay list was found, no relay it writes to answered,
 * and several of the app's relays hold the same list (`copyToAsk`, the one place that says so). That
 * several hold it shows only that it was once sent widely, never that it is the newest: someone who
 * now writes to a relay of their own alone has an old list on many. Only the person knows whether
 * they have followed anyone since it was made, so the agreement decides whether they may be asked,
 * and their answer decides the change (src/follow/change.ts).
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

// The fewest of the app's follow-list relays whose having nothing of a person is ever believed, and
// how many must answer before it is, are kept with the choice of relays for any list a person keeps
// as one record (src/nostr/listRelays.ts), and handed on from here.
export { NEW_LIST_QUORUM, newListQuorum };

/**
 * The fewest of the app's follow-list relays that must hold the very same list as their newest of a
 * person, when no relay the person writes to answers, before the person may be asked whether to
 * build on it (`copyToAsk`). Fewer show nothing of how widely the list was sent, and the person is
 * not asked. It is no proof that the list is their newest, with however many: only that it is a
 * list of theirs that their other apps once sent to the relays most apps use.
 */
export const AGREE_MIN = 3;

/**
 * The earliest a copy may be dated for the person to be asked about it (`copyToAsk`): the first
 * second of 2020 in Greenwich, in seconds since the epoch. The person is shown the day the copy was
 * last changed, and asked whether they have followed anyone since: a list dated before any they
 * could be using now is no date to weigh, and is more likely a clock that was wrong than a list
 * that old.
 */
export const COPY_NOT_BEFORE_S = 1_577_836_800;

/**
 * How far past the device's clock a copy may be dated and still be asked about (`copyToAsk`), in
 * seconds: a day, for a clock that is set a little wrong, here or where the list was made. A list
 * dated later than that was last changed on a day that has not come, which nobody can have followed
 * anyone since.
 */
export const COPY_AHEAD_S = 86_400;

/** The app's own follow-list relays, as the addresses a list is read from: each once (`followRelaysWith`). */
const appRelays = (): Set<string> => new Set(followRelaysWith(null).relays);

/**
 * Whether as many of the app's follow-list relays are among `answered`, the relays that answered a
 * read of a person's list, as must answer before their nothing is believed (`newListQuorum`: more
 * than half of them, and no fewer than three). The person's own relays do not make up the number:
 * only the app's are counted, wherever the list was read. It says nothing of what they answered.
 */
export function enoughAnswered(answered: readonly string[]): boolean {
  const ours = appRelays();
  return answered.filter((url) => ours.has(url)).length >= newListQuorum(ours.size);
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
export type FollowRelays = ListRelays;

/**
 * Where the follow list of a person is read and saved, given their relay list (as `readRelayList`
 * found it; null when they have none), as `listRelaysWith` chooses them, with the follow-list relays
 * (`config.followListRelays`) as the app's own and at most `MAX_FOLLOW_RELAYS`. Not the review relays
 * as such: the search relay keeps no follow lists, and answers as if the person had none; one is
 * among these only when it is a follow-list relay too, or the person's own list names it.
 */
export function followRelaysWith(theirList: { write: readonly string[]; read: readonly string[] } | null): FollowRelays {
  return listRelaysWith(theirList, config.followListRelays, MAX_FOLLOW_RELAYS);
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

/** What the relays hold of a person's follow list, with which of them hold the newest (`readLists`). */
interface ListsRead extends FollowRead {
  /**
   * Those of `answered` whose own newest list by the person is `list`, the very same event (its
   * id), in their order. None when no list was found. A relay that holds an older list, another
   * list of the same second, or none, is not among them.
   */
  holders: string[];
}

/**
 * What each of `relays` holds of the follow list of `pubkey`, read side by side, each relay once
 * however often it is named: the newest list of all (by time, then the lower id: NIP-01), the relays
 * that answered, and those of them whose own newest list is that one. Throws only when `signal`
 * aborts.
 */
async function readLists(pubkey: string, relays: readonly string[], readers: Readers, signal: AbortSignal): Promise<ListsRead> {
  signal.throwIfAborted();
  // A list is replaceable: a relay keeps one per person, so one is all there is to ask for.
  const filter: NostrFilter = { kinds: [FOLLOW_KIND], authors: [pubkey], limit: 1 };
  // Each relay once, at its first place: one named twice is one relay, with one answer.
  const each = [...new Set(relays)];
  const reads = await Promise.allSettled(each.map((url) => ask(url, filter, readers, signal)));
  signal.throwIfAborted();

  const answered: string[] = [];
  /** The newest list each of `answered` sent, in their order; null for one that sent none. */
  const sent: Array<NostrEvent | null> = [];
  reads.forEach((read, at) => {
    if (read.status !== "fulfilled") return;
    answered.push(each[at]!);
    // A relay may send more than it was asked for: its newest by this person is what it holds.
    sent.push(newestList(read.value, pubkey));
  });
  const list = newestList(
    sent.filter((event) => event !== null),
    pubkey,
  );
  const holders = list === null ? [] : answered.filter((_, at) => sent[at]?.id === list.id);
  return { list, answered, holders };
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
  const { list, answered } = await readLists(pubkey, relays, readers, signal);
  return { list, answered };
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
   * base for anything by the app's own say: at most the person may be asked about it (`copyToAsk`).
   */
  trusted: boolean;
  /**
   * Whether a relay of the person's own was heard from: their relay list names a relay to write to
   * that the app can use (`writes` is not empty), and at least one of those answered. Not so when
   * they have no relay list, or it names none, though the read is then one to trust.
   */
  ownAnswered: boolean;
  /**
   * How many of the app's follow-list relays (`config.followListRelays`), among those that answered,
   * sent `list` as their newest list by this person: the very same event, by its id. A relay that
   * holds an older list, or none, or did not answer, is not counted, and nor is a relay of the
   * person's own that is not one of the app's. 0 when no list was found.
   */
  agreed: number;
}

/**
 * The copy of their list that the person whose read is `read` may be asked about, whether to build a
 * change on it though the read is not one to trust; null when they may not be asked. `now` is the
 * time, in seconds, by the clock of whoever asks: a change gives its own, and the page the device's.
 * The one place that says when: a change (src/follow/change.ts) and the page's own read
 * (src/follow/FollowProvider.tsx) both ask here. Every one of these must hold:
 *
 *   - the read is not one to trust (one that is needs no asking);
 *   - their relay list was found;
 *   - it names a relay to write to that the app can use;
 *   - none of those answered: where their other apps keep their list could not be reached;
 *   - a list was found;
 *   - at least `AGREE_MIN` of the app's follow-list relays hold that very list as their newest;
 *   - the list is dated no earlier than `COPY_NOT_BEFORE_S`, and no later than `COPY_AHEAD_S` after
 *     `now`: what the person is asked turns on the day it was last changed, and a date outside
 *     those says nothing they can weigh.
 *
 * In every other read that is not one to trust there is nothing to ask: where the list is kept is
 * not known, or no list was found, or too few relays hold what was, or its date is no date. What
 * this gives is never the newest list for certain, and nothing may be built on it but by the
 * person's own say, given for that very list.
 */
export function copyToAsk(read: OwnListRead, now: number): NostrEvent | null {
  if (read.trusted) return null;
  if (read.relayList.is !== "found" || read.writes.length === 0 || read.ownAnswered) return null;
  if (read.list === null || read.agreed < AGREE_MIN) return null;
  if (read.list.created_at < COPY_NOT_BEFORE_S || read.list.created_at > now + COPY_AHEAD_S) return null;
  return read.list;
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
 * It says two things more, which decide nothing here: whether a relay of the person's own was heard
 * from (`ownAnswered`), and how many of the app's relays hold the newest list (`agreed`). A read
 * that is not one to trust may be put to the person when they say so (`copyToAsk`).
 *
 * The page's read and a change's fresh read are both this, with the same times. A read is never
 * kept for a change: a change calls it anew. Throws only when `signal` aborts.
 */
export async function readOwnList(pubkey: string, readers: Readers, signal: AbortSignal): Promise<OwnListRead> {
  signal.throwIfAborted();
  const relayList = await readRelayList(pubkey, readers, signal, FOLLOW_READ_MS, OUT_IS_NO_ANSWER);
  if (relayList.is === "unknown") return { relayList, relays: [], writes: [], list: null, answered: [], trusted: false, ownAnswered: false, agreed: 0 };
  const { relays, writes } = followRelaysWith(relayList.is === "found" ? relayList : null);
  const { list, answered, holders } = await readLists(pubkey, relays, readers, signal);
  const ownAnswered = writes.some((url) => answered.includes(url));
  // With relays of their own to write to, one of those must have been heard from (ruling R44).
  const trusted = writes.length === 0 || ownAnswered;
  const ours = appRelays();
  const agreed = holders.filter((url) => ours.has(url)).length;
  return { relayList, relays, writes, list, answered, trusted, ownAnswered, agreed };
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
