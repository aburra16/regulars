import { createContext, type JSX, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { useCircle } from "../circle/CircleProvider.tsx";
import { config } from "../config.ts";

/** Whose scores the screens show: the house curator's view, or the person's own circle. */
export type View = "house" | "circle";

/** Where the view is kept for the session, in `sessionStorage`. */
export const VIEW_STORAGE_KEY = "regulars.view";

export interface ViewValue {
  view: View;
  /** Changes the view for every screen, and keeps it for the session. */
  setView(view: View): void;
}

const ViewContext = createContext<ViewValue | null>(null);

/** The view kept for this session. Until My circle opens, everyone sees House picks (decisions.md #6). */
function readView(): View {
  try {
    const kept = window.sessionStorage.getItem(VIEW_STORAGE_KEY);
    return kept === "circle" && config.features.circle ? "circle" : "house";
  } catch {
    // Storage that is blocked: start from House picks.
    return "house";
  }
}

/**
 * The view, for every screen below it, so the toggles on the top bar, the map and a place page
 * agree. It is state only: which scores to show is up to each screen. It starts at House picks.
 * My circle can be the view only while it is open and the person's circle is ready (`useCircle`):
 * otherwise the view is House picks, and when the circle goes (the person signs out) House picks is
 * kept, so that My circle never comes back by itself.
 */
export function ViewProvider({ children }: { children: ReactNode }): JSX.Element {
  const { ready } = useCircle();
  const usable = config.features.circle && ready;
  const [chosen, setChosen] = useState<View>(readView);
  const setView = useCallback((next: View) => {
    setChosen(next);
    try {
      window.sessionStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Blocked or full. The view still holds until the page is closed.
    }
  }, []);
  useEffect(() => {
    if (!usable && chosen === "circle") setView("house");
  }, [usable, chosen, setView]);
  const view: View = usable ? chosen : "house";
  const value = useMemo(() => ({ view, setView }), [view, setView]);
  return <ViewContext value={value}>{children}</ViewContext>;
}

/** The view, and how to change it. Use it inside a `ViewProvider`. */
export function useView(): ViewValue {
  const value = useContext(ViewContext);
  if (value === null) throw new Error("useView must be used inside <ViewProvider>.");
  return value;
}

/**
 * The view the screens show, for what only reads it: the scores and the words that go with them.
 * House picks outside a `ViewProvider`, as everyone starts there (a test of part of the app has none).
 */
export function useCurrentView(): View {
  return useContext(ViewContext)?.view ?? "house";
}
