import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { type Account, REQUEST_TIMEOUT_MS } from "../account/session.ts";
import { withTabLock } from "../account/tabLock.ts";
import { abortable } from "../account/writeRelays.ts";
import { asEvent, isNewer, type Readers, type Writers } from "../nostr/events.ts";
import { PUBLISH_TIMEOUT_MS, SIGN_TIMEOUT_MS, sameTag, sendOnce, signInTime, signTimeFor } from "../nostr/send.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { KEEP_WAIT_MS, type KeptFor } from "./kept.ts";
import { FOLLOW_KIND, type Removed, removedBy, withFollow, withoutFollow, withRestored, withWholeList } from "./list.ts";
import {
  accountShowsUse,
  copyToAsk,
  enoughAnswered,
  FOLLOW_READ_MS,
  newListQuorum,
  type OwnListRead,
  readFollowList,
  readOwnList,
  reviewRelaysBeside,
} from "./read.ts";

/*
 * Writing a person's follow list (kind 3): the only code in the app that signs or sends one
 * (tests/followGuard.test.ts holds the rest of src to that). A follow list is one record, and saving
 * it replaces the whole of it in every app the person uses, so a mistake here can wipe their
 * follows. Two things write one, and both go down one path (`write`):
 *
 *   - `changeFollow`: one person's entry is added or taken out, or what an unfollow took out is put
 *     back as it was (Undo), and the rest of the list is kept as it was;
 *   - `putBackList`: a copy of the list that was kept in this browser is put back whole, in place of
 *     the list as it is now. The one write that replaces a list on purpose.
 *
 * Each write goes through the same steps, and stops at the first that fails:
 *
 *   1. one write at a time, in this tab and across the person's tabs;
 *   2. the list is read afresh from the relays, and the newest is built on, never one read before.
 *      For a change, the read must be one to trust (`readOwnList`, ./read.ts): the person's relay
 *      list found, and a relay it writes to heard from, or known to be none. A read that could not
 *      learn where their list is kept, or heard from none of those relays, stops it. One such read
 *      does not end there: when no relay they write to answered and several of the app's relays
 *      hold the same list (`copyToAsk`, ./read.ts), the change is not made, and says that the
 *      person may be asked whether to build on that list (`ask`). Several relays holding a list is
 *      no proof that it is their newest, and only they know whether they have followed anyone
 *      since. If they say so, the change is asked for again with the id of the list they were
 *      shown, and is made only if the fresh read then finds that very list, in that same case, and
 *      only once it is kept (step 5). And before any of that, a write is stopped by a list older
 *      than one this tab has seen: one a read of the person's list found, whether that read was
 *      one to trust or not, or one a write saved. Such a list is not the newest, and is neither
 *      asked about nor built on, whatever the person has said;
 *   3. when no relay sends a list, a change makes a fresh one only for an account known to have no
 *      relay list that more than half of the app's follow-list relays show no sign of, and never
 *      out of what an unfollow took out (Undo); and a copy is put back only when the read is one to
 *      trust and as many of the app's relays answered it as a first list needs, so that there is
 *      no list of theirs it could replace unseen; otherwise nothing is written;
 *   4. the list to sign is made of the newest (./list.ts): for a change, with one person's entries
 *      added, taken out or put back, and the rest as it was; for a copy put back, the copy's own
 *      entries and nothing of the newest;
 *   5. the list the write is built on is kept in this browser, as the relays sent it (./kept.ts): if
 *      the write was built on the wrong list, that copy is what the person has their follows back
 *      from. A change built on a read to trust goes on if it could not be kept; one made by the
 *      person's say on a read that is not, and a whole list put back, are never made without it;
 *   6. the person's signer signs the new list, and what it returns must be exactly what was built,
 *      and a valid event: its id the hash of its fields, its signature the person's;
 *   7. it is sent to every relay the list was read from and every relay the person writes to;
 *   8. it is read back from the relays that took it.
 *
 * `changeFollow` is called only when the person taps Follow, Unfollow (which Following says first),
 * Undo, or Try again for one of those that was not made, or presses Use this copy for the one of
 * those they were asked about; and `putBackList` only when they press Put it back, on the page
 * that lists their copies.
 * Nothing here loads Nostrify (its imports are types), and nostr-tools' check of a signature is
 * fetched when a write first needs it, before the signer is asked (`signatureCheck`). Nothing here
 * is logged: a list, its entries and the relays a person keeps it on are theirs.
 */

/**
 * The browser's lock (Web Locks) that one change holds, in whichever tab: two at once would each
 * build on the list as it was, and the one saved second would undo the other.
 */
export const FOLLOW_LOCK = "regulars.follow";

/** The longest a signer has to sign: an add-on's time, or a phone app's own limit, whichever is longer. */
const SLOWEST_SIGNER_MS = Math.max(SIGN_TIMEOUT_MS, REQUEST_TIMEOUT_MS);

/**
 * How long a write waits for the lock (`withTabLock`): longer than one write can take (the relay
 * list, the list, the signs of use, the keeping of the list it is built on, the slowest signer, two
 * tries at each relay and the read-back), so it waits out the one that holds it. A tab that holds
 * it longer is stuck, and the write goes ahead without it: no wait goes on for ever.
 */
export const FOLLOW_LOCK_WAIT_MS = 4 * FOLLOW_READ_MS + SLOWEST_SIGNER_MS + 2 * PUBLISH_TIMEOUT_MS + 20_000;

/**
 * How long the other relays have once the first has taken a changed list, before the change goes on
 * to read it back from those that have taken it by then (ruling R10): a relay that does not answer
 * does not hold the person up for its whole `PUBLISH_TIMEOUT_MS`. The sends still under way are not
 * stopped then: each ends on its own, taken, refused or out of time.
 */
export const FOLLOW_SETTLE_MS = 3_000;

/** How a change to a follow list ended. Each says what was signed or sent on the way to it. */
export type FollowOutcome =
  /**
   * The list as it was saved, and whether it is known to be the newest (`confirmed`): the read-back
   * found it so, and no relay refused it as holding a newer one. When not, it is saved, and could
   * not be checked yet. A copy put back over a read that is not one to trust is never confirmed:
   * what the relays the person writes to hold was not read. `kept` is whether the list it was built on was kept first, to be put back
   * (`FollowDeps.keep`): not when there was none to keep, as for a first list. After an unfollow,
   * `removed` is what it took out of the list it was built on, each entry as that list wrote it and
   * where it was: what Undo puts back (`{ restore }`). `bySay` is there, and true, when the read it
   * was built on was not one to trust and the person had said to build on the very list it found
   * (`changeFollow`'s `allowed`): then `kept` is always true.
   */
  | { kind: "saved"; list: NostrEvent; confirmed: boolean; kept: boolean; removed?: Removed[]; bySay?: true }
  /**
   * Already so: nothing was signed or sent. The list as the relays hold it; null for an account that
   * has none. `bySay` as for a saved one: the list is the one the person said to build on, found by
   * a read that is not one to trust.
   */
  | { kind: "unchanged"; list: NostrEvent | null; bySay?: true }
  /**
   * The change was not made, and the person may be asked whether to make it on `copy`: no relay
   * they write to answered, at least `AGREE_MIN` of the app's relays (./read.ts) hold that list,
   * the newest any relay sent, and its date is one a person can weigh (`copyToAsk`). `id` is the list's, and `changed` when it was made (its
   * `created_at`, in seconds): what the person is told, as only they know whether they have
   * followed anyone since. Nothing was signed, sent or kept. The list is one this tab has seen
   * from then on: nothing is built on an older one, and an older one is not asked about. To make
   * the change on it, it is asked for again with that id (`allowed`). Only a change of one entry
   * ends so: a copy put back never does.
   */
  | { kind: "ask"; copy: { id: string; changed: number } }
  /**
   * The newest list could not be read: the read was not one to trust (the person's relay list
   * could not be read, or no relay it writes to answered) and not one the person may be asked
   * about; or none came and it is not known that there is none (the account shows use, or too few
   * relays answered; or the change is an Undo, whose list is known to be somewhere); or what came
   * is older than a list this tab has seen.
   * For a copy put back (`putBackList`): the person's relay list could not be read, or no relay
   * answered; or none came, from a read that is not one to trust or that too few of the app's
   * relays answered; or what came is older than a list this tab has seen. Nothing was signed or
   * sent.
   */
  | { kind: "not-loaded" }
  /**
   * The list was read, and the write was not made because the list it would be built on could not
   * be kept in this browser first (`FollowDeps.keep` did not say yes in its time, or there is no
   * keeping): for a write that is never made without that copy, which is one made by the person's
   * say on a read that is not one to trust, and a copy put back over a list. Nothing was signed or
   * sent. Not the same as a list that could not be read: the relays answered, and it is this
   * browser's storage that did not.
   */
  | { kind: "not-kept" }
  /** The signer said no, or ran out of time. Nothing was sent. */
  | { kind: "not-approved" }
  /**
   * The check of what the signer returns could not be had, and the signer was not asked (for a copy
   * put back, the copy could not be checked then either, and nothing was read); or what the signer
   * returned was not what was built, or was no valid event (its id not the hash of its fields, or
   * its signature not the person's), and nothing was sent; or it was sent, and no relay said it
   * took it (one that did not answer in its time may have kept it all the same).
   */
  | { kind: "not-saved" };

/**
 * What a change does to the list: follows the person, unfollows them, or puts back what an unfollow
 * of them took out (Undo). `restore` is that unfollow's `removed`, and `left` the id of the list it
 * saved: only into that very list do the entries go back to their old places (`withRestored`).
 */
type Action = "follow" | "unfollow" | { restore: readonly Removed[]; left: string };

/**
 * `action` as a change may be asked for, for `who`, a lower-case key, with a copy of its own of what
 * it is to put back, so that what is checked here is what is built on later. Throws a TypeError for
 * anything else. What is put back must be entries of that person's and nothing more, as each goes
 * into the list that is signed: one or more `p` tags that name `who`, each with a place.
 */
function checked(action: unknown, who: string): Action {
  if (action === "follow" || action === "unfollow") return action;
  if (typeof action !== "object" || action === null) throw new TypeError("Neither a follow, an unfollow nor a putting back");
  const { restore, left } = action as { restore?: unknown; left?: unknown };
  if (typeof left !== "string" || !isHex64(left) || !Array.isArray(restore) || restore.length === 0) {
    throw new TypeError("Not what an unfollow took out, and the list it left");
  }
  const entries = restore.map((entry: unknown): Removed => {
    const { index, tag } = (typeof entry === "object" && entry !== null ? entry : {}) as { index?: unknown; tag?: unknown };
    const isPlace = typeof index === "number" && Number.isSafeInteger(index) && index >= 0;
    if (!isPlace || !Array.isArray(tag) || !tag.every((value) => typeof value === "string")) throw new TypeError("Not an entry of a follow list");
    return { index, tag: [...(tag as string[])] };
  });
  // Every one of them names `who`: none is anything else, or anyone else's.
  if (removedBy({ tags: entries.map((entry) => entry.tag) }, who).length !== entries.length) {
    throw new TypeError("Not entries of that person's");
  }
  return { restore: entries, left };
}

/** What a change is made with. */
export interface FollowDeps {
  /** The reader of each relay, which must check signatures (the app's do): anyone can write a list in a person's name. */
  readers: Readers;
  writers: Writers;
  /** The time, in seconds. Default: the device's clock. */
  now?: () => number;
  /** How long the signer has, in milliseconds. Default: as for a review (`signTimeFor`): an add-on 60 seconds, a phone app its own limit. */
  signWithin?: number;
  /**
   * Keeps `list`, the list a write is built on, as the relays sent it, with what is about to be done
   * to it (`why`), and says whether it is kept: the app's is `keepCopy` (./kept.ts) for the person
   * signed in. A write asks it once there is something to sign, before the person is asked to
   * approve it, and waits for its answer, for `KEEP_WAIT_MS` at most (./kept.ts): past that the
   * list counts as not kept, whatever comes of the keeping. Left out, or anything but a yes: the
   * list was not kept, and a change of one entry built on a read to trust goes on all the same,
   * while one made by the person's say on a read that is not (`allowed`) is not made, and a copy is
   * not put back over a list that was not kept (`putBackList`).
   *
   * `spare` is given by a putting back alone: the id of the copy that is being put back, which
   * must not give way to this keeping. Where only so many copies are kept, the oldest other one
   * goes: a putting back that then does not save still has its copy to try again with.
   */
  keep?: (list: NostrEvent, why: KeptFor, spare?: string) => Promise<boolean>;
}

/**
 * The newest follow list of a person's that this tab has seen, by their key: its time and id, kept
 * in memory only (ruling R9). Seen is any list a read of theirs found, whether or not that read was
 * one to trust, and any list a write saved: each was checked to be theirs, so it is a list that
 * exists, and a write built on an older one would take its place everywhere. A read that finds an
 * older one, or none, has missed a list that is known to be there: the relays that hold it did not
 * answer. Building on what it did find would undo whatever the newer one changed, a follow the
 * person made a moment ago among them. So it only ever stops a write, and never allows one.
 */
const floors = new Map<string, Pick<NostrEvent, "id" | "created_at">>();

/**
 * Forgets what this tab has seen of every person's follow list (the floor a later read is held to).
 * For sign-out: what was seen is the person's, and the next to sign in starts as in a tab just opened.
 */
export function forgetFollowFloor(): void {
  floors.clear();
}

/** Whether `list`, the newest a fresh read found (null: none), is older than one this tab has seen of `pubkey`'s. */
function belowFloor(pubkey: string, list: NostrEvent | null): boolean {
  const floor = floors.get(pubkey);
  return floor !== undefined && (list === null || isNewer(floor, list));
}

/**
 * Says that this tab has seen `list`, a follow list of `pubkey`'s: one a write read or saved, or
 * one the page's own read found (ruling R18), whether that read was one to trust or not, and
 * whether a button draws from it or not. So no write is built on a list older than any this tab has
 * seen: not on one older than the list on screen, nor on one older than a list the person was asked
 * about. The floor becomes `list` when it is newer than the one remembered, and never lowers. A
 * `list` that is not that person's follow list is no floor of theirs, and is ignored. Give it only
 * a list a reader has checked to be theirs. Nothing is read, signed or sent.
 */
export function raiseFollowFloor(pubkey: string, list: NostrEvent): void {
  if (list.kind !== FOLLOW_KIND || list.pubkey !== pubkey) return;
  const floor = floors.get(pubkey);
  if (floor === undefined || isNewer(list, floor)) floors.set(pubkey, { id: list.id, created_at: list.created_at });
}

/** This tab's changes, in turn: the end of the last one asked for, however it ended. */
let line: Promise<void> = Promise.resolve();

/**
 * Runs `task` once every change this tab asked for before it has ended, so that a second tap waits
 * for the first whatever the browser's locks do. A change stopped while it waits is not started.
 * Rejects with the signal's reason as soon as `signal` aborts; the next in line still waits for
 * `task` to end.
 */
function inTurn<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const turn = line.then(() => {
    signal.throwIfAborted();
    return task();
  });
  line = turn.then(
    () => {},
    () => {},
  );
  return abortable(turn, signal);
}

/**
 * Runs `task`, a write to the list whose turn in this tab has come (`inTurn`), under the browser's
 * lock (`FOLLOW_LOCK`), which holds across the person's tabs. Without Web Locks two tabs may write
 * the list at the same moment, and the one saved second undoes the other's: each still reads afresh,
 * so nothing else of the list is at risk.
 */
function underLock<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return withTabLock(FOLLOW_LOCK, FOLLOW_LOCK_WAIT_MS, task, signal);
}

/**
 * Whether a fresh list may be made for the account `pubkey`, whose list no relay sent. Only when all
 * of these hold, and otherwise its list is somewhere these relays are not, or could not be reached,
 * and a fresh one would replace it:
 *
 *   - they are known to have no relay list (`read.relayList` is `none`: the relay-list relays
 *     answered, and no relay sent one). One that was found is a sign the account has been used
 *     (ruling R16), and one that is not known may be there (ruling R43);
 *   - enough of the app's follow-list relays answered the read of the list, with none
 *     (`newListQuorum`: more than half of them, and no fewer than three);
 *   - as many answered both questions about the account's use, with no sign of any
 *     (`accountShowsUse`). The review relays are asked those questions besides
 *     (`reviewRelaysBeside`): no follow list is read from them, but a profile there is a sign as
 *     anywhere, and their nothing is not counted.
 *
 * How the relays are counted: with no relay list, `read.relays` are the app's follow-list relays and
 * no others (`followRelaysWith`), so both counts are of the app's relays alone. A person's own
 * relays come only from their relay list, which ends this at the first line, so they can neither
 * make up the number nor lower it. Throws only when `signal` aborts.
 */
async function isNewAccount(pubkey: string, read: OwnListRead, readers: Readers, signal: AbortSignal): Promise<boolean> {
  if (read.relayList.is !== "none") return false;
  const { relays, answered } = read;
  const quorum = newListQuorum(relays.length);
  if (answered.length < quorum) return false;
  try {
    return !(await accountShowsUse(pubkey, relays, readers, signal, quorum, reviewRelaysBeside(relays)));
  } catch {
    signal.throwIfAborted();
    // Too few relays answered both questions, or the asking failed: not known to be new.
    return false;
  }
}

/**
 * `signed` as an event of its seven fields, when it is exactly `template` signed by `pubkey`: the
 * same kind, time and `content`, and the same tags, each the same value for value, in the same
 * order, with none more and none fewer. Null otherwise. A review may carry a tag its signer adds
 * (src/review/post.ts); a follow list may not, as whatever is signed here replaces the person's
 * whole list.
 */
function exactly(signed: unknown, template: EventTemplate, pubkey: string): NostrEvent | null {
  const event = asEvent(signed);
  if (event === null) return null;
  const same =
    event.pubkey === pubkey &&
    event.kind === template.kind &&
    event.created_at === template.created_at &&
    event.content === template.content &&
    event.tags.length === template.tags.length &&
    template.tags.every((tag, at) => sameTag(tag, event.tags[at]));
  return same ? event : null;
}

/**
 * The check that an event is valid: its id is the hash of its fields, and its signature is over
 * that id by the key it names. It is nostr-tools' own (`verifyEvent`), with its hashing and its
 * curve: none of it is written here. A list that fails it is one the person never signed, and relays
 * that check would refuse it while one that did not would keep it in their name (ruling R41).
 *
 * Its code is fetched when a change first needs it, as the curve it brings is no part of the first
 * screen (tests/relay-chunk.test.ts), and it is had BEFORE the signer is asked: null when it cannot
 * be fetched, so that the change stops with nothing signed, and the person is not asked to approve
 * what could not then be sent. The fetch is waited for under `signal`: one that hangs ends with the
 * change, and does not hold the tab's turn or the lock. Throws only when `signal` aborts.
 *
 * The check is given a copy of the event, as nostr-tools notes its verdict on what it checks, and
 * takes such a note at its word: what it is asked about is the seven fields `exactly` read
 * (`asEvent`), which carry no note, and stay so.
 */
async function signatureCheck(signal: AbortSignal): Promise<((event: NostrEvent) => boolean) | null> {
  try {
    const { verifyEvent } = await abortable(import("nostr-tools/pure"), signal);
    return (event) => verifyEvent({ ...event });
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

/** How a relay answered a list it was sent. */
interface Answer {
  /** Whether it took it, on its first try or its second. */
  took: boolean;
  /** Whether it said, on either try, that it holds a newer one: said once, it stands, whatever the other try came to. */
  saidNewer: boolean;
}

/**
 * Whether a relay's refusal says that it holds a newer list than the one it was sent: `replaced:`,
 * as relays that keep one list a person say, or any reason that speaks of a newer one. What the
 * relay said is read here and goes no further: it is not logged, and not kept.
 */
const saysNewer = (reason: string): boolean => /^replaced:/i.test(reason) || /\bnewer\b/i.test(reason);

/**
 * Sends `event` to the relay at `url`, and how it answered: one try of `PUBLISH_TIMEOUT_MS`
 * (`sendOnce`), and one more when the first failed in a way that may pass (its connection was lost,
 * or it refused for now). Not a second when the first was refused for good or had no answer in its
 * time, which is no failure that may pass, nor once `signal` has aborted, whatever its reason reads
 * as.
 */
async function sendTo(url: string, event: NostrEvent, writers: Writers, signal: AbortSignal): Promise<Answer> {
  const first = await sendOnce(url, event, writers, signal);
  if (first === null) return { took: true, saidNewer: false };
  const saidNewer = saysNewer(first.reason);
  if (!first.mayPass || signal.aborted) return { took: false, saidNewer };
  const second = await sendOnce(url, event, writers, signal);
  return { took: second === null, saidNewer: saidNewer || (second !== null && saysNewer(second.reason)) };
}

/** What the relays did with a list they were sent, as far as they had answered (`sendToAll`). */
interface Sent {
  /** The relays that had taken it, in the order they were given. */
  took: string[];
  /** Whether one of them said it holds a newer list: then this one is not the newest everywhere, whoever took it. */
  newerElsewhere: boolean;
}

/**
 * Sends `event` to every one of `places` at once (`sendTo`), and resolves with what they did with
 * it: once every relay has answered or run out of time, or `FOLLOW_SETTLE_MS` after the first took
 * it, whichever comes first. So no relay took it only once all have answered. A send still under way
 * when this resolves goes on to its own end, and `signal` still stops it; nothing it does then can
 * throw, and it leaves no timer behind.
 */
function sendToAll(places: readonly string[], event: NostrEvent, writers: Writers, signal: AbortSignal): Promise<Sent> {
  return new Promise((resolve) => {
    const took = new Set<string>();
    let newerElsewhere = false;
    let waiting = places.length;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(settle);
      // As the relays have answered by now: one that answers later changes nothing of this.
      resolve({ took: places.filter((url) => took.has(url)), newerElsewhere });
    };
    const answered = (url: string, answer: Answer) => {
      waiting -= 1;
      if (answer.saidNewer) newerElsewhere = true;
      if (answer.took) {
        took.add(url);
        // Counted from the first that takes it, once: a later one starts no clock of its own.
        settle ??= setTimeout(done, FOLLOW_SETTLE_MS);
      }
      if (waiting === 0) done();
    };
    if (waiting === 0) done();
    for (const url of places) {
      void sendTo(url, event, writers, signal).then(
        (answer) => answered(url, answer),
        () => answered(url, { took: false, saidNewer: false }),
      );
    }
  });
}

/**
 * How a fresh read stands for a write: whether the write may be built on it.
 *
 *   - `yes`: it may.
 *   - `by-say`: it may, by the person's own say and nothing else: the read is not one to trust, and
 *     they said to build on the very list it found. Such a write is never made without that list
 *     kept first, and never starts a list.
 *   - `{ ask }`: it may not; the person may be asked whether to build on `ask`, the list it found.
 *   - `no`: it may not, and there is nothing to ask.
 *
 * There is no other way on: a write goes on for `yes` and for `by-say`, each named, and stops for
 * anything else.
 */
type Standing = "yes" | "by-say" | { ask: NostrEvent } | "no";

/**
 * What a write to the list does that is its own: which fresh read it may be built on, whether it may
 * start a list where none was found, and the list it makes of the newest. Everything else of a write
 * is one path (`write`), which whatever writes a follow list goes down, so that no safeguard is
 * written twice: the fresh read, the floor, the check of what the signer returns, the send, and the
 * read-back.
 */
interface Writing {
  /** What the list it is built on is kept for (`FollowDeps.keep`): what this write is about to do to it. */
  why: KeptFor;
  /** The id of a kept copy that keeping that list must not push out (`FollowDeps.keep`'s `spare`): the copy this write puts back. Left out by a write that puts none back. */
  spares?: string;
  /** How `read`, the fresh read, stands for this write (`Standing`), at `now`, the write's own time in seconds. */
  buildsOn(read: OwnListRead, now: number): Standing;
  /** Whether a list may be made though `read` found none. Throws only when `signal` aborts. */
  startsOne(read: OwnListRead, signal: AbortSignal): Promise<boolean>;
  /** The list to sign, made at `now` of `list`, the newest the read found (null: none); null when the list is so already. */
  build(list: NostrEvent | null, now: number): EventTemplate | null;
  /** What it takes out of `list`, each entry as the list wrote it and where: for Undo. Left out by a write that takes nothing out. */
  removes?(list: NostrEvent | null): Removed[];
  /**
   * Whether nothing is signed unless the list it is built on was kept first (`FollowDeps.keep`). Not
   * so for a change of one entry built on a read to trust, which the other safeguards stand behind;
   * so for a write that replaces the list whole. Where the read found no list there is none to keep,
   * and none is needed. A write that goes on by the person's say alone (`Standing`) is never made
   * without it, whatever this says.
   */
  onlyIfKept: boolean;
  /**
   * Whether what it saves over a read that is not one to trust is told as not confirmed, however
   * it is read back. So for a whole list put back: the relays the person writes to were not heard
   * from, and the app cannot say that their list is the copy everywhere. Not so for a change, which
   * is built on such a read only by the person's say for the list they were shown.
   */
  sureOnlyIfTrusted: boolean;
}

/**
 * What a change of one person's entries is, as a write (`changeFollow`). `who` is a lower-case key,
 * and `action` has been checked. `allowed` is the id of the list the person said to build on, when
 * they were asked and said so; undefined when they said nothing.
 */
function changing(account: Account, who: string, action: Action, readers: Readers, allowed: string | undefined): Writing {
  return {
    why: { did: typeof action === "string" ? action : "undo", who },
    buildsOn(read, now) {
      // The person's list as far as it can be known: it is built on, whatever they were asked.
      if (read.trusted) return "yes";
      // Not their list as far as it can be known: where they keep it could not be learned, or no
      // relay they write to was heard from, and what the others sent may be years old (rulings R43
      // and R44). Nothing is built on it by the app's own say, though it is a list this tab has
      // seen, which nothing older is built on. Whether it is a list to ask them about is said in
      // one place, which is given this change's own clock: a copy whose date is no date is not
      // asked about, nor built on by any say.
      const copy = copyToAsk(read, now);
      if (copy === null) return "no";
      // Their say is for one list, by its id: the one they were shown, with when it was last
      // changed. It allows that list and no other, and only here, where they may be asked at all.
      return allowed !== undefined && copy.id === allowed ? "by-say" : { ask: copy };
    },
    // Never guess: no list found is a list to start only for an account known to be new, and only
    // by a follow or an unfollow. What Undo puts back was taken out of a list, and that list is
    // somewhere: a read that finds none has not found it, and a list made of what was to be put
    // back would replace it.
    startsOne: async (read, signal) => typeof action === "string" && isNewAccount(account.pubkey, read, readers, signal),
    // One person's entries change; null when the list is so already.
    build(list, now) {
      if (action === "follow") return withFollow(list, who, now);
      if (action === "unfollow") return withoutFollow(list, who, now);
      return withRestored(list, action.restore, now, action.left);
    },
    // What an unfollow takes out, as the list wrote it and where: Undo puts it back.
    ...(action === "unfollow" ? { removes: (list: NostrEvent | null) => removedBy(list, who) } : {}),
    onlyIfKept: false,
    sureOnlyIfTrusted: false,
  };
}

/**
 * What putting a kept copy back is, as a write (`putBackList`). `copy` has been checked: it is the
 * person's own follow list, validly signed, and nothing else can reach it.
 */
function puttingBack(copy: NostrEvent): Writing {
  return {
    why: { did: "put-back" },
    // The list as it is now is kept before this copy replaces it, and must not take this copy's
    // place among the kept ones: were the write then not approved, there would be nothing to put
    // back, and nothing put back.
    spares: copy.id,
    // The read need not be one a change could be built on. A change adds to whatever list the read
    // found, so the read must have found the person's newest; this replaces that list, whatever it
    // is, with one known to be theirs, at their own word, and the page has told them what that
    // loses. But relays must have been asked and have answered: where their list is kept must be
    // known (their relay list read), or the list would be sent where no app of theirs looks; and
    // with no answer at all, nothing is known of the list that would be replaced.
    // It asks nothing here, as the page it is pressed on has asked already.
    buildsOn: (read) => (read.relayList.is !== "unknown" && read.answered.length > 0 ? "yes" : "no"),
    // No list was found, so there is none to keep, and a whole list is never written without a net
    // unless there is truly none to lose. A kept copy is itself a sign that the person had a list,
    // so their having none now takes two things. The read is one to trust: when it is not (no relay
    // they write to was heard from), a list of theirs may be where the read did not reach. And as
    // many of the app's relays answered as a first list needs: one relay's nothing proves nothing,
    // as some keep no lists, and a read can be one to trust though one relay alone answered it.
    startsOne: async (read) => read.trusted && enoughAnswered(read.answered),
    // The copy's content and its tags, whole; null when the newest list is that already.
    build: (list, now) => withWholeList(copy, list, now),
    // The list as it is now goes for good when this is saved: it is never replaced without a copy.
    onlyIfKept: true,
    // Put back over a read that heard from no relay the person writes to, it is saved where it
    // could be sent, and it is not known that it is their list where their other apps keep it.
    sureOnlyIfTrusted: true,
  };
}

/**
 * Has `keep` keep `list`, the list `writing` is about to replace, and says whether it is kept. Only
 * a yes is one: a keeping that says no, fails or throws has not kept it, and none of those is a
 * failure of the write.
 *
 * It is waited for no longer than `KEEP_WAIT_MS` (./kept.ts), whatever keeps: the app's own keeping
 * gives its answer within that, and one that does not has not kept the list. So no keeping holds
 * the tab's turn and the lock past that, nor a person at a button that says it is saving. And it is
 * waited for under `signal`, so that it ends with the write. Throws only when `signal` aborts; no
 * timer is left behind.
 */
async function keptFirst(keep: NonNullable<FollowDeps["keep"]>, list: NostrEvent, writing: Writing, signal: AbortSignal): Promise<boolean> {
  const { why, spares } = writing;
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(new DOMException("The list was not kept in time", "TimeoutError")), KEEP_WAIT_MS);
  try {
    const keeping = Promise.resolve().then(() => (spares === undefined ? keep(list, why) : keep(list, why, spares)));
    return (await abortable(keeping, AbortSignal.any([signal, late.signal]))) === true;
  } catch {
    signal.throwIfAborted();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** One write, start to end, once it is its turn: the path every write to a follow list goes down (`Writing`). */
async function write(account: Account, writing: Writing, deps: FollowDeps, signal: AbortSignal): Promise<FollowOutcome> {
  const { readers, writers } = deps;
  /** The time, in seconds, by this write's clock: asked each time it is needed, as a write may wait on a relay or a signer between. */
  const clock = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  signal.throwIfAborted();

  // Read fresh: where the list is, and then the newest list those relays hold now, by the one read
  // the page makes too (`readOwnList`). A relay that is out is not waited on at all, in this read
  // or any after it (ruling R40): it is one that did not answer.
  const read = await readOwnList(account.pubkey, readers, signal);

  // Not the newest: this tab has seen a newer list than any relay sent now. Before anything else,
  // whatever the read's standing and whatever the person has said: such a list is not asked about,
  // and nothing is built on it.
  if (belowFloor(account.pubkey, read.list)) return { kind: "not-loaded" };
  // What the read found is a list of the person's, checked as theirs by the reader, whether or not
  // the read is one to trust: this tab has seen it from here on, and no write is built on an older
  // one. That only ever stops a write.
  if (read.list !== null) raiseFollowFloor(account.pubkey, read.list);

  // Whether this write may be built on that read. It goes on in two cases, each named, and in no
  // other: whatever else comes back here, nothing is built.
  const standing = writing.buildsOn(read, clock());
  if (standing !== "yes" && standing !== "by-say") {
    // The person may be asked about the list it found.
    if (typeof standing === "object") return { kind: "ask", copy: { id: standing.ask.id, changed: standing.ask.created_at } };
    return { kind: "not-loaded" };
  }
  // By the person's say alone: the read is not one to trust, and they said to build on this list.
  const bySay = standing === "by-say";

  // No list was found, and this write may not make one. None is ever made by the person's say:
  // that was given for a list.
  if (read.list === null && (bySay || !(await writing.startsOne(read, signal)))) return { kind: "not-loaded" };

  // The list to sign; null when the list is so already.
  const template = writing.build(read.list, clock());
  if (template === null) return bySay ? { kind: "unchanged", list: read.list, bySay } : { kind: "unchanged", list: read.list };
  const removed = writing.removes?.(read.list);

  // A net first: the list this write is built on is kept in the browser, as the relays sent it,
  // before anything is signed, so that it can be put back if this write was built on the wrong
  // one. A first list has none to keep.
  const kept = read.list !== null && deps.keep !== undefined && (await keptFirst(deps.keep, read.list, writing, signal));
  // No net, and this write is not made without one: the list stays as it is. One made by the
  // person's say never is, as the list it is built on may not be their newest: no net, no leap.
  // The list was read: it is the keeping that failed, and the outcome says that.
  if ((bySay || (writing.onlyIfKept && read.list !== null)) && !kept) return { kind: "not-kept" };

  // What the signer returns will be checked: the check is had first, so that the person is asked
  // to approve only what can then be sent (it is fetched; a deploy may have taken its code away).
  const valid = await signatureCheck(signal);
  if (valid === null) return { kind: "not-saved" };

  // The signer is handed a copy: what it does to that changes nothing of what its answer is held to.
  let signed: unknown;
  try {
    signed = await signInTime(
      account.signer,
      { ...template, tags: template.tags.map((tag) => [...tag]) },
      signal,
      deps.signWithin ?? signTimeFor(account.how),
    );
  } catch {
    signal.throwIfAborted();
    return { kind: "not-approved" };
  }
  // Exactly what was built, and truly signed: anything else stops here, and nothing is sent.
  const event = exactly(signed, template, account.pubkey);
  if (event === null || !valid(event)) return { kind: "not-saved" };
  signal.throwIfAborted();

  // Save: everywhere the list was read from, and everywhere the person writes, all at once.
  const { took, newerElsewhere } = await sendToAll([...new Set([...read.answered, ...read.writes])], event, writers, signal);
  // A change that was stopped meanwhile leaves nothing behind: the person signed out, what this tab
  // had seen was forgotten then (`forgetFollowFloor`), and the next to sign in starts afresh.
  signal.throwIfAborted();
  if (took.length === 0) return { kind: "not-saved" };
  // A relay holds it now: it is the newest this tab knows of.
  raiseFollowFloor(account.pubkey, event);

  // Read back from the relays that took it: confirmed when the newest they hold is the one saved,
  // and no relay refused it as holding a newer one. And, for a write that says so, only when the
  // read it replaced a list over was one to trust: otherwise what the person's own relays hold
  // was never read, and it is saved, and not checked.
  const back = await readFollowList(account.pubkey, took, readers, signal);
  const confirmed = !newerElsewhere && back.list?.id === event.id && (read.trusted || !writing.sureOnlyIfTrusted);
  const saved: Extract<FollowOutcome, { kind: "saved" }> = { kind: "saved", list: event, confirmed, kept };
  if (removed !== undefined) saved.removed = removed;
  if (bySay) saved.bySay = true;
  return saved;
}

/**
 * Follows or unfollows `who` for the person signed in as `account`, or puts back what an unfollow of
 * `who` took out of their list (`action` `{ restore, left }`, from that unfollow's outcome: its
 * `removed`, and the id of the list it saved): the one way the app changes an entry of a follow
 * list (a kept copy put back whole is `putBackList`'s). Call it only when the person taps Follow,
 * Unfollow (which Following says first), Undo, or Try again for one of those that was not made; or
 * presses Use this copy, for the one of those they were asked about, and then with `allowed`.
 *
 * One change at a time, in this tab and across the person's tabs (`FOLLOW_LOCK`). Each reads the
 * list afresh (`readOwnList`), from the relays the person's relay list names and
 * `config.followListRelays` (not the review relays as such, which keep no follow lists), and builds
 * on the newest, when that read is one to trust (their relay list read, and a relay it writes to
 * heard from; or known to be none), and unless this tab has seen a newer one than any of them sent
 * (`raiseFollowFloor`, `forgetFollowFloor`). When no relay sends one, a fresh list is made only for
 * an account known to have no relay list that more than half of the app's follow-list relays, and
 * no fewer than `NEW_LIST_QUORUM` (./read.ts), show no sign of. One entry is added
 * or taken out (`withFollow`, `withoutFollow`), or the entries an unfollow took out are put back,
 * each where it was when the list is still the one that unfollow left, and at its end otherwise
 * (`withRestored`), and never into a list of their own: an Undo that finds no list is not loaded,
 * whatever the account looks like. A list that names the person again already is left as it is.
 * `account.signer` signs the result, within `deps.signWithin`; what it returns must be exactly what
 * was built, and a valid event (its id the hash of its fields, its signature the person's:
 * `signatureCheck`, whose code is had before the signer is asked); it is sent to every relay that answered the read and every relay the person writes
 * to, each once, and once more after a failure that may pass; and it is read back from those that
 * have taken it, `FOLLOW_SETTLE_MS` after the first did at the latest. A send to a slower relay may
 * go on after this resolves, until it ends or `signal` aborts.
 *
 * Where the read is not one to trust, nothing is built by the app's own say. In one such case the
 * change ends by saying that the person may be asked (`ask`, with the list found and when it was
 * last changed): their relay list was found, no relay it writes to answered, and at least
 * `AGREE_MIN` of the app's relays hold the same list, dated neither before 2020 nor more than a day
 * after this change's clock (`copyToAsk`, ./read.ts). That agreement shows only that the list was
 * once sent widely: someone who now writes to a relay of their own alone has an old list on many
 * relays, and when theirs is out for a moment the agreement holds for a list that is not their
 * newest. Only the person knows whether they have followed anyone since it was made. So `allowed`
 * is their answer: the id of the list they were shown and said to build on. With it, the change is
 * made as one built on a read to trust is, by every step above, when all of these hold, and not
 * otherwise:
 *
 *   - the fresh read is in that same case (were it one to trust, the change is an ordinary one, and
 *     `allowed` counts for nothing);
 *   - the newest list it found is the very list `allowed` names: another newest, and it ends in
 *     `ask` again, with that one;
 *   - that list is kept first (`deps.keep` answers yes within its time): otherwise it is not kept
 *     (`not-kept`), and nothing is signed.
 *
 * `allowed` never starts a list, is nothing where the relay list is unknown or known to be none, or
 * where fewer relays agree, and allows no list but the one it names. Call it with one only when the
 * person has said so, of that list.
 *
 * Resolves with how it ended (`FollowOutcome`). Whatever the signer throws is `not-approved`.
 * Rejects with a TypeError, before anything is read, when `who` or the account's key is not a public
 * key, or `action` is none of the three: what is put back must be one or more `p` tags that each
 * name `who`, each with its place, and the id of a list, and nothing else; or when `allowed` is
 * given and is not the id of an event. And with the signal's
 * reason when `signal` aborts, after which nothing more is signed or sent (a relay sent the list
 * before then may have kept it). Of a change that was stopped, or that ended with nothing made,
 * one thing stays: the list its fresh read found, when it had found one, is a list this tab has
 * seen, whether or not that read was one to trust, and a later change is held to it (the floor,
 * `raiseFollowFloor`) until that is forgotten (`forgetFollowFloor`, as at sign-out). The list it
 * was sending is not remembered, whichever relay took it.
 */
export async function changeFollow(
  account: Account,
  who: string,
  action: "follow" | "unfollow" | { restore: readonly Removed[]; left: string },
  deps: FollowDeps,
  signal: AbortSignal,
  allowed?: string,
): Promise<FollowOutcome> {
  const key = typeof who === "string" ? who.toLowerCase() : "";
  if (!isHex64(key) || !isHex64(account.pubkey)) throw new TypeError("Not a public key");
  const asked = checked(action, key);
  if (allowed !== undefined && (typeof allowed !== "string" || !isHex64(allowed))) throw new TypeError("Not the id of a list");
  signal.throwIfAborted();
  // In turn within this tab, and then under the browser's lock, which holds across the person's tabs.
  return inTurn(() => underLock(() => write(account, changing(account, key, asked, deps.readers, allowed), deps, signal), signal), signal);
}

/**
 * `copy` as the follow list of the person `pubkey`, by its shape: an event of kind 3 by them. Throws
 * a TypeError for anything else. What comes back is a copy of its own of the event's seven fields,
 * which nothing can change: so what is checked of it is what is put back, whatever is done to `copy`
 * meanwhile. Its signature is not checked here.
 */
function ownListIn(copy: unknown, pubkey: string): NostrEvent {
  const event = asEvent(copy);
  if (event === null || event.kind !== FOLLOW_KIND || event.pubkey !== pubkey) throw new TypeError("Not a follow list of this person's");
  const tags = Object.freeze(event.tags.map((tag) => Object.freeze([...tag]))) as unknown as string[][];
  return Object.freeze({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags, content: event.content, sig: event.sig });
}

/**
 * Puts `copy` back as the follow list of the person signed in as `account`: a kept copy of their
 * list (./kept.ts), in place of the list as it is now, the whole of it. It is the one write that
 * replaces a follow list on purpose, and whoever they have followed since the copy was made is no
 * longer followed after it. Call it only when the person presses Put it back, having been told so.
 *
 * `copy` must be the person's own follow list: an event of kind 3 by `account.pubkey` that is valid,
 * its id the hash of its fields and its signature theirs (`signatureCheck`), checked here, once its
 * turn has come and before anything is read. Nothing else can be put back: not a list that
 * was changed after it was signed, not another person's, not another kind of event. What is written
 * is that event's `content` and its tags, every one as the copy wrote it and in its order
 * (`withWholeList`), in a new event made now, or one second after the newest list the relays hold
 * when that is later, so that it is the newest everywhere.
 *
 * It goes down the path every write to a follow list does (`write`), by the same steps as
 * `changeFollow`: in turn in this tab and under the browser's lock (`FOLLOW_LOCK`); a fresh read
 * (`readOwnList`); never over a list older than one this tab has seen (the floor); the signer's
 * answer held to exactly what was built, and to being a valid event; sent to every relay that
 * answered the read and every relay the person writes to; read back; and the floor raised to what
 * was saved. Where it differs:
 *
 *   - the fresh read need not be one to trust, as a change's must: the person's relay list must
 *     have been read (found, or known to be none), and at least one relay must have answered.
 *     Otherwise it is not loaded. Over a read that is not one to trust it is saved and never
 *     confirmed, however it is read back: the relays the person writes to were not heard from;
 *   - relays that answer with no list at all do not stop it, when that read is one to trust and
 *     as many of the app's follow-list relays answered it as a first list needs (`enoughAnswered`,
 *     ./read.ts): the copy is known to be theirs, and there is no list to lose. No sign of the
 *     account's use is looked for, as the copy is one. Otherwise a read that found no list is not
 *     loaded: their list may be where the read did not reach, or on the relays that did not
 *     answer, and there would be nothing kept of it;
 *   - the newest list the read found is kept first (`deps.keep`, as a copy kept before one was put
 *     back), so that putting back can itself be put back. The keeping is told which copy is being
 *     put back (its id), so that it does not push that very copy out to make room: a putting back
 *     that then does not save still has it. If the list cannot be kept, by a keeping that says no,
 *     fails, does not answer in its time or is not there, it is not kept (`not-kept`), and nothing
 *     is signed: a whole list is never replaced without a net;
 *   - when the newest list has the copy's `content` and tags already, nothing is signed, and it is
 *     unchanged.
 *
 * Resolves with how it ended (`FollowOutcome`), as `changeFollow` does; a saved one has nothing for
 * Undo, and it never ends by asking (`ask`): the page it is pressed on has asked already, of the
 * whole list. `not-saved` too when the check of a signature cannot be had: then the copy was not checked,
 * and nothing was read. Rejects with a TypeError, before anything is read, when `copy` is not the
 * person's own valid follow list, or the account's key is not a public key. And with the signal's
 * reason when `signal` aborts, after which nothing more is signed or sent.
 */
export async function putBackList(account: Account, copy: NostrEvent, deps: FollowDeps, signal: AbortSignal): Promise<FollowOutcome> {
  if (!isHex64(account.pubkey)) throw new TypeError("Not a public key");
  const own = ownListIn(copy, account.pubkey);
  signal.throwIfAborted();
  // It takes its turn in this tab as it is asked for, as a change does, so that a change asked for
  // after it is made after it, on the list it put back.
  return inTurn(async () => {
    // The check of its signature, before the browser's lock is asked for or anything is read: the
    // same check the signer's answer is held to, with nostr-tools' own hashing and curve. Without
    // it nothing is known of the copy, and nothing is done with it.
    const valid = await signatureCheck(signal);
    if (valid === null) return { kind: "not-saved" };
    if (!valid(own)) throw new TypeError("Not a list the person signed");
    return underLock(() => write(account, puttingBack(own), deps, signal), signal);
  }, signal);
}
