import type { NostrEvent } from "@nostrify/nostrify";
import { verifyEvent } from "nostr-tools/pure";

/*
 * A check of the signatures of a fresh list of places, by sample. The places relay is read with its
 * checks off (./relayReader.ts): checking all 7,954 took 6.7 s on a desktop. A sample costs little and
 * catches a relay that serves forged places in any number; when one of it fails, every one is checked,
 * and each that fails is left out. One forged place among thousands can pass: that is the sample's
 * price. The checks run on the page, in slices, so the page is never held up long at a time.
 * ./store.tsx loads this module as it loads the relay's code, so neither it nor nostr-tools' signature
 * code is in the first screen's.
 */

/** How long one slice of checks may run before the page has its turn, in milliseconds. */
export const SLICE_MS = 8;

export interface SignatureCheck {
  /** The events, in their order, less each whose signature failed. */
  events: NostrEvent[];
  /** How many signatures were checked. */
  checked: number;
  /** How many failed. */
  failed: number;
}

/**
 * `size` distinct positions of a list of `count`, picked at random (all of them when the list is no
 * longer): the first `size` of a shuffle (Fisher and Yates'), stopped there. `random` is in [0, 1).
 */
function pick(count: number, size: number, random: () => number): number[] {
  const positions = Array.from({ length: count }, (_, i) => i);
  const picked = Math.min(size, count);
  for (let i = 0; i < picked; i++) {
    const j = i + Math.floor(random() * (count - i));
    [positions[i], positions[j]] = [positions[j]!, positions[i]!];
  }
  return positions.slice(0, picked);
}

/**
 * Waits for the page to have had its turn: until the browser is idle (at most 50 ms), or the next
 * task where it cannot say (Safari). Rejects with the signal's reason when it aborts.
 */
function pageTurn(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let cancel: () => void;
    const onAbort = () => {
      cancel();
      reject(signal.reason);
    };
    const go = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(go, { timeout: 50 });
      cancel = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(go, 0);
      cancel = () => clearTimeout(id);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Checks the events at `positions`, in slices of at most `SLICE_MS`, and notes each result in `results`. */
async function checkEach(
  events: readonly NostrEvent[],
  positions: readonly number[],
  results: Map<number, boolean>,
  verify: (event: NostrEvent) => boolean,
  signal: AbortSignal,
): Promise<void> {
  let sliceStart = Number.NEGATIVE_INFINITY;
  for (const at of positions) {
    if (performance.now() - sliceStart >= SLICE_MS) {
      await pageTurn(signal);
      sliceStart = performance.now();
    }
    signal.throwIfAborted();
    results.set(at, verify(events[at]!));
  }
}

/**
 * Checks the signatures of `sample` of `events` (a fresh list from the relay), picked at random, and
 * all of them when one of those fails. Gives back the events less each that failed; the whole list,
 * the same array, when none did. A sample of 0 checks none. Rejects with the signal's reason when it
 * aborts. `verify` and `random` are nostr-tools' check and Math.random, unless a test gives others.
 */
export async function checkSignatures(
  events: NostrEvent[],
  {
    sample,
    signal,
    verify = verifyEvent,
    random = Math.random,
  }: { sample: number; signal: AbortSignal; verify?: (event: NostrEvent) => boolean; random?: () => number },
): Promise<SignatureCheck> {
  const results = new Map<number, boolean>();
  await checkEach(events, pick(events.length, sample, random), results, verify, signal);
  if ([...results.values()].every(Boolean)) return { events, checked: results.size, failed: 0 };

  // One of the sample failed: the list cannot be trusted by sample. Check the rest too.
  const rest: number[] = [];
  for (let at = 0; at < events.length; at++) if (!results.has(at)) rest.push(at);
  await checkEach(events, rest, results, verify, signal);
  const kept = events.filter((_, at) => results.get(at) === true);
  return { events: kept, checked: results.size, failed: events.length - kept.length };
}
