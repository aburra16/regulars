/*
 * Whether the browser has an add-on to sign in with: one that puts `window.nostr` on the page
 * (NIP-07). Where it has, signing in is one tap (decision 23): Continue, Rate this place or the
 * account button asks it at once. Some add-ons put themselves on the page a moment after it loads, so
 * the sign-in page looks again, briefly, before it decides which way Continue goes (`lookForAddOn`).
 * This module loads nothing of Nostrify: the first screen asks it.
 */

/** How long after the page loads an add-on may still put itself on it: the sign-in page looks until then, at most half a second. */
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
 * How long ago the page loaded, in milliseconds: from the end of its document's loading (when an
 * add-on puts itself on the page), both against the start of its navigation. A document still loading
 * (a slow network: the browser has not said it is done) has just loaded: 0, and the look runs. Where
 * the browser says nothing of the navigation, from its start. A page reached by a link in the app
 * loaded long before.
 */
export function msSinceLoad(): number {
  if (typeof performance === "undefined") return Number.POSITIVE_INFINITY;
  const navigation = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation === undefined) return performance.now();
  if (navigation.domContentLoadedEventEnd <= 0) return 0;
  return performance.now() - navigation.domContentLoadedEventEnd;
}

/** Whether a blocked script has been said in the console, once a page. */
let saidBlocked = false;

/** An address's scheme ("chrome-extension:"), or what a browser names in its place ("inline"). Never the rest. */
function schemeOf(address: string): string {
  try {
    return new URL(address).protocol;
  } catch {
    return /^[a-z-]+$/.test(address) ? address : "unknown";
  }
}

/**
 * While `signal` has not aborted, says once in the console when the page's Content Security Policy
 * (tools/csp.ts) blocks a script: most likely an add-on's that writes itself into the page as text, or
 * comes from where the policy does not let scripts in, so that it never puts `window.nostr` on the
 * page and signing in finds no add-on. Only the address's scheme is said: the rest can tell which
 * add-on it is. The sign-in page and the sign-in where the person is watch while they are open.
 */
export function watchForBlockedAddOn(signal: AbortSignal): void {
  if (typeof document === "undefined" || signal.aborted) return;
  const onViolation = (event: Event) => {
    const { effectiveDirective, blockedURI } = event as SecurityPolicyViolationEvent;
    // A script element's, by the directive that blocked it (script-src where a browser does not split it).
    const script = effectiveDirective === "script-src-elem" || (effectiveDirective === "script-src" && blockedURI !== "eval");
    if (!script || saidBlocked) return;
    saidBlocked = true;
    console.warn(`[signin] the page's policy blocked an add-on's script: ${schemeOf(blockedURI)}`);
  };
  document.addEventListener("securitypolicyviolation", onViolation);
  signal.addEventListener("abort", () => document.removeEventListener("securitypolicyviolation", onViolation), { once: true });
}

/** For tests: as if no blocked script had been said yet. */
export function forgetBlockedAddOn(): void {
  saidBlocked = false;
}

/**
 * Looks for the browser's add-on: at once, then every `ADD_ON_CHECK_MS` and whenever the window gets
 * the focus, until it is there (true) or `ADD_ON_WAIT_MS` have passed since the page loaded (false):
 * for a page that loaded `loadedAgo` ms ago, what is left of them, and for one that loaded longer ago,
 * no time at all. When `signal` aborts it ends with what the page has then. Nothing of it is left
 * running once it ends.
 */
export function lookForAddOn(signal: AbortSignal, loadedAgo: number = msSinceLoad()): Promise<boolean> {
  return new Promise((resolve) => {
    if (hasAddOn()) return resolve(true);
    const left = ADD_ON_WAIT_MS - loadedAgo;
    if (signal.aborted || left <= 0) return resolve(false);
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
    const deadline = setTimeout(stop, left);
    window.addEventListener("focus", check);
    signal.addEventListener("abort", stop, { once: true });
  });
}
