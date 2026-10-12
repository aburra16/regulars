import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { useEffect, useState } from "react";

import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { readWithin } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { useOwnFollowed } from "../follow/FollowProvider.tsx";
import { FOLLOW_KIND, names } from "../follow/list.ts";
import { FOLLOW_READ_MS, followRelaysWith, OUT_IS_NO_ANSWER } from "../follow/read.ts";
import { asEvent, isNewer, type Readers } from "../nostr/events.ts";
import { fetchProfiles } from "../nostr/profiles.ts";
import { useRelays, useScoresStore } from "../score/ScoresProvider.tsx";

/*
 * Who follows a person, among the people the person signed in follows: for the line on a person's
 * page that names up to three of them ("Followed by Maya, Jon and Dele, people you follow"). It is
 * names and nothing else: never how many there are, of those named or of those left out (decision
 * 19).
 *
 * It only reads. The person's own follows are the session's list, as the buttons have it, known for
 * theirs by its owner (`useOwnFollowed`); the lists of the people on it are asked of the follow-list
 * relays; and a list is never written from here, nor is `changeFollow` called (tests/followGuard.test.ts
 * holds a module that knows follow lists to signing and sending nothing). It knows who is signed in
 * by their public key alone (`useOwnPubkey`): the signer is not in its reach. Nothing here is logged:
 * who follows whom is theirs.
 *
 * While Follow is not open (`config.features.follow`, ruling R39) it reads nothing, and names nobody.
 */

/** The most names the line has. */
const FOLLOWED_BY_NAMES = 3;

/** The most of the person's follows one request asks about. */
const FOLLOWED_BY_BATCH = 500;

/** The most requests' worth of the person's follows that are asked about: the first 1,500 on their list. */
const FOLLOWED_BY_BATCHES = 3;

/** How many followers' names are read at a time, in the order of the person's list, until there are names enough. */
const NAMES_AT_A_TIME = 10;

/** The most reads of names for one line: a run of followers with no name is not followed to its end. */
const NAME_READS = 3;

/** `items` in runs of at most `size`, in order. */
function runsOf<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) runs.push(items.slice(start, start + size));
  return runs;
}

/**
 * Those of `batch` who follow `person`, in the order of `batch`: each follow-list relay is asked,
 * side by side and within `FOLLOW_READ_MS`, for the follow lists by them that name the person. Of
 * each author the newest list sent stands (by time, then the lower id: NIP-01), whichever relay sent
 * it, and they count only if that one names the person: a relay that lags may still hold the list
 * of someone who has taken the person out since. A relay that fails, or is slow, is left out, and one
 * that is out at once (`OUT_IS_NO_ANSWER`, ruling R40). Throws only when `signal` aborts.
 */
async function followersAmong(batch: readonly string[], person: string, readers: Readers, signal: AbortSignal): Promise<string[]> {
  // A list is replaceable: a relay keeps one per person, so one each is all there is to ask for.
  const filter: NostrFilter = { kinds: [FOLLOW_KIND], authors: [...batch], "#p": [person], limit: batch.length };
  // The app's own follow-list relays, and no other: not the person's, nor the review relays as such (ruling R12).
  const relays = followRelaysWith(null).relays;
  const reads = await Promise.allSettled(relays.map((url) => readWithin(url, filter, readers, signal, FOLLOW_READ_MS, OUT_IS_NO_ANSWER)));
  signal.throwIfAborted();

  const asked = new Set(batch);
  const newest = new Map<string, NostrEvent>();
  for (const read of reads) {
    if (read.status !== "fulfilled") continue;
    for (const value of read.value) {
      const list = asEvent(value);
      // Only what was asked for: a follow list, by one of them.
      if (list === null || list.kind !== FOLLOW_KIND || !asked.has(list.pubkey)) continue;
      const kept = newest.get(list.pubkey);
      if (kept === undefined || isNewer(list, kept)) newest.set(list.pubkey, list);
    }
  }
  return batch.filter((author) => names(newest.get(author) ?? null, person));
}

/**
 * The names of `people`, by key: the one the app has read already (`known`), else the one their
 * profile gives, read from the review relays as the app reads every profile (`fetchProfiles`), each
 * relay within `FOLLOW_READ_MS`, not waited on when it is out (`OUT_IS_NO_ANSWER`), and with what a
 * read from it adds. Someone with no name to show is not in the map. When no relay answers, only the
 * names known already. Throws only when `signal` aborts.
 */
async function namesOf(
  people: readonly string[],
  known: (pubkey: string) => string | undefined,
  readers: Readers,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const named = new Map<string, string>();
  const unread: string[] = [];
  for (const pubkey of people) {
    const name = known(pubkey);
    if (name === undefined) unread.push(pubkey);
    else named.set(pubkey, name);
  }
  if (unread.length === 0) return named;
  const within: Readers = (url) => ({
    async *req(filter, stop) {
      // Checked for their shape where they are read (`profilesFrom`).
      yield* (await readWithin(url, filter, readers, stop, FOLLOW_READ_MS, OUT_IS_NO_ANSWER)) as NostrEvent[];
    },
  });
  const profiles = await fetchProfiles(within, config.reviewRelays, unread, signal);
  for (const [pubkey, { name }] of profiles ?? []) if (name !== undefined) named.set(pubkey, name);
  return named;
}

/**
 * The names of up to `FOLLOWED_BY_NAMES` of `follows` who follow `person`, in the order of
 * `follows`, the list of the person signed in (`me`). Neither `me` nor `person` is ever among them.
 * The first `FOLLOWED_BY_BATCH * FOLLOWED_BY_BATCHES` of `follows` are asked about, a batch at a
 * time, and no further once there are names enough, or once as many names have been read as will be
 * (`NAME_READS`). A follower with no name to show is passed over: nobody is "Someone" here. Throws
 * only when `signal` aborts.
 */
async function followedBy(
  person: string,
  me: string,
  follows: readonly string[],
  readers: Readers,
  known: (pubkey: string) => string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  const asked = follows.filter((key) => key !== me && key !== person).slice(0, FOLLOWED_BY_BATCH * FOLLOWED_BY_BATCHES);
  const found: string[] = [];
  let nameReads = 0;
  for (const batch of runsOf(asked, FOLLOWED_BY_BATCH)) {
    // No name is left to be read: who else follows them could not be named, and is not asked for.
    if (nameReads >= NAME_READS) break;
    const followers = await followersAmong(batch, person, readers, signal);
    for (const some of runsOf(followers, NAMES_AT_A_TIME)) {
      if (nameReads >= NAME_READS) break;
      nameReads += 1;
      const named = await namesOf(some, known, readers, signal);
      for (const pubkey of some) {
        const name = named.get(pubkey);
        if (name !== undefined) found.push(name);
        if (found.length >= FOLLOWED_BY_NAMES) return found;
      }
    }
  }
  return found;
}

/** What an answer is an answer to: who is signed in, whose page it is, and the list of the first as the read began with it. */
interface Basis {
  me: string | undefined;
  person: string;
  follows: readonly string[] | null;
}

/** Nobody to name. */
const NOBODY: readonly string[] = [];

/**
 * The names of up to three people the person signed in follows who follow the person whose key is
 * `pubkey` (64 hex digits, in either case), in the order of their own list; none while that is not
 * known. It is not known, and nothing is asked, while nobody is signed in, while their list has not
 * been read, when they follow nobody, on their own page, and while Follow is not open.
 *
 * An answer is for one person signed in and one person's page. When either is another, what was
 * read for the one before is let go of, and is never drawn for the next: not for one drawing, and not
 * if it comes after. Nor is anything read for a person from another's list: the list is used only
 * when its owner is the person signed in. It is taken as it is when the reading begins; a change of
 * theirs to it on the page (a follow of the person whose page it is, who is never among the names)
 * does not begin it again.
 *
 * When it cannot be read, there are no names, and nothing says so; it is not asked for again while
 * the page is open. The reading stops when the component goes, and one that is stopped as soon as
 * it has begun (React's strict mode stops each effect once) has asked nothing.
 */
export function useFollowedBy(pubkey: string): readonly string[] {
  const me = useOwnPubkey()?.toLowerCase();
  const held = useOwnFollowed();
  const { readers } = useRelays();
  const store = useScoresStore("useFollowedBy");
  const person = pubkey.toLowerCase();
  // The list of the person signed in, and no one else's. None while Follow is not open: the session
  // holds none then, and this reads other people's lists itself, so it looks for itself too.
  const followed = config.features.follow && held !== null && held.owner === me ? held.followed : null;

  const [kept, keep] = useState<Basis>(() => ({ me, person, follows: followed }));
  // The same reading goes on while the same person looks at the same page with a list that is known.
  const same = kept.me === me && kept.person === person;
  const follows = followed === null ? null : same && kept.follows !== null ? kept.follows : followed;
  let basis = kept;
  if (!same || kept.follows !== follows) {
    // React's way to update state from props: this render is thrown away and done again at once.
    basis = { me, person, follows };
    keep(basis);
  }

  const [answer, setAnswer] = useState<{ to: Basis; names: readonly string[] } | null>(null);

  useEffect(() => {
    const { me: viewer, person: whom, follows: theirs } = basis;
    if (viewer === undefined || theirs === null || theirs.length === 0 || viewer === whom) return;
    const stop = new AbortController();
    // A turn later, so that an effect stopped as soon as it has begun asks no relay anything.
    Promise.resolve()
      .then(() => (stop.signal.aborted ? null : followedBy(whom, viewer, theirs, readers, (key) => store.nameOf(key), stop.signal)))
      .then(
        (found) => {
          if (found !== null && !stop.signal.aborted) setAnswer({ to: basis, names: found });
        },
        () => {
          // Stopped, or it could not be read: there are no names, and nothing is said.
        },
      );
    return () => stop.abort();
  }, [basis, readers, store]);

  // Only the answer to what is asked now: one that was for someone else is never drawn.
  return answer !== null && answer.to === basis ? answer.names : NOBODY;
}
