import type { JSX } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { Attribution } from "./Attribution.tsx";

/**
 * Where the place details come from, and a link to the page that says more (DeskExplore.dc.html,
 * PlaceNew.dc.html): at the foot of every page that shows places. The line wraps; the link goes
 * after it, on the same line when there is room.
 */
export function DetailsCredit({ className = "" }: { className?: string }): JSX.Element {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-1 text-caption text-muted ${className}`}>
      <Attribution kind="details" />
      {/* A link on its own, so a target 24 px tall or more: 6 px above and below its line, taken back by
          as much margin, so its words sit where they would. */}
      <Link to="/about" className="-my-1.5 py-1.5 font-semibold text-ink underline hover:text-accent">
        {copy.common.aboutData}
      </Link>
    </div>
  );
}
