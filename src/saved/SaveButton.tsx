import { type JSX, type ReactNode, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { heldKeyPressesNothing } from "../circle/Personalize.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import type { Place } from "../places/place.ts";
import { quietLine, wordButton } from "../ui/Banner.tsx";
import { SavedFilledIcon, SavedIcon } from "../ui/icons.tsx";
import { type SavedLine, useSaved } from "./SavedProvider.tsx";

/*
 * The Save button on a place's page: the bookmark at the top right of a phone's page, and Save among
 * the desktop rail's actions (both the design's). Signed out, it is a link to sign in, which comes
 * back to the place and saves nothing: once signed in, the person presses Save themself. Signed in,
 * it is a toggle: Save, with the bookmark outlined, and Saved, with it filled; a press of Saved takes
 * the place out of the list. While a change is made it says Saving…, and a press does nothing.
 *
 * It changes nothing itself. A press asks the session's own list for the change (`useSaved`,
 * ./SavedProvider.tsx), which is `changeSaved`'s from start to end, and what the button says comes
 * from that list. Nothing but a press asks for a change: no page that opens, no sign-in, no read.
 *
 * Under it, quietly, what the press left to say: how a change was not made, with Try again, which
 * makes that change again; or, after a save that put the first place in the list, that the list is
 * public, with the way to Saved. On a phone the lines are under the page's header, as wide as the
 * page, and on a desktop under the row of the rail's actions: wherever the page puts them (`linesIn`).
 * On a phone, Saving… is a line there too while a change is made, as the bookmark has no word to say
 * it with; the line the change leaves, if any, takes its place. They are in a polite status that is
 * there for as long as the button is, so a screen reader hears each as it comes. Try again goes as it
 * is pressed, and leaves the focus on the button.
 */

/** The phone's bookmark: a touch target (44 px) around the 22 px icon, at the top right of the page. */
const PHONE = "flex size-11 shrink-0 items-center justify-center";

/**
 * A button of the desktop's rail, as src/place/Actions.tsx draws Directions, Call and Website beside
 * it (the design): 48 px, a 1.5 px edge, the word alone.
 */
const RAIL = "flex h-12 min-w-0 items-center justify-center gap-1.5 rounded-tile border-token px-2 text-secondary font-bold no-underline";

/**
 * Its colours. The phone's bookmark is in the ink, outlined or filled; the rail's Save is outlined,
 * as the rail's other actions are, and Saved filled with the emphasis, the fill that marks a choice
 * (an ink fill would turn light in the dark theme). Both quiet while a change is made.
 */
const LOOK = {
  phone: { shown: "cursor-pointer text-ink", saving: "cursor-default text-muted" },
  rail: {
    save: "cursor-pointer border-ink text-ink",
    saved: "cursor-pointer border-emphasis bg-emphasis text-on-emphasis",
    saving: "cursor-default border-line-strong text-muted",
  },
} as const;

/** The line for each way a change was not made: under a Save button, and under Remove from list on the Saved page. */
export const NOT_MADE: Record<Exclude<SavedLine, "first-save">, string> = {
  "not-loaded": copy.saved.notLoaded,
  "not-approved": copy.saved.notApproved,
  "not-saved": copy.saved.notSaved,
};

export interface SaveButtonProps {
  /** The place the button saves. */
  place: Place;
  /** `phone`, the bookmark at the top right of a phone's page; `rail`, the word among the desktop rail's actions. */
  look: "phone" | "rail";
  /**
   * Where its lines are drawn in place of right after it: an element of the page's, which the page puts
   * where the lines have room (under a phone's header; under the rail's row of actions). Null while the
   * page has not drawn that element yet: no lines until it has.
   */
  linesIn?: HTMLElement | null;
}

/** The button's place for someone signed out: a link to sign in, which can come back to this page. It saves nothing by itself. */
function SignInToSave({ look }: Pick<SaveButtonProps, "look">): JSX.Element {
  const location = useLocation();
  if (look === "phone") {
    return (
      <Link to="/signin" state={{ from: location }} aria-label={copy.place.save} className={`${PHONE} text-ink`}>
        <SavedIcon size={22} />
      </Link>
    );
  }
  return (
    <Link to="/signin" state={{ from: location }} className={`${RAIL} border-ink text-ink`}>
      {copy.place.saveShort}
    </Link>
  );
}

/**
 * The toggle, for someone signed in, with what its own changes left to say. It is one button
 * throughout, so the focus stays on it through a change: off while the change is made, never gone. A
 * key held down on it, or on Try again, makes no second change once the first has ended
 * (`heldKeyPressesNothing`).
 *
 * Its name for a screen reader is Save in either state, on a phone and in the rail alike, with whether
 * it is pressed: the rail's word to see says Saved once the place is saved, and its name stays Save.
 * While a change is made, Saving…, and it says pressed or not as it did before the press, until the
 * list says otherwise.
 */
function Shown({ place, look, linesIn }: SaveButtonProps): JSX.Element {
  const of = useSaved(place);
  const button = useRef<HTMLButtonElement>(null);
  const lineId = useId();
  const saving = of.state === "saving";
  // Pressed as the list has it; while a change is made, as it was before the press.
  const [pressed, setPressed] = useState(of.state === "saved");
  if (!saving && pressed !== (of.state === "saved")) setPressed(of.state === "saved");

  const onPress = () => {
    // Off while a change is made.
    if (!saving) of.press();
  };

  const tryAgain = () => {
    // Try again goes as it is pressed: the focus goes to the button first, which stays.
    button.current?.focus({ preventScroll: true });
    of.retry();
  };

  let line: ReactNode = null;
  let word: ReactNode = null;
  if (saving) {
    // The bookmark has no word: on a phone, Saving… is said under the header. The rail's word says it.
    if (look === "phone") line = <p className={quietLine}>{copy.saved.saving}</p>;
  } else if (of.line === "first-save") {
    line = (
      <p id={lineId} className={quietLine}>
        {copy.saved.firstSave}
      </p>
    );
    word = (
      <Link to="/saved" aria-describedby={lineId} className={wordButton}>
        {copy.saved.seeSaved}
      </Link>
    );
  } else if (of.line !== undefined) {
    line = (
      <p id={lineId} className={quietLine}>
        {NOT_MADE[of.line]}
      </p>
    );
    word = (
      <button type="button" aria-describedby={lineId} onClick={tryAgain} className={wordButton}>
        {copy.saved.tryAgain}
      </button>
    );
  }

  const under = (
    <div onKeyDown={heldKeyPressesNothing} className="flex min-w-0 flex-wrap items-center gap-x-4">
      {/* Always there while the button is, so a screen reader hears each line as it comes. Empty, it takes no room. */}
      <div role="status" className="min-w-0">
        {line}
      </div>
      {word}
    </div>
  );

  // Its name in either look: Save, saved or not, as `aria-pressed` says which; Saving… while a change is made.
  const named = saving ? copy.saved.saving : copy.saved.save;
  let face: ReactNode;
  let looks: string;
  if (look === "phone") {
    face = pressed ? <SavedFilledIcon size={22} /> : <SavedIcon size={22} />;
    looks = `${PHONE} ${saving ? LOOK.phone.saving : LOOK.phone.shown}`;
  } else {
    // The word to see: Saved once the place is saved. Its name stays Save.
    face = saving ? copy.saved.saving : pressed ? copy.saved.saved : copy.saved.save;
    looks = `${RAIL} ${saving ? LOOK.rail.saving : pressed ? LOOK.rail.saved : LOOK.rail.save}`;
  }

  const drawn = (
    <button
      ref={button}
      type="button"
      aria-pressed={pressed}
      aria-label={named}
      // Off, not gone, while the change is made: the focus stays on it.
      aria-disabled={saving ? true : undefined}
      onClick={onPress}
      onKeyDown={heldKeyPressesNothing}
      className={looks}
    >
      {face}
    </button>
  );

  return (
    <>
      {drawn}
      {linesIn === undefined ? under : linesIn !== null && createPortal(under, linesIn)}
    </>
  );
}

/**
 * The Save button for `place`, as `look` draws it, with its lines where the page puts them
 * (`linesIn`). Signed out, a link to sign in; while a session this tab kept is restored, nothing, as
 * the person is about to be signed in. While saving is not open (`config.features.saved`) it draws
 * nothing, for anyone.
 */
export function SaveButton({ place, look, linesIn }: SaveButtonProps): JSX.Element | null {
  const { account, restoring } = useAccount();
  if (!config.features.saved) return null;
  if (account === undefined) return restoring ? null : <SignInToSave look={look} />;
  // A button of its own for each place: what one place's button was pressed for is never another's.
  return <Shown key={place.address} place={place} look={look} linesIn={linesIn} />;
}
