import { type JSX, memo, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
import { openLine, openState } from "../places/hours.ts";
import type { Place } from "../places/place.ts";
import { HoursText } from "../ui/PlaceCard.tsx";
import { scriptLang } from "../ui/scriptLang.ts";

/**
 * What a location of a chain is known by: its street address, since its name is the chain's and the
 * same on every row. A place with no street address is known by its town, and then by its name.
 */
export const locationName = (place: Place): string => place.street ?? place.locality ?? place.name;

/**
 * A location in the chain's list (Chain.dc.html): its address, and at the top right, where its
 * score goes, that nobody has reviewed it yet; under it how far it is and whether it is open. The
 * whole row is one link to the place, named by the address, described by the rest. It is `memo`:
 * a chain can have hundreds of rows, and showing more of them does not draw those already there again.
 */
export const LocationRow = memo(function LocationRow({
  place,
  km,
  locale,
  now,
}: {
  place: Place;
  /** How far the location is from where the list is near, in kilometres. */
  km: number;
  locale: string;
  now: Date;
}): JSX.Element {
  const id = useId();
  const state = useMemo(() => openState(place, now), [place, now]);
  const distance = formatDistance(km, locale);
  const hours = openLine(state, locale, "card");
  // Hours the app could not read are the text as written, which can be any length: they get a line to be cut off on.
  const unread = state.kind === "unparsed";
  const name = locationName(place);

  return (
    <Link
      to={`/place/${encodeURIComponent(place.d)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-line ${unread ? `${id}-hours ` : ""}${id}-score`}
      className="flex flex-col gap-[5px] border-t-token border-line py-3.5 text-ink no-underline"
    >
      <div className="flex items-start justify-between gap-2.5">
        <span
          id={`${id}-name`}
          lang={scriptLang(name)}
          dir="auto"
          className="min-w-0 text-[17px] leading-[1.25] font-bold wrap-break-word"
        >
          {name}
        </span>
        <span id={`${id}-score`} className="shrink-0 pt-[3px] text-caption font-semibold whitespace-nowrap text-muted">
          {copy.score.noReviewsYet}
        </span>
      </div>
      <div id={`${id}-line`} className="text-secondary text-muted">
        {distance}
        {!unread && (
          <>
            {distance !== "" && copy.common.joiner}
            <HoursText state={state} line={hours} />
          </>
        )}
      </div>
      {unread && (
        <div id={`${id}-hours`} title={hours} className="truncate text-secondary text-muted">
          {hours}
        </div>
      )}
    </Link>
  );
});
