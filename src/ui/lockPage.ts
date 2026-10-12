/** The element the app renders into, in index.html. Dialogs render beside it, into `document.body`. */
export const APP_ROOT_ID = "root";

/** How many dialogs hold the page, and how to put it back when the last one lets go. */
let holders = 0;
let restore: (() => void) | undefined;

/**
 * Locks the page behind a dialog: it stops scrolling, and the app's root becomes inert, so
 * neither a pointer nor the keyboard nor a screen reader can reach it. Returns the release; the
 * page is unlocked once every dialog that locked it has released it. A release only counts once.
 */
export function lockPage(): () => void {
  holders += 1;
  if (holders === 1) {
    const { body, documentElement } = document;
    const root = document.getElementById(APP_ROOT_ID);
    const before = {
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
      inert: root?.hasAttribute("inert") ?? false,
    };
    // Where the scroll bar takes room, keep that room, so the page does not shift sideways.
    const scrollBar = documentElement.clientWidth > 0 ? window.innerWidth - documentElement.clientWidth : 0;
    body.style.overflow = "hidden";
    if (scrollBar > 0) body.style.paddingRight = `${scrollBar}px`;
    root?.setAttribute("inert", "");
    restore = () => {
      body.style.overflow = before.overflow;
      body.style.paddingRight = before.paddingRight;
      if (!before.inert) root?.removeAttribute("inert");
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) {
      restore?.();
      restore = undefined;
    }
  };
}
