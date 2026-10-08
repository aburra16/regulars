import { type JSX, type ReactNode, type RefObject, useId, useRef } from "react";

import { useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useCircleEmptiness } from "../score/useScore.ts";
import { retryButton } from "../ui/Banner.tsx";
import { WorkingIcon } from "../ui/icons.tsx";
import { useCircle } from "./CircleProvider.tsx";
import { emptyCircleLine } from "./EmptyCircle.tsx";

/** Personalize: the fill of a chosen chip, a chip's shape, 44 px tall. */
const personalizeButton =
  "h-11 shrink-0 cursor-pointer rounded-chip border-0 bg-emphasis px-5 font-text text-[15px] font-bold text-on-emphasis";

/** A quiet button in words, 44 px tall: Cancel, Dismiss. */
const wordButton =
  "inline-flex min-h-touch cursor-pointer items-center border-0 bg-transparent p-0 font-text text-secondary font-semibold text-ink underline hover:text-accent";

/** A quiet line: what the state is. */
const quietLine = "m-0 text-secondary leading-[1.4] text-muted";

/**
 * Personalize, and the circle getting ready, under the toggle on Explore (decisions 8 and 26): for a
 * person signed in whose circle is not ready, the button, with the line beside it that says what it
 * does; once tapped, while their add-on or phone app asks them, a line that says so, with Cancel; then
 * the banner while Brainstorm works it out (the brief's screen 11); then a quiet notice that it is
 * ready, which never switches the view. When Brainstorm is busy, the run failed or Brainstorm could not
 * be reached, a quiet line with Try again; House picks works all along. When the returning visitor's
 * look found a scorer with no ranks (unconfirmed), the line that says nobody in their circle has rated
 * places yet, with Work out my circle again, in either view (ruling R10).
 *
 * What it says is in a polite status that is always there while the panel is, so a screen reader hears
 * each change. A button that goes leaves the focus on the panel; Dismiss, which puts the panel away,
 * leaves it on `holdFocus`, the part of the page the panel sits in.
 */
export function Personalize({ holdFocus }: { holdFocus: RefObject<HTMLElement | null> }): JSX.Element | null {
  const { account } = useAccount();
  const circle = useCircle();
  const { youRated } = useCircleEmptiness();
  const panel = useRef<HTMLDivElement>(null);
  const lineId = useId();
  if (!config.features.circle || account === undefined) return null;

  /** Runs `act`, with the focus on the panel first: the button pressed is about to go. */
  const fromPanel = (act: () => void) => () => {
    panel.current?.focus({ preventScroll: true });
    act();
  };

  let message: ReactNode = null;
  let actions: ReactNode = null;
  switch (circle.state) {
    case "checking":
      return null;
    case "off":
      actions = (
        <div className="flex flex-col items-start gap-2">
          <button type="button" aria-describedby={lineId} onClick={fromPanel(circle.personalize)} className={personalizeButton}>
            {copy.circle.personalize}
          </button>
          <p id={lineId} className={quietLine}>
            {copy.circle.consent}
          </p>
        </div>
      );
      break;
    case "signing":
      message = <p className={quietLine}>{account.how === "phone" ? copy.circle.approvePhone : copy.circle.approveBrowser}</p>;
      actions = (
        <button type="button" onClick={fromPanel(circle.cancel)} className={wordButton}>
          {copy.circle.cancel}
        </button>
      );
      break;
    case "working":
      message = (
        <div className="flex flex-col gap-3 rounded-card bg-trust-tint p-4 text-trust-ink">
          <p className="m-0 flex items-center gap-2.5 text-body font-bold">
            <WorkingIcon size={22} className="shrink-0 text-trust" />
            {copy.circle.workingTitle}
          </p>
          <p className="m-0 text-secondary leading-[1.45]">{copy.circle.workingBody}</p>
        </div>
      );
      break;
    case "ready":
    case "recently":
      if (!circle.notice) return null;
      message = (
        <p className="m-0 text-secondary font-semibold leading-[1.4] text-trust">
          {circle.state === "recently" ? copy.circle.recently : copy.circle.ready}
        </p>
      );
      actions = (
        <button
          type="button"
          onClick={() => {
            holdFocus.current?.focus({ preventScroll: true });
            circle.dismissReady();
          }}
          className={wordButton}
        >
          {copy.circle.dismiss}
        </button>
      );
      break;
    case "unconfirmed":
      message = (
        <p id={lineId} className="m-0 text-secondary leading-[1.4] font-semibold text-trust">
          {emptyCircleLine(youRated)}
        </p>
      );
      actions = (
        <button type="button" aria-describedby={lineId} onClick={fromPanel(circle.personalize)} className={`mt-2 ${retryButton}`}>
          {copy.circle.workOutAgain}
        </button>
      );
      break;
    case "busy":
    case "failed":
    case "unavailable":
      message = (
        <p id={lineId} className={quietLine}>
          {circle.state === "busy" ? copy.circle.busy : copy.circle.unavailable}
        </p>
      );
      actions = (
        <button type="button" aria-describedby={lineId} onClick={fromPanel(circle.retry)} className={`mt-2 ${retryButton}`}>
          {copy.circle.tryAgain}
        </button>
      );
      break;
  }

  return (
    <div ref={panel} tabIndex={-1} className="flex flex-col items-start outline-none">
      <div role="status" className="w-full">
        {message}
      </div>
      {actions}
    </div>
  );
}
