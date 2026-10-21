import type { NostrEvent } from "@nostrify/nostrify";

import { type Account, REQUEST_TIMEOUT_MS } from "../account/session.ts";
import { withTabLock } from "../account/tabLock.ts";
import { abortable } from "../account/writeRelays.ts";
import { isNewer, type Readers, type Writers } from "../nostr/events.ts";
import { exactly, sendToAll, signatureCheck } from "../nostr/listWrite.ts";
import { PUBLISH_TIMEOUT_MS, SIGN_TIMEOUT_MS, signInTime, signTimeFor } from "../nostr/send.ts";
import { isHex64 } from "../nostr/shapes.ts";
import type { Place } from "../places/place.ts";
import { newestSaved, withoutSaved, withSaved } from "./list.ts";
import { mayStartList, readSavedList, SAVED_READ_MS } from "./read.ts";

/*
 * Writing a person's saved places (a bookmark set, kind 30003): the only code in the app that signs
 * or sends one (tests/savedGuard.test.ts holds the rest of src to that). The list is one record, and
 * saving it replaces the whole of it in every app the person uses, so a mistake here can lose their
 * saves, and another app's entries in the same record. Each save or unsave changes one place's entry
 * and keeps the rest as it was, and goes through these steps, stopping at the first that fails:
 *
 *   1. one write at a time, in this tab and across the person's tabs;
 *   2. the list is read afresh from the relays (`readSavedList`, ./read.ts), and the newest is built
 *      on, never one read before;
 *   3. a write is stopped by a list older than one this tab has seen: one a read of the person's
 *      list found, or one a write saved. Such a list is not the newest, and is not built on;
 *   4. when no relay sends a list, a first one is made only when the person's relay list was read
 *      (found, or known to be none) and more than half of the app's saved-list relays, and no fewer
 *      than three, answered with none (`mayStartList`, ./read.ts): otherwise their list may be on
 *      relays of their own that were not read, or on those that did not answer, and a fresh one
 *      would replace it. With no relay answering, nothing is written: the app never guesses a list;
 *   5. the list to sign is the newest with one place's entry added or taken out (./list.ts), made
 *      now, or one second after the newest when that is later;
 *   6. the person's signer signs it, and what it returns must be exactly what was built, and a valid
 *      event: its id the hash of its fields, its signature the person's;
 *   7. the list it was built on must still be no older than any this tab has seen: while the signer
 *      was asked, the page may have read a newer one, saved meanwhile in another tab or app, and then
 *      nothing is sent;
 *   8. it is sent to every relay that answered the read and every relay the person writes to, and is
 *      saved once one of them takes it.
 *
 * Lighter than a follow list's writer (src/follow/change.ts): no copy of the list is kept in the
 * browser, the person is never asked whether to build on a list, and what was saved is not read
 * back. The record holds little but what the app puts in it, so a bad write costs a few saves, and
 * saving them again puts them back. `changeSaved` is called only when the person presses Save, or
 * presses to take a place out of their list.
 * Nothing here loads Nostrify (its imports are types), and nostr-tools' check of a signature is
 * fetched when a write first needs it, before the signer is asked (`signatureCheck`,
 * src/nostr/listWrite.ts). Nothing here is logged: a list, its entries and the relays a person keeps
 * it on are theirs.
 */

/**
 * The browser's lock (Web Locks) that one change holds, in whichever tab: two at once would each
 * build on the list as it was, and the one saved second would undo the other.
 */
export const SAVED_LOCK = "regulars.saved";

/** The longest a signer has to sign: an add-on's time, or a phone app's own limit, whichever is longer. */
const SLOWEST_SIGNER_MS = Math.max(SIGN_TIMEOUT_MS, REQUEST_TIMEOUT_MS);

/**
 * How long a write waits for the lock (`withTabLock`): longer than one write can take (the relay
 * list and the list, each with room for twice a relay's time, the slowest signer, two tries at each
 * relay, and time to spare), so it waits out the one that holds it. A tab that holds it longer is
 * stuck, and the write goes ahead without it: no wait goes on for ever.
 */
const SAVED_LOCK_WAIT_MS = 4 * SAVED_READ_MS + SLOWEST_SIGNER_MS + 2 * PUBLISH_TIMEOUT_MS + 20_000;

/**
 * How long the other relays have once the first has taken a changed list, before the change ends: a
 * relay that does not answer does not hold the person up for its whole `PUBLISH_TIMEOUT_MS`. The
 * sends still under way are not stopped then: each ends on its own, taken, refused or out of time.
 */
export const SAVED_SETTLE_MS = 3_000;

/** How a change to a person's saved places ended. Each says what was signed or sent on the way to it. */
export type SavedOutcome =
  /**
   * The list as it was saved: at least one relay took it. One that says it holds a newer list does
   * not change that; the next read shows whichever is the newest.
   */
  | { kind: "saved"; list: NostrEvent }
  /**
   * Already so: the place is in the list already, or not in it. Nothing was signed or sent. The
   * list as the relays hold it; null for a person who has none, when enough relays said so.
   */
  | { kind: "unchanged"; list: NostrEvent | null }
  /**
   * The newest list could not be read: no relay answered; or none sent a list, and the person's
   * relay list could not be read, or too few of the app's relays answered, to know that there is
   * none; or what came is older than a list this tab has seen. Nothing was signed or sent. Or, once
   * signed: by the time the signer answered, this tab had seen a newer list than the one it was built
   * on, so that one was not the newest after all. The person's signer signed then, and what it
   * signed was sent nowhere.
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

/** What a change is made with. */
export interface SavedDeps {
  /** The reader of each relay, which must check signatures (the app's do): anyone can write a list in a person's name. */
  readers: Readers;
  writers: Writers;
  /** The time, in seconds. Default: the device's clock. */
  now?: () => number;
  /** How long the signer has, in milliseconds. Default: as for a review (`signTimeFor`): an add-on 60 seconds, a phone app its own limit. */
  signWithin?: number;
}

/**
 * The newest list of saved places of a person's that this tab has seen, by their key: its time and
 * id, kept in memory only. Seen is any list a read of theirs found and any list a write saved: each
 * was checked to be theirs, so it is a list that exists, and a write built on an older one would take
 * its place everywhere. A read that finds an older one, or none, has missed a list that is known to
 * be there: the relays that hold it did not answer. Building on what it did find would undo whatever
 * the newer one changed, a place the person saved a moment ago among them. So it only ever stops a
 * write, and never allows one.
 */
const floors = new Map<string, Pick<NostrEvent, "id" | "created_at">>();

/**
 * Forgets what this tab has seen of every person's saved places (the floor a later read is held to).
 * For sign-out: what was seen is the person's, and the next to sign in starts as in a tab just opened.
 */
export function forgetSavedFloor(): void {
  floors.clear();
}

/**
 * Whether `list`, a list of `pubkey`'s that a read found as their newest (null: it found none), is
 * older than one this tab has seen of theirs (`raiseSavedFloor`). Its id and time are all that is
 * looked at. A read that found such a list, or none, has missed a list that is known to be there: no
 * write is built on what it found, and nothing on screen should draw from it. Nothing is read, signed
 * or sent.
 */
export function belowSavedFloor(pubkey: string, list: Pick<NostrEvent, "id" | "created_at"> | null): boolean {
  const floor = floors.get(pubkey);
  return floor !== undefined && (list === null || isNewer(floor, list));
}

/**
 * Says that this tab has seen `list`, a list of saved places of `pubkey`'s: one a write read or
 * saved, or one the page's own read found. So no write is built on a list older than any this tab
 * has seen, nor on one older than the list on screen (`belowSavedFloor`). The floor becomes `list`
 * when it is newer than the one remembered, and never lowers. A `list` that is not that person's
 * list of saved places (their kind 30003 named `regulars-saved`, as ./list.ts reads one) is no floor
 * of theirs, and is ignored. Give it only a list a reader has checked to be theirs. Nothing is read,
 * signed or sent.
 */
export function raiseSavedFloor(pubkey: string, list: NostrEvent): void {
  // The list's rules say what a list of theirs is: of this one alone, it is that list or none.
  if (newestSaved([list], pubkey) === null) return;
  const floor = floors.get(pubkey);
  if (floor === undefined || isNewer(list, floor)) floors.set(pubkey, { id: list.id, created_at: list.created_at });
}

/** This tab's changes, in turn: the end of the last one asked for, however it ended. */
let line: Promise<void> = Promise.resolve();

/**
 * Runs `task` once every change this tab asked for before it has ended, so that a second press waits
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
 * lock (`SAVED_LOCK`), which holds across the person's tabs. Without Web Locks two tabs may write the
 * list at the same moment, and the one saved second undoes the other's: each still reads afresh, so
 * nothing else of the list is at risk.
 */
function underLock<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return withTabLock(SAVED_LOCK, SAVED_LOCK_WAIT_MS, task, signal);
}

/** What a change does to the list, as checked: a place added by its address, or an address taken out. */
type Asked = { save: string } | { unsave: string };

/**
 * `change` as a change may be asked for, with its address copied, so that what is checked here is
 * what is built on later. Throws a TypeError for anything else: a save of anything but a place's
 * address (the list's own rule, `withSaved`, asked of no list), or an unsave of what is no text.
 */
function checked(change: unknown): Asked {
  if (typeof change === "object" && change !== null) {
    const { save, unsave } = change as { save?: unknown; unsave?: unknown };
    if (save !== undefined && unsave === undefined) {
      const address = typeof save === "object" && save !== null ? (save as { address?: unknown }).address : undefined;
      if (typeof address === "string") {
        // Throws for an address that is not a place's: nothing else is ever added to the list.
        withSaved(null, { address }, 0);
        return { save: address };
      }
    }
    if (unsave !== undefined && save === undefined && typeof unsave === "string") return { unsave };
  }
  throw new TypeError("Neither a save of a place nor an unsave of one");
}

/** One change, start to end, once it is its turn. */
async function write(account: Account, asked: Asked, deps: SavedDeps, signal: AbortSignal): Promise<SavedOutcome> {
  const { readers, writers } = deps;
  /** The time, in seconds, by this change's clock: asked each time it is needed, as a change may wait on a relay or a signer between. */
  const clock = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  signal.throwIfAborted();

  // Read fresh: where the list is, and then the newest list those relays hold now, by the one read
  // the page makes too (`readSavedList`).
  const read = await readSavedList(account.pubkey, readers, signal);
  // Stopped while it was read: nothing of what it found is kept. The person signed out, and what this
  // tab had seen was forgotten then (`forgetSavedFloor`).
  signal.throwIfAborted();

  // Not the newest: this tab has seen a newer list than any relay sent now. Nothing is built on it.
  if (belowSavedFloor(account.pubkey, read.list)) return { kind: "not-loaded" };
  // What the read found is a list of the person's, checked as theirs by the reader: this tab has
  // seen it from here on, and no write is built on an older one. That only ever stops a write.
  if (read.list !== null) raiseSavedFloor(account.pubkey, read.list);

  // No list was found, and none may be made: the person's relay list could not be read, and their
  // own relays with it, or too few of the app's relays answered to know that they have none, and no
  // relay at all when none answered. Never guess.
  if (read.list === null && !mayStartList(read)) return { kind: "not-loaded" };

  // The list to sign; null when the list is so already.
  const now = clock();
  const template = "save" in asked ? withSaved(read.list, { address: asked.save }, now) : withoutSaved(read.list, asked.unsave, now);
  if (template === null) return { kind: "unchanged", list: read.list };

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

  // The floor once more, just before the list is sent: while the signer was asked, this tab may
  // have seen a newer list than the one this change is built on (the page reads the list, and finds
  // one saved meanwhile in another tab or app). Sent, this list would take that one's place
  // everywhere. Nothing is sent, and nothing was changed.
  if (belowSavedFloor(account.pubkey, read.list)) return { kind: "not-loaded" };

  // Save: everywhere the list was read from, and everywhere the person writes, all at once. A relay
  // that says it holds a newer list changes nothing of how this ends: the next read shows the newest.
  const { took } = await sendToAll([...new Set([...read.answered, ...read.writes])], event, writers, signal, SAVED_SETTLE_MS);
  // A change that was stopped meanwhile leaves nothing behind: the person signed out, what this tab
  // had seen was forgotten then (`forgetSavedFloor`), and the next to sign in starts afresh.
  signal.throwIfAborted();
  if (took.length === 0) return { kind: "not-saved" };
  // A relay holds it now: it is the newest this tab knows of.
  raiseSavedFloor(account.pubkey, event);
  return { kind: "saved", list: event };
}

/**
 * Saves a place for the person signed in as `account` (`{ save: place }`), or takes the place at an
 * address out of their saved places (`{ unsave: address }`): the one way the app changes that list.
 * Call it only when the person presses Save, or presses to take a place out of the list.
 *
 * One change at a time, in this tab and across the person's tabs (`SAVED_LOCK`). Each reads the list
 * afresh (`readSavedList`), from the relays the person's relay list names and
 * `config.savedListRelays`, and builds on the newest, unless this tab has seen a newer one than any of
 * them sent (`raiseSavedFloor`, `forgetSavedFloor`). When no relay sends one, a first list is made
 * only when the person's relay list was read, and more than half of the app's saved-list relays, and
 * no fewer than three, answered (`mayStartList`). One place's entry is added at the end, with the
 * list hub as its hint (`withSaved`), or every entry of that address is taken out (`withoutSaved`),
 * and the rest of the list is kept as it was. A place in the list already, or not in it, is left as
 * it is.
 * `account.signer` signs the result, within `deps.signWithin`; what it returns must be exactly what
 * was built, and a valid event (`signatureCheck`, whose code is had before the signer is asked); it
 * is not loaded, and sent nowhere, when this tab has seen a newer list than the one it was built on
 * by then; it is sent to every relay that answered the read and every relay the person writes to,
 * each once, and once more after a failure that may pass; and it ends `SAVED_SETTLE_MS` after the
 * first relay took it at the latest. A send to a slower relay may go on after this resolves, until
 * it ends or `signal` aborts.
 *
 * Resolves with how it ended (`SavedOutcome`). Whatever the signer throws is `not-approved`. Rejects
 * with a TypeError, before anything is read, when the account's key is not a public key, or `change`
 * is neither a save of a place (an address `39999:<the house>:<d>`) nor an unsave of an address. And
 * with the signal's reason when `signal` aborts, after which nothing more is signed or sent (a relay
 * sent the list before then may have kept it). Of a change that was stopped, or that ended with
 * nothing made, one thing stays: the list its fresh read found, when it found one before the change
 * was stopped, is a list this tab has seen, and a later change is held to it until that is forgotten
 * (`forgetSavedFloor`, as at sign-out).
 */
export async function changeSaved(
  account: Account,
  change: { save: Pick<Place, "address"> } | { unsave: string },
  deps: SavedDeps,
  signal: AbortSignal,
): Promise<SavedOutcome> {
  if (!isHex64(account.pubkey)) throw new TypeError("Not a public key");
  const asked = checked(change);
  signal.throwIfAborted();
  // In turn within this tab, and then under the browser's lock, which holds across the person's tabs.
  return inTurn(() => underLock(() => write(account, asked, deps, signal), signal), signal);
}
