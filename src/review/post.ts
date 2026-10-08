import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { abortable, writeRelaysOf } from "../account/writeRelays.ts";
import { config } from "../config.ts";
import type { RelayReader, RelayWriter } from "../nostr/events.ts";
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

/** How long each relay has to take the review, or refuse it. Each has a limit of its own. */
export const PUBLISH_TIMEOUT_MS = 10_000;

/** A review posted: the signed event, the relays that took it, and what each of the others said. */
export interface Posted {
  event: NostrEvent;
  /** The relays that took it, in the order they were given: the review relays first. */
  accepted: string[];
  /** Each relay that refused it, or did not answer in time, and why. */
  refused: Record<string, string>;
}

/** No relay took the review, or there was none to send it to. `refused` says what each one said. */
export class NotPosted extends Error {
  constructor(readonly refused: Record<string, string>) {
    super("No relay took the review");
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

/**
 * Sends `event` to the relay at `url` with `writers`, giving it `PUBLISH_TIMEOUT_MS` of its own. Null
 * when it took it; else why not.
 */
async function sendTo(
  url: string,
  event: NostrEvent,
  writers: (url: string) => RelayWriter,
  signal: AbortSignal,
): Promise<string | null> {
  const limit = new AbortController();
  const timer = setTimeout(
    () => limit.abort(new DOMException(`${url} did not answer in time`, "TimeoutError")),
    PUBLISH_TIMEOUT_MS,
  );
  try {
    await writers(url).publish(event, AbortSignal.any([signal, limit.signal]));
    return null;
  } catch (error) {
    return reasonOf(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Posts a review: `signer` signs `template` (the person's add-on or phone app, which may ask them
 * first), and the signed event is sent to each of `relays` side by side, each with a limit of its own
 * (`PUBLISH_TIMEOUT_MS`). It is posted once every relay has answered or run out of time, if at least
 * one took it, whichever: the review relays come first in `relays` (`whereToPost`), and `accepted`
 * says which took it. With no relays, nothing is signed.
 *
 * Throws `NotPosted` when no relay took it; whatever the signer throws, as it is (the person said no,
 * or `AccountChanged`); and the signal's reason when `signal` aborts.
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
  const answers = await Promise.all(relays.map(async (url) => [url, await sendTo(url, event, writers, signal)] as const));
  signal.throwIfAborted();

  const accepted: string[] = [];
  const refused: Record<string, string> = {};
  for (const [url, reason] of answers) {
    if (reason === null) accepted.push(url);
    else refused[url] = reason;
  }
  if (accepted.length === 0) throw new NotPosted(refused);
  return { event, accepted, refused };
}
