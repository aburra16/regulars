import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import type { How } from "../account/session.ts";
import { abortable } from "../account/writeRelays.ts";
import type { Writers } from "./events.ts";

/*
 * What posting a review (src/review/post.ts), changing a follow list (src/follow/change.ts) and
 * changing a person's saved places (src/saved/change.ts) share: signing with the person's signer
 * within a time, and one try at sending an event to a relay, with whether a failure may pass. Each of
 * them checks what was signed by its own rule, and decides for itself how often a relay is tried.
 * Nothing here loads Nostrify (its imports are types), and nothing here is logged.
 */

/**
 * How long a try at a relay goes unanswered before something is done. A try made with `sendOnce` is
 * given up on then: the person's own relays have one such try for a review, and every relay one for
 * a follow list. A review relay's try goes on listening, and the next starts beside it (ruling P2,
 * src/review/post.ts), as a relay with a long queue answers late, and stores the review all the same.
 */
export const PUBLISH_TIMEOUT_MS = 15_000;

/**
 * How long the person's relay list (NIP-65) may take to read before a review goes without it: a
 * directory that is slow to answer does not hold the person up, and the review then goes to the
 * review relays alone (`whereToPost`, src/review/post.ts). A follow list never goes without it: the
 * read of a person's own list has its own time, and stops the change when the relay list could not
 * be read (`readOwnList`, src/follow/read.ts).
 */
export const WRITE_RELAYS_WAIT_MS = 4_000;

/**
 * How long an add-on in the browser (NIP-07) has to sign: it asks the person, who may not answer,
 * and some add-ons never say no. A phone app has its own time limit (`REQUEST_TIMEOUT_MS`,
 * src/account/session.ts), longer: the person may have to find their phone.
 */
export const SIGN_TIMEOUT_MS = 60_000;

/** How long the signer of a person signed in by `how` has to sign (`signInTime`'s `within`): an add-on 60 seconds; a phone app its own. */
export const signTimeFor = (how: How): number | undefined => (how === "browser" ? SIGN_TIMEOUT_MS : undefined);

/** The signer did not sign within the time it was given (`signInTime`). */
export class NotSignedInTime extends Error {
  constructor() {
    super("The signer did not sign in time");
    this.name = "NotSignedInTime";
  }
}

/**
 * What `signer` signs of `template`, as the signer gives it: the caller checks that it is what was
 * asked for. `NotSignedInTime` once `within` milliseconds have passed without it; with no `within`,
 * the signer's own limit holds. Whatever the signer throws, as it is (the person said no); the
 * signal's reason when `signal` aborts first.
 */
export async function signInTime(
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
    if (clock.signal.aborted) throw new NotSignedInTime();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether two tags are the same, value by value. */
export const sameTag = (a: readonly string[], b: readonly string[] | undefined): boolean =>
  a.length === b?.length && a.every((value, i) => value === b[i]);

/** What a relay's refusal, or the end of its time, says, as text. */
export const reasonOf = (error: unknown): string =>
  error instanceof Error || error instanceof DOMException ? error.message : String(error);

/**
 * Whether a relay's failure to take an event may pass, so that it is worth sending again: its
 * connection closed or failed before it answered (`writerFor`'s `NetworkError`), or it refused the
 * event for a fault of its own (`error:`) or for now (`rate-limited:`), as NIP-01's prefixes say. Any
 * other refusal is its answer, and final: `blocked:`, `invalid:`, `replaced:`, `pow:`, `restricted:`,
 * `auth-required:`, another prefix, or none.
 */
export function mayPass(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "NetworkError";
  return error instanceof Error && /^(?:error|rate-limited):/.test(error.message);
}

/** A signal that aborts with a TimeoutError once `ms` milliseconds have passed, and `stop`, which clears its timer. */
export function timeLimit(ms: number): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The relay did not answer in time", "TimeoutError")), ms);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

/** One try at sending an event to a relay: taken (null), or why not, whether that may pass (`mayPass`), and whether its signal stopped it. */
export type Tried = { reason: string; mayPass: boolean; stopped: boolean } | null;

/**
 * One try at sending `event` to the relay at `url`, with a writer of its own from `writers` (the
 * app's opens a connection for it, and closes it when the try ends), until `signal` aborts (a writer
 * that does not stop then is stopped waiting for). Null when the relay took it; else why not.
 */
export async function tryOnce(url: string, event: NostrEvent, writers: Writers, signal: AbortSignal): Promise<Tried> {
  try {
    await abortable(Promise.resolve().then(() => writers(url).publish(event, signal)), signal);
    return null;
  } catch (error) {
    return { reason: reasonOf(error), mayPass: mayPass(error), stopped: signal.aborted };
  }
}

/**
 * Sends `event` to the relay at `url`: one try (`tryOnce`), of `PUBLISH_TIMEOUT_MS`, until `signal`
 * aborts. Null when it took it; else why not, stopped when its time ran out or `signal` aborted.
 * Nothing is logged.
 */
export async function sendOnce(url: string, event: NostrEvent, writers: Writers, signal: AbortSignal): Promise<Tried> {
  const limit = timeLimit(PUBLISH_TIMEOUT_MS);
  try {
    return await tryOnce(url, event, writers, AbortSignal.any([signal, limit.signal]));
  } finally {
    limit.stop();
  }
}
