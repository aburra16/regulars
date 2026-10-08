import type { JSX } from "react";

import starSvg from "../assets/icons/star.svg?raw";
import { copy } from "../copy/en.ts";
import { formatScore } from "../score/score.ts";
import type { ShownScore } from "../score/shown.ts";

/*
 * What a card, a row of the search results and a chain's location row show of a place's score
 * (Main.dc.html, Search.dc.html, Chain.dc.html): the score at the top right, and the line under the
 * hours that says who it comes from. Both are about the place: how many people its score is made
 * of, never anything about one of them (decision 19).
 */

/** Nothing to show: nobody has reviewed the place, or its reviews are not read yet. */
export const NO_SCORE: ShownScore = { kind: "none" };

/**
 * A place's score at the top right (Main.dc.html): the accent star and the number, 17 px on a card
 * and 16 on a row. The star is drawn for the eye; a screen reader hears "4.6 out of 5".
 */
export function ScoreFigure({ id, score, size }: { id: string; score: number; size: "card" | "row" }): JSX.Element {
  return (
    <span
      id={id}
      className={`inline-flex shrink-0 items-center gap-1 font-bold whitespace-nowrap text-ink ${
        size === "card" ? "text-[17px]" : "text-body"
      }`}
    >
      <span
        aria-hidden="true"
        className={`block shrink-0 text-accent [&>svg]:size-full ${size === "card" ? "size-4" : "size-[15px]"}`}
        // Safe: the text is our own icon file, bundled at build time, never data from outside.
        dangerouslySetInnerHTML={{ __html: starSvg }}
      />
      <span aria-hidden="true">{formatScore(score)}</span>
      <span className="sr-only">{copy.score.starsLabel(score)}</span>
    </span>
  );
}

/**
 * The line under a place's hours about its score, when it has reviews: who a score comes from, in
 * the trust colour ("Rated by 3 people the house trusts"); or, in the muted one, why a place with
 * reviews has none (people the house trusts reviewed it without stars, or only others rated it), how
 * many have rated it while House picks can't be worked out, that its reviews are being counted, or
 * that they couldn't be loaded. Nothing for a place nobody has reviewed, which each list says its own
 * way, nor while its reviews are being read.
 */
export function whoLine(shown: ShownScore): { text: string; house: boolean } | undefined {
  switch (shown.kind) {
    case "scored":
      return { text: copy.score.ratedByHouse(shown.counted), house: true };
    case "unscored":
      if (shown.starless > 0) return { text: copy.score.starless(shown.starless), house: false };
      return { text: copy.score.othersRated(shown.others), house: false };
    case "unavailable":
      return { text: copy.score.peopleRated(shown.reviewers), house: false };
    case "pending":
      return { text: copy.score.counting, house: false };
    case "failed":
      return { text: copy.score.failed, house: false };
    case "reading":
    case "none":
      return undefined;
  }
}

/** The line `whoLine` gives, drawn: 14 px, semibold in the trust colour for a score, muted otherwise. */
export function WhoLine({ id, line }: { id: string; line: { text: string; house: boolean } }): JSX.Element {
  return (
    <div id={id} className={`text-secondary ${line.house ? "font-semibold text-trust" : "text-muted"}`}>
      {line.text}
    </div>
  );
}
