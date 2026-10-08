import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { useHere } from "./useLocation.ts";

/**
 * Says why the places are not near the person, when they asked to be found and were not: they
 * said no, or the browser could not. It says nothing otherwise. Put it under the "Near" control.
 */
export function LocationNotice(): JSX.Element | null {
  const here = useHere();
  let text: string;
  if (here.denied) {
    // The places are still where they were: the default city, a city the person picked, or where they had been found.
    text = copy.location.denied(here.source === "device" ? copy.location.lastKnown : here.label);
  } else if (here.unavailable) {
    text = copy.location.unavailable;
  } else {
    return null;
  }
  return (
    <p role="status" className="m-0 text-secondary leading-[1.4] text-muted">
      {text}
    </p>
  );
}
