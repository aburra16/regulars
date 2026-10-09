import { createContext, type JSX, type ReactNode, type RefObject, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import type { View } from "../view/ViewProvider.tsx";
import { type CircleState, useCircle } from "./CircleProvider.tsx";

/*
 * The door to My circle (Avi, 2026-10-08): before the person's circle is asked for, My circle's half
 * of the toggle is the way to Personalize. Tapping it opens a small panel under that toggle, with what
 * Personalize offers then: in off, decision 26's line and Personalize; when Brainstorm was busy, the
 * run failed or Brainstorm could not be reached, the line that says so and Try again. Opening or
 * closing the panel asks Brainstorm nothing: only Personalize or Try again does, as before.
 *
 * Where the page has its own panel, the toggles open that one, or move the focus to it: the phone's
 * Explore, whose Personalize under the toggle waits to be opened, and the Why page, which explains My
 * circle and keeps Personalize in view. Elsewhere (the desktop's top bar, the phone's map), the toggle
 * opens a panel of its own, floating under it. One panel is open at a time on a page, and none once
 * the person goes to another page.
 */

/** The states in which My circle's half is the door: the circle is not asked for, or asking for it ended without one. */
export const DOOR_STATES: ReadonlySet<CircleState> = new Set<CircleState>(["off", "busy", "failed", "unavailable"]);

/** The page's own panel, which the door opens where the page has one: Personalize, on the phone's Explore and the Why page. */
export interface PagePanel {
  /** Its id, which the halves name as what they open (`aria-controls`). */
  id: string;
  /** Whether it offers Personalize (off) only once a half opens it (the phone's Explore); else it always does (the Why page). */
  waits: boolean;
  /** Puts the focus on its first button. */
  focus(): void;
}

/** A toggle's two buttons, for the focus to go back to. */
export interface Halves {
  house: RefObject<HTMLButtonElement | null>;
  circle: RefObject<HTMLButtonElement | null>;
}

export interface CircleDoorValue {
  /**
   * Whether My circle's half is the door now: My circle is open (`config.features.circle`), the person
   * is signed in, and their circle is off, busy, failed or unavailable.
   */
  door: boolean;
  /** The toggle whose half opened the panel, while it is open: its id. */
  openedBy: string | null;
  /** Opens the panel, from the half of the toggle `by`. */
  open(by: string): void;
  /**
   * Closes the panel. The focus goes to the toggle that opened it: to its half (`circle`: Not now,
   * Escape) or to House picks (`house`: Personalize, Try again, after which the half is off a while);
   * or, with neither, stays where it is (a tap elsewhere).
   */
  close(focus?: View): void;
  /** The page's own panel, while it has one. */
  pagePanel: PagePanel | null;
  /** Makes `panel` the page's own; gives back how to let it go. */
  setPagePanel(panel: PagePanel): () => void;
  /** Tells the door where the halves of the toggle `id` are, so that closing can put the focus on one; gives back how to forget them. */
  addToggle(id: string, halves: Halves): () => void;
}

const DoorContext = createContext<CircleDoorValue | null>(null);

/**
 * The door to My circle, for every toggle and Personalize on the page below it (`useCircleDoor`). It
 * must be inside the router, the account provider and the circle's provider. Another page closes the
 * panel, and so does the half no longer being the door (Personalize was tapped, or the person signed out).
 */
export function CircleDoorProvider({ children }: { children: ReactNode }): JSX.Element {
  const { account } = useAccount();
  const { state } = useCircle();
  const { pathname } = useLocation();
  const door = config.features.circle && account !== undefined && DOOR_STATES.has(state);
  const [openedBy, setOpenedBy] = useState<string | null>(null);
  const [pagePanel, setPanel] = useState<PagePanel | null>(null);

  // Another page: no panel is open on it.
  const [page, setPage] = useState(pathname);
  if (page !== pathname) {
    setPage(pathname);
    setOpenedBy(null);
  }
  // The half is no longer the door: there is nothing for the panel to offer.
  if (!door && openedBy !== null) setOpenedBy(null);

  // The toggles on the page, and the one that opened the panel last: what closing focuses is read as it closes.
  const toggles = useRef(new Map<string, Halves>());
  const opener = useRef<string | null>(null);

  const open = useCallback((by: string) => {
    opener.current = by;
    setOpenedBy(by);
  }, []);

  const close = useCallback((focus?: View) => {
    const halves = opener.current === null ? undefined : toggles.current.get(opener.current);
    if (focus !== undefined) halves?.[focus].current?.focus();
    setOpenedBy(null);
  }, []);

  const setPagePanel = useCallback((panel: PagePanel) => {
    setPanel(panel);
    return () => setPanel((now) => (now === panel ? null : now));
  }, []);

  const addToggle = useCallback((id: string, halves: Halves) => {
    toggles.current.set(id, halves);
    return () => {
      if (toggles.current.get(id) === halves) toggles.current.delete(id);
      // The toggle that opened the panel has gone (the window crossed between the layouts): so has the panel.
      setOpenedBy((now) => (now === id ? null : now));
    };
  }, []);

  const value = useMemo<CircleDoorValue>(
    () => ({ door, openedBy: door ? openedBy : null, open, close, pagePanel, setPagePanel, addToggle }),
    [door, openedBy, open, close, pagePanel, setPagePanel, addToggle],
  );
  return <DoorContext value={value}>{children}</DoorContext>;
}

/** The door to My circle. Use it inside a `CircleDoorProvider`. */
export function useCircleDoor(): CircleDoorValue {
  const value = useContext(DoorContext);
  if (value === null) throw new Error("useCircleDoor must be used inside <CircleDoorProvider>.");
  return value;
}
