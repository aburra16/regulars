import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { Place } from "../places/place.ts";
import { cameFrom } from "../signin/returnTo.ts";
import { placePath } from "./paths.ts";

/**
 * The way from the review form back to the place's page (`to`), by its back arrow, its cross, Escape,
 * or once the review is posted: one step back in the history when the person came to the form from
 * the place, so the page is as they left it; else the place's page in place of the form (it was the
 * first page opened, or sign in replaced itself with it with nothing behind).
 */
export function useBackToPlace(place: Place): { to: string; back(): void } {
  const navigate = useNavigate();
  const { key, state } = useLocation();
  const to = placePath(place.d);
  const fromPlace = key !== "default" && cameFrom(state)?.pathname === to;
  const back = useCallback(() => {
    if (fromPlace) void navigate(-1);
    else void navigate(to, { replace: true });
  }, [navigate, fromPlace, to]);
  return { to, back };
}
