import { type JSX, memo, useEffect, useId, useRef } from "react";
import { Link } from "react-router-dom";

import { Personalize } from "../circle/Personalize.tsx";
import { copy } from "../copy/en.ts";
import { useHere } from "../location/useLocation.ts";
import { distanceKm, formatDistance } from "../places/distance.ts";
import { placeKindLabel } from "../places/kinds.ts";
import { howLongAgo, writtenOn } from "../reviews/when.ts";
import { useNames, useScoreActions } from "../score/useScore.ts";
import { useDocumentTitle } from "../shell/useDocumentTitle.ts";
import { useLocale } from "../shell/useLocale.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { PageMessage, primaryButton, retryButton } from "../ui/Banner.tsx";
import { KindTile } from "../ui/KindTile.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { Stars } from "../ui/Stars.tsx";
import { ViewSwitch } from "../ui/ViewToggle.tsx";
import { useView } from "../view/ViewProvider.tsx";
import { type RecentEntry, useRecent } from "./useRecent.ts";

/** A quiet line: whose reviews these are, or where the reading of them stands. */
const quietLine = "m-0 text-secondary leading-[1.4] text-muted";

/** "Show older reviews": an outline button, 44 px tall, as Explore's Show more. */
const olderButton =
  "inline-flex h-11 cursor-pointer items-center rounded-button border-token border-line-strong bg-ground px-6 font-text text-body font-semibold text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/**
 * One review in the list: who wrote it ("You" for the person's own) and how long ago, the place with
 * what it is and how far it is from where the app is looking, as a card says them, the stars and the
 * words, three lines at most. The whole of it is one link to the place, named in a sentence of its own
 * ("Maya's review of Jacafé, 2 hours ago"), and described by the rest. A reviewer appears by name only
 * (decision 19). It is `memo`: the list drawn again for another review does not draw this one again.
 */
const RecentItem = memo(function RecentItem({
  entry,
  name,
  km,
  locale,
  now,
}: {
  entry: RecentEntry;
  name: string;
  km: number;
  locale: string;
  now: Date;
}): JSX.Element {
  const id = useId();
  const { review, place, mine } = entry;
  const who = mine ? copy.recent.you : name;
  const when = howLongAgo(review.createdAt, now);
  const written = writtenOn(review.createdAt);
  const kindLine = copy.explore.kindLine(placeKindLabel(place.category, place.cuisine), formatDistance(km, locale));
  const describedBy = [`${id}-kind`, review.stars !== null && `${id}-stars`, review.text !== "" && `${id}-text`]
    .filter(Boolean)
    .join(" ");
  return (
    <Link
      to={`/place/${encodeURIComponent(place.d)}`}
      aria-label={mine ? copy.recent.yourEntry(place.name, when) : copy.recent.entry(name, place.name, when)}
      aria-describedby={describedBy}
      className="flex flex-col gap-2.5 rounded-card border-token border-line p-4 text-ink no-underline"
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-body font-bold">
          <bdi lang={scriptLang(who)}>{who}</bdi>
        </span>
        {/* No time for one no date can hold: the review shows without it. */}
        {written !== undefined && (
          <time dateTime={written.toISOString()} className="shrink-0 text-caption text-muted">
            {when}
          </time>
        )}
      </div>
      <div className="flex items-center gap-3">
        <KindTile category={place.category} size="row" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span
            lang={scriptLang(place.name)}
            dir="auto"
            className="line-clamp-2 font-display text-card-title leading-[1.2] font-bold wrap-break-word"
          >
            {place.name}
          </span>
          <span id={`${id}-kind`} className="text-secondary text-muted">
            {kindLine}
          </span>
        </div>
      </div>
      {review.stars !== null && (
        <span className="flex">
          <Stars value={review.stars} />
          {/* What the stars say, for the link's description: a name inside a link is not read out. */}
          <span id={`${id}-stars`} className="sr-only">
            {copy.score.starsLabel(review.stars)}
          </span>
        </span>
      )}
      {review.text !== "" && (
        <p
          id={`${id}-text`}
          dir="auto"
          lang={scriptLang(review.text)}
          className="m-0 line-clamp-3 max-w-measure text-body leading-[1.5] whitespace-pre-line wrap-break-word text-ink-soft wide:text-[17px] wide:leading-[1.55]"
        >
          {review.text}
        </p>
      )}
    </Link>
  );
});

/**
 * Recent (Avi, 2026-10-08): the newest reviews of places everywhere, from the people who count in the
 * view on screen, as they count in its scores, newest first. A heading, the House picks / My circle
 * toggle (on a phone, under the heading, with Personalize under it, as Explore has them; on a desktop,
 * the top bar's), one quiet line saying whose reviews these are, and the list, each review a link to
 * its place. No number about a person, and no order but time (decision 19).
 *
 * The list is the session's (`useRecent`): Back from a place finds it as it was, scrolled where it was.
 * Where the reading stands is said in a polite status above the list: the loading line, or that it
 * could not be read, with Try again. Under the list, "Show older reviews" reads the next page; the
 * focus then moves to the first review it brings, or stays on the button when it brings none, or goes
 * to the line that says there are no more (the top of the page, when there is no list). Nobody counting,
 * the page says so in the view's words; in My circle, with the way back to House picks.
 */
export function RecentPage(): JSX.Element {
  useDocumentTitle(copy.titles.recent);
  const wide = useWide();
  const recent = useRecent();
  const { entries, named, state, view, older, newer, end } = recent;
  const { setView } = useView();
  const { refresh } = useScoreActions();
  const here = useHere();
  const locale = useLocale();
  const now = useNow();
  const headingId = useId();
  const unavailableId = useId();
  // The top of the page, which keeps the focus when what had it goes: Personalize's notice put away,
  // Try again pressed, the switch to House picks.
  const top = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const endLine = useRef<HTMLParagraphElement>(null);
  // The reviews listed when "Show older reviews" was pressed, until those it brings are listed.
  const before = useRef<ReadonlySet<string> | null>(null);

  // The names of those who count in either view, so that a switch of the view lists them by name at once.
  const names = useNames(named);

  // Once the older page is read and whose its reviews are is known: the focus to the first new review,
  // as Explore's Show more does. With none, it stays on the button, or goes to the end line if the button
  // went. Not if the person has moved it elsewhere meanwhile.
  const { counting } = recent;
  useEffect(() => {
    const listed = before.current;
    if (listed === null || older === "reading" || (counting && older !== "failed")) return;
    before.current = null;
    const active = document.activeElement;
    if (active !== button.current && active !== document.body && active !== null) return;
    let last = -1;
    entries.forEach((entry, i) => {
      if (listed.has(entry.review.id)) last = i;
    });
    const next = entries.findIndex((entry, i) => i > last && !listed.has(entry.review.id));
    if (next >= 0) list.current?.children[next]?.querySelector("a")?.focus();
    else if (button.current === null) (endLine.current ?? top.current)?.focus();
  }, [entries, older, counting]);

  const showOlder = () => {
    if (older === "reading") return;
    before.current = new Set(entries.map((entry) => entry.review.id));
    recent.showOlder();
  };

  const retry = () => {
    top.current?.focus({ preventScroll: true });
    recent.retry();
  };

  let status: JSX.Element | null = null;
  if (state === "loading") status = <p className={quietLine}>{copy.recent.loading}</p>;
  else if (state === "failed") status = <p className={quietLine}>{copy.recent.failed}</p>;
  else if (newer === "failed") status = <p className={quietLine}>{copy.recent.newerFailed}</p>;
  const failed = state === "failed" || (state === "ready" && newer === "failed");

  let body: JSX.Element | null = null;
  if (state === "ready" && entries.length === 0) {
    const circle = view === "circle";
    const words = end
      ? circle
        ? copy.recent.emptyCircle
        : copy.recent.emptyHouse
      : circle
        ? copy.recent.noneLatestCircle
        : copy.recent.noneLatestHouse;
    body = (
      <PageMessage
        action={
          circle && (
            <button
              type="button"
              onClick={() => {
                top.current?.focus({ preventScroll: true });
                setView("house");
              }}
              className={primaryButton}
            >
              {copy.recent.toHouse}
            </button>
          )
        }
      >
        {words}
      </PageMessage>
    );
  } else if (state === "ready") {
    body = (
      <ul ref={list} role="list" aria-labelledby={headingId} className="m-0 flex list-none flex-col gap-3 p-0">
        {entries.map((entry) => (
          <li key={entry.review.id}>
            <RecentItem
              entry={entry}
              name={names.get(entry.review.reviewer) ?? copy.reviews.someone}
              km={distanceKm(here.lat, here.lon, entry.place.lat, entry.place.lon)}
              locale={locale}
              now={now}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      className={`flex flex-1 flex-col ${
        wide ? "mx-auto w-full max-w-[760px] px-gutter-desktop pt-8 pb-12" : "px-gutter-phone pt-4 pb-5"
      }`}
    >
      <div ref={top} tabIndex={-1} className="flex flex-col outline-none">
        <h1
          id={headingId}
          className="m-0 font-display text-display-phone leading-[1.1] font-extrabold tracking-display wide:text-display-desktop"
        >
          {copy.pages.recent}
        </h1>
        {!wide && (
          <div className="mt-4">
            <ViewSwitch variant="bar" />
          </div>
        )}
        {/* On a phone, the panel My circle's half opens, right under it; on a desktop, the top bar's
            toggle offers Personalize, and this says how the circle is getting on. Saying nothing, it
            takes no room. */}
        <Personalize holdFocus={top} offer={wide ? "toggle" : "opened"} className="mt-3" />
        <p className={`mt-2.5 ${quietLine}`}>{view === "circle" ? copy.recent.circleLine : copy.recent.houseLine}</p>
        {state === "unavailable" && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p id={unavailableId} className={quietLine}>
              {view === "circle" ? copy.score.circleUnavailable : copy.score.houseUnavailable}
            </p>
            <button
              type="button"
              aria-describedby={unavailableId}
              onClick={() => {
                top.current?.focus({ preventScroll: true });
                refresh();
              }}
              className={retryButton}
            >
              {copy.load.retry}
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col pt-[18px]">
        {/* Always there, so a screen reader hears the line when it comes. Empty, it takes no room. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 has-[p]:pb-3.5">
          <div role="status">{status}</div>
          {failed && (
            <button type="button" onClick={retry} className={retryButton}>
              {copy.load.retry}
            </button>
          )}
        </div>
        {body}
        {state === "ready" && (
          <div className="flex flex-col items-center gap-3 pt-4 text-center">
            <div role="status">
              {older === "failed" ? (
                <p className={quietLine}>{copy.recent.olderFailed}</p>
              ) : (
                // An empty list says as much in its own words.
                end &&
                entries.length > 0 && (
                  <p ref={endLine} tabIndex={-1} className={`${quietLine} outline-none`}>
                    {copy.recent.end}
                  </p>
                )
              )}
            </div>
            {!end && (
              <button
                ref={button}
                type="button"
                aria-disabled={older === "reading" ? true : undefined}
                aria-busy={older === "reading" ? true : undefined}
                onClick={showOlder}
                className={olderButton}
              >
                {copy.recent.showOlder}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
