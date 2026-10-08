import { type JSX, type KeyboardEvent, type MouseEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { copy } from "../copy/en.ts";
import type { RemoveReview, RemoveStatus } from "../review/useRemoveReview.ts";
import type { Review } from "../reviews/review.ts";
import { whenWritten, writtenOn } from "../reviews/when.ts";
import type { PlaceScore } from "../score/score.ts";
import type { ViewState } from "../score/store.ts";
import { useNames } from "../score/useScore.ts";
import { scriptLang } from "../ui/scriptLang.ts";
import { Stars } from "../ui/Stars.tsx";
import type { View } from "../view/ViewProvider.tsx";
import { EditLink, RateLink } from "./ScorePanel.tsx";

/*
 * A place's reviews (Place.dc.html, DeskPlace.dc.html), worded for the view on screen: the review of
 * the person signed in, on its own at the top, with Edit and Remove (ruling R15); those by people
 * inside the view (the house trusts them, or they are in the person's circle), listed; and those by
 * people outside it, folded into a dashed box that shows them, dimmed, on request. Each review has its
 * reviewer's name, its stars, when it was written and its words. A reviewer appears by name only:
 * never a rank, a weight or a meter (decision 19), and the folded box is no verdict on the people in
 * it. Nor does anything say whether the view counts the person's own review: it is never among the
 * others, nor dimmed, nor counted with them.
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
  now,
  wide,
  folded,
}: {
  review: Review;
  name: string;
  now: Date;
  wide: boolean;
  folded: boolean;
}): JSX.Element {
  const ink = folded ? "text-muted" : "text-ink";
  const written = writtenOn(review.createdAt);
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
        {/* No date for a time no date can hold: the review shows without one, and the page stands. */}
        {written !== undefined && (
          <time dateTime={written.toISOString()} className="shrink-0 text-caption text-muted">
            {whenWritten(review.createdAt, now)}
          </time>
        )}
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
  now,
  wide,
  folded,
}: {
  reviews: readonly Review[];
  names: Map<string, string>;
  now: Date;
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
            now={now}
            wide={wide}
            folded={folded}
          />
        </li>
      ))}
    </ul>
  );
}

/** The heading of a part of the reviews, on a phone or a desktop. */
const sectionHeading = (wide: boolean) => `m-0 font-display font-bold ${wide ? "text-[26px]" : "text-h2"}`;

/** A small button of the person's own review, 44 px tall, in the chip's shape. */
const chipButton =
  "h-11 cursor-pointer rounded-chip px-4 font-text text-secondary font-bold aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/** Edit and Remove under the person's own review: words, 44 px tall, as Rate this place is beside the reviews. */
const wordButton = "inline-flex min-h-touch shrink-0 cursor-pointer items-center text-[15px] underline";

/** The row under the person's own review: Edit, then Remove, or Keep it in its place once asked. */
const actionsRow = "flex flex-wrap items-center gap-x-6";

/**
 * The person's own review (ruling R15), under "Your review": as anyone's is drawn, never dimmed, with
 * Edit, which opens the form with it, and Remove, which asks first (`removal`).
 *
 * Asked, Keep it takes Remove's place, in the same row, and the focus goes to it; what removing does,
 * and the Remove that does it, come after, so that a second quick tap where Remove was keeps the review
 * rather than removing it (ruling R17). Keep it, or Escape, closes the question and gives the focus back
 * to Remove; not while it is being removed. Removing, that Remove says so; when no relay took it, an
 * alert says so, and it becomes Try again: one button throughout, which keeps the focus. When only the
 * person's own relays took it, it says so, with Try again and nothing to keep it by, nor Edit: it is
 * gone from their own places already. A double click on Remove asks, and its second click does not
 * confirm.
 */
function YourReview({
  review,
  name,
  now,
  wide,
  removal,
}: {
  review: Review;
  name: string;
  now: Date;
  wide: boolean;
  removal: RemoveReview;
}): JSX.Element {
  const headingId = useId();
  const questionId = useId();
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const { status } = removal;
  const was = useRef<RemoveStatus>(status);

  useEffect(() => {
    const before = was.current;
    was.current = status;
    if (status === "asking" && before === "idle") keepRef.current?.focus();
    else if (status === "idle" && before !== "idle") removeRef.current?.focus();
  }, [status]);

  const asked = status !== "idle" && status !== "removed";
  const removing = status === "removing";
  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    // The second click of a double click on Remove, which asked: not a yes.
    if (event.detail > 1 || removing) return;
    removal.remove();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || (status !== "asking" && status !== "failed")) return;
    event.preventDefault();
    removal.keep();
  };

  return (
    <section aria-labelledby={headingId} className={`flex flex-col ${wide ? "gap-5" : "gap-[18px]"}`}>
      <h2 id={headingId} className={sectionHeading(wide)}>
        {copy.reviews.yours}
      </h2>
      <ReviewItem review={review} name={name} now={now} wide={wide} folded={false} />
      <div onKeyDown={onKeyDown} className="flex flex-col gap-3">
        {status !== "partial" && (
          <div className={actionsRow}>
            <EditLink className={`${wordButton} font-bold text-accent`} />
            {asked ? (
              <button
                key="keep"
                ref={keepRef}
                type="button"
                aria-describedby={questionId}
                aria-disabled={removing ? true : undefined}
                onClick={() => {
                  if (!removing) removal.keep();
                }}
                className={`${chipButton} border-token border-line-strong bg-ground text-ink`}
              >
                {copy.reviews.keep}
              </button>
            ) : (
              // Off while a session this tab kept is restored: there is no one to sign the removal yet.
              <button
                key="remove"
                ref={removeRef}
                type="button"
                aria-disabled={removal.ready ? undefined : true}
                onClick={() => {
                  if (removal.ready) removal.ask();
                }}
                className={`${wordButton} border-0 bg-transparent p-0 font-text font-semibold text-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
              >
                {copy.reviews.remove}
              </button>
            )}
          </div>
        )}
        {asked && (
          <div role="group" aria-labelledby={questionId} className="flex flex-col gap-3 rounded-card bg-surface p-4">
            <p id={questionId} className="m-0 max-w-measure text-body leading-[1.45] text-ink">
              {copy.reviews.removeQuestion}
            </p>
            {(status === "failed" || status === "partial") && (
              <p role="alert" className="m-0 text-body font-semibold text-accent">
                {status === "failed" ? copy.reviews.removeFailed : copy.reviews.removePartial}
              </p>
            )}
            <div>
              <button
                type="button"
                aria-disabled={removing ? true : undefined}
                onClick={confirm}
                className={`${chipButton} border-0 bg-accent-solid text-on-accent`}
              >
                {removing ? copy.reviews.removing : status === "asking" ? copy.reviews.removeConfirm : copy.reviews.removeAgain}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** What the folded box says it holds, in the view's words. */
function foldedTitle(count: number, view: View, state: ViewState, anyInside: boolean): string {
  if (state === "unavailable") return copy.reviews.uncounted(count);
  if (view === "circle") return anyInside ? copy.reviews.foldedMoreCircle(count) : copy.reviews.foldedAllCircle(count);
  return anyInside ? copy.reviews.foldedMore(count) : copy.reviews.foldedAll(count);
}

/**
 * The reviews of a place with its score from `view` (`score`, undefined while it is worked out;
 * `state`, where the view's ranks stand): first `mine`, the review of the person signed in, under
 * "Your review", with Edit and Remove (`removal`), whatever the view and whether it is worked out
 * yet; then those inside the view under their heading, with "Rate this place" beside it when `rate`
 * (a phone's page whose panel has no button), and the folded ones in their box, neither of them with
 * the person's own, nor counting it. "Show them" opens and closes them: its one label stays, and
 * `aria-expanded` says which. `now` says how long ago each was written.
 */
export function Reviews({
  score,
  mine,
  removal,
  view,
  state,
  wide,
  rate,
  now,
}: {
  score: PlaceScore | undefined;
  mine: Review | undefined;
  removal: RemoveReview;
  view: View;
  state: ViewState;
  wide: boolean;
  rate: boolean;
  now: Date;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const foldedId = useId();
  const titleId = useId();
  const { inside, folded } = useMemo(() => {
    const others = (reviews: readonly Review[] | undefined) => (reviews ?? []).filter((review) => review.id !== mine?.id);
    return { inside: others(score?.inside), folded: others(score?.folded) };
  }, [score, mine]);
  const reviewers = useMemo(
    () => [...(mine === undefined ? [] : [mine]), ...inside, ...folded].map((review) => review.reviewer),
    [mine, inside, folded],
  );
  const names = useNames(reviewers);

  return (
    <div className={`flex flex-col ${wide ? "gap-[26px]" : "gap-[22px]"}`}>
      {mine !== undefined && (
        <YourReview
          review={mine}
          name={names.get(mine.reviewer) ?? copy.reviews.someone}
          now={now}
          wide={wide}
          removal={removal}
        />
      )}
      {inside.length > 0 && (
        <section className={`flex flex-col ${wide ? "gap-5" : "gap-[18px]"}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 className={sectionHeading(wide)}>{view === "circle" ? copy.reviews.headingCircle : copy.reviews.heading}</h2>
            {rate && <RateLink />}
          </div>
          <ReviewList reviews={inside} names={names} now={now} wide={wide} folded={false} />
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
              <h2 id={titleId} className="m-0 text-body font-bold">
                {foldedTitle(folded.length, view, state, inside.length > 0)}
              </h2>
              <p className="m-0 text-secondary leading-[1.45] text-muted">{copy.reviews.foldedNote}</p>
            </div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={foldedId}
              aria-describedby={titleId}
              onClick={() => setOpen((was) => !was)}
              className="h-11 shrink-0 cursor-pointer self-start rounded-chip border-0 bg-surface px-4 font-text text-secondary font-bold text-ink wide:self-center"
            >
              {copy.reviews.show}
            </button>
          </section>
          {/* Always on the page, so the button can name it as what it opens; empty and hidden while closed. */}
          <div id={foldedId} hidden={!open}>
            {open && <ReviewList reviews={folded} names={names} now={now} wide={wide} folded />}
          </div>
        </div>
      )}
    </div>
  );
}
