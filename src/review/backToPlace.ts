import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { Place } from "../places/place.ts";
import { cameFrom } from "../signin/returnTo.ts";
import { placePath } from "./paths.ts";

/**
 * The way from the review form back to the place's page (`to`), by its back arrow, its cross, Escape,
 * or once the review is posted: one step back in the history when the person came to the form from
 * the place, so the page is as they left it; else the place's page in place of the form (it was the
 * first page opened, or sign in replaced itself with it with nothing behind).
 *
 * It goes once (ruling R15): a second way back before the form has gone (the arrow pressed twice, or
 * the review posted while the person is already going back) does nothing. Going twice would step
 * back past the place, or put the place in place of itself, losing where it came from.
 */
export function useBackToPlace(place: Place): { to: string; back(): void } {
  const navigate = useNavigate();
  const { key, state } = useLocation();
  const to = placePath(place.d);
  const fromPlace = key !== "default" && cameFrom(state)?.pathname === to;
  /** Whether the person is going back already: the form goes with this, so it is never set back. */
  const leaving = useRef(false);
  const back = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    if (fromPlace) void navigate(-1);
    else void navigate(to, { replace: true });
  }, [navigate, fromPlace, to]);
  return { to, back };
}
