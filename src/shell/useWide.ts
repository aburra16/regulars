import { useSyncExternalStore } from "react";

/**
 * The one breakpoint: phone layouts below it, desktop layouts from it up. The `wide:` variant in
 * src/styles/index.css is the same width; tests/styles.test.ts checks that the two agree.
 */
export const WIDE_QUERY = "(min-width: 900px)";

/** The query list, made once for each `matchMedia` the page has (a test may swap it). */
let cached: { matchMedia: Window["matchMedia"]; list: MediaQueryList } | undefined;

function wideQuery(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  if (cached?.matchMedia !== window.matchMedia) {
    cached = { matchMedia: window.matchMedia, list: window.matchMedia(WIDE_QUERY) };
  }
  return cached.list;
}

function subscribe(onChange: () => void): () => void {
  const list = wideQuery();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

const isWide = (): boolean => wideQuery()?.matches ?? false;

/**
 * Whether the window is wide enough for the desktop layout. It reads the width only, never the
 * device or the browser, and changes as the window is resized. A browser without `matchMedia`
 * gets the phone layout.
 */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, isWide, () => false);
}
