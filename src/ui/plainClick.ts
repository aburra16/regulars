import type { MouseEvent } from "react";

/** A click that is the link's own to handle: a new tab or window is the browser's, with the link's address as it is. */
export const isPlainClick = (event: MouseEvent<HTMLElement>): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
