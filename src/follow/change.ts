import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { type Account, REQUEST_TIMEOUT_MS } from "../account/session.ts";
import { withTabLock } from "../account/tabLock.ts";
import { abortable } from "../account/writeRelays.ts";
import { asEvent, isNewer, type Readers, type Writers } from "../nostr/events.ts";
import { PUBLISH_TIMEOUT_MS, SIGN_TIMEOUT_MS, sameTag, sendOnce, signInTime, signTimeFor } from "../nostr/send.ts";
import { isHex64 } from "../nostr/shapes.ts";
import { FOLLOW_KIND, type Removed, removedBy, withFollow, withoutFollow, withRestored } from "./list.ts";
import { accountShowsUse, FOLLOW_READ_MS, newListQuorum, type OwnListRead, readFollowList, readOwnList, reviewRelaysBeside } from "./read.ts";

/*
 * Changing a person's follow list (kind 3): `changeFollow`, the only code in the app that signs or
 * sends one (tests/followGuard.test.ts holds the rest of src to that). A follow list is one record,
 * and saving it replaces the whole of it in every app the person uses, so a mistake here can wipe
 * their follows. Each change goes through the same steps, and stops at the first that fails:
 *
 *   1. one change at a time, in this tab and across the person's tabs;
 *   2. the list is read afresh from the relays, and the newest is built on, never one read before.
 *      The read must be one to trust (`readOwnList`, ./read.ts): the person's relay list found, and
 *      a relay it writes to heard from, or known to be none. A read that could not learn where
 *      their list is kept, or heard from none of those relays, stops it; and so does a list older
 *      than one this tab has saved or built on, which is not the newest;
 *   3. when no relay sends a list, a fresh one is made only for an account known to have no relay
 *      list that more than half of the app's follow-list relays show no sign of, and never out of
 *      what an unfollow took out (Undo); otherwise nothing is written;
 *   4. one person's entry is added or taken out, or what an unfollow took out is put back as it
 *      was, and the rest is kept as it was (./list.ts);
 *   5. the person's signer signs it, and what it returns must be exactly what was built, and a
 *      valid event: its id the hash of its fields, its signature the person's;
 *   6. it is sent to every relay the list was read from and every relay the person writes to;
 *   7. it is read back from the relays that took it.
 *
 * It is called only when the person taps Follow, Unfollow (which Following says first) or Undo,
 * which puts back what the unfollow before it took out. Nothing here loads Nostrify (its imports are
 * types), and nostr-tools' check of a signature is fetched when a change first needs it, before the
 * signer is asked (`signatureCheck`). Nothing here is logged: a list, its entries and the relays a
 * person keeps it on are theirs.
 */

/**
 * The browser's lock (Web Locks) that one change holds, in whichever tab: two at once would each
 * build on the list as it was, and the one saved second would undo the other.
 */
export const FOLLOW_LOCK = "regulars.follow";

/** The longest a signer has to sign: an add-on's time, or a phone app's own limit, whichever is longer. */
const SLOWEST_SIGNER_MS = Math.max(SIGN_TIMEOUT_MS, REQUEST_TIMEOUT_MS);

/**
 * How long a change waits for the lock (`withTabLock`): longer than one change can take (the relay
 * list, the list, the signs of use, the slowest signer, two tries at each relay and the read-back),
 * so it waits out the one that holds it. A tab that holds it longer is stuck, and the change goes
 * ahead without it: no wait goes on for ever.
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
   * not be checked yet. After an unfollow, `removed` is what it took out of the list it was built on,
   * each entry as that list wrote it and where it was: what Undo puts back (`{ restore }`).
   */
  | { kind: "saved"; list: NostrEvent; confirmed: boolean; removed?: Removed[] }
  /** Already so: nothing was signed or sent. The list as the relays hold it; null for an account that has none. */
  | { kind: "unchanged"; list: NostrEvent | null }
  /**
   * The newest list could not be read: the read was not one to trust (the person's relay list
   * could not be read, or no relay it writes to answered); or none came and it is not known that
   * there is none (the account shows use, or too few relays answered; or the change is an Undo,
   * whose list is known to be somewhere); or what came is older than a list this tab has seen.
   * Nothing was signed or sent.
   */
  | { kind: "not-loaded" }
  /** The signer said no, or ran out of time. Nothing was sent. */
  | { kind: "not-approved" }
  /**
   * The check of what the signer returns could not be had, and the signer was not asked; or what
   * the signer returned was not what was built, or was no valid event (its id not the hash of its
   * fields, or its signature not the person's), and nothing was sent; or it was sent, and no relay
   * said it took it (one that did not answer in its time may have kept it all the same).
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
}

/**
 * The newest follow list this tab has saved, or read to build a change on, by the person's key: its
 * time and id, kept in memory only (ruling R9). A read that finds an older one, or none, has missed
 * a list that is known to be there: the relays that hold it did not answer. Building on what it did
 * find would undo whatever the newer one changed, a follow the person made a moment ago among them.
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
 * Says that this tab has seen `list`, a follow list of `pubkey`'s: one a change read or saved, or
 * the one a page shows (ruling R18), so that a change is never built on a list older than the one
 * on screen. The floor becomes `list` when it is newer than the one remembered, and never lowers.
 * A `list` that is not that person's follow list is no floor of theirs, and is ignored. Nothing is
 * read, signed or sent.
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

/** One change, start to end, once it is this change's turn (`changeFollow`). `who` is a lower-case key, and `action` has been checked. */
async function change(account: Account, who: string, action: Action, deps: FollowDeps, signal: AbortSignal): Promise<FollowOutcome> {
  const { readers, writers } = deps;
  signal.throwIfAborted();

  // Read fresh: where the list is, and then the newest list those relays hold now, by the one read
  // the page makes too (`readOwnList`). A relay that is out is not waited on at all, in this read
  // or any after it (ruling R40): it is one that did not answer.
  const read = await readOwnList(account.pubkey, readers, signal);

  // Not the person's list as far as it can be known: where they keep it could not be learned, or no
  // relay they write to was heard from, and what the others sent may be years old (rulings R43 and
  // R44). Nothing is built on it, and it is not taken for the newest this tab has seen.
  if (!read.trusted) return { kind: "not-loaded" };

  // Not the newest: this tab has seen a newer list than any relay sent now.
  if (belowFloor(account.pubkey, read.list)) return { kind: "not-loaded" };
  if (read.list !== null) raiseFollowFloor(account.pubkey, read.list);

  // Never guess: no list found is a list to start only for an account known to be new, and only by
  // a follow or an unfollow. What Undo puts back was taken out of a list, and that list is somewhere:
  // a read that finds none has not found it, and a list made of what was to be put back would
  // replace it.
  const putsBack = typeof action !== "string";
  if (read.list === null && (putsBack || !(await isNewAccount(account.pubkey, read, readers, signal)))) {
    return { kind: "not-loaded" };
  }

  // One person's entries change; null when the list is so already.
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  let template: EventTemplate | null;
  if (action === "follow") template = withFollow(read.list, who, now);
  else if (action === "unfollow") template = withoutFollow(read.list, who, now);
  else template = withRestored(read.list, action.restore, now, action.left);
  if (template === null) return { kind: "unchanged", list: read.list };
  // What an unfollow takes out, as the list wrote it and where: Undo puts it back.
  const removed = action === "unfollow" ? removedBy(read.list, who) : undefined;

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
  // and no relay refused it as holding a newer one.
  const back = await readFollowList(account.pubkey, took, readers, signal);
  const confirmed = !newerElsewhere && back.list?.id === event.id;
  return removed === undefined ? { kind: "saved", list: event, confirmed } : { kind: "saved", list: event, confirmed, removed };
}

/**
 * Follows or unfollows `who` for the person signed in as `account`, or puts back what an unfollow of
 * `who` took out of their list (`action` `{ restore, left }`, from that unfollow's outcome: its
 * `removed`, and the id of the list it saved): the one way the app changes a follow list. Call it
 * only when the person taps Follow, Unfollow (which Following says first) or Undo.
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
 * Resolves with how it ended (`FollowOutcome`). Whatever the signer throws is `not-approved`.
 * Rejects with a TypeError, before anything is read, when `who` or the account's key is not a public
 * key, or `action` is none of the three: what is put back must be one or more `p` tags that each
 * name `who`, each with its place, and the id of a list, and nothing else. And with the signal's
 * reason when `signal` aborts, after which nothing more is signed or sent (a relay sent the list
 * before then may have kept it). Of a change that was stopped, one thing stays: the list its fresh
 * read found, when it had found one, is the newest this tab has seen, and a later change is held to
 * it (the floor, `raiseFollowFloor`) until that is forgotten (`forgetFollowFloor`, as at sign-out).
 * The list it was sending is not remembered, whichever relay took it.
 */
export async function changeFollow(
  account: Account,
  who: string,
  action: "follow" | "unfollow" | { restore: readonly Removed[]; left: string },
  deps: FollowDeps,
  signal: AbortSignal,
): Promise<FollowOutcome> {
  const key = typeof who === "string" ? who.toLowerCase() : "";
  if (!isHex64(key) || !isHex64(account.pubkey)) throw new TypeError("Not a public key");
  const asked = checked(action, key);
  signal.throwIfAborted();
  // In turn within this tab, and then under the browser's lock, which holds across the person's tabs.
  // Without Web Locks two tabs may change the list at the same moment, and the one saved second
  // undoes the other's one entry: each still reads afresh, so nothing else of the list is at risk.
  const underLock = () => withTabLock(FOLLOW_LOCK, FOLLOW_LOCK_WAIT_MS, () => change(account, key, asked, deps, signal), signal);
  return inTurn(underLock, signal);
}
