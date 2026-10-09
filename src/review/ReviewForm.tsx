import { type JSX, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { useAccount } from "../account/AccountProvider.tsx";
import { useOwnName } from "../account/useOwnName.ts";
import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import type { Review } from "../reviews/review.ts";
import type { WholeStars } from "../reviews/write.ts";
import { useScore } from "../score/useScore.ts";
import { primaryButton } from "../ui/Banner.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { Star } from "../ui/Stars.tsx";
import { type Draft, readDraft, saveDraft } from "./draft.ts";
import type { Posting } from "./usePost.ts";

/*
 * The review form (screen 8, Review.dc.html; D3, DeskReview.dc.html): the stars, each with its word,
 * the words a friend should know, and Post. The page and the dialog around it are ./ReviewPage.tsx and
 * ./ReviewDialog.tsx. The design's tags wait behind their switch (brief § 4.4): they are not here.
 */

const STARS = [1, 2, 3, 4, 5] as const satisfies readonly WholeStars[];

/** Stands in for the name while the sentence is split around it. No name holds it: it is not text. */
const NAME_MARK = "\u0000";

/**
 * The stars of `review` as the form can choose them: whole stars from 1 to 5. A review written in
 * another app may give 4.5, or none.
 */
function wholeStarsOf(review: Review | undefined): WholeStars | undefined {
  if (review === undefined || review.stars === null) return undefined;
  return Math.min(5, Math.max(1, Math.round(review.stars))) as WholeStars;
}

/**
 * "Reviewing as Maya" (the design's), for the person who has signed in, by the name their profile
 * gives, kept apart from the sentence's direction. An empty place, which keeps the row's layout, while
 * their name is not known; and nothing about them but their name (decision 19).
 */
function ReviewingAsName({ pubkey, className }: { pubkey: string; className: string }): JSX.Element {
  const name = useOwnName(pubkey);
  if (name === undefined) return <span />;
  const [before = "", after = ""] = copy.review.reviewingAs(NAME_MARK).split(NAME_MARK);
  return (
    <p className={`m-0 min-w-0 truncate ${className}`}>
      {before}
      <bdi lang={scriptLang(name)}>{name}</bdi>
      {after}
    </p>
  );
}

/** The same, for whoever has signed in: an empty place, which keeps the row's layout, when nobody has. */
export function ReviewingAs({ className }: { className: string }): JSX.Element {
  const { account } = useAccount();
  return account === undefined ? <span /> : <ReviewingAsName pubkey={account.pubkey} className={className} />;
}

/** "Your review of" over the place's name, which is the page's heading, marked with its script. */
export function ReviewTitle({ place, wide, className = "" }: { place: Place; wide: boolean; className?: string }): JSX.Element {
  return (
    <section className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <p className="m-0 text-[15px] text-muted">{copy.review.yourReviewOf}</p>
      <h1
        lang={scriptLang(place.name)}
        dir="auto"
        className={`m-0 font-display leading-[1.1] font-extrabold tracking-display wrap-break-word ${wide ? "text-[32px]" : "text-[30px]"}`}
      >
        {place.name}
      </h1>
    </section>
  );
}

/** The next number of stars from `from` for each key the stars answer to, going round at the ends; undefined for any other key. */
function starFor(key: string, from: WholeStars): WholeStars | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return from === 5 ? 1 : ((from + 1) as WholeStars);
    case "ArrowLeft":
    case "ArrowUp":
      return from === 1 ? 5 : ((from - 1) as WholeStars);
    case "Home":
      return 1;
    case "End":
      return 5;
    default:
      return undefined;
  }
}

/**
 * The five stars as a radio group (WAI-ARIA's radio pattern): each a radio named by its stars and
 * their word ("4 stars, Good"), 56 px as the design draws them, filled up to the stars chosen. The
 * group is one stop for the Tab key, at the star chosen, or the first while none is; the arrow keys,
 * Home and End move to a star and choose it. The design draws them as pressed buttons; a choice of one
 * of five is a radio group.
 */
function StarRadios({
  labelledBy,
  stars,
  onChoose,
}: {
  labelledBy: string;
  stars: WholeStars | undefined;
  onChoose(n: WholeStars): void;
}): JSX.Element {
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = radios.current.findIndex((radio) => radio === event.target);
    const next = at < 0 ? undefined : starFor(event.key, (at + 1) as WholeStars);
    if (next === undefined) return;
    event.preventDefault();
    onChoose(next);
    radios.current[next - 1]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="flex gap-1.5">
      {STARS.map((n) => (
        <button
          key={n}
          ref={(radio) => {
            radios.current[n - 1] = radio;
          }}
          type="button"
          role="radio"
          aria-checked={n === stars}
          aria-label={copy.review.star(n)}
          tabIndex={n === (stars ?? 1) ? 0 : -1}
          onClick={() => onChoose(n)}
          className="flex size-14 cursor-pointer items-center justify-center rounded-[16px] border-0 bg-surface p-0"
        >
          {/* Filled up to the stars chosen, in the accent; the rest in the dashed line's colour, which keeps 3 to 1 in the dark. */}
          <span className={n <= (stars ?? 0) ? "text-accent" : "text-line-dashed"}>
            <Star size="button" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** The phone's Post (Review.dc.html): the accent, 56 px, as wide as the page. */
const PHONE_POST =
  "flex h-14 w-full cursor-pointer items-center justify-center rounded-[18px] border-0 bg-accent-solid font-text text-[17px] font-bold text-on-accent";

/**
 * The form that reviews `place`, for the person who has signed in. It starts from what they had typed
 * into it in this tab (`readDraft`: before it sent them to sign in, before a reload, or before the
 * window crossed 900 px and drew it the other way), or else from their own review of the place, when
 * they have one. What they type is kept for the tab as they type it, for the place and for them
 * (`saveDraft`), until it is posted or closed. Post is off until a star is chosen. Posting is
 * `posting`'s, kept above the form by its route (`usePost`), so that a form drawn again shows a post
 * under way, and how it ended: Posting… (and, when Regulars is slow to take it, a line under Post that
 * says so), then the place, or why it didn't post, with Try again. `wide` lays it out for the desktop's
 * dialog.
 */
export function ReviewForm({ place, wide, posting }: { place: Place; wide: boolean; posting: Posting }): JSX.Element {
  const { account, restoring } = useAccount();
  // Whose draft it is: while a session this tab kept is restored, the kept session's.
  const me = useOwnPubkey();
  const { reviews } = useScore(place.address);
  const own = account === undefined ? undefined : reviews.find((review) => review.reviewer === account.pubkey);
  const { status } = posting;
  /** Whether a review relay is slow to take the post under way: said under Post, for everyone. */
  const slow = status === "posting" && posting.slow;

  const [draft] = useState(() => readDraft(place.address, me));
  const [stars, setStars] = useState<WholeStars | undefined>(() => draft?.stars ?? wholeStarsOf(own));
  const [text, setText] = useState(() => draft?.text ?? own?.text ?? "");
  /** Whether the form holds what the person chose, a draft, or their review already: not to be filled in again. */
  const filled = useRef(draft !== undefined || own !== undefined);

  const howId = useId();
  const textId = useId();
  const hintId = useId();

  // The person's own review may come once the form is open (read from the relays, or they have just
  // signed in): it fills the form in, unless they have started on it.
  useEffect(() => {
    if (filled.current || own === undefined) return;
    filled.current = true;
    setStars(wholeStarsOf(own));
    setText(own.text);
  }, [own]);

  /** Keeps what the person has chosen and typed so far, for this tab. */
  const keep = (next: Draft) => {
    filled.current = true;
    saveDraft(place.address, next, me);
  };

  const off = stars === undefined || status === "posting" || restoring;

  const post = () => {
    if (stars === undefined || off) return;
    posting.post(stars, text);
  };

  const choose = (n: WholeStars) => {
    keep({ stars: n, text });
    setStars(n);
  };

  const pad = wide ? "" : "px-gutter-phone";
  const word = stars === undefined ? "" : (copy.review.starWords[stars - 1] ?? "");

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        post();
      }}
      className={`flex flex-col ${wide ? "gap-[22px]" : "flex-1"}`}
    >
      <section className={`flex flex-col gap-3 ${pad} ${wide ? "" : "pt-[26px]"}`}>
        <h2 id={howId} className="m-0 text-[17px] font-bold">
          {copy.review.howWasIt}
        </h2>
        <div className={`flex flex-wrap ${wide ? "items-center gap-x-4 gap-y-1.5" : "flex-col gap-3"}`}>
          <StarRadios labelledBy={howId} stars={stars} onChoose={choose} />
          <p className={`m-0 text-[15px] font-semibold text-accent ${wide ? "" : "min-h-[22px]"}`}>{word}</p>
        </div>
      </section>

      <section className={`flex flex-col gap-2.5 ${pad} ${wide ? "" : "pt-5"}`}>
        <label htmlFor={textId} className="text-[17px] font-bold">
          {copy.review.textLabel}
        </label>
        <textarea
          id={textId}
          rows={5}
          dir="auto"
          value={text}
          onChange={(event) => {
            keep({ stars, text: event.target.value });
            setText(event.target.value);
          }}
          placeholder={copy.review.textPlaceholder}
          aria-describedby={hintId}
          className={`box-border w-full rounded-[16px] border-token border-field-border bg-ground px-4 py-3.5 font-text text-body leading-[1.5] text-ink placeholder:text-muted ${
            wide ? "resize-y" : "resize-none"
          }`}
        />
        <p id={hintId} className="m-0 text-caption text-muted">
          {copy.review.textHint}
        </p>
      </section>

      <section
        className={
          wide ? "flex flex-wrap items-center gap-x-5 gap-y-3.5" : `mt-auto flex flex-col gap-3 ${pad} pt-6 pb-[26px]`
        }
      >
        {(status === "failed" || status === "not on Regulars") && (
          <p role="alert" className={`m-0 text-body font-semibold text-accent ${wide ? "basis-full" : ""}`}>
            {status === "failed" ? copy.review.failed : copy.review.notOnRegulars}
          </p>
        )}
        <p className={`m-0 text-caption leading-[1.45] text-muted ${wide ? "min-w-0 flex-[1_1_260px]" : ""}`}>
          {copy.review.notice}
        </p>
        <button
          type="submit"
          aria-disabled={off ? true : undefined}
          className={`${wide ? primaryButton : PHONE_POST} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
        >
          {status === "posting" ? copy.review.posting : status === "editing" ? copy.review.post : copy.review.tryAgain}
        </button>
        {/*
          Said politely while it posts: the button says it too, which a screen reader does not hear
          change. Once Regulars is slow to take it, the same line says so, under the button, for everyone.
        */}
        <p
          role="status"
          aria-live="polite"
          className={slow ? `m-0 text-caption leading-[1.45] text-muted ${wide ? "basis-full text-right" : "text-center"}` : "sr-only"}
        >
          {slow ? copy.review.stillPosting : status === "posting" ? copy.review.posting : ""}
        </p>
      </section>
    </form>
  );
}
