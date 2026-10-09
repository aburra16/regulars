import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import type { How } from "../account/session.ts";
import { abortable, isReviewRelay, sendableRelayAddress, writeRelaysOf } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type RelayReader, type RelayWriter } from "../nostr/events.ts";
import { appWriters } from "../nostr/relayCode.ts";
import { removalTemplate } from "../reviews/write.ts";

/*
 * Posting a review (M2b Task 6, rulings R12 to R14), and removing one (Task 7): where it goes, signing
 * it with the person's signer, and sending it to all of those relays at once: posted (or removed) as
 * soon as a review relay takes it, the others going on. A review relay that is slow to answer, or
 * fails in a way that may pass, is sent it again (ruling P1). Nothing here loads Nostrify: the app's
 * writers load the relay code when a review is first sent (src/nostr/relayCode.ts), so the form can be
 * on the first screen. What a review relay answers is logged, when it does not take it
 * (`warnNotTaken`): its address and its own words, which are public. Nothing else is: not what passes
 * through, which is the person's, nor where their own relays are, which their signer may have said.
 */

/**
 * How long the person's relay list may take to read before the review goes to the review relays
 * alone: a directory that is slow to answer does not hold the person up.
 */
export const WRITE_RELAYS_WAIT_MS = 4_000;

/**
 * How long a relay has, on each try, to take the review or refuse it: it is sent to every one at
 * once, and a try that has not been answered by then is given up on. The person's own relays have
 * one try; a review relay may have more (`REVIEW_RELAY_TRIES`).
 */
export const PUBLISH_TIMEOUT_MS = 15_000;

/**
 * How many tries a review relay has, each over a connection of its own, while it does not answer in
 * time or fails in a way that may pass (`mayPass`): a relay that stalls while it reindexes, or whose
 * store fails a batch, often takes the review a moment later.
 */
export const REVIEW_RELAY_TRIES = 3;

/** How long to wait before each try at a review relay after the first: 2 seconds before the second, 5 before the third. */
export const REVIEW_RELAY_WAITS_MS: readonly number[] = [2_000, 5_000];

/**
 * How long the review relays have in all, from the start, their tries and the waits between them
 * together: a last try has what is left of it. After that the review is not on Regulars.
 */
export const REVIEW_RELAY_PATIENCE_MS = 50_000;

/** How long a review relay may go without taking the review, once it is sent, before the form says it is slow (`SendOptions.onSlow`). */
export const SLOW_POST_MS = 8_000;

/**
 * A review posted: the signed event, the relays that took it, and what each of the others said. It
 * is posted once a review relay has taken it, and the other relays may not have answered yet: until
 * `settled`, `accepted` and `refused` grow as they do.
 */
export interface Posted {
  event: NostrEvent;
  /** The relays that have taken it, in the order they were given (the review relays first). One of them is a review relay. */
  accepted: string[];
  /** Each relay that has refused it, or did not answer in time, and why (a review relay's last try's). */
  refused: Record<string, string>;
  /** Done once every relay has answered, or the time for them is up: `accepted` and `refused` are final. */
  settled: Promise<void>;
}

/**
 * How long an add-on in the browser (NIP-07) has to sign a review or a removal: it asks the person,
 * who may not answer, and some add-ons never say no. A phone app has its own time limit
 * (`REQUEST_TIMEOUT_MS`, src/account/connect.ts), longer: the person may have to find their phone.
 */
export const SIGN_TIMEOUT_MS = 60_000;

/** How long the signer of a person signed in by `how` has to sign (`SendOptions.signWithin`): an add-on 60 seconds; a phone app its own. */
export const signTimeFor = (how: How): number | undefined => (how === "browser" ? SIGN_TIMEOUT_MS : undefined);

/** How a review is sent: the writer of each relay (the app's own by default), asked for one on each try. */
export interface SendOptions {
  writers?: (url: string) => RelayWriter;
  /**
   * For signing (`postReview`): how long the signer has, in milliseconds, after which the review is
   * not posted (`NotPosted`). None by default: the signer's own limit holds.
   */
  signWithin?: number;
  /**
   * Called once when no review relay has taken the review `SLOW_POST_MS` after it was sent (once it
   * is signed): the form says Regulars is slow to answer. Not once one has, nor once the sending has stopped.
   */
  onSlow?: () => void;
}

/**
 * What `signer` signs of `template`, or `NotPosted` once `within` milliseconds have passed without it;
 * the signal's reason when `signal` aborts first.
 */
async function signInTime(
  signer: NostrSigner,
  template: EventTemplate,
  signal: AbortSignal,
  within: number | undefined,
): Promise<NostrEvent> {
  if (within === undefined) return abortable(signer.signEvent(template), signal);
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new DOMException("The signer did not answer in time", "TimeoutError")), within);
  try {
    return await abortable(signer.signEvent(template), AbortSignal.any([signal, clock.signal]));
  } catch (error) {
    signal.throwIfAborted();
    if (clock.signal.aborted) throw new NotPosted({});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The review is not on Regulars: no review relay took it (ruling R13). `accepted` names the relays
 * that did, the person's own, when some did: it is saved there, and not where the app reads reviews.
 * `refused` says what each of the others said. `event` is the review as it was signed, which can be
 * sent again as it is (`sendReview`). All are empty when there was nowhere to send it, or the signer
 * signed something other than the review it was asked to.
 */
export class NotPosted extends Error {
  constructor(
    readonly refused: Record<string, string>,
    readonly accepted: readonly string[] = [],
    readonly event?: NostrEvent,
  ) {
    super("No review relay took the review");
    this.name = "NotPosted";
  }
}

/**
 * Where `pubkey`'s review goes (`writeRelaysOf`): the review relays and the relays the person writes
 * to. Their relay list may take at most `WRITE_RELAYS_WAIT_MS` to read; after that the review goes to
 * the review relays alone (`config.reviewRelays`). Empty when there are none of either: the form says
 * the review didn't post. Throws only when `signal` aborts, with its reason.
 */
export async function whereToPost(
  pubkey: string,
  signer: NostrSigner,
  readers: (url: string) => RelayReader,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const wait = new AbortController();
  const timer = setTimeout(
    () => wait.abort(new DOMException("The relay lists took too long to read", "TimeoutError")),
    WRITE_RELAYS_WAIT_MS,
  );
  try {
    return await writeRelaysOf(pubkey, signer, readers, AbortSignal.any([signal, wait.signal]));
  } catch (error) {
    signal.throwIfAborted();
    if (wait.signal.aborted) return [...config.reviewRelays];
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The time to stamp a person's review of a place with, in seconds: `now`, or a second after the
 * newest of their reviews of it (`previous`, under any `d` and in any filing), or after their last
 * removal of one (`removedAt`), whichever is latest. Two versions of a review in the same second
 * would leave the relays to pick by id (NIP-01), and a removal takes every version up to its own time
 * (NIP-09): an edit made at once must be the later one.
 */
export function reviewStamp(now: number, previous: readonly { createdAt: number }[], removedAt: number | undefined): number {
  return Math.max(now, ...previous.map((review) => review.createdAt + 1), removedAt === undefined ? 0 : removedAt + 1);
}

/** What a relay's refusal, or the end of its time, says, as text. */
const reasonOf = (error: unknown) => (error instanceof Error || error instanceof DOMException ? error.message : String(error));

/** Whether two tags are the same, value by value. */
const sameTag = (a: readonly string[], b: readonly string[] | undefined) =>
  a.length === b?.length && a.every((value, i) => value === b[i]);

/**
 * The tags a signer may never add. Each of the first names a review (`d`), a place or a review's
 * address (`a`), an event (`e`), a kind (`k`) or a person (`p`): added to a review, one would file it
 * under another place too; added to a removal, it would remove more than the person asked to (ruling
 * R17). The others change what becomes of it: `expiration` has relays drop it at a time (NIP-40), `-`
 * has them refuse it from an app that has not proven whose it is (NIP-70), and `delegation` makes it
 * another person's (NIP-26). A list of what may not be added, not of what may: a signer that adds a
 * tag of its own, such as `client` or a `nonce` (NIP-13), still signs reviews.
 */
const NOT_THE_SIGNERS = new Set(["d", "a", "e", "k", "p", "expiration", "-", "delegation"]);

/**
 * Whether `tags` are `asked`, tag by tag and value by value, and then any the signer added: none of a
 * name `asked` uses, and none of `NOT_THE_SIGNERS`. A tag naming the signer (`["client", …]`) may follow.
 */
function asAskedWithTheSigners(tags: readonly (readonly string[])[], asked: readonly (readonly string[])[]): boolean {
  if (tags.length < asked.length || !asked.every((tag, i) => sameTag(tag, tags[i]))) return false;
  const names = new Set(asked.map((tag) => tag[0]));
  return tags.slice(asked.length).every(([name]) => name !== undefined && !names.has(name) && !NOT_THE_SIGNERS.has(name));
}

/**
 * Whether `signed` is what `template` asked for, signed: the same kind, time and words, and the same
 * tags, in order, before any the signer adds after them (some add one naming themselves, such as
 * `["client", …]`: ruling R15), so long as an added one changes nothing the template says
 * (`asAskedWithTheSigners`, ruling R17). Its id, key and signature are the signer's to add too. A
 * signer that changes the time would undo the order of a person's edits (`reviewStamp`); one that
 * changes or leaves out a tag, puts one before them, or adds one that names something, what they
 * wrote, or what they removed.
 */
function isSigned(signed: unknown, template: EventTemplate): signed is NostrEvent {
  const event = asEvent(signed);
  return (
    event !== null &&
    event.kind === template.kind &&
    event.created_at === template.created_at &&
    event.content === template.content &&
    asAskedWithTheSigners(event.tags, template.tags)
  );
}

/**
 * Whether a relay's failure to take a review may pass, so that a review relay is sent it again: its
 * connection closed or failed before it answered (`writerFor`'s `NetworkError`), or it refused the
 * review for a fault of its own (`error:`) or for now (`rate-limited:`), as NIP-01's prefixes say.
 * Any other refusal is its answer, and final: `blocked:`, `invalid:`, `replaced:`, `pow:`,
 * `restricted:`, `auth-required:`, another prefix, or none. A try that ran out of time may pass too
 * (`tryToSend`).
 */
function mayPass(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "NetworkError";
  return error instanceof Error && /^(?:error|rate-limited):/.test(error.message);
}

/**
 * Logs that the review relay at `url` did not take a review or a removal, and what it said, for
 * whoever looks into why it didn't post: "[post] wss://… did not take it: error: …". Only a review
 * relay's (`isReviewRelay`), and only its address and its answer: never the event, what the person
 * wrote, who they are, or anything of their signer's, such as the person's own relays.
 */
function warnNotTaken(url: string, reason: string): void {
  if (isReviewRelay(url)) console.warn(`[post] ${url} did not take it: ${reason}`);
}

/** A signal that aborts with a TimeoutError once `ms` milliseconds have passed, and `stop`, which clears its timer. */
function timeLimit(ms: number): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The relay did not answer in time", "TimeoutError")), ms);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

/** Waits `ms` milliseconds, unless `signal` aborts first. True when it waited them all. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One try at sending a review to a relay: taken (null), or why not, and whether it is worth another. */
type Tried = { reason: string; again: boolean } | null;

/**
 * One try at sending `event` to the relay at `url`, with a writer of its own from `writers` (the
 * app's opens a connection for it): it has `PUBLISH_TIMEOUT_MS`, and stops when `signal` aborts (a
 * writer that does not stop then is stopped waiting for). Null when the relay took it; else why not,
 * and whether to try again: when the try ran out of time, or the failure may pass (`mayPass`), but
 * not when `signal` stopped it.
 */
async function tryToSend(url: string, event: NostrEvent, writers: (url: string) => RelayWriter, signal: AbortSignal): Promise<Tried> {
  const limit = timeLimit(PUBLISH_TIMEOUT_MS);
  const within = AbortSignal.any([signal, limit.signal]);
  try {
    await abortable(Promise.resolve().then(() => writers(url).publish(event, within)), within);
    return null;
  } catch (error) {
    return { reason: reasonOf(error), again: !signal.aborted && (limit.signal.aborted || mayPass(error)) };
  } finally {
    limit.stop();
  }
}

/**
 * Sends `event` to the relay at `url` (`tryToSend`), up to `tries` times while its failures may
 * pass, waiting `REVIEW_RELAY_WAITS_MS` before each try after the first, until `signal` aborts. Null
 * once it has taken it; else why not, the last time. Each try a review relay does not take is logged
 * (`warnNotTaken`), unless `left` has aborted: the person stopped it, and the relay said nothing.
 */
async function sendTo(
  url: string,
  event: NostrEvent,
  writers: (url: string) => RelayWriter,
  tries: number,
  signal: AbortSignal,
  left: AbortSignal,
): Promise<string | null> {
  for (let tried = 1; ; tried += 1) {
    const result = await tryToSend(url, event, writers, signal);
    if (result === null) return null;
    if (!left.aborted) warnNotTaken(url, result.reason);
    const wait = REVIEW_RELAY_WAITS_MS[tried - 1];
    if (!result.again || tried >= tries || wait === undefined || !(await pause(wait, signal))) return result.reason;
  }
}

/**
 * Sends `event`, a review signed already, to every one of `relays` at once (Try again sends one this
 * way, without asking for it to be signed again). It is posted as soon as a review relay
 * (`config.reviewRelays`, however written) takes it: that is where Regulars reads it from, and the
 * person's own relays alone are not (ruling R13). The others go on, and what they say is added to the
 * post as they say it. Each try at a relay has `PUBLISH_TIMEOUT_MS`. The person's own relays have one;
 * a review relay that does not answer in time, or fails in a way that may pass (`mayPass`), is sent it
 * again, up to `REVIEW_RELAY_TRIES` times, `REVIEW_RELAY_WAITS_MS` apart, all within
 * `REVIEW_RELAY_PATIENCE_MS` from the start (ruling P1). `opts.onSlow` hears when none has taken it
 * after `SLOW_POST_MS`. `signal` stops the sending, tries to come and all, until the review is
 * posted; once it is, only those limits do, so a person who goes back to the place does not cut
 * their own relays off.
 *
 * Throws `NotPosted`, with what each relay did and the event, when no review relay took it once every
 * relay has answered or the time is up, or when there was nowhere to send it; and the signal's
 * reason when `signal` aborts before it is posted.
 */
export function sendReview(event: NostrEvent, relays: readonly string[], signal: AbortSignal, opts: SendOptions = {}): Promise<Posted> {
  const { writers = appWriters, onSlow } = opts;
  if (signal.aborted) return Promise.reject(signal.reason);
  if (relays.length === 0) return Promise.reject(new NotPosted({}, [], event));

  const order = new Map(relays.map((url, i) => [url, i]));
  const accepted: string[] = [];
  const refused: Record<string, string> = {};
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // The caller's signal, until the review is posted; the review relays' patience, from the start; and
  // when to say it is slow.
  const cut = new AbortController();
  const patience = timeLimit(REVIEW_RELAY_PATIENCE_MS);
  const slow = onSlow === undefined ? undefined : setTimeout(onSlow, SLOW_POST_MS);
  const onAbort = () => {
    clearTimeout(slow);
    cut.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const patiently = AbortSignal.any([cut.signal, patience.signal]);

  return new Promise<Posted>((resolve, reject) => {
    let posted: Posted | undefined;
    let waiting = relays.length;
    const answer = (url: string, reason: string | null) => {
      if (reason === null) {
        accepted.push(url);
        accepted.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      } else {
        refused[url] = reason;
      }
      if (posted === undefined && reason === null && isReviewRelay(url)) {
        posted = { event, accepted, refused, settled };
        clearTimeout(slow);
        signal.removeEventListener("abort", onAbort);
        resolve(posted);
      }
      waiting -= 1;
      if (waiting > 0) return;
      patience.stop();
      clearTimeout(slow);
      signal.removeEventListener("abort", onAbort);
      settle();
      if (posted !== undefined) return;
      reject(signal.aborted ? signal.reason : new NotPosted(refused, accepted, event));
    };
    for (const url of relays) {
      const sending = isReviewRelay(url)
        ? sendTo(url, event, writers, REVIEW_RELAY_TRIES, patiently, cut.signal)
        : sendTo(url, event, writers, 1, cut.signal, cut.signal);
      void sending.then((reason) => answer(url, reason));
    }
  });
}

/**
 * Posts a review: `signer` signs `template` (the person's add-on or phone app, which may ask them
 * first), within `opts.signWithin` when given (an add-on: `SIGN_TIMEOUT_MS`), and the signed event,
 * once checked to be what was asked for, is sent to every one of `relays` at once (`sendReview`):
 * posted as soon as a review relay takes it, the others going on, and a review relay that is slow or
 * fails for now tried again. With no relays, nothing is signed.
 *
 * Throws `NotPosted` when no review relay took it (with what the others did, and the event), when
 * there was nowhere to send it, when the signer signed something else, or did not sign in time;
 * whatever the signer throws, as it is (the person said no, or `AccountChanged`); and the signal's
 * reason when `signal` aborts before it is posted.
 */
export async function postReview(
  template: EventTemplate,
  signer: NostrSigner,
  relays: readonly string[],
  signal: AbortSignal,
  opts: SendOptions = {},
): Promise<Posted> {
  signal.throwIfAborted();
  if (relays.length === 0) throw new NotPosted({});
  const event = await signInTime(signer, template, signal, opts.signWithin);
  if (!isSigned(event, template)) throw new NotPosted({});
  return sendReview(event, relays, signal, opts);
}

/** One of the person's reviews of a place, as removing it names it (`ScoresStore.ownCoordinates`). */
export interface ReviewToRemove {
  id: string;
  d: string;
  createdAt: number;
  /** The relays it went to, when the tab knows (a review it holds): its removal goes there too. */
  relays?: readonly string[];
}

/**
 * Where a removal of `reviews` goes (Global Constraints, Removal): the review relays, where the
 * person writes now (`where`, from `whereToPost`), and every relay each review went to, as far as the
 * tab knows; each once, however written. Only relays a review may be sent to are kept
 * (`sendableRelayAddress`): what the tab kept of where a review went is held to the same rule.
 */
export function removalRelays(where: readonly string[], reviews: readonly Pick<ReviewToRemove, "relays">[]): string[] {
  const relays = new Set<string>();
  for (const url of [...config.reviewRelays, ...where, ...reviews.flatMap((review) => review.relays ?? [])]) {
    const address = sendableRelayAddress(url);
    if (address !== null) relays.add(address);
  }
  return [...relays];
}

/**
 * Removes the person's `reviews` of a place: every version of their review of it, under any `d` and
 * in any filing. `account.signer` signs one removal naming them all (`removalTemplate`, NIP-09), at
 * `now` or at the newest of them, whichever is later: a removal takes the versions at an address up to
 * its own time, so it must not be older than the newest. It is sent as a review is (`postReview`):
 * removed once a review relay takes it, the others going on. With nothing to remove, or nowhere to
 * send it, nothing is signed.
 *
 * Throws as `postReview` does: `NotPosted` when no review relay took it (with what the others did, and
 * the signed removal, to send again as it is), whatever the signer throws, and the signal's reason.
 */
export async function removeReview(
  reviews: readonly ReviewToRemove[],
  account: { pubkey: string; signer: NostrSigner },
  relays: readonly string[],
  now: number,
  signal: AbortSignal,
  opts: SendOptions = {},
): Promise<Posted> {
  signal.throwIfAborted();
  if (reviews.length === 0) throw new NotPosted({});
  const stamp = Math.max(now, ...reviews.map((review) => review.createdAt));
  const template = removalTemplate(
    reviews.map(({ id, d }) => ({ id, pubkey: account.pubkey, d })),
    stamp,
  );
  return postReview(template, account.signer, relays, signal, opts);
}
