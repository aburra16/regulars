import { useSyncExternalStore } from "react";

/**
 * The locale of a browser that does not say: it reads distances in miles, as the US does, where the
 * device's time zone does not say otherwise.
 */
const FALLBACK = "en-US";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

const current = (): string => navigator.language || FALLBACK;

/**
 * The browser's language, such as "pt-PT": it decides whether times read on a 12- or 24-hour clock,
 * and whether distances read in miles or kilometres where the device's time zone does not
 * (`readsMiles`). It follows the person's setting if they change it.
 */
export function useLocale(): string {
  return useSyncExternalStore(subscribe, current, () => FALLBACK);
}
