import { type JSX, useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AccountChanged, useAccount } from "../account/AccountProvider.tsx";
import { useOwnName } from "../account/useOwnName.ts";
import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import type { Review } from "../reviews/review.ts";
import { reviewTemplate, type WholeStars } from "../reviews/write.ts";
import { useRelays } from "../score/ScoresProvider.tsx";
import { useScore, useScoreActions } from "../score/useScore.ts";
import { primaryButton } from "../ui/Banner.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { Star } from "../ui/Stars.tsx";
import { dropDraft, readDraft, saveDraft } from "./draft.ts";
import { postReview, reviewStamp, whereToPost } from "./post.ts";

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

/** Where the form stands: being filled in, being posted, or not posted (said, with what was typed kept). */
type Status = "editing" | "posting" | "failed";

/** The phone's Post (Review.dc.html): the accent, 56 px, as wide as the page. */
const PHONE_POST =
  "flex h-14 w-full cursor-pointer items-center justify-center rounded-[18px] border-0 bg-accent-solid font-text text-[17px] font-bold text-on-accent";

/**
 * The form that reviews `place`, for the person who has signed in. It starts from their own review of
 * the place, when they have one, or from what they had typed when it last sent them to sign in. Post
 * is off until a star is chosen. Posting signs the review with the person's signer and sends it where
 * they publish (`whereToPost`, `postReview`); once a relay has taken it, the place shows it at once,
 * held until the relays send it back (`noteOwnReview`), and `onPosted` takes the person back to the
 * place. When no relay takes it, it says so, and what was typed stays. A person who is signed out, or
 * whose add-on or phone app now signs as someone else (they are signed out, `AccountChanged`), is
 * sent to sign in, and back here with what they typed. `wide` lays it out for the desktop's dialog.
 */
export function ReviewForm({ place, wide, onPosted }: { place: Place; wide: boolean; onPosted(): void }): JSX.Element {
  const { account, restoring } = useAccount();
  const { readers, writers } = useRelays();
  const { noteOwnReview, ownCoordinates, ownRemovedAt } = useScoreActions();
  const { reviews } = useScore(place.address);
  const navigate = useNavigate();
  const location = useLocation();
  const own = account === undefined ? undefined : reviews.find((review) => review.reviewer === account.pubkey);

  const [draft] = useState(() => readDraft(place.address));
  const [stars, setStars] = useState<WholeStars | undefined>(() => draft?.stars ?? wholeStarsOf(own));
  const [text, setText] = useState(() => draft?.text ?? own?.text ?? "");
  const [status, setStatus] = useState<Status>("editing");
  /** Whether the form holds what the person chose, a draft, or their review already: not to be filled in again. */
  const filled = useRef(draft !== undefined || own !== undefined);
  /** Aborts what is under way when the form goes. */
  const life = useRef<AbortController | null>(null);

  const howId = useId();
  const textId = useId();
  const hintId = useId();

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort(new DOMException("The review form was closed", "AbortError"));
  }, []);

  // The draft has served: it is in the form.
  useEffect(() => {
    if (draft !== undefined) dropDraft();
  }, [draft]);

  // The person's own review may come once the form is open (read from the relays, or they have just
  // signed in): it fills the form in, unless they have started on it.
  useEffect(() => {
    if (filled.current || own === undefined) return;
    filled.current = true;
    setStars(wholeStarsOf(own));
    setText(own.text);
  }, [own]);

  /** To sign in, and back here with what was typed. */
  const toSignIn = (chosen: WholeStars) => {
    saveDraft(place.address, { stars: chosen, text });
    void navigate("/signin", { state: { from: location } });
  };

  const off = stars === undefined || status === "posting" || restoring;

  const post = async () => {
    const signal = life.current?.signal;
    if (stars === undefined || off || signal === undefined) return;
    if (account === undefined) return toSignIn(stars);
    setStatus("posting");
    try {
      const relays = await whereToPost(account.pubkey, account.signer, readers, signal);
      const now = Math.floor(Date.now() / 1000);
      const stamp = reviewStamp(now, ownCoordinates(account.pubkey, place.address), ownRemovedAt(account.pubkey, place.address));
      const { event } = await postReview(reviewTemplate(place, stars, text.trim(), stamp), account.signer, relays, signal, writers);
      noteOwnReview(event);
      onPosted();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AccountChanged) return toSignIn(stars);
      setStatus("failed");
    }
  };

  const choose = (n: WholeStars) => {
    filled.current = true;
    setStars(n);
  };

  const pad = wide ? "" : "px-gutter-phone";
  const word = stars === undefined ? "" : (copy.review.starWords[stars - 1] ?? "");

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void post();
      }}
      className={`flex flex-col ${wide ? "gap-[22px]" : "flex-1"}`}
    >
      <section className={`flex flex-col gap-3 ${pad} ${wide ? "" : "pt-[26px]"}`}>
        <h2 id={howId} className="m-0 text-[17px] font-bold">
          {copy.review.howWasIt}
        </h2>
        <div className={`flex flex-wrap ${wide ? "items-center gap-x-4 gap-y-1.5" : "flex-col gap-3"}`}>
          <div role="group" aria-labelledby={howId} className="flex gap-1.5">
            {STARS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={n === stars}
                aria-label={copy.review.star(n)}
                onClick={() => choose(n)}
                className="flex size-14 cursor-pointer items-center justify-center rounded-[16px] border-0 bg-surface p-0"
              >
                {/* Filled up to the stars chosen, in the accent; the rest in the dashed line's colour, which keeps 3 to 1 in the dark. */}
                <span className={n <= (stars ?? 0) ? "text-accent" : "text-line-dashed"}>
                  <Star size="button" />
                </span>
              </button>
            ))}
          </div>
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
            filled.current = true;
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
        {status === "failed" && (
          <p role="alert" className={`m-0 text-body font-semibold text-accent ${wide ? "basis-full" : ""}`}>
            {copy.review.failed}
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
          {status === "posting" ? copy.review.posting : copy.review.post}
        </button>
      </section>
    </form>
  );
}
