import { type JSX, useId, useMemo, useState } from "react";

import { copy } from "../copy/en.ts";
import type { Review } from "../reviews/review.ts";
import type { PlaceScore } from "../score/score.ts";
import type { HouseState } from "../score/store.ts";
import { useNames } from "../score/useScore.ts";
import { scriptLang } from "../ui/scriptLang.ts";
import { Stars } from "../ui/Stars.tsx";
import { RateLink } from "./ScorePanel.tsx";

/*
 * A place's reviews (Place.dc.html, DeskPlace.dc.html, worded for House picks): those by people the
 * house trusts, listed; and those by people outside House picks, folded into a dashed box that shows
 * them, dimmed, on request. Each review has its reviewer's name, its stars, when it was written and
 * its words. A reviewer appears by name only: never a rank, a weight or a meter (decision 19), and
 * the folded box is no verdict on the people in it.
 */

/** The first character a person would see of a name: one emoji, or one letter with its marks. */
function initialOf(name: string): string {
  const first =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("en", { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next().value?.segment
      : Array.from(name)[0];
  return (first ?? "").toLocaleUpperCase();
}

/** One review. A folded one is dimmed: drawn in the muted colour, its stars too. */
function ReviewItem({
  review,
  name,
  nowSeconds,
  wide,
  folded,
}: {
  review: Review;
  name: string;
  nowSeconds: number;
  wide: boolean;
  folded: boolean;
}): JSX.Element {
  const ink = folded ? "text-muted" : "text-ink";
  return (
    <article data-folded={folded ? "true" : undefined} className="flex flex-col gap-2">
      <div className={`flex items-center ${wide ? "gap-3" : "gap-2.5"}`}>
        {/* The initial stands in for a face, which the app does not have. */}
        <span
          aria-hidden="true"
          className={`flex shrink-0 items-center justify-center rounded-full bg-surface font-bold ${ink} ${wide ? "size-11" : "size-10"}`}
        >
          {initialOf(name)}
        </span>
        <h3 className={`m-0 min-w-0 flex-1 truncate text-body font-bold ${ink}`}>
          <bdi lang={scriptLang(name)}>{name}</bdi>
        </h3>
        <time dateTime={new Date(review.createdAt * 1000).toISOString()} className="shrink-0 text-caption text-muted">
          {copy.reviews.when(nowSeconds - review.createdAt)}
        </time>
      </div>
      {review.stars !== null && <Stars value={review.stars} tone={folded ? "muted" : "accent"} />}
      {review.text !== "" && (
        <p
          dir="auto"
          lang={scriptLang(review.text)}
          className={`m-0 max-w-measure whitespace-pre-line wrap-break-word ${
            wide ? "text-[17px] leading-[1.55]" : "text-body leading-[1.5]"
          } ${folded ? "text-muted" : "text-ink-soft"}`}
        >
          {review.text}
        </p>
      )}
    </article>
  );
}

/** Reviews one under another, a line between each two (Place.dc.html). */
function ReviewList({
  reviews,
  names,
  nowSeconds,
  wide,
  folded,
}: {
  reviews: readonly Review[];
  names: Map<string, string>;
  nowSeconds: number;
  wide: boolean;
  folded: boolean;
}): JSX.Element {
  return (
    <ul role="list" className="m-0 flex list-none flex-col p-0">
      {reviews.map((review, i) => (
        <li key={review.id} className={i === 0 ? "" : "mt-[18px] border-t-token border-line pt-[18px]"}>
          <ReviewItem
            review={review}
            name={names.get(review.reviewer) ?? copy.reviews.someone}
            nowSeconds={nowSeconds}
            wide={wide}
            folded={folded}
          />
        </li>
      ))}
    </ul>
  );
}

/** What the folded box says it holds. */
function foldedTitle(count: number, house: HouseState, anyInside: boolean): string {
  if (house === "unavailable") return copy.reviews.uncounted(count);
  return anyInside ? copy.reviews.foldedMore(count) : copy.reviews.foldedAll(count);
}

/**
 * The reviews of a place with its score from the house's view (`score`; `house`, where the house's
 * view stands): those inside House picks under their heading, with "Rate this place" beside it on a
 * phone, and the folded ones in their box. `now` says how long ago each was written.
 */
export function Reviews({
  score,
  house,
  wide,
  now,
}: {
  score: PlaceScore;
  house: HouseState;
  wide: boolean;
  now: Date;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const foldedId = useId();
  const reviewers = useMemo(() => [...score.inside, ...score.folded].map((review) => review.reviewer), [score]);
  const names = useNames(reviewers);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const { inside, folded } = score;

  return (
    <div className={`flex flex-col ${wide ? "gap-[26px]" : "gap-[22px]"}`}>
      {inside.length > 0 && (
        <section className={`flex flex-col ${wide ? "gap-5" : "gap-[18px]"}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 className={`m-0 font-display font-bold ${wide ? "text-[26px]" : "text-h2"}`}>{copy.reviews.heading}</h2>
            {!wide && <RateLink />}
          </div>
          <ReviewList reviews={inside} names={names} nowSeconds={nowSeconds} wide={wide} folded={false} />
        </section>
      )}
      {folded.length > 0 && (
        <div className="flex flex-col gap-[18px]">
          <section
            className={`flex rounded-card border-token border-dashed border-line-dashed ${
              wide ? "flex-wrap items-center gap-x-6 gap-y-3 p-[18px]" : "flex-col gap-2.5 p-4"
            }`}
          >
            <div className={`flex min-w-0 flex-col gap-1.5 ${wide ? "flex-[1_1_320px]" : ""}`}>
              <h2 className="m-0 text-body font-bold">{foldedTitle(folded.length, house, inside.length > 0)}</h2>
              <p className="m-0 text-secondary leading-[1.45] text-muted">{copy.reviews.foldedNote}</p>
            </div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={foldedId}
              onClick={() => setOpen((was) => !was)}
              className="h-11 shrink-0 cursor-pointer self-start rounded-chip border-0 bg-surface px-4 font-text text-secondary font-bold text-ink wide:self-center"
            >
              {open ? copy.reviews.hide : copy.reviews.show}
            </button>
          </section>
          {/* Always on the page, so the button can name it as what it opens; empty and hidden while closed. */}
          <div id={foldedId} hidden={!open}>
            {open && <ReviewList reviews={folded} names={names} nowSeconds={nowSeconds} wide={wide} folded />}
          </div>
        </div>
      )}
    </div>
  );
}
