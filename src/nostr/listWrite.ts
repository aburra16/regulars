import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";

import { abortable } from "../account/writeRelays.ts";
import { asEvent, type Writers } from "./events.ts";
import { sameTag, sendOnce } from "./send.ts";

/*
 * What the writers of a list that a person keeps as one replaceable record share, whatever its kind
 * (src/follow/change.ts writes a follow list, src/saved/change.ts a person's saved places): the
 * checks that what the signer returned is exactly what was built and a valid event, and the sending
 * of it to several relays at once, with how they answered. Saving such a list replaces the whole of
 * it in every app the person uses; what is built, when a write may be made and where it goes are
 * each writer's own. Nothing here loads Nostrify (its imports are types), nostr-tools' check of a
 * signature is fetched when it is first needed (`signatureCheck`), and nothing here is logged.
 */

/**
 * `signed` as an event of its seven fields, when it is exactly `template` signed by `pubkey`: the
 * same kind, time and `content`, and the same tags, each the same value for value, in the same
 * order, with none more and none fewer. Null otherwise. A review may carry a tag its signer adds
 * (src/review/post.ts); a list may not, as whatever is signed for one replaces the person's whole
 * list.
 */
export function exactly(signed: unknown, template: EventTemplate, pubkey: string): NostrEvent | null {
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
 * that check would refuse it while one that did not would keep it in their name.
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
export async function signatureCheck(signal: AbortSignal): Promise<((event: NostrEvent) => boolean) | null> {
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
export interface Sent {
  /** The relays that had taken it, in the order they were given. */
  took: string[];
  /** Whether one of them said it holds a newer list: then this one is not the newest everywhere, whoever took it. */
  newerElsewhere: boolean;
}

/**
 * Sends `event` to every one of `places` at once (`sendTo`), and resolves with what they did with
 * it: once every relay has answered or run out of time, or `settleMs` after the first took it,
 * whichever comes first. So no relay took it only once all have answered. A send still under way
 * when this resolves goes on to its own end, and `signal` still stops it; nothing it does then can
 * throw, and it leaves no timer behind.
 */
export function sendToAll(places: readonly string[], event: NostrEvent, writers: Writers, signal: AbortSignal, settleMs: number): Promise<Sent> {
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
        settle ??= setTimeout(done, settleMs);
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
