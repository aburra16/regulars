/*
 * What the app needs of the browser that some of the browsers it supports do not have. main.tsx
 * imports this module before any other, so it is in place before anything uses it.
 */

/**
 * `AbortSignal.any`, as the browsers that have it do it: a signal that aborts when the first of
 * `signals` does, with that one's reason, and at once when one is aborted already. Safari has it
 * from 17.4; Nostrify's relay and the places' reader both use it, so without it on iOS 16.4 to
 * 17.3 the places would never load.
 */
export function abortSignalAny(signals: Iterable<AbortSignal>): AbortSignal {
  const controller = new AbortController();
  const list = [...signals];
  const already = list.find((signal) => signal.aborted);
  if (already !== undefined) {
    controller.abort(already.reason);
    return controller.signal;
  }
  for (const signal of list) {
    // Once the combined signal has aborted, each of these listeners is taken off again.
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}

if (typeof AbortSignal.any !== "function") AbortSignal.any = abortSignalAny;
