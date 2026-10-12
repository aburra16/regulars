import { type JSX, memo, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { initialOf } from "../account/useOwnName.ts";
import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { copy } from "../copy/en.ts";
import { FollowButton } from "../follow/FollowButton.tsx";
import { placeKindLabel } from "../places/kinds.ts";
import { placePath } from "../review/paths.ts";
import { whenWritten, writtenOn } from "../reviews/when.ts";
import { usePictures, useScoreActions } from "../score/useScore.ts";
import { useNow } from "../shell/useNow.ts";
import { useWide } from "../shell/useWide.ts";
import { BackLink } from "../ui/BackLink.tsx";
import { quietLine, retryButton } from "../ui/Banner.tsx";
import { ProfilePicture } from "../ui/ProfilePicture.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { Stars } from "../ui/Stars.tsx";
import { useFollowedBy } from "./useFollowedBy.ts";
import { type PersonEntry, type PersonReviews, usePersonReviews } from "./usePersonReviews.ts";

/*
 * A person's page (the brief's screen 9, without the design's meter and its three counts:
 * decision 19), at `/person/<npub>`: their picture, or their initial, and their name; the Follow
 * button, the one main one on the page; and their reviews of the places on the list, newest first, 20
 * at a time. Each review is the place, a link to it, what the place is, the stars, when it was written
 * and the words. The rows are all the person's own, so none repeats their name, and none has a Follow
 * button.
 *
 * The page is read in one order at both widths (ruling R34): the name, which takes the focus as the
 * person arrives; who follows them; the Follow button, the page's one action; the reviews. Where each
 * is drawn is the layout's doing, not the order's.
 *
 * The button is in the header on a phone, at the end of the picture's row, and at the start of the
 * side rail on a desktop (`Follow`): never both. It is a pill, as wide as its words (ruling R46). It
 * is not drawn until the list of who the person signed in follows has been read, nor while a session
 * the tab kept is restored (src/follow/FollowButton.tsx), so its place is one that an absent button
 * leaves whole: the picture's row is as tall with it as without, and the rail keeps its width, so
 * nothing moves when the button comes. Signed out, it is a link to sign in, which comes back here and
 * follows nobody. On the person's own page, "This is you" is in its place.
 *
 * Under the name, for a person signed in: who of the people they follow follows this one, by name,
 * three of them at most (`FollowedBy`, ./useFollowedBy.ts). It is not there until it has been read,
 * nor when there is nobody to name, nor when it could not be read, which nothing says.
 *
 * Nothing on the page is a number about the person: not how many reviews they have written, nor how
 * many people follow them, nor a rank, a weight or a meter (decision 19); the stars on a row are that
 * review's rating of the place. Nor does anything say whether the view on screen counts them: someone
 * a place's page folds away has the same page as anyone.
 *
 * The page's code is a chunk of its own, which its route fetches (./PersonRoute.tsx): the route names
 * the tab for the person, and gives the page their name.
 */

/** The picture, or the initial in its place: 72 px on a phone, as the design draws it, and 80 px on a desktop. */
function Picture({ pubkey, name, className = "" }: { pubkey: string; name: string; className?: string }): JSX.Element {
  const picture = usePictures([pubkey]).get(pubkey);
  return (
    // Hidden from a screen reader: the name is beside it.
    <span
      aria-hidden="true"
      className={`flex size-18 shrink-0 items-center justify-center rounded-full bg-surface font-display text-[30px] font-extrabold text-ink wide:size-20 ${className}`}
    >
      <ProfilePicture address={picture} fallback={initialOf(name)} />
    </span>
  );
}

/**
 * Where the main Follow button is, for the person whose page it is: the button with its lines
 * (src/follow/FollowButton.tsx), which draws nothing while it cannot say Follow or Following; or, on
 * the page of the person signed in themself, the words that say so. One of these is drawn on a page.
 * `linesIn` is where the button's lines go when they are not under it (the phone's page).
 */
function Follow({ pubkey, name, linesIn }: { pubkey: string; name: string; linesIn?: HTMLElement | null }): JSX.Element {
  const me = useOwnPubkey();
  // The person's own page: a key in upper-case hex is the same person.
  if (me?.toLowerCase() === pubkey.toLowerCase()) {
    // As tall as the button, where the button would be.
    return <p className={`flex min-h-8 items-center ${quietLine}`}>{copy.person.you}</p>;
  }
  return <FollowButton pubkey={pubkey} name={name} size="main" linesIn={linesIn} />;
}

/** The person's name, the page's heading, which takes the focus as the person arrives (src/shell/headingFocus.ts). */
function Name({ name, className }: { name: string; className: string }): JSX.Element {
  return (
    <h1 tabIndex={-1} className={`m-0 min-w-0 font-display font-extrabold wrap-break-word outline-none ${className}`}>
      <bdi lang={scriptLang(name)}>{name}</bdi>
    </h1>
  );
}

/** The first of the marks that stand for the names while the line's words are split around them: characters no sentence of the app's has. */
const FIRST_MARK = 0xe000;

/**
 * The line that names who follows the person, of the people the person signed in follows: "Followed
 * by Maya, Jon and Dele, people you follow". `names` are those to name, three at most; with none,
 * there is no line. Names and nothing else: never how many there are (decision 19). It is in the
 * trust colour, as what is about whom the person trusts is. Each name is kept apart from the
 * direction of the words around it, and is drawn heavier than they are, so that a name reads as a
 * name whatever it is written like (ruling R36). A long name with no break in it is broken where the
 * line ends, as the page's heading is.
 */
function FollowedBy({ names, className = "" }: { names: readonly string[]; className?: string }): JSX.Element | null {
  if (names.length === 0) return null;
  const marks = names.map((_, at) => String.fromCharCode(FIRST_MARK + at));
  const parts = copy.follow.followedBy(...marks).split(new RegExp(`([${marks.join("")}])`, "u"));
  return (
    <p className={`m-0 min-w-0 text-secondary leading-[1.35] wrap-break-word text-trust ${className}`}>
      {parts.map((part, at) => {
        const name = names[marks.indexOf(part)];
        return name === undefined ? (
          part
        ) : (
          <bdi key={at} lang={scriptLang(name)} className="font-semibold">
            {name}
          </bdi>
        );
      })}
    </p>
  );
}

/**
 * One review, on its author's page: the place it is of, a link to the place's page, and when it was
 * written; what the place is; the stars, when the review gives any; and the words, when it has any.
 * It is `memo`: the list drawn again for more reviews does not draw this one again.
 */
const PersonReview = memo(function PersonReview({ entry, now }: { entry: PersonEntry; now: Date }): JSX.Element {
  const { review, place } = entry;
  const written = writtenOn(review.createdAt);
  return (
    <article className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2.5">
        <h3 className="m-0 min-w-0 text-[17px] font-bold">
          {/*
            44 px tall, for a name of one line or of several. A flex box of its own, so that the row's
            baseline is the name's first line: when it was written sits level with that line, not the last.
          */}
          <Link
            to={placePath(place.d)}
            lang={scriptLang(place.name)}
            dir="auto"
            className="inline-flex min-w-touch py-[11px] leading-[1.3] wrap-break-word text-ink underline hover:text-accent"
          >
            {place.name}
          </Link>
        </h3>
        {/* No date for a time no date can hold: the review shows without one, and the page stands. */}
        {written !== undefined && (
          <time dateTime={written.toISOString()} className="shrink-0 text-caption whitespace-nowrap text-muted">
            {whenWritten(review.createdAt, now)}
          </time>
        )}
      </div>
      <p className="m-0 -mt-1.5 text-secondary leading-[1.4] text-muted">{placeKindLabel(place.category, place.cuisine)}</p>
      {review.stars !== null && (
        <span className="mt-2 flex">
          <Stars value={review.stars} />
        </span>
      )}
      {review.text !== "" && (
        <p
          dir="auto"
          lang={scriptLang(review.text)}
          className="m-0 mt-2 max-w-measure text-body leading-[1.5] whitespace-pre-line wrap-break-word text-ink-soft wide:text-[17px] wide:leading-[1.55]"
        >
          {review.text}
        </p>
      )}
    </article>
  );
});

/** Show more, and Try again in its place: the page's outline button, 52 px tall (the design), as wide as a phone's page. */
const moreButton =
  "inline-flex h-13 w-full cursor-pointer items-center justify-center rounded-button border-token border-line-strong bg-ground px-7 font-text text-[15px] font-bold text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-60 wide:w-auto wide:self-start";

/**
 * The person's reviews, under their heading, which never says how many (decision 19). Where the
 * reading of them stands is said politely under the heading: that they are being read; that there
 * are none, once every review relay has sent everything it has and none is of a place on the list;
 * or that they could not be read, with Try again, which begins the reading again (no relay
 * answered, or nothing is listed and a relay was left: ./usePersonReviews.ts). Under the list, Show more reads
 * the next, and stays, busy, while it does; it is there only while a relay that answers may have
 * more. When the next could not be read, as no relay answered, the same button is Try again, with
 * the line that says so under it, so that the button is where it was: it asks the same relays again,
 * as often as it is pressed, and nothing reads again by itself (./reviewsRead.ts).
 *
 * The focus is never left on nothing. Show more's goes to the first review it brings; when it brings
 * none and there are no more, so that the button goes, to the last review; and Try again's, which
 * goes as it is pressed, to the heading.
 */
function Reviews({ reviews, wide, className = "" }: { reviews: PersonReviews; wide: boolean; className?: string }): JSX.Element {
  const { entries, state, more, end, showMore, retry } = reviews;
  const now = useNow();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The reviews listed when Show more was pressed, until those it brings are listed.
  const before = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const listed = before.current;
    if (listed === null || more === "reading") return;
    before.current = null;
    // Not read: the button stays, as Try again, with the focus.
    if (more === "failed") return;
    // Not if the person has moved the focus elsewhere meanwhile.
    const active = document.activeElement;
    if (active !== button.current && active !== document.body && active !== null) return;
    const rows = list.current?.children;
    const first = entries.findIndex((entry) => !listed.has(entry.review.id));
    if (first >= 0) rows?.[first]?.querySelector("a")?.focus();
    else if (button.current === null) (rows?.[rows.length - 1]?.querySelector("a") ?? heading.current)?.focus();
  }, [entries, more]);

  const onMore = () => {
    if (more === "reading") return;
    before.current = new Set(entries.map((entry) => entry.review.id));
    if (more === "failed") retry();
    else showMore();
  };

  const onRetry = () => {
    // The button goes as the reading starts: the focus stays in this part of the page.
    heading.current?.focus({ preventScroll: true });
    retry();
  };

  let status: string | null = null;
  if (state === "loading") status = copy.person.loading;
  else if (state === "failed") status = copy.person.failed;
  else if (end && entries.length === 0) status = copy.person.none;

  return (
    <section aria-labelledby={headingId} className={`flex flex-col ${className}`}>
      <h2 ref={heading} id={headingId} tabIndex={-1} className={`m-0 font-display font-bold outline-none ${wide ? "text-[26px]" : "text-h2"}`}>
        {copy.person.reviews}
      </h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 has-[p]:pt-3">
        {/* Always there, so a screen reader hears the line when it comes. Empty, it takes no room. */}
        <div role="status">{status !== null && <p className={quietLine}>{status}</p>}</div>
        {state === "failed" && (
          <button type="button" onClick={onRetry} className={retryButton}>
            {copy.person.retry}
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <ul ref={list} role="list" className="m-0 flex list-none flex-col p-0 pt-2">
          {entries.map((entry, i) => (
            <li key={entry.review.id} className={i === 0 ? "" : "mt-4 border-t-token border-line pt-2"}>
              <PersonReview entry={entry} now={now} />
            </li>
          ))}
        </ul>
      )}
      {state === "ready" && (
        <div className="flex flex-col has-[button]:pt-5">
          {!end && (
            <button
              ref={button}
              type="button"
              aria-disabled={more === "reading" ? true : undefined}
              aria-busy={more === "reading" ? true : undefined}
              onClick={onMore}
              className={moreButton}
            >
              {more === "failed" ? copy.person.retry : copy.person.showMore}
            </button>
          )}
          {/* Under the button, so that the button that was pressed is where it was when the line comes. */}
          <div role="status" className="has-[p]:pt-2">
            {more === "failed" && <p className={quietLine}>{copy.person.failed}</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/** What both layouts draw: who the person is, who follows them of the people the person signed in follows, and their reviews as far as they are read. */
interface View {
  pubkey: string;
  name: string;
  followers: readonly string[];
  reviews: PersonReviews;
}

/**
 * The phone's page: the way back; the picture, with the Follow button at the end of its row; the
 * name; who follows them; what the button has to say; and the reviews, one under another. The header
 * is a grid, so that the button is drawn in the picture's row though it comes after the name and the
 * line under it for a keyboard and a screen reader (ruling R34).
 *
 * The button is in the picture's row, at the end of it, level with the middle of the picture and less
 * tall than it, with the room a tap has (44 px) inside the row: the name and the reviews are where
 * they are with it or without it. Its lines, which come after a tap, are drawn in the header's last
 * row, as wide as the page (beside the picture there is no room for them, least of all for
 * Personalize's panel): so the button is where it was when they come, and so is the name; the reviews
 * make room.
 */
function PhonePerson({ pubkey, name, followers, reviews }: View): JSX.Element {
  // The row the button's lines are drawn in, once it is on the page.
  const [lines, setLines] = useState<HTMLDivElement | null>(null);
  return (
    <div className="flex flex-1 flex-col pb-6">
      <div className="px-3 pt-3.5">
        <BackLink wide={false} back={copy.person.back} />
      </div>
      <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 px-gutter-phone pt-2">
        <Picture pubkey={pubkey} name={name} className="col-start-1 row-start-1" />
        <Name name={name} className="col-span-2 row-start-2 mt-3 text-display-phone leading-[1.08] tracking-display" />
        <FollowedBy names={followers} className="col-span-2 row-start-3 mt-3" />
        {/* At the end of the picture's row, level with the middle of the picture: a pill, as wide as its words. */}
        <div className="col-start-2 row-start-1 min-w-0 self-center justify-self-end">
          <Follow pubkey={pubkey} name={name} linesIn={lines} />
        </div>
        {/*
          Empty, it takes no room: its room is for a line that is seen. A line that is only heard (what a
          screen reader is told when a press shows Unfollow) gives it none, so nothing under it moves.
        */}
        <div ref={setLines} className="col-span-2 row-start-4 min-w-0 has-[p:not(.sr-only)]:mt-2" />
      </header>
      <Reviews reviews={reviews} wide={false} className="px-gutter-phone pt-[26px]" />
    </div>
  );
}

/**
 * The desktop's page, in the layout a place's page has (D2): the way back, a column with the picture
 * beside the name and the reviews under them, and a side rail with the Follow button at its start,
 * level with the name's first line, its lines under it as wide as the rail. The rail is as
 * wide as a rail whether or not the button is drawn, so the column is where it is either way. It is
 * after the header and before the reviews: the order the phone's page is read in too. The name is at
 * the top of the picture's height, and the line that names who follows them under it, within that
 * height: the reviews are where they are with the line or without it.
 */
function DeskPerson({ pubkey, name, followers, reviews }: View): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter-desktop pt-4 pb-12">
      <BackLink wide back={copy.person.back} />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-10 gap-y-[26px]">
        <header className="flex min-w-0 items-start gap-[18px]">
          <Picture pubkey={pubkey} name={name} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
            <Name name={name} className="text-display-desktop leading-[1.05] tracking-[-0.025em]" />
            <FollowedBy names={followers} />
          </div>
        </header>
        {/* Ten pixels down from the top of the picture: the pill, 32 px tall, is level with the middle of the name's first line. */}
        <div className="row-span-2 mt-2.5 w-rail min-w-0 shrink-0">
          <Follow pubkey={pubkey} name={name} />
        </div>
        <Reviews reviews={reviews} wide />
      </div>
    </div>
  );
}

/**
 * The page of the person whose public key is `pubkey` (64 hex digits, in lower case), named `name` as
 * their profile gives it, or "Someone". The route draws it once its code is fetched (./PersonRoute.tsx).
 * What it reads is read here, above the two layouts: a window that crosses 900 px is laid out the
 * other way, and reads nothing again.
 */
export function PersonPage({ pubkey, name }: { pubkey: string; name: string }): JSX.Element {
  const wide = useWide();
  const reviews = usePersonReviews(pubkey);
  const followers = useFollowedBy(pubkey);
  const { refresh } = useScoreActions();
  const view: View = {
    pubkey,
    name,
    followers,
    reviews: {
      ...reviews,
      retry: () => {
        // The reviews could not be had, and the reading begins again. When no review relay answered
        // for the first page their name may not have been read either: it is asked for again with them.
        if (reviews.state === "failed") refresh();
        reviews.retry();
      },
    },
  };
  return wide ? <DeskPerson {...view} /> : <PhonePerson {...view} />;
}
