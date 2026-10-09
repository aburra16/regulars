import { createContext, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/*
 * Where the focus goes once the person goes to another page (a new pathname), for a screen reader and
 * a keyboard: to the new page's main heading, the `h1` in `main`, which each page makes focusable from
 * code only (`tabIndex={-1}`) and draws with no ring; or, when the address names a section of the page
 * (`/about#signing-in`), to that section's heading, made focusable the same way. The page is not
 * scrolled for it: Back puts a page where it was, and a new page opens at its top, or at the section,
 * as the router has them.
 *
 * It goes there when the focus went with the page before, or is still on the link that took the
 * person to the new page (a tab, a link in the top bar). Not on the first load, nor on what the first
 * load does by itself before the person has done anything (an old link to Recent, sent on to
 * Trending). Not when the new page puts the focus somewhere of its own as it comes in: a dialog's first
 * control, the search field opened from Explore, the control that opened a dialog when the dialog
 * closes. Not when the app put it somewhere on purpose just before the page changed, and the person
 * has done nothing since (`usePlaceFocus`: the account button that has just become theirs, as signing
 * in from You takes them on to Explore). Nor when it is somewhere else that stays: the field the person
 * is typing in (the desktop's search, in the top bar), or the × of the bar that tells them of their circle.
 */

/** What says the person has done something on the page: a press, a key, a click (a screen reader's too). */
const ACTS = ["pointerdown", "keydown", "click"] as const;

/** Where the app last put the focus on purpose (`usePlaceFocus`), until the person does something. */
export const PlacedFocus = createContext<RefObject<Element | null> | null>(null);

/**
 * Puts the focus on an element on purpose, without scrolling, where the next page's heading leaves it
 * (`useHeadingFocus`) until the person does something: for a focus the app moves just before the page
 * changes, which `ArrivalMark` cannot tell from one left behind. Outside the frame, it only focuses.
 */
export function usePlaceFocus(): (element: HTMLElement | null) => void {
  const placed = useContext(PlacedFocus);
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return;
      element.focus({ preventScroll: true });
      if (placed !== null) placed.current = element;
    },
    [placed],
  );
}

/**
 * Notes what has the focus as each new page goes in, into `at`. Drawn first in the frame, before the
 * page: React runs a commit's layout effects in the order of the tree, a component's children before
 * it, so this runs once the page before has gone from the document and before anything of the new one
 * runs. Whatever moves the focus after it, the new page did. It draws nothing.
 */
export function ArrivalMark({ at }: { at: RefObject<Element | null> }): null {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    at.current = document.activeElement;
  }, [pathname, at]);
  return null;
}

/**
 * Whether the focus, as it is, has nowhere of its own to be: it went with the page before (to the
 * body), or it is on a link, which took the person to the new page and is not what they are reading.
 */
function nowhere(active: Element | null): boolean {
  return active === null || active === document.body || active instanceof HTMLAnchorElement;
}

/** What a heading is. */
const HEADINGS = "h1, h2, h3, h4, h5, h6";

/**
 * The heading the focus goes to on a new page in `main`: the heading of the section the address's
 * `hash` names (itself, when it is one), when that is in the page and has one; else the page's `h1`.
 */
function headingOf(main: HTMLElement, hash: string): HTMLElement | null {
  let id = "";
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    // Not an id the page could have given: the page's own heading, then.
  }
  const named = id === "" ? null : document.getElementById(id);
  if (named !== null && main.contains(named)) {
    const heading = named.matches(HEADINGS) ? named : named.querySelector<HTMLElement>(HEADINGS);
    if (heading !== null) return heading;
  }
  return main.querySelector("h1");
}

/**
 * Moves the focus to the main heading of each new page in `main` (or of the section its address names), once it is in (`ready`: the frame
 * shows the page, not the places' loading line), when it is where it was as the page went in
 * (`arrival`, which `ArrivalMark` notes), that is nowhere of its own (`nowhere`), and the app did not
 * put it there on purpose (`placed`, which `usePlaceFocus` notes and the frame gives as `PlacedFocus`).
 * Call it in the component that draws `main` and the mark: its effects run after the page's.
 */
export function useHeadingFocus(
  main: RefObject<HTMLElement | null>,
  ready: boolean,
): { arrival: RefObject<Element | null>; placed: RefObject<Element | null> } {
  const { pathname, hash } = useLocation();
  const how = useNavigationType();
  const arrival = useRef<Element | null>(null);
  const placed = useRef<Element | null>(null);
  // Whether the person has done anything on the page yet. Back and Forward are theirs too.
  const acted = useRef(false);
  // The pathname whose page the focus was last settled for, and whether a new page's heading is due it.
  const settled = useRef(pathname);
  const due = useRef(false);

  // Anything the person does: they have acted, and where the app put the focus is theirs to move now.
  useEffect(() => {
    const note = () => {
      acted.current = true;
      placed.current = null;
    };
    for (const type of ACTS) document.addEventListener(type, note, true);
    return () => {
      for (const type of ACTS) document.removeEventListener(type, note, true);
    };
  }, []);

  useEffect(() => {
    if (settled.current !== pathname) {
      settled.current = pathname;
      due.current = acted.current || how === "POP";
    }
    if (!due.current || !ready) return;
    due.current = false;
    const active = document.activeElement;
    if (active !== arrival.current || !nowhere(active) || active === placed.current) return;
    if (main.current !== null) headingOf(main.current, hash)?.focus({ preventScroll: true });
  }, [pathname, hash, how, ready, main]);

  return { arrival, placed };
}
