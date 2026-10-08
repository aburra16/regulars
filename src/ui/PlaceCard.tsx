import { type JSX, memo, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
import { type OpenState, openLine, openState } from "../places/hours.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import type { ShownScore } from "../score/shown.ts";
import { KindTile } from "./KindTile.tsx";
import { NO_SCORE, ScoreFigure, WhoLine, whoLine } from "./ScoreSlot.tsx";
import { scriptLang } from "./scriptLang.ts";

export interface PlaceCardProps {
  place: Place;
  /** How far the place is from where the list is near, in kilometres. */
  km: number;
  /**
   * `unrated-dashed` is a place others have rated, with no score, in a list that has places with
   * scores: a dashed edge and "No score yet" at the top right, where the score would be
   * (Main.dc.html). Every other card is `normal`.
   */
  variant: "normal" | "unrated-dashed";
  /**
   * The place's score from the view on screen (`ShownScore`): at the top right when it has one, and
   * under the hours, where the line about who rated it goes, who it comes from. With none, a normal
   * card says nobody has reviewed the place yet ("No reviews yet"). Default: none.
   */
  score?: ShownScore;
  /** The browser's language: it decides miles or kilometres, and the 12- or 24-hour clock. */
  locale: string;
  now: Date;
  /** The card of the pin chosen on the map: a heavier edge in the ink colour (DeskExplore.dc.html). */
  selected?: boolean;
  /** The card docked over the phone's map (Map.dc.html): white, with no edge but a shadow. */
  onMap?: boolean;
}

/** The edge of a card: 1.5 px line colour, dashed for an unrated place, 2 px ink when chosen; none over the map, which has a shadow. */
function edge(variant: PlaceCardProps["variant"], selected: boolean, onMap: boolean): string {
  if (onMap) return "bg-ground shadow-card-over-map";
  if (selected) return "border-2 border-ink";
  return variant === "unrated-dashed" ? "border-token border-dashed border-line-dashed" : "border-token border-line";
}

/**
 * The words about the hours, as part of a line. An open or closed place has that word first, in
 * bold ("Open until 11 pm"); the copy puts it first in every line of those two states. Any other
 * line is as it is.
 */
export function HoursText({ state, line }: { state: OpenState; line: string }): JSX.Element {
  if (state.kind !== "open" && state.kind !== "closed") return <>{line}</>;
  const space = line.indexOf(" ");
  const word = space === -1 ? line : line.slice(0, space);
  return (
    <>
      <span className="font-bold text-ink">{word}</span>
      {space === -1 ? "" : line.slice(space)}
    </>
  );
}

/**
 * The line about the hours. Hours the app could not read are the text as the relay gave it, which
 * can be any length: one line, cut off, with the whole of it in the tooltip.
 */
function HoursLine({ id, state, line }: { id: string; state: OpenState; line: string }): JSX.Element {
  if (state.kind === "unparsed") {
    return (
      <div id={id} title={line} className="truncate text-secondary text-muted">
        {line}
      </div>
    );
  }
  return (
    <div id={id} className="text-secondary text-muted">
      <HoursText state={state} line={line} />
    </div>
  );
}

/**
 * A place in a list (Main.dc.html): its kind on a tile, its name and its score, what it is and how
 * far, and whether it is open; then the line about who rated it, or that nobody has yet. The whole
 * card is one link to the place; the link is named by the place's name, and the rest is its
 * description. It is `memo`: a list drawn again for another place's score does not draw this card
 * again unless its own changed.
 */
export const PlaceCard = memo(function PlaceCard({
  place,
  km,
  variant,
  locale,
  now,
  selected = false,
  onMap = false,
  score = NO_SCORE,
}: PlaceCardProps): JSX.Element {
  const id = useId();
  const state = useMemo(() => openState(place, now), [place, now]);
  const kindLine = copy.explore.kindLine(placeKindLabel(place.category, place.cuisine), formatDistance(km, locale));
  const hoursLine = openLine(state, locale, "card");
  const dashed = variant === "unrated-dashed";
  // At the top right: the score, or, on a dashed card, that it has none yet.
  const top = score.kind === "scored" || dashed;
  // Under the hours: who the score comes from, or why there is none; "No reviews yet" on a normal card nobody has reviewed.
  const line = whoLine(score) ?? (score.kind === "none" && !dashed ? { text: copy.score.noReviewsYet, house: false } : undefined);
  const describedBy = [`${id}-kind`, `${id}-hours`, top && `${id}-score`, line && `${id}-who`].filter(Boolean).join(" ");

  return (
    <Link
      to={`/place/${encodeURIComponent(place.d)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={describedBy}
      className={`flex gap-3.5 rounded-card p-3.5 text-ink no-underline ${edge(variant, selected, onMap)}`}
    >
      <KindTile category={place.category} size="card" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2.5">
          <span
            id={`${id}-name`}
            lang={scriptLang(place.name)}
            dir="auto"
            className="line-clamp-2 min-w-0 font-display text-card-title leading-[1.2] font-bold wrap-break-word"
          >
            {place.name}
          </span>
          {score.kind === "scored" ? (
            <ScoreFigure id={`${id}-score`} score={score.score} size="card" />
          ) : (
            dashed && (
              <span id={`${id}-score`} className="shrink-0 pt-1 text-caption font-semibold whitespace-nowrap text-muted">
                {copy.score.noScoreYet}
              </span>
            )
          )}
        </div>
        <div id={`${id}-kind`} className="text-secondary text-muted">
          {kindLine}
        </div>
        <HoursLine id={`${id}-hours`} state={state} line={hoursLine} />
        {line !== undefined &&
          (score.kind === "none" ? (
            // M1's line, semibold in the muted colour.
            <div id={`${id}-who`} className="text-secondary font-semibold text-muted">
              {line.text}
            </div>
          ) : (
            <WhoLine id={`${id}-who`} line={line} />
          ))}
      </div>
    </Link>
  );
});
