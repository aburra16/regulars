import { type JSX, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
import { openLine, openState } from "../places/hours.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { KindTile } from "./KindTile.tsx";
import { HoursText } from "./PlaceCard.tsx";
import { scriptLang } from "./scriptLang.ts";

export interface PlaceRowProps {
  place: Place;
  /** How far the place is from where the list is near, in kilometres. */
  km: number;
  /**
   * What `km` is measured from: where the list is near ("Cafe · 0.3 mi"), or the place whose page
   * the row is on, which the row says ("Cafe · 0.3 mi from here", PlaceNew.dc.html). Default `list`.
   */
  from?: "list" | "place";
  /** The browser's language: it decides miles or kilometres, and the 12- or 24-hour clock. */
  locale: string;
  now: Date;
}

/**
 * A place in the search results (Search.dc.html): the compact form of the card, a row with a line
 * under it. Its kind on a small tile, its name (two lines at most), what it is, how far and whether
 * it is open on one line, and, at the top right where a score goes, that nobody has reviewed it
 * yet. The whole row is one link to the place; the link is named by the place's name, and the rest
 * is its description.
 */
export function PlaceRow({ place, km, from = "list", locale, now }: PlaceRowProps): JSX.Element {
  const id = useId();
  const state = useMemo(() => openState(place, now), [place, now]);
  const distance = formatDistance(km, locale);
  const kindLine = copy.explore.kindLine(
    placeKindLabel(place.category, place.cuisine),
    from === "place" && distance !== "" ? copy.place.fromHere(distance) : distance,
  );
  const hoursLine = openLine(state, locale, "card");
  // Hours the app could not read are the text as written, which can be any length: they get a line to be cut off on.
  const unread = state.kind === "unparsed";

  return (
    <Link
      to={`/place/${encodeURIComponent(place.d)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-kind ${unread ? `${id}-hours ` : ""}${id}-score`}
      className="flex gap-3 border-b-token border-line py-3.5 text-ink no-underline"
    >
      <KindTile category={place.category} size="row" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2.5">
          <span
            id={`${id}-name`}
            lang={scriptLang(place.name)}
            dir="auto"
            className="line-clamp-2 min-w-0 font-display text-[18px] leading-[1.2] font-bold wrap-break-word"
          >
            {place.name}
          </span>
          <span id={`${id}-score`} className="shrink-0 pt-[3px] text-caption font-semibold whitespace-nowrap text-muted">
            {copy.score.noReviewsYet}
          </span>
        </div>
        <div id={`${id}-kind`} className="text-secondary text-pretty text-muted">
          {kindLine}
          {!unread && (
            <>
              {copy.common.joiner}
              <HoursText state={state} line={hoursLine} />
            </>
          )}
        </div>
        {unread && (
          <div id={`${id}-hours`} title={hoursLine} className="truncate text-secondary text-muted">
            {hoursLine}
          </div>
        )}
      </div>
    </Link>
  );
}
