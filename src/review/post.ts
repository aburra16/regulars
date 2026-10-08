import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { abortable, isReviewRelay, writeRelaysOf } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import { asEvent, type RelayReader, type RelayWriter } from "../nostr/events.ts";
import { appWriters } from "../nostr/relayCode.ts";

/*
 * Posting a review (M2b Task 6, ruling R12): where it goes, signing it with the person's signer, and
 * sending it to each of those relays. Nothing here loads Nostrify: the app's writers load the relay
 * code when a review is first sent (src/nostr/relayCode.ts), so the form can be on the first screen.
 * Nothing is logged: what passes through is the person's.
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

/** A review posted: the signed event, the relays that took it, and what each of the others said. */
export interface Posted {
  event: NostrEvent;
  /** The relays that took it, in the order they were given: the review relays first. One of them is among them. */
  accepted: string[];
  /** Each relay that refused it, or did not answer in time, and why. */
  refused: Record<string, string>;
}

/**
 * The review is not on Regulars: no review relay took it (ruling R13). `accepted` names the relays
 * that did, the person's own, when some did: it is saved there, and not where the app reads reviews.
 * `refused` says what each of the others said. Both are empty when there was nowhere to send it, or
 * the signer signed something other than the review it was asked to.
 */
export class NotPosted extends Error {
  constructor(
    readonly refused: Record<string, string>,
    readonly accepted: readonly string[] = [],
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

/** Whether two lists of tags are the same, tag by tag and value by value. */
const sameTags = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]) =>
  a.length === b.length && a.every((tag, i) => tag.length === b[i]?.length && tag.every((value, j) => value === b[i]?.[j]));

/**
 * Whether `signed` is the review `template` asked for, signed: the same kind, time, words and tags.
 * Only its id, key and signature are the signer's to add. A signer that changes the time would undo the
 * order of a person's edits (`reviewStamp`); one that changes anything else, what they wrote.
 */
function isSigned(signed: unknown, template: EventTemplate): signed is NostrEvent {
  const event = asEvent(signed);
  return (
    event !== null &&
    event.kind === template.kind &&
    event.created_at === template.created_at &&
    event.content === template.content &&
    sameTags(event.tags, template.tags)
  );
}

/** Sends `event` to the relay at `url` with `writers`, until `signal` aborts. Null when it took it; else why not. */
async function sendTo(
  url: string,
  event: NostrEvent,
  writers: (url: string) => RelayWriter,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    await writers(url).publish(event, signal);
    return null;
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Posts a review: `signer` signs `template` (the person's add-on or phone app, which may ask them
 * first), and the signed event, once checked to be what was asked for, is sent to every one of
 * `relays` at once. They have `PUBLISH_TIMEOUT_MS` in all; any still silent then is given up on. It is
 * posted when a review relay took it (`config.reviewRelays`, however written): that is where Regulars
 * reads it from, and where the person's own relays alone are not (ruling R13). `accepted` and
 * `refused` say what each relay did. With no relays, nothing is signed.
 *
 * Throws `NotPosted` when no review relay took it (with what the others did), when there was nowhere
 * to send it, or when the signer signed something else; whatever the signer throws, as it is (the
 * person said no, or `AccountChanged`); and the signal's reason when `signal` aborts.
 */
export async function postReview(
  template: EventTemplate,
  signer: NostrSigner,
  relays: string[],
  signal: AbortSignal,
  writers: (url: string) => RelayWriter = appWriters,
): Promise<Posted> {
  signal.throwIfAborted();
  if (relays.length === 0) throw new NotPosted({});
  const event = await abortable(signer.signEvent(template), signal);
  if (!isSigned(event, template)) throw new NotPosted({});

  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("The relays did not answer in time", "TimeoutError")),
    PUBLISH_TIMEOUT_MS,
  );
  let answers: (readonly [string, string | null])[];
  try {
    const sending = AbortSignal.any([signal, deadline.signal]);
    answers = await Promise.all(relays.map(async (url) => [url, await sendTo(url, event, writers, sending)] as const));
  } finally {
    clearTimeout(timer);
  }
  signal.throwIfAborted();

  const accepted: string[] = [];
  const refused: Record<string, string> = {};
  for (const [url, reason] of answers) {
    if (reason === null) accepted.push(url);
    else refused[url] = reason;
  }
  if (!accepted.some(isReviewRelay)) throw new NotPosted(refused, accepted);
  return { event, accepted, refused };
}
