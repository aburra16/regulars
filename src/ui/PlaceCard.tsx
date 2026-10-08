import { type JSX, useId, useMemo } from "react";
import { Link } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatDistance } from "../places/distance.ts";
import { type OpenState, openLine, openState } from "../places/hours.ts";
import { placeKindLabel } from "../places/kinds.ts";
import type { Place } from "../places/place.ts";
import { KindTile } from "./KindTile.tsx";
import { scriptLang } from "./scriptLang.ts";

export interface PlaceCardProps {
  place: Place;
  /** How far the place is from where the list is near, in kilometres. */
  km: number;
  /**
   * `normal` has no score yet and says nobody has reviewed the place ("No reviews yet", under the
   * hours, where the line about who rated it goes). `unrated-dashed` is a place without a score in
   * a list that has places with scores: a dashed edge and "No score yet" at the top right, where
   * the score would be (My circle's list, Main.dc.html). Before sign in no list has scores, so M1
   * passes `normal`.
   */
  variant: "normal" | "unrated-dashed";
  /** The browser's language: it decides miles or kilometres, and the 12- or 24-hour clock. */
  locale: string;
  now: Date;
  /** The card of the pin chosen on the map: a heavier edge in the ink colour (DeskExplore.dc.html). */
  selected?: boolean;
}

/** The edge of a card: 1.5 px line colour, dashed for an unrated place, 2 px ink when chosen. */
function edge(variant: PlaceCardProps["variant"], selected: boolean): string {
  if (selected) return "border-2 border-ink";
  return variant === "unrated-dashed" ? "border-token border-dashed border-line-dashed" : "border-token border-line";
}

/**
 * The line about the hours. An open or closed place has that word first, in bold ("Open until
 * 11 pm"). Hours the app could not read are the text as the relay gave it, which can be any length:
 * one line, cut off, with the whole of it in the tooltip.
 */
function HoursLine({ id, state, line }: { id: string; state: OpenState; line: string }): JSX.Element {
  if (state.kind === "unparsed") {
    return (
      <div id={id} title={line} className="truncate text-secondary text-muted">
        {line}
      </div>
    );
  }
  if (state.kind === "open" || state.kind === "closed") {
    // The copy puts the word first in every line of these two states: "Open until ...", "Closed · opens ...".
    const space = line.indexOf(" ");
    const word = space === -1 ? line : line.slice(0, space);
    return (
      <div id={id} className="text-secondary text-muted">
        <span className="font-bold text-ink">{word}</span>
        {space === -1 ? "" : line.slice(space)}
      </div>
    );
  }
  return (
    <div id={id} className="text-secondary text-muted">
      {line}
    </div>
  );
}

/**
 * A place in a list (Main.dc.html): its kind on a tile, its name, what it is and how far, and
 * whether it is open; then, where the line about who rated it goes, that nobody has reviewed it
 * yet. The whole card is one link to the place; the link is named by the place's name, and the
 * rest is its description.
 */
export function PlaceCard({ place, km, variant, locale, now, selected = false }: PlaceCardProps): JSX.Element {
  const id = useId();
  const state = useMemo(() => openState(place, now), [place, now]);
  const kindLine = copy.explore.kindLine(placeKindLabel(place.category, place.cuisine), formatDistance(km, locale));
  const hoursLine = openLine(state, locale, "card");

  return (
    <Link
      to={`/place/${encodeURIComponent(place.d)}`}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-kind ${id}-hours ${id}-score`}
      className={`flex gap-3.5 rounded-card p-3.5 text-ink no-underline ${edge(variant, selected)}`}
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
          {variant === "unrated-dashed" && (
            <span id={`${id}-score`} className="shrink-0 pt-1 text-caption font-semibold whitespace-nowrap text-muted">
              {copy.score.noScoreYet}
            </span>
          )}
        </div>
        <div id={`${id}-kind`} className="text-secondary text-muted">
          {kindLine}
        </div>
        <HoursLine id={`${id}-hours`} state={state} line={hoursLine} />
        {variant === "normal" && (
          <div id={`${id}-score`} className="text-secondary font-semibold text-muted">
            {copy.score.noReviewsYet}
          </div>
        )}
      </div>
    </Link>
  );
}
