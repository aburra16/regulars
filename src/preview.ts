/*
 * The preview switch (ruling R39): how one browser is shown what the app ships with off. Follow is
 * behind it. A production build has Follow off until its live check with the owner has passed, as a
 * follow list is one record that a mistake can wipe; it is on only in a browser that was opened once
 * at an address of the app with `?preview=follow`, which the browser then keeps. `?preview=follow-off`
 * lets go of it. No page says any of this.
 *
 * The config reads it as it loads (src/config.ts): before anything is drawn, and before the router
 * reads the address. So the page the switch came with has Follow already, and no page sees the
 * parameter. Nothing here loads anything else, and nothing is logged.
 */

/** Where a browser keeps that it previews Follow, in `localStorage`: "on", or nothing. */
export const FOLLOW_PREVIEW_KEY = "regulars.preview.follow";

/** The switch as an address carries it, whole: one parameter, written so and no other way. */
const TURN_ON = "preview=follow";
const TURN_OFF = "preview=follow-off";

/**
 * Does what the page's address says of the switch, and takes that one parameter out of it: every
 * other parameter stays as it was written and in its order, with the path, the section (the hash)
 * and what the history holds for the page. Nothing for an address with no switch in it, which
 * another value of `preview` is not. A browser that will not keep the switch keeps none: the
 * parameter goes all the same.
 */
function takeSwitch(): void {
  const { pathname, search, hash } = window.location;
  const parameters = search.replace(/^\?/, "").split("&");
  const rest = parameters.filter((parameter) => parameter !== TURN_ON && parameter !== TURN_OFF);
  if (rest.length === parameters.length) return;
  for (const parameter of parameters) {
    try {
      if (parameter === TURN_ON) window.localStorage.setItem(FOLLOW_PREVIEW_KEY, "on");
      else if (parameter === TURN_OFF) window.localStorage.removeItem(FOLLOW_PREVIEW_KEY);
    } catch {
      // Storage blocked or full: nothing is kept, and Follow stays off.
    }
  }
  window.history.replaceState(window.history.state, "", `${pathname}${rest.length > 0 ? `?${rest.join("&")}` : ""}${hash}`);
}

/**
 * Whether this browser previews Follow: the switch in the page's address is taken first
 * (`takeSwitch`), and then it is what the browser keeps. False where it keeps nothing, where what it
 * keeps cannot be read (storage blocked: reading it throws), and where there is no browser. It
 * never throws.
 */
export function previewsFollow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    takeSwitch();
  } catch {
    // An address that could not be read or written again: what the browser keeps still decides.
  }
  try {
    return window.localStorage.getItem(FOLLOW_PREVIEW_KEY) === "on";
  } catch {
    return false;
  }
}
