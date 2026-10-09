import { type JSX, memo, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
import { openLine, openState } from "../places/hours.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import type { ShownScore } from "../score/shown.ts";
import { KindTile } from "./KindTile.tsx";
import { HoursText } from "./PlaceCard.tsx";
import { NO_SCORE, ScoreFigure, WhoLine, whoLine } from "./ScoreSlot.tsx";
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
  /**
   * Where the place is, said in place of how far: "Prague, Czechia", for the search's places from
   * elsewhere, where a distance across an ocean says nothing. Default: the distance.
   */
  where?: string;
  /** The browser's language: it decides miles or kilometres, and the 12- or 24-hour clock. */
  locale: string;
  now: Date;
  /** The place's score from the view on screen (`ShownScore`). Default: none, "No reviews yet". */
  score?: ShownScore;
}

/**
 * What goes at the top right of a row, where a score goes (Search.dc.html, Chain.dc.html): the
 * score; "No score yet" for a place with reviews and no score; "No reviews yet" for one nobody has;
 * nothing while its reviews are being read or counted, when they couldn't be loaded, or when House
 * picks can't be worked out, which the line under it says.
 */
export function RowScore({ id, score }: { id: string; score: ShownScore }): JSX.Element | null {
  if (score.kind === "scored") return <ScoreFigure id={id} score={score.score} size="row" />;
  if (score.kind !== "none" && score.kind !== "unscored") return null;
  return (
    <span id={id} className="shrink-0 pt-[3px] text-caption font-semibold whitespace-nowrap text-muted">
      {score.kind === "none" ? copy.score.noReviewsYet : copy.score.noScoreYet}
    </span>
  );
}

/** Whether `RowScore` draws anything for `score`. */
export const hasRowScore = (score: ShownScore): boolean =>
  score.kind === "scored" || score.kind === "none" || score.kind === "unscored";

/**
 * A place in the search results (Search.dc.html): the compact form of the card, a row with a line
 * under it. Its kind on a small tile, its name (two lines at most), what it is, how far (or where it
 * is) and whether it is open on one line, at the top right where a score goes its score (or that it
 * has none), and under it who the score comes from. The whole row is one link to the place; the link
 * is named by the place's name, and the rest is its description. It is `memo`: a list drawn again for
 * another place's score does not draw this row again unless its own changed.
 */
export const PlaceRow = memo(function PlaceRow({
  place,
  km,
  from = "list",
  where,
  locale,
  now,
  score = NO_SCORE,
}: PlaceRowProps): JSX.Element {
  const id = useId();
  const state = useMemo(() => openState(place, now), [place, now]);
  const distance = formatDistance(km, locale);
  const kindLine = copy.explore.kindLine(
    placeKindLabel(place.category, place.cuisine),
    where ?? (from === "place" && distance !== "" ? copy.place.fromHere(distance) : distance),
  );
  const hoursLine = openLine(state, locale, "card");
  // Hours the app could not read are the text as written, which can be any length: they get a line to be cut off on.
  const unread = state.kind === "unparsed";
  const line = whoLine(score);
  const describedBy = [`${id}-kind`, unread && `${id}-hours`, hasRowScore(score) && `${id}-score`, line && `${id}-who`]
    .filter(Boolean)
    .join(" ");

  return (
    <Link
      to={`/place/${encodeURIComponent(place.d)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={describedBy}
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
          <RowScore id={`${id}-score`} score={score} />
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
        {line !== undefined && <WhoLine id={`${id}-who`} line={line} />}
      </div>
    </Link>
  );
});
