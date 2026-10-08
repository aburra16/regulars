/*
 * Whether the browser has an add-on to sign in with: one that puts `window.nostr` on the page
 * (NIP-07). Where it has, signing in is one tap (decision 23): Continue, or Rate this place, asks it
 * at once. Some add-ons put themselves on the page a moment after it loads, so the sign-in page looks
 * again, briefly, before it decides which way Continue goes (`lookForAddOn`). This module loads
 * nothing of Nostrify: the first screen asks it.
 */

/** How long the sign-in page looks for an add-on that comes late, from when it opens: at most half a second. */
export const ADD_ON_WAIT_MS = 500;

/** How often it looks in that time. */
export const ADD_ON_CHECK_MS = 100;

/** Whether the browser has an add-on to sign in with: something on the page that can say who the person is. */
export function hasAddOn(): boolean {
  if (typeof window === "undefined") return false;
  const nostr = (window as { nostr?: { getPublicKey?: unknown } }).nostr;
  return typeof nostr?.getPublicKey === "function";
}

/**
 * Looks for the browser's add-on: at once, then every `ADD_ON_CHECK_MS` and whenever the window gets
 * the focus, until it is there (true) or `ADD_ON_WAIT_MS` have passed (false). When `signal` aborts it
 * ends with what the page has then. Nothing of it is left running once it ends.
 */
export function lookForAddOn(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (hasAddOn()) return resolve(true);
    if (signal.aborted) return resolve(false);
    const end = (found: boolean) => {
      clearInterval(every);
      clearTimeout(deadline);
      window.removeEventListener("focus", check);
      signal.removeEventListener("abort", stop);
      resolve(found);
    };
    const check = () => {
      if (hasAddOn()) end(true);
    };
    const stop = () => end(hasAddOn());
    const every = setInterval(check, ADD_ON_CHECK_MS);
    const deadline = setTimeout(stop, ADD_ON_WAIT_MS);
    window.addEventListener("focus", check);
    signal.addEventListener("abort", stop, { once: true });
  });
}
