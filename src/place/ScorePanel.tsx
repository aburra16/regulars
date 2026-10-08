import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";

import { copy } from "../copy/en.ts";
import { primaryButton } from "../ui/Banner.tsx";
import { scriptLang } from "../ui/scriptLang.ts";

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
 * Where the score goes, before anyone has reviewed the place: a dashed panel that asks the person to
 * be the first (PlaceNew.dc.html). The place's name is in the sentence, marked with its script and
 * kept apart from the sentence's direction, so a name in Arabic does not reorder the words around it.
 * On a phone "Rate this place" is in the panel; on a desktop it heads the rail, and the panel has
 * none (DeskPlace.dc.html).
 */
export function ScorePanel({ name, wide }: { name: string; wide: boolean }): JSX.Element {
  const [before = "", after = ""] = copy.place.nobodyYet(NAME_MARK).split(NAME_MARK);
  return (
    <section
      className={`flex flex-col gap-3 border-token border-dashed border-field-border ${
        wide ? "rounded-[24px] p-[22px]" : "rounded-panel px-[18px] py-5"
      }`}
    >
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
