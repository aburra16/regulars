import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { abortable, isReviewRelay, sendableRelayAddress, writeRelaysOf } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type RelayReader, type RelayWriter } from "../nostr/events.ts";
import { appWriters } from "../nostr/relayCode.ts";
import { removalTemplate } from "../reviews/write.ts";

/*
 * Posting a review (M2b Task 6, rulings R12 to R14), and removing one (Task 7): where it goes, signing
 * it with the person's signer, and sending it to all of those relays at once: posted (or removed) as
 * soon as a review relay takes it, the others going on under one limit. Nothing here loads Nostrify:
 * the app's writers load the relay code when a review is first sent (src/nostr/relayCode.ts), so the
 * form can be on the first screen. Nothing is logged: what passes through is the person's.
 */

/**
 * How long the person's relay list may take to read before the review goes to the review relays
 * alone: a directory that is slow to answer does not hold the person up.
 */
export const WRITE_RELAYS_WAIT_MS = 4_000;

/**
 * How long the relays have, all together, to take the review or refuse it: it is sent to every one
 * at once, and those that have not answered by then are given up on.
 */
export const PUBLISH_TIMEOUT_MS = 12_000;

/**
 * A review posted: the signed event, the relays that took it, and what each of the others said. It
 * is posted once a review relay has taken it, and the other relays may not have answered yet: until
 * `settled`, `accepted` and `refused` grow as they do.
 */
export interface Posted {
  event: NostrEvent;
  /** The relays that have taken it, in the order they were given (the review relays first). One of them is a review relay. */
  accepted: string[];
  /** Each relay that has refused it, or did not answer in time, and why. */
  refused: Record<string, string>;
  /** Done once every relay has answered, or the time for them is up: `accepted` and `refused` are final. */
  settled: Promise<void>;
}

/** How a review is sent: the writer of each relay (the app's own by default). */
export interface SendOptions {
  writers?: (url: string) => RelayWriter;
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
 * Sends `event` to the relay at `url` with `writers`, until `signal` aborts (a writer that does not
 * stop then is stopped waiting for). Null when it took it; else why not.
 */
async function sendTo(
  url: string,
  event: NostrEvent,
  writers: (url: string) => RelayWriter,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    await abortable(Promise.resolve().then(() => writers(url).publish(event, signal)), signal);
    return null;
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Sends `event`, a review signed already, to every one of `relays` at once (Try again sends one this
 * way, without asking for it to be signed again). It is posted as soon as a review relay
 * (`config.reviewRelays`, however written) takes it: that is where Regulars reads it from, and the
 * person's own relays alone are not (ruling R13). The others go on: they have `PUBLISH_TIMEOUT_MS`
 * from the start, all together, and what they say is added to the post as they say it.
 * `signal` stops the sending until the review is posted; once it is, only that time does, so a
 * person who goes back to the place does not cut their own relays off.
 *
 * Throws `NotPosted`, with what each relay did and the event, when no review relay took it once every
 * relay has answered or the time is up, or when there was nowhere to send it; and the signal's
 * reason when `signal` aborts before it is posted.
 */
export function sendReview(event: NostrEvent, relays: readonly string[], signal: AbortSignal, opts: SendOptions = {}): Promise<Posted> {
  const { writers = appWriters } = opts;
  if (signal.aborted) return Promise.reject(signal.reason);
  if (relays.length === 0) return Promise.reject(new NotPosted({}, [], event));

  const order = new Map(relays.map((url, i) => [url, i]));
  const accepted: string[] = [];
  const refused: Record<string, string> = {};
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // One limit for them all; and the caller's signal, until the review is posted.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("The relays did not answer in time", "TimeoutError")),
    PUBLISH_TIMEOUT_MS,
  );
  const cut = new AbortController();
  const onAbort = () => cut.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const sending = AbortSignal.any([cut.signal, deadline.signal]);

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
        signal.removeEventListener("abort", onAbort);
        resolve(posted);
      }
      waiting -= 1;
      if (waiting > 0) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
      if (posted !== undefined) return;
      reject(signal.aborted ? signal.reason : new NotPosted(refused, accepted, event));
    };
    for (const url of relays) void sendTo(url, event, writers, sending).then((reason) => answer(url, reason));
  });
}

/**
 * Posts a review: `signer` signs `template` (the person's add-on or phone app, which may ask them
 * first), and the signed event, once checked to be what was asked for, is sent to every one of
 * `relays` at once (`sendReview`): posted as soon as a review relay takes it, the others going on.
 * With no relays, nothing is signed.
 *
 * Throws `NotPosted` when no review relay took it (with what the others did, and the event), when
 * there was nowhere to send it, or when the signer signed something else; whatever the signer throws,
 * as it is (the person said no, or `AccountChanged`); and the signal's reason when `signal` aborts
 * before it is posted.
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
  const event = await abortable(signer.signEvent(template), signal);
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
