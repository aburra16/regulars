import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { stepsBackToExplore } from "../explore/returnPoint.ts";
import { usePlaces } from "../places/store.tsx";
import { useIndexes } from "../places/useIndexes.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { PageMessage, primaryButton } from "./Banner.tsx";
import { isPlainClick } from "./plainClick.ts";

/**
 * A place or a chain that is not on the list: it came off the map at the monthly refresh, or the link
 * is wrong. The way back goes to the Explore the person left, when there is one behind this page.
 */
export function NotListed(): JSX.Element {
  useDocumentTitle(copy.titles.notListed);
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-gutter-phone py-16 text-center wide:px-gutter-desktop">
      <h1 className="m-0 font-display text-h2 font-bold">{copy.place.noLongerListed}</h1>
      <p className="m-0 max-w-[36ch] text-body leading-[1.5] text-ink-soft">{copy.place.noLongerListedDetail}</p>
      <Link
        to="/"
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          const steps = stepsBackToExplore();
          if (steps === undefined) return;
          event.preventDefault();
          void navigate(steps);
        }}
        className={`${primaryButton} mt-2`}
      >
        {copy.place.backToExplore}
      </Link>
    </div>
  );
}

/**
 * What a page of a place or a chain shows when the list has not got it: the loading line while the
 * latest list may still, otherwise "No longer listed". The places on screen may be the ones saved on
 * this device, and the latest, still on its way, may have what is asked for; a place new to it is not
 * off the map.
 */
export function NotListedOrLoading(): JSX.Element {
  const indexes = useIndexes();
  const { source, error } = usePlaces();
  if (indexes === undefined || (source === "cache" && error === undefined)) {
    return <PageMessage>{copy.load.loading}</PageMessage>;
  }
  return <NotListed />;
}
