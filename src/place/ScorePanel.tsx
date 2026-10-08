import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { formatScore } from "../score/score.ts";
import type { ShownScore } from "../score/shown.ts";
import { primaryButton } from "../ui/Banner.tsx";
import { scriptLang } from "../ui/scriptLang.ts";
import { Stars } from "../ui/Stars.tsx";

/** Stands in for the name while the sentence is split around it. No name holds it: it is not text. */
const NAME_MARK = "\u0000";

/**
 * "Rate this place": the accent button, 52 px, the width of what it is in (PlaceNew.dc.html,
 * DeskPlace.dc.html). Writing a review needs sign in, which is not open yet, so it goes to the
 * sign-in page, which can come back here.
 */
export function RateButton(): JSX.Element {
  const location = useLocation();
  // While `config.features.signIn` is off. When it opens, the review form (M2) takes this link for a person who has signed in.
  return (
    <Link to="/signin" state={{ from: location }} className={`${primaryButton} w-full`}>
      {copy.place.rate}
    </Link>
  );
}

/**
 * The same, as a link in the accent colour beside the heading of a phone's reviews (Place.dc.html
 * has "Write a review" there): a place with a score has no button in its panel.
 */
export function RateLink(): JSX.Element {
  const location = useLocation();
  return (
    <Link
      to="/signin"
      state={{ from: location }}
      className="inline-flex min-h-touch shrink-0 items-center text-[15px] font-bold text-accent underline"
    >
      {copy.place.rate}
    </Link>
  );
}

/** The dashed edge of a panel with no score in it (PlaceNew.dc.html), on a phone or a desktop. */
const dashedPanel = (wide: boolean) =>
  `flex flex-col gap-3 border-token border-dashed border-field-border ${
    wide ? "rounded-panel-desktop p-panel-desktop" : "rounded-panel px-[18px] py-5"
  }`;

/** The filled panel of a score (Place.dc.html, DeskPlace.dc.html), on a phone or a desktop. */
const filledPanel = (wide: boolean) =>
  `flex bg-surface ${
    wide ? "flex-wrap items-center gap-x-7 gap-y-[18px] rounded-panel-desktop p-panel-desktop" : "flex-col gap-3.5 rounded-panel p-[18px]"
  }`;

/**
 * Where the score goes, before anyone has reviewed the place: a dashed panel that asks the person to
 * be the first (PlaceNew.dc.html). The place's name is in the sentence, marked with its script and
 * kept apart from the sentence's direction, so a name in Arabic does not reorder the words around it.
 */
function BeFirst({ name, wide }: { name: string; wide: boolean }): JSX.Element {
  const [before = "", after = ""] = copy.place.nobodyYet(NAME_MARK).split(NAME_MARK);
  return (
    <section className={dashedPanel(wide)}>
      <h2 className="m-0 font-display text-[26px] leading-[1.1] font-extrabold tracking-display">{copy.place.beFirst}</h2>
      <p className="m-0 max-w-measure text-[15px] leading-[1.45] wrap-break-word text-ink-soft">
        {before}
        <bdi lang={scriptLang(name)}>{name}</bdi>
        {after}
      </p>
      {!wide && <RateButton />}
    </section>
  );
}

/**
 * The house's score (Place.dc.html, DeskPlace.dc.html): the big number, its stars, and how many
 * people the house trusts it comes from, in the trust colour. A screen reader hears the stars'
 * "4.6 out of 5" in place of the bare number. Never anything about one of the people (decision 19).
 */
function HouseScore({ score, counted, wide }: { score: number; counted: number; wide: boolean }): JSX.Element {
  return (
    <section className={filledPanel(wide)}>
      <h2 className="sr-only">{copy.view.house}</h2>
      <div className={`flex items-center ${wide ? "gap-4" : "gap-3.5"}`}>
        <p
          aria-hidden="true"
          className={`m-0 font-display leading-none font-extrabold tracking-[-0.03em] ${wide ? "text-[64px]" : "text-score"}`}
        >
          {formatScore(score)}
        </p>
        <div className="flex flex-col gap-1.5">
          <Stars value={score} size="panel" />
          <p className="m-0 text-[15px] font-semibold text-trust">{copy.score.fromHouse(counted)}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * While the place's reviews are being read: the panel's place, waiting quietly. Nothing is said, so
 * nothing is said that turns out untrue ("Be the first" of a place with reviews).
 */
function Reading({ wide }: { wide: boolean }): JSX.Element {
  return <section aria-busy="true" className={`${filledPanel(wide)} ${wide ? "min-h-[108px]" : "min-h-[90px]"}`} />;
}

/**
 * No review relay answered for the place: one quiet line where the score goes, and Try again, which
 * reads the reviews of every place asked for again (`onRetry`).
 */
function Failed({ wide, onRetry }: { wide: boolean; onRetry(): void }): JSX.Element {
  return (
    <section className={filledPanel(wide)}>
      <p className="m-0 text-[15px] font-semibold text-muted">{copy.score.failed}</p>
      <button
        type="button"
        onClick={onRetry}
        className="h-11 cursor-pointer self-start rounded-chip border-token border-line-strong bg-ground px-4 font-text text-secondary font-bold text-ink"
      >
        {copy.load.retry}
      </button>
      {!wide && <RateButton />}
    </section>
  );
}

/**
 * A place with reviews whose reviewers the house is still being asked about: a quiet line where the
 * score will be. Not "Be the first", which would be untrue, and nothing folded yet: nobody is
 * outside House picks before the house has said so.
 */
function Counting({ wide }: { wide: boolean }): JSX.Element {
  return (
    <section className={filledPanel(wide)}>
      <p className="m-0 text-[15px] font-semibold text-muted">{copy.score.counting}</p>
      {!wide && <RateButton />}
    </section>
  );
}

/**
 * A place with reviews and no score: "No score yet", in the dashed panel of a place with none, and
 * why: people the house trusts reviewed it without stars, or how many others have rated it (their
 * reviews are folded below). When House picks can't be worked out, how many have rated it, and one
 * quiet line under the panel says why there is no score.
 */
function NoScore({ shown, wide }: { shown: Extract<ShownScore, { kind: "unscored" | "unavailable" }>; wide: boolean }): JSX.Element {
  const lines: string[] = [];
  if (shown.kind === "unavailable") lines.push(copy.score.peopleRated(shown.reviewers));
  else {
    if (shown.starless > 0) lines.push(copy.score.starless(shown.starless));
    if (shown.others > 0) lines.push(copy.score.othersRated(shown.others));
  }
  const panel = (
    <section className={dashedPanel(wide)}>
      <h2 className="m-0 font-display text-[26px] leading-[1.1] font-extrabold tracking-display">{copy.score.noScoreYet}</h2>
      {lines.map((line) => (
        <p key={line} className="m-0 max-w-measure text-[15px] leading-[1.45] text-ink-soft">
          {copy.common.sentence(line)}
        </p>
      ))}
      {!wide && <RateButton />}
    </section>
  );
  if (shown.kind !== "unavailable") return panel;
  return (
    <div className="flex flex-col gap-2.5">
      {panel}
      <p className="m-0 text-secondary leading-[1.4] text-muted">{copy.score.houseUnavailable}</p>
    </div>
  );
}

/**
 * Where the place's score goes, under its name, by what there is to show (`ShownScore`): the house's
 * score; the reviews being counted; no score yet; or, before anyone has reviewed it, the dashed panel
 * that asks the person to be the first. While the reviews are read it waits quietly; when they
 * couldn't be, it says so, with Try again (`onRetry`). On a phone "Rate this place" is in a panel
 * with no score (beside the reviews' heading when it has one); on a desktop it heads the rail
 * (DeskPlace.dc.html).
 */
export function ScorePanel({
  name,
  wide,
  shown,
  onRetry,
}: {
  name: string;
  wide: boolean;
  shown: ShownScore;
  onRetry(): void;
}): JSX.Element {
  switch (shown.kind) {
    case "scored":
      return <HouseScore score={shown.score} counted={shown.counted} wide={wide} />;
    case "reading":
      return <Reading wide={wide} />;
    case "failed":
      return <Failed wide={wide} onRetry={onRetry} />;
    case "pending":
      return <Counting wide={wide} />;
    case "unscored":
    case "unavailable":
      return <NoScore shown={shown} wide={wide} />;
    case "none":
      return <BeFirst name={name} wide={wide} />;
  }
}
