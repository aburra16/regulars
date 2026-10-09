import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";

import { useAccount } from "../account/AccountProvider.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useCircleEmptiness } from "../score/useScore.ts";
import { retryButton } from "../ui/Banner.tsx";
import { WorkingIcon } from "../ui/icons.tsx";
import { DOOR_STATES, useCircleDoor } from "./CircleDoor.tsx";
import { type CircleState, type CircleValue, useCircle } from "./CircleProvider.tsx";
import { emptyCircleLine } from "./EmptyCircle.tsx";

/** Personalize: the fill of a chosen chip, a chip's shape, 44 px tall. */
const personalizeButton =
  "h-11 shrink-0 cursor-pointer rounded-chip border-0 bg-emphasis px-5 font-text text-[15px] font-bold text-on-emphasis";

/** A quiet button in words, 44 px tall: Cancel, Dismiss, Not now. */
const wordButton =
  "inline-flex min-h-touch cursor-pointer items-center border-0 bg-transparent p-0 font-text text-secondary font-semibold text-ink underline hover:text-accent";

/** A quiet line: what the state is. */
const quietLine = "m-0 text-secondary leading-[1.4] text-muted";

/** The states in which the door to My circle offers something: Personalize (off), or Try again. */
type Offered = "off" | "busy" | "failed" | "unavailable";

const offers = (state: CircleState): state is Offered => DOOR_STATES.has(state);

/**
 * What the door to My circle offers in `state`: in off, Personalize, with decision 26's line under it,
 * which says what it does; when Brainstorm is busy, the run failed or Brainstorm could not be reached,
 * the quiet line that says so (the `message`), with Try again. `tap` makes a button's click of what it
 * does. `notNow`, in a panel that My circle's half opened, goes beside the button.
 */
function offered(
  state: Offered,
  circle: CircleValue,
  lineId: string,
  tap: (act: () => void) => () => void,
  notNow: ReactNode,
): { message: ReactNode; actions: ReactNode } {
  if (state === "off") {
    return {
      message: null,
      actions: (
        <div className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <button type="button" aria-describedby={lineId} onClick={tap(circle.personalize)} className={personalizeButton}>
              {copy.circle.personalize}
            </button>
            {notNow}
          </div>
          <p id={lineId} className={quietLine}>
            {copy.circle.consent}
          </p>
        </div>
      ),
    };
  }
  return {
    message: (
      <p id={lineId} className={quietLine}>
        {state === "busy" ? copy.circle.busy : copy.circle.unavailable}
      </p>
    ),
    actions: (
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        <button type="button" aria-describedby={lineId} onClick={tap(circle.retry)} className={retryButton}>
          {copy.circle.tryAgain}
        </button>
        {notNow}
      </div>
    ),
  };
}

/**
 * Personalize, and the circle getting ready, under the toggle (decisions 8 and 26): for a person signed
 * in whose circle is not ready, the button, with the line under it that says what it does; once tapped,
 * while their add-on or phone app asks them, a line that says so, with Cancel; then the banner while
 * Brainstorm works it out (the brief's screen 11); then a quiet notice that it is ready, which never
 * switches the view. When Brainstorm is busy, the run failed or Brainstorm could not be reached, a quiet
 * line with Try again; House picks works all along. When the returning visitor's look found a scorer
 * with no ranks (unconfirmed), the line that says nobody in their circle has rated places yet, with Work
 * out my circle again, in either view (ruling R10).
 *
 * Where Personalize is offered (`offer`), before the circle is asked for (Avi, 2026-10-08):
 * - `always`: here, always (the Why page, which explains My circle);
 * - `opened`: here, once My circle's half opens it, with Not now beside it (the phone's Explore);
 * - `toggle`: not here: the panel that floats under the toggle offers it (the desktop's Explore).
 * Unless the toggle has its own, this is the page's panel, which My circle's half opens or goes to.
 *
 * What it says is in a polite status that is always there while the panel is, so a screen reader hears
 * each change. A button that goes leaves the focus on the panel, or, where the panel can go with it
 * (asking for the circle can end in off, which it may not offer), on `holdFocus`, the part of the page
 * the panel sits in; Dismiss, which puts the panel away, leaves it there too. Opened from the half, the
 * focus goes to its first button; Not now and Escape close it, and Personalize or Try again too, which
 * leave the focus on the half and on House picks. `className` spaces it from what is around it.
 */
export function Personalize({
  holdFocus,
  offer = "always",
  className = "",
}: {
  holdFocus: RefObject<HTMLElement | null>;
  offer?: "always" | "opened" | "toggle";
  className?: string;
}): JSX.Element | null {
  const { account } = useAccount();
  const circle = useCircle();
  const { openedBy, close, setPagePanel } = useCircleDoor();
  const { youRated } = useCircleEmptiness();
  const panel = useRef<HTMLDivElement>(null);
  const lineId = useId();
  const panelId = useId();

  // The page's own panel, unless the toggle has its own.
  const waits = offer === "opened";
  const pageOwn = offer !== "toggle";
  const focusFirst = useCallback(() => panel.current?.querySelector("button")?.focus(), []);
  useLayoutEffect(
    () => (pageOwn ? setPagePanel({ id: panelId, waits, focus: focusFirst }) : undefined),
    [pageOwn, waits, panelId, focusFirst, setPagePanel],
  );

  // Opened from My circle's half, where it waits for that: the focus goes in, to its first button.
  const opened = waits && openedBy !== null;
  useEffect(() => {
    if (opened) focusFirst();
  }, [opened, focusFirst]);

  if (!config.features.circle || account === undefined) return null;

  /** Runs `act`, with the focus on the panel first: the button pressed is about to go. */
  const fromPanel = (act: () => void) => () => {
    panel.current?.focus({ preventScroll: true });
    act();
  };

  /**
   * Personalize, Try again: from a panel the half opened, which closes, the focus goes to House picks,
   * as the half is off while the circle is asked for. Where off is not offered unopened, the panel goes
   * if asking ends there (the add-on said no): the focus waits on `holdFocus`.
   */
  const start = (act: () => void) => () => {
    if (opened) close("house");
    else (offer === "always" ? panel : holdFocus).current?.focus({ preventScroll: true });
    act();
  };

  const notNow = opened ? (
    <button type="button" onClick={() => close("circle")} className={wordButton}>
      {copy.circle.notNow}
    </button>
  ) : null;

  let message: ReactNode = null;
  let actions: ReactNode = null;
  switch (circle.state) {
    case "checking":
      return null;
    case "off":
    case "busy":
    case "failed":
    case "unavailable":
      if (circle.state === "off" && (offer === "toggle" || (waits && !opened))) return null;
      ({ message, actions } = offered(circle.state, circle, lineId, start, notNow));
      break;
    case "signing":
      message = <p className={quietLine}>{account.how === "phone" ? copy.circle.approvePhone : copy.circle.approveBrowser}</p>;
      actions = (
        <button
          type="button"
          onClick={() => {
            // Back to off, which this panel may not offer: then it goes, and the focus waits on `holdFocus`.
            // An unconfirmed circle worked out again is put back (held), and stays shown here.
            (offer === "always" || circle.held ? panel : holdFocus).current?.focus({ preventScroll: true });
            circle.cancel();
          }}
          className={wordButton}
        >
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
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (opened && event.key === "Escape") close("circle");
  };

  return (
    <div ref={panel} id={panelId} tabIndex={-1} onKeyDown={onKeyDown} className={`flex flex-col items-start outline-none ${className}`}>
      <div role="status" className="w-full">
        {message}
      </div>
      {actions}
    </div>
  );
}

/**
 * The panel My circle's half opens where the page has none of its own (the desktop's top bar, the
 * phone's map), floating under the toggle, in the floating things' ground and shadow: what the door
 * offers, with Not now. Opened, the focus goes to its first button. Personalize and Try again run
 * `onStart` first, which closes it and puts the focus on House picks; Not now runs `onClose`, which
 * closes it and puts the focus back on the half. What it says is in a polite status, as Personalize's is.
 */
export function DoorPanel({
  id,
  className,
  onStart,
  onClose,
}: {
  id: string;
  className: string;
  onStart(): void;
  onClose(): void;
}): JSX.Element | null {
  const circle = useCircle();
  const panel = useRef<HTMLDivElement>(null);
  const lineId = useId();
  useEffect(() => {
    panel.current?.querySelector("button")?.focus();
  }, []);
  if (!offers(circle.state)) return null;

  const tap = (act: () => void) => () => {
    onStart();
    act();
  };
  const notNow = (
    <button type="button" onClick={onClose} className={wordButton}>
      {copy.circle.notNow}
    </button>
  );
  const { message, actions } = offered(circle.state, circle, lineId, tap, notNow);
  return (
    <div ref={panel} id={id} className={`flex flex-col items-start rounded-panel bg-ground p-4 shadow-float ${className}`}>
      <div role="status" className="w-full">
        {message}
      </div>
      {actions}
    </div>
  );
}
