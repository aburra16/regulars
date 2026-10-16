import { type JSX, type KeyboardEvent, useId, useRef, useState } from "react";

import { useAccount } from "../account/AccountProvider.tsx";
import { useOwnName } from "../account/useOwnName.ts";
import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import { PAID_WAYS, type Price } from "../reviews/review.ts";
import { REVIEW_WORDS_MAX, type WholeStars, wholeStarsOf } from "../reviews/write.ts";
import { useScore } from "../score/useScore.ts";
import { primaryButton } from "../ui/Banner.tsx";
import { CHIP_OFF, CHIP_ON } from "../ui/Chips.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { Star } from "../ui/Stars.tsx";
import { type Draft, readDraft, saveDraft } from "./draft.ts";
import type { Posting } from "./usePost.ts";

/*
 * The review form (screen 8; D3): the stars, each with its word, the price and how they paid (both
 * optional), the words a friend should know, and Post. The page and the dialog around it are
 * ./ReviewPage.tsx and ./ReviewDialog.tsx. The design's tags wait behind their switch (brief § 4.4):
 * they are not here.
 */

const STARS = [1, 2, 3, 4, 5] as const satisfies readonly WholeStars[];

/** The prices the form offers, $ to $$$$. */
const PRICES = [1, 2, 3, 4] as const satisfies readonly Price[];

/** Stands in for the name while the sentence is split around it. No name holds it: it is not text. */
const NAME_MARK = "\u0000";

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
        tabIndex={-1}
        className={`m-0 font-display leading-[1.1] font-extrabold tracking-display wrap-break-word outline-none ${wide ? "text-[32px]" : "text-[30px]"}`}
      >
        {place.name}
      </h1>
    </section>
  );
}

/**
 * Which of a radio group's `count` radios to go to from the one at `at`, counted from 0, for each key
 * the group answers to, going round at the ends; undefined for any other key.
 */
function stepFor(key: string, at: number, count: number): number | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (at + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (at + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
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
    const next = at < 0 ? undefined : stepFor(event.key, at, STARS.length);
    if (next === undefined) return;
    event.preventDefault();
    onChoose((next + 1) as WholeStars);
    radios.current[next]?.focus();
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

/**
 * An option of a choice that may be left unmade, drawn as the app's chips are (`CHIP_ON`, `CHIP_OFF`):
 * 44 px tall, and as wide at the least, with a 1.5 px edge. The chosen one is filled and has no edge; it
 * takes the edge's width as padding, so the row does not move when one is chosen or cleared.
 */
const OPTION = "inline-flex h-11 min-w-touch cursor-pointer items-center justify-center rounded-chip font-text text-[15px] font-semibold";

/**
 * A choice of one of `options`, or of none, as a radio group (WAI-ARIA's radio pattern, as the stars
 * are): each a radio that shows `shown` of it, named by `spoken` of it when that is given (a price's
 * signs are read out in words, not one by one). The group is one stop for the Tab key, at the one
 * `chosen`, or the first while none is; the arrow keys, Home and End move to one and choose it. A press
 * on the one chosen clears the group, as the choice is optional.
 */
function OptionalRadios<T extends string | number>({
  labelledBy,
  options,
  chosen,
  onChoose,
  shown,
  spoken,
}: {
  labelledBy: string;
  options: readonly T[];
  chosen: T | null;
  onChoose(option: T | null): void;
  shown(option: T): string;
  spoken?(option: T): string;
}): JSX.Element {
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = radios.current.findIndex((radio) => radio === event.target);
    const next = at < 0 ? undefined : stepFor(event.key, at, options.length);
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || option === undefined) return;
    event.preventDefault();
    onChoose(option);
    radios.current[next]?.focus();
  };
  const stop = chosen === null ? 0 : Math.max(0, options.indexOf(chosen));
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="flex flex-wrap gap-2">
      {options.map((option, i) => {
        const on = option === chosen;
        return (
          <button
            key={option}
            ref={(radio) => {
              radios.current[i] = radio;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={spoken?.(option)}
            tabIndex={i === stop ? 0 : -1}
            onClick={() => onChoose(on ? null : option)}
            className={`${OPTION} ${on ? CHIP_ON : CHIP_OFF}`}
          >
            {shown(option)}
          </button>
        );
      })}
    </div>
  );
}

/** The phone's Post (the design): the accent, 56 px, as wide as the page. */
const PHONE_POST =
  "flex h-14 w-full cursor-pointer items-center justify-center rounded-[18px] border-0 bg-accent-solid font-text text-[17px] font-bold text-on-accent";

/**
 * The form that reviews `place`, for the person who has signed in. Each of its fields (the stars, the
 * words, the price and how they paid) is the person's once they act on it: a star chosen, the words
 * edited, a price or a way pressed, and nothing else; pressing one touches no other. The fields they
 * have acted on start from what the tab kept (`readDraft`: before it sent them to sign in, before a
 * reload, or before the window crossed 900 px and drew it the other way). Each other field shows what
 * their own review of the place gives, as soon as it is read and as it changes, and an edit keeps it
 * from that review (`usePost`), so a press or a word before the review is read loses nothing of it.
 * What they act on is kept for the tab as they go, for the place and for them (`saveDraft`), until it is
 * posted or closed. Post is off until stars are shown, chosen or their review's. Posting is `posting`'s,
 * kept above the form by its route (`usePost`), so that a form drawn again shows a post under way, and
 * how it ended: Posting… (and, when Regulars is slow to take it, a line under Post that says so), then
 * the place, or why it didn't post, with Try again. `wide` lays it out for the desktop's dialog.
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

  /** The fields the person has acted on (`Draft`), from what the tab kept: none of the others. */
  const [touched, setTouched] = useState<Draft>(() => readDraft(place.address, me) ?? {});
  // A field not touched shows what their review gives, which an edit keeps as it is.
  const stars = touched.stars ?? wholeStarsOf(own?.stars);
  const text = touched.text ?? own?.text ?? "";
  const price = touched.price === undefined ? (own?.price ?? null) : touched.price;
  const paid = touched.paid === undefined ? (own?.paid ?? null) : touched.paid;

  const howId = useId();
  const priceId = useId();
  const paidId = useId();
  const textId = useId();
  const hintId = useId();

  /** Touches the fields in `change`, as the person has given them, and keeps what they have touched for this tab. */
  const touch = (change: Draft) => {
    const next = { ...touched, ...change };
    saveDraft(place.address, next, me);
    setTouched(next);
  };

  const off = stars === undefined || status === "posting" || restoring;

  const post = () => {
    if (off) return;
    posting.post(touched);
  };

  const pad = wide ? "" : "px-gutter-phone";
  const word = stars === undefined ? "" : (copy.review.starWords[stars - 1] ?? "");
  /** Whether the words are at the most the field takes, or past it (a longer review written elsewhere). */
  const full = text.length >= REVIEW_WORDS_MAX;

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
          <StarRadios labelledBy={howId} stars={stars} onChoose={(n) => touch({ stars: n })} />
          <p className={`m-0 text-[15px] font-semibold text-accent ${wide ? "" : "min-h-[22px]"}`}>{word}</p>
        </div>
      </section>

      <section className={`flex flex-col gap-3 ${pad} ${wide ? "" : "pt-5"}`}>
        <h2 id={priceId} className="m-0 text-[17px] font-bold">
          {copy.review.price}
        </h2>
        <OptionalRadios
          labelledBy={priceId}
          options={PRICES}
          chosen={price}
          onChoose={(next: Price | null) => touch({ price: next })}
          shown={copy.price.signs}
          spoken={copy.price.spoken}
        />
      </section>

      <section className={`flex flex-col gap-3 ${pad} ${wide ? "" : "pt-5"}`}>
        <h2 id={paidId} className="m-0 text-[17px] font-bold">
          {copy.review.howPaid}
        </h2>
        <OptionalRadios
          labelledBy={paidId}
          options={PAID_WAYS}
          chosen={paid}
          onChoose={(next) => touch({ paid: next })}
          shown={(way) => copy.paid[way]}
        />
      </section>

      <section className={`flex flex-col gap-2.5 ${pad} ${wide ? "" : "pt-5"}`}>
        <label htmlFor={textId} className="text-[17px] font-bold">
          {copy.review.textLabel}
        </label>
        <textarea
          id={textId}
          rows={5}
          dir="auto"
          maxLength={REVIEW_WORDS_MAX}
          value={text}
          onChange={(event) => touch({ text: event.target.value })}
          placeholder={copy.review.textPlaceholder}
          aria-describedby={hintId}
          className={`box-border w-full rounded-[16px] border-token border-field-border bg-ground px-4 py-3.5 font-text text-body leading-[1.5] text-ink placeholder:text-muted ${
            wide ? "resize-y" : "resize-none"
          }`}
        />
        <p id={hintId} className="m-0 text-caption text-muted">
          {copy.review.textHint}
        </p>
        {/*
          Said politely once the words reach the most the field takes; a longer review written
          elsewhere opens whole, and says so too. While it says nothing it stays, so that a screen
          reader hears it when it does, and takes no room.
        */}
        <p role="status" aria-live="polite" className={full ? "m-0 text-caption text-muted" : "sr-only"}>
          {full ? copy.review.wordsFull : ""}
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
