import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { useHere } from "./useLocation.ts";

/**
 * Says why the places are not near the person, when they asked to be found and were not: they
 * said no, or the browser could not. Put it under the "Near" control. It is a status region that
 * is always there and empty until it has something to say, because a screen reader announces a
 * change to a region it already knows, not a region that arrives with its words. `className`
 * places the region; it takes no room while it is empty.
 */
export function LocationNotice({ className }: { className?: string }): JSX.Element {
  const here = useHere();
  let text: string | undefined;
  if (here.denied) {
    // The places are still where they were: the default city, a city the person picked, or where they had been found.
    text = copy.location.denied(here.source === "device" ? copy.location.lastKnown : here.label);
  } else if (here.unavailable) {
    text = copy.location.unavailable;
  }
  return (
    <div role="status" data-testid="location-status" className={className}>
      {text !== undefined && <p className="m-0 text-secondary leading-[1.4] text-muted">{text}</p>}
    </div>
  );
}
