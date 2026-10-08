import { useSyncExternalStore } from "react";

/** The locale of a browser that does not say: it reads distances in miles, as the US does. */
const FALLBACK = "en-US";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

const current = (): string => navigator.language || FALLBACK;

/**
 * The browser's language, such as "pt-PT": it decides whether distances read in miles or
 * kilometres, and whether times read on a 12- or 24-hour clock. It follows the person's setting
 * if they change it.
 */
export function useLocale(): string {
  return useSyncExternalStore(subscribe, current, () => FALLBACK);
}
