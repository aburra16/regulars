import {
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import { type Account, useAccount } from "../account/AccountProvider.tsx";
import { useOwnPubkey } from "../account/useOwnPubkey.ts";
import { useCircleDoor } from "../circle/CircleDoor.tsx";
import { useCircle } from "../circle/CircleProvider.tsx";
import { DoorPanel, heldKeyPressesNothing } from "../circle/Personalize.tsx";
import { updateWord, updateWords } from "../circle/updateWords.ts";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { formatDay } from "../locale.ts";
import { writtenOn } from "../reviews/when.ts";
import { useLocale } from "../shell/useLocale.ts";
import { quietLine, wordButton } from "../ui/Banner.tsx";
import { Named } from "../ui/Named.tsx";
import { type FollowOf, useFollow } from "./FollowProvider.tsx";

/*
 * The Follow button (decision 44; the design's Trust button, at
 * about half its size: ruling R46): small, beside a reviewer's name on a review, and the main one on
 * a person's page. It says Follow, then Following, and Unfollow before a press takes the follow back
 * (ruling R47, `useUnfollowShown`); and under it, quietly, what the tap left to say: what a follow
 * means for the person's circle, with the way to have it built; that someone is no longer followed,
 * with Undo for ten seconds; and how a change went wrong, with Try again where that helps.
 *
 * It changes nothing itself. A tap of Follow, Unfollow, Undo or Try again asks the session's own
 * list for the change (`useFollow`, ./FollowProvider.tsx), which is `changeFollow`'s from start to
 * end, and what the button says comes from that list. Nothing but a press on the word Unfollow asks
 * for an unfollow: no pointer that moves, no focus that comes, no time that passes
 * (tests/followGuard.test.ts holds the code to the one place that asks). Which change Try again makes
 * again is the list's to say, never read off what the button says now (ruling R27).
 *
 * A change may come back asking: where the person's other apps keep their list could not be
 * reached, and it could only be built on a copy found elsewhere, which may be an old one. Then
 * nothing was changed, and the lines say so, with the day that copy was last changed and two
 * answers. Use this copy is the person's say, and the one press that gives it (the guard holds the
 * code to that too): the session makes the change that asked, on that copy. Not now lets it go. The
 * button itself is as it was before the press, and a press on it is a press, not an answer.
 *
 * Nor does it reach Brainstorm: Update now is the circle's own `update`, and Personalize here only
 * opens Personalize's panel, whose own button is the person's consent (decision 26). Nobody's rank,
 * weight or count is shown (decision 19), and a reviewer the view folds away has the same button
 * and the same lines as anyone.
 *
 * What it draws of a change (`trouble`, `justFollowed`) it only draws: a button on a page just opened
 * may be given, for one drawing, what was said on the page before, so nothing here takes the focus,
 * scrolls or speaks because of them. The focus is moved for a control the person was on, and for no
 * other: a word under the button takes it as it is tapped, where the browser did not give it, and a
 * word that goes with the focus on it leaves the focus on the button or by the lines (`Word`).
 *
 * It is in two parts: the button with what its own changes left to say (`Shown`), and what a follow
 * means for the person's circle, with the door to Personalize (`CircleLines`).
 */

/**
 * How long "Unfollow" stays on the button once a press has shown it, in milliseconds, when nothing
 * takes it back sooner. Ten seconds (ruling R48): time for a second press by someone who cannot make
 * one quickly, with a switch or a screen reader.
 */
export const UNFOLLOW_SHOWN_MS = 10_000;

/**
 * For how long after the press that showed "Unfollow" a press on the button does nothing, in
 * milliseconds: a double tap is one tap. It begins again from each press it takes for none, so three
 * quick taps are one tap too.
 */
export const UNFOLLOW_GUARD_MS = 400;

/**
 * The button's shape (ruling R46), about half the size the design drew it: a pill, small beside a name
 * (28 px tall, in the caption's size of type) and main on a person's page (32 px tall, at the start of
 * its place and as wide as its words, not as its place). Neither changes width with its word (`Face`).
 */
const SHAPE = {
  small: "h-7 shrink-0 rounded-chip px-2.5 text-caption",
  main: "h-8 shrink-0 self-start rounded-button px-4 text-secondary",
} as const;

/**
 * The room a tap has around a pill that is smaller than a touch target (44 px, the tokens' `--touch`):
 * a part of the button itself that is not seen, laid over its middle, as tall and as wide as the pill
 * and never less than 44 px either way. It is no padding: the pill is drawn no bigger, and takes no
 * more room in its row. A tap there is a tap on the button.
 *
 * It reaches past the pill, above and below (8 px for the small one, 6 px for the main one), so what
 * is around the button must leave it that room and cut nothing off (no `overflow` that hides). It has
 * it. Beside a reviewer's name the row is as tall as the picture (40 px on a phone, 44 px on a
 * desktop), and the words under the row begin 10 px or more under the pill. On a person's page the
 * pill is in the middle of the picture's row, or in the side rail, 26 px under the way back, with its
 * words 10 px under it (`Shown`). It is never wider than the pill, whose words make it wider than
 * 44 px, so it reaches over nothing beside it. Two buttons in rows one under the other are a review
 * apart.
 */
const TAP_AREA =
  "relative after:absolute after:top-1/2 after:left-1/2 after:h-full after:w-full after:min-h-touch after:min-w-touch after:-translate-x-1/2 after:-translate-y-1/2";

/** One cell: the button is a grid of one, in which the word it says and the words it can say are laid over each other (`Face`). */
const BUTTON = `inline-grid place-items-center border-token font-text font-bold whitespace-nowrap ${TAP_AREA}`;

/** The one cell of the button's grid. */
const CELL = "col-start-1 row-start-1";

/** Every word the button can say. */
const WORDS = [copy.follow.follow, copy.follow.following, copy.follow.unfollow, copy.follow.saving];

/**
 * What is on the button: the word it says, and under it, unseen and unread, every word it can say.
 * They share the one cell of the button's grid, which is as wide as the widest of them: so the button
 * is as wide for one word as for another, and what is beside it does not move as its word changes.
 * Nothing is measured, so it holds in any face and at any size of type. The unseen words are drawn by
 * the style sheet, each from its element's own `data-word`: they are not in the page's text, nor in
 * the button's name.
 */
function Face({ word }: { word: string }): JSX.Element {
  return (
    <>
      <span className={CELL}>{word}</span>
      {WORDS.map((each) => (
        <span key={each} aria-hidden="true" data-word={each} className={`${CELL} invisible before:content-[attr(data-word)]`} />
      ))}
    </>
  );
}

/**
 * Its colours. Follow and Following are the trust colour's, which is for who the person trusts and
 * nothing else: Follow, an outline when small and a fill when main, as the design draws them;
 * Following, the trust tint, the same in both sizes. Unfollow is not: it is the accent's outline and
 * word on the ground, the colour Closed and the stars have. And quiet while a change is being saved.
 */
const LOOK = {
  follow: { small: "cursor-pointer border-trust bg-ground text-trust", main: "cursor-pointer border-trust bg-trust text-ground" },
  following: "cursor-pointer border-trust bg-trust-tint text-trust-ink",
  unfollow: "cursor-pointer border-accent bg-ground text-accent",
  saving: "cursor-default border-line-strong bg-ground text-muted",
} as const;

/** Where the day goes in the line that asks about a copy (`copy.follow.copyFound`). */
const DAY_MARK = "\u0000";

/**
 * The line that asks about a copy: the size of the quiet lines under the button, no longer than a
 * line of a review, and in the ink a review's words have. It says what the person could lose, and
 * is not the quietest text in its row.
 */
const askingLine = "m-0 max-w-measure text-secondary leading-[1.4] text-ink-soft";

/** The line for each way a change did not simply succeed. */
const TROUBLE: Record<NonNullable<FollowOf["trouble"]>, string> = {
  "not-loaded": copy.follow.notLoaded,
  "not-kept": copy.follow.notKept,
  "not-approved": copy.follow.notApproved,
  "not-saved": copy.follow.notSaved,
  unconfirmed: copy.follow.unconfirmed,
};

export interface FollowButtonProps {
  /** Whom the button is for: their public key, 64 hex digits in either case. */
  pubkey: string;
  /** Their name as the page shows it, for the button's name and its lines. */
  name: string;
  /**
   * `small`, beside a reviewer's name: there only while there is something to tap or to say (see
   * `FollowButton`). `main`, on a person's page: there in every state the list is known in, and a
   * link to sign in for someone signed out.
   */
  size: "small" | "main";
  /**
   * For the main button, where its lines are drawn in place of under it: an element of the page's,
   * which the page puts where the lines have room (a person's page on a phone, where the button is
   * beside the picture and its lines go under the header, as wide as the page). Null while the page
   * has not drawn that element yet: no lines until it has. Left out, the lines are under the button.
   */
  linesIn?: HTMLElement | null;
}

/**
 * The main button's place for someone signed out: a link to sign in, which can come back to this
 * page. It follows nobody by itself: once signed in, the person taps Follow.
 */
function SignInToFollow({ name }: { name: string }): JSX.Element {
  const location = useLocation();
  return (
    <Link
      to="/signin"
      state={{ from: location }}
      aria-label={copy.follow.followNamed(name)}
      className={`${BUTTON} ${SHAPE.main} ${LOOK.follow.main} no-underline`}
    >
      <Face word={copy.follow.follow} />
    </Link>
  );
}

/**
 * What a word is putting the focus on as it goes (`Word`), for as long as that takes: the focus comes
 * to it within the call that moves it, so whatever is told of that focus can ask whether the app
 * moved it. Null at every other time.
 */
let handedTo: Element | null = null;

/**
 * Whether the focus that has just come to `button` is one the keyboard gave it, as the browser tells
 * it (`:focus-visible`): Tab's is, and a click's or a tap's is not. Where the browser cannot tell (it
 * does not know the selector), it is not taken for the keyboard's.
 */
function keyboardGave(button: Element): boolean {
  try {
    return button.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Whether the button says Unfollow, in place of Following, with what tells it so (ruling R47). One
 * rule decides every press, however it is made (`Shown`): a press unfollows only while the button says
 * Unfollow, and a press while it says Following shows Unfollow and changes nothing. So the person
 * has seen the word before the press that acts on it, with a mouse, a finger, a pen, a key or a
 * screen reader. What the button says is drawn from what is held here, and from nothing a style
 * sheet knows (no `:hover`), so that what a press does and what the button said are one thing.
 *
 * It says Unfollow only while `following` (the person is followed, and no change is being saved),
 * and then for any of three reasons:
 * - `pointed`: a mouse is over it, and came onto it while it said Following. Right after a follow the
 *   pointer is on the button still, and it goes on saying Following, so that the person sees the
 *   follow was made; once the pointer has left, coming back shows Unfollow. Only a mouse points
 *   (`pointerType`): a finger and a pen do not hover here, and the mouse's events a browser sends
 *   after a tap are not looked at, so a tap is never taken for a mouse over the button.
 * - `keyed`: the keyboard's focus is on it (`keyboardGave`), and came onto it while it said Following,
 *   by the person's doing. As for the pointer, focus that has stayed since the follow shows nothing;
 *   nor does focus a word handed over as it went (`handedTo`), which the person did not move; nor
 *   focus that comes back with the window, after another window (a signer's, say) was in front of it:
 *   that focus never left the button.
 * - `asked`: a press while it said Following, which shows it for those who cannot point or tab to
 *   it: the first tap on a phone, a click or a key before the pointer or the focus has left. It goes
 *   back to Following by itself after `UNFOLLOW_SHOWN_MS`, on a press anywhere else on the page, when
 *   the button loses the focus, and when the person goes to another page. While it is why the button
 *   says Unfollow (`pressed`), a screen reader is told that the press changed nothing (ruling R48).
 *
 * `guarded` is true for `UNFOLLOW_GUARD_MS` after the press that showed it, whatever became of
 * Unfollow meanwhile: a press on the button in that time does nothing, so a double tap is one tap.
 * Each press it takes for none begins that time again (`guardAgain`), so a run of quick taps is one
 * tap, however long the run.
 *
 * A click is the end of a press, and acts on what the button said as the press began (ruling R49,
 * `beganOff`). A pointer that comes down while the button does not say Unfollow can only show it,
 * whatever the pointer, the focus or a key do before the click: so a browser that reports a finger
 * as a mouse, or calls a tap's own focus the keyboard's, shows Unfollow between the press and its
 * click and still unfollows nobody on that tap. A click no pointer made (a key's, a screen reader's)
 * has no press before it: it acts on what the button says, and leaves what is kept of a pointer's
 * press for that press's own click.
 *
 * What is kept of a press is let go of when its click comes; when the press is cancelled (a scroll
 * that began on the button); and when the next press begins, which is how one that was dragged away
 * and let go elsewhere ends, as every pointer's click has a press of its own just before it. Only a
 * click that counts itself and yet has no press of its own could find such a press still kept: it
 * would show Unfollow, once, and let go of it.
 *
 * Nothing here changes the person's list, or can: it only says which word is shown. Its two timers
 * and its listener on the document are there only while they have something to end, each only takes
 * Unfollow away or ends the guard, and none outlasts the button.
 */
function useUnfollowShown(following: boolean, button: RefObject<HTMLButtonElement | null>) {
  // Where the person is, in the tab's history: another page, or this one come back to, is another key.
  const { key: page } = useLocation();
  const [pointed, setPointed] = useState(false);
  const [keyed, setKeyed] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // The presses the guard is for: the one that showed Unfollow, and each it took for none since. None: no guard.
  const [guardedFor, setGuardedFor] = useState(0);

  // None of it outlasts what it was for. While the person is not followed, or a change is being
  // saved, nothing of it is kept: when the button next says Following, it says so until a pointer or
  // the focus comes to it anew, or a press asks. And a press asked on the page it was made on.
  if (!following && (pointed || keyed || asked !== null)) {
    setPointed(false);
    setKeyed(false);
    setAsked(null);
  } else if (asked !== null && asked !== page) {
    setAsked(null);
  }
  const pressed = following && asked === page;
  const shown = following && (pointed || keyed || pressed);
  // Whether the button said Unfollow as a pointer last came down on it; null once a click has ended that press.
  const down = useRef<boolean | null>(null);
  // Whether the window, and not the focus, went from the button: the focus it has next came back with the window.
  const windowWent = useRef(false);

  useEffect(() => {
    if (!pressed) return;
    const back = () => setAsked(null);
    const timer = setTimeout(back, UNFOLLOW_SHOWN_MS);
    /** A press that is not on the button: before anything on the page can keep it from being heard. */
    const elsewhere = (event: Event) => {
      if (!(event.target instanceof Node) || button.current?.contains(event.target) !== true) back();
    };
    document.addEventListener("pointerdown", elsewhere, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", elsewhere, true);
    };
  }, [pressed, button]);

  // From the last of those presses: each one more ends the time that was running, and begins it again.
  useEffect(() => {
    if (guardedFor === 0) return;
    const timer = setTimeout(() => setGuardedFor(0), UNFOLLOW_GUARD_MS);
    return () => clearTimeout(timer);
  }, [guardedFor]);

  return {
    /** Whether the button says Unfollow. */
    shown,
    /** Whether a press is why it says so: that press changed nothing, which a screen reader is told (`Shown`). */
    pressed,
    guarded: guardedFor > 0,
    /** For a press while the button said Following: shows Unfollow, and begins the guard. It changes nothing else. */
    ask: () => {
      setAsked(page);
      setGuardedFor(1);
    },
    /** For a press the guard took for none: the guard's time begins again from it. */
    guardAgain: () => setGuardedFor((presses) => presses + 1),
    /**
     * For a click: whether the press it ends began while the button did not say Unfollow. A click
     * that counts nothing (`detail` 0) is a key's, a screen reader's or a script's: no pointer came
     * down for it, so it ends no press, and what is kept of one is left for that press's own click (a
     * key pressed while a mouse is held down on Following does not free the mouse's click of it).
     * A pointer's click reads what is kept, and lets go of it.
     */
    beganOff: (click: { detail: number }) => {
      if (click.detail === 0) return false;
      const onUnfollow = down.current;
      down.current = null;
      return onUnfollow === false;
    },
    /** What the button is told of the pointer and of the focus. */
    told: {
      onPointerDown: () => {
        down.current = shown;
      },
      // The press is over, and no click comes of it.
      onPointerCancel: () => {
        down.current = null;
      },
      onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === "mouse") setPointed(following);
      },
      onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === "mouse") setPointed(false);
      },
      onFocus: (event: FocusEvent<HTMLButtonElement>) => {
        const cameBack = windowWent.current;
        windowWent.current = false;
        setKeyed(following && !cameBack && handedTo !== event.currentTarget && keyboardGave(event.currentTarget));
      },
      onBlur: (event: FocusEvent<HTMLButtonElement>) => {
        // When the focus goes to something else, the document's focus is no longer the button's as it
        // is told. When the window goes behind another, it still is, and nothing takes it.
        windowWent.current = event.relatedTarget === null && event.currentTarget.ownerDocument.activeElement === event.currentTarget;
        setKeyed(false);
        setAsked(null);
      },
    },
  };
}

/**
 * A quiet button in words beside a line: Undo, Try again, Update now, Cancel, Personalize. `at` is
 * its element, for what puts the focus on it.
 *
 * Each goes once it has done its work, or when its time is up (Undo's ten seconds; Cancel, once the
 * person's add-on answers), and may have the focus as it does. The focus would drop to the page, so
 * it goes `home` instead: to the button, for a word that is the button's change; by the lines, for
 * one that is the circle's. Looked at once the word is out of the page, as Personalize's panel does
 * (src/circle/Personalize.tsx), so that React's development run of an effect twice moves nothing.
 *
 * That is safe for a word drawn from what was said on the page before (a new page's first drawing):
 * the focus moves only if the word had it as it went, and a word that was drawn and taken away again
 * before the page was shown was never focused by anyone. Nothing is moved because a line came, only
 * because a control the person was on has gone.
 *
 * A word has the focus as it is tapped in most browsers. Safari does not focus a button on a click or
 * a tap, and leaves the focus on nothing: there the word that was tapped would go, and the focus
 * with it. So a tap puts the focus on the word first, where it is not: then a word that goes for the
 * tap (Undo, Try again, Update now, Cancel) leaves the focus home, as above, and one that stays has
 * it, as in the other browsers. It is done in the tap alone: never as a word is drawn, in an effect,
 * or for anything the page before said.
 *
 * The focus a word leaves on the button is the app's doing, not the person's: the button is told so
 * (`handedTo`), and shows nothing for it.
 */
function Word({
  home,
  at,
  onTap,
  children,
  ...aria
}: {
  home: RefObject<HTMLElement | null>;
  at?: RefObject<HTMLButtonElement | null>;
  onTap(): void;
  children: string;
  "aria-describedby"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}): JSX.Element {
  const own = useRef<HTMLButtonElement>(null);
  const word = at ?? own;
  useLayoutEffect(() => {
    const node = word.current;
    return () => {
      if (node === null || node !== document.activeElement) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        const to = home.current;
        if (!node.isConnected && (now === null || now === document.body) && to?.isConnected === true) {
          handedTo = to;
          try {
            to.focus({ preventScroll: true });
          } finally {
            handedTo = null;
          }
        }
      });
    };
  }, [word, home]);
  const tap = () => {
    const node = word.current;
    if (node !== null && node !== document.activeElement) node.focus({ preventScroll: true });
    onTap();
  };
  return (
    <button ref={word} type="button" onClick={tap} className={wordButton} {...aria}>
      {children}
    </button>
  );
}

/**
 * What a follow means for the person's circle, under Following, while My circle is open: a unit of
 * its own under the button, with its own polite status, which is there for as long as the button is
 * (so a screen reader hears each line as it comes) and says something only while `shown`: the person
 * has just followed someone. Following changes My circle only; nothing is said of House picks.
 *
 * With a circle: the follow counts once it is built again. Update now is the circle's own `update`,
 * and what it comes to is said in the Why page's words (`updateWords`), with the word the Why page
 * has beside them (`updateWord`). That the circle was updated lately is drawn outside the status: the
 * bar at the foot of the page says it aloud already (src/circle/CircleNews.tsx), and it is not said
 * twice. Once the circle has been built again there is no more to say here: the bar says it is up
 * to date.
 *
 * Without one: the follow counts once it is built. Personalize opens Personalize's own panel here,
 * through the shell's door (`useCircleDoor`, as a toggle's half does, so one panel is open on a page
 * at a time), and asks Brainstorm nothing: the button in the panel does (decision 26). Not now, Escape
 * and a second tap close it, with the focus back on Personalize. While the tab still looks for a
 * circle built before, nothing is said: there may be one.
 *
 * The door this opened is this unit's, by its own id, and closes when its line goes, however it goes:
 * an unfollow from any button for the person, another page, or the button leaving the page. So a
 * line that comes back later never brings back a panel nobody asked for, which would take the focus
 * to its Personalize without a tap.
 */
function CircleLines({ shown, account }: { shown: boolean; account: Account }): JSX.Element {
  const circle = useCircle();
  const door = useCircleDoor();
  const self = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const doorId = useId();
  const panelId = useId();
  const countsId = useId();

  const said = shown && config.features.circle;
  const built = said && circle.ready;
  const unbuilt = said && !circle.ready && circle.state !== "checking";
  const panelOpen = unbuilt && door.openedBy === doorId;

  // The door, as it stands for this unit at its last drawing: read as its line goes.
  const mine = useRef({ open: false, close: door.close });
  useLayoutEffect(() => {
    mine.current = { open: door.openedBy === doorId, close: door.close };
  });
  // Closes the door this unit opened once its line has gone, or the unit has. It only closes, and
  // only a door that is open for this unit, so it does nothing for a line that was drawn once from
  // what the page before said: nobody has opened a door from that.
  useEffect(() => {
    if (!unbuilt) return;
    return () => {
      if (mine.current.open) mine.current.close();
    };
  }, [unbuilt]);

  /** Closes Personalize's panel, asking Brainstorm nothing, with the focus on what opened it, or by the lines when that has gone. */
  const closePanel = () => {
    (opener.current ?? self.current)?.focus({ preventScroll: true });
    door.close();
  };

  /** What the polite status says, one line under another. */
  const lines: ReactNode[] = [];
  /** A line the bar at the foot of the page says aloud already: drawn, outside the status. */
  let barSays: ReactNode = null;
  let word: ReactNode = null;
  let panel: ReactNode = null;

  if (built && circle.updateStep !== "updated") {
    const step = circle.updateStep;
    lines.push(
      <p key="counts" id={countsId} className={quietLine}>
        {copy.follow.countsAfterUpdate}
      </p>,
    );
    if (step === "recently") {
      barSays = <p className={quietLine}>{copy.circle.recently}</p>;
    } else if (step !== "idle") {
      lines.push(
        <p key="update" className={quietLine}>
          {updateWords(step, account.how)}
        </p>,
      );
    }
    const which = updateWord(step);
    if (which === "cancel") {
      word = (
        <Word key="cancel" home={self} onTap={circle.cancel}>
          {copy.circle.cancel}
        </Word>
      );
    } else if (which === "update") {
      word = (
        <Word key="update" home={self} aria-describedby={countsId} onTap={circle.update}>
          {copy.follow.updateNow}
        </Word>
      );
    }
  } else if (unbuilt) {
    lines.push(
      <p key="counts" id={countsId} className={quietLine}>
        {copy.follow.countsOnceBuilt}
      </p>,
    );
    if (door.door) {
      word = (
        <Word
          key="personalize"
          at={opener}
          home={self}
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? panelId : undefined}
          aria-describedby={countsId}
          onTap={() => (panelOpen ? closePanel() : door.open(doorId))}
        >
          {copy.follow.personalize}
        </Word>
      );
    }
    if (panelOpen) {
      const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") closePanel();
      };
      panel = (
        <div onKeyDown={onKeyDown}>
          <DoorPanel
            id={panelId}
            className="mt-1 w-full max-w-[340px]"
            onLeave={() => self.current?.focus({ preventScroll: true })}
            onClose={closePanel}
          />
        </div>
      );
    }
  }

  const any = lines.length > 0 || barSays !== null || word !== null;
  return (
    // No ring: it holds the focus only when a word under it has gone with the focus on it.
    <div ref={self} tabIndex={-1} className="outline-none">
      <div className={`flex flex-wrap items-center gap-x-4 ${any ? "pt-1" : ""}`}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div role="status" className="flex flex-col gap-0.5">
            {lines}
          </div>
          {barSays}
        </div>
        {word}
      </div>
      {panel}
    </div>
  );
}

/**
 * The button once there is one to show, for the person signed in as `account`, with what its own
 * changes left to say under it, and under that what a follow means for the person's circle
 * (`CircleLines`).
 *
 * It is one button throughout, so the focus stays on it through a change: off while the change is
 * saved, never gone. Its name says where it stands, as the word on it does ("Follow Maya", "Following
 * Maya. Unfollow", "Unfollow Maya"), so it has no pressed state beside it (ruling R29). A key held
 * down on it, or on a word under it, makes no second change once the first has ended
 * (`heldKeyPressesNothing`).
 *
 * One rule decides what a press does to someone followed, however it is made (ruling R47): it
 * unfollows only if the button said Unfollow as it was pressed, and if it said Following it shows
 * Unfollow and changes nothing (`useUnfollowShown`). `onPress` is the one place that asks for an
 * unfollow, and it goes by the word this drawing put on the button, which is the word the person
 * pressed. A press that only showed Unfollow is answered for a screen reader, in the status below:
 * "Press again to unfollow Maya." (ruling R48).
 *
 * Its lines are in a polite status that is there for as long as the button is: how the last change
 * went wrong, with Try again for one that was not made, which makes that same change again (`retry`);
 * and that someone is no longer followed, with Undo. While Undo is offered it is the way to try
 * again, as is a tap of Follow, both of which put back what the unfollow took out (rulings R22, R28).
 * Undo and Try again go as they are tapped, and leave the focus on the button.
 *
 * While the person is asked about a change to this one (`asking`), that is what the status says, in
 * place of the rest: that the copy found may be an old one, with the day it was last changed, as
 * their language writes a day and by their own clock, and never how many people it holds. Under it
 * are its two answers, words like the others: Not now, which changes nothing and comes first, and
 * Use this copy, which `onUseThisCopy` runs and nothing else does. Each goes as it is tapped, and
 * leaves the focus on the button; as the asking comes, the focus stays on the button, which the
 * person pressed. Undo's line is not drawn meanwhile: when Undo is what asked, Use this copy is
 * that Undo, and Not now gives the line back for what is left of its time. A press of the button
 * itself is no answer: it asks again, for the change that asked.
 *
 * The main button's lines are under it, or in `linesIn` when the page gives a place for them: the
 * same lines, with the same words and the same focus, drawn there.
 */
function Shown({
  name,
  size,
  of,
  account,
  linesIn,
  onUsed,
}: {
  name: string;
  size: "small" | "main";
  of: FollowOf;
  account: Account;
  linesIn: HTMLElement | null | undefined;
  onUsed(): void;
}): JSX.Element {
  const { clearUpdate } = useCircle();
  const locale = useLocale();
  const button = useRef<HTMLButtonElement>(null);
  const troubleId = useId();
  const undoId = useId();
  const askingId = useId();

  const { state, trouble, canUndo, justFollowed, asking } = of;
  const saving = state === "saving";
  const following = state === "following";
  const unfollow = useUnfollowShown(following, button);

  const onPress = (event: MouseEvent<HTMLButtonElement>) => {
    const beganOff = unfollow.beganOff(event);
    // Off while a change is saved.
    if (saving) return;
    // A press too soon after the one that showed Unfollow is none, and so is one too soon after that.
    if (unfollow.guarded) {
      unfollow.guardAgain();
      return;
    }
    if (following) {
      // It says Following, or said so as this press began: the press shows Unfollow, and that is all it does.
      if (!unfollow.shown || beganOff) {
        unfollow.ask();
        return;
      }
      // It says Unfollow, and did as the press began: the one place an unfollow is asked for.
      onUsed();
      of.unfollow();
      return;
    }
    onUsed();
    // What Update now last came to was said of the circle as it was before this follow, so it is let
    // go of: the line under Following says what this follow needs (ruling R24). Only for a follow
    // that adds the person, which the list says: a Follow in Undo's ten seconds puts back what was
    // there, and adds nobody.
    if (of.follow()) clearUpdate();
  };

  const tryAgain = () => {
    onUsed();
    // The change that failed may be a follow, an unfollow or an Undo: which, the list says, as for
    // a tap of Follow.
    if (of.retry()) clearUpdate();
  };

  const undo = () => {
    onUsed();
    of.undo();
  };

  // The person's answer to being asked about a copy: the one place that gives it, and the tap of
  // Use this copy is the one thing that runs it. Which change it makes is the session's to say:
  // the one that asked. A follow among them adds the person, as a tap of Follow does (ruling R24).
  const onUseThisCopy = () => {
    onUsed();
    if (of.useThisCopy()) clearUpdate();
  };

  /** What the polite status says, one line under another. */
  const lines: ReactNode[] = [];
  /** The word beside them, or the asking's two. Otherwise one at most: Try again is not offered while Undo is. */
  let word: ReactNode = null;

  if (asking !== null) {
    // The words are the copy's, and the day is drawn where the line puts it: as one thing, never
    // broken across two lines, and marked with the moment it stands for when a date can hold that.
    const [before = "", after = ""] = copy.follow.copyFound(DAY_MARK).split(DAY_MARK);
    lines.push(
      <p key="asking" id={askingId} className={askingLine}>
        {before}
        <time dateTime={writtenOn(asking.changed)?.toISOString()} className="whitespace-nowrap">
          {formatDay(asking.changed, locale)}
        </time>
        {after}
      </p>,
    );
    word = (
      // The two answers, in a row of their own under the line, whatever room there is beside it. The
      // one that changes nothing comes first, as the one that keeps a list does where a copy is put back.
      <div key="answers" className="flex basis-full flex-wrap gap-x-4">
        <Word home={button} aria-describedby={askingId} onTap={of.notNow}>
          {copy.follow.notNow}
        </Word>
        <Word home={button} aria-describedby={askingId} onTap={onUseThisCopy}>
          {copy.follow.useThisCopy}
        </Word>
      </div>
    );
  } else if (trouble !== null) {
    lines.push(
      <p key="trouble" id={troubleId} className={quietLine}>
        {TROUBLE[trouble]}
      </p>,
    );
    // Saved, but not checked: there is nothing to try again.
    if (trouble !== "unconfirmed" && !canUndo) {
      word = (
        <Word key="retry" home={button} aria-describedby={troubleId} onTap={tryAgain}>
          {copy.follow.tryAgain}
        </Word>
      );
    }
  }

  if (canUndo && asking === null) {
    lines.push(
      <p key="undo" id={undoId} className={quietLine}>
        <Named line={copy.follow.unfollowed} name={name} />
      </p>,
    );
    word = (
      <Word key="undo" home={button} aria-describedby={undoId} onTap={undo}>
        {copy.follow.undo}
      </Word>
    );
  }

  // A press that showed Unfollow changed the button's name and nothing else, which a screen reader
  // may not say again: so the press is answered in words, in the status of the button's own lines,
  // where it is said once as it comes (ruling R48). Heard and not seen: the word on the button says
  // it to the eye. It is there for as long as that press is why the button says Unfollow, and no
  // longer; not for a mouse over the button or the keyboard's focus coming to it, which press nothing.
  const again = unfollow.pressed ? (
    <p key="again" className="sr-only">
      <Named line={copy.follow.pressAgain} name={name} />
    </p>
  ) : null;

  /** What it says, its name for a screen reader (the word on it is its name while a change is saved), and its colours. */
  let face: { word: string; named: string | undefined; look: string };
  if (saving) face = { word: copy.follow.saving, named: undefined, look: LOOK.saving };
  else if (!following) face = { word: copy.follow.follow, named: copy.follow.followNamed(name), look: LOOK.follow[size] };
  else if (unfollow.shown) face = { word: copy.follow.unfollow, named: copy.follow.unfollowNamed(name), look: LOOK.unfollow };
  else face = { word: copy.follow.following, named: copy.follow.followingNamed(name), look: LOOK.following };
  const drawn = (
    <button
      ref={button}
      type="button"
      aria-label={face.named}
      // Off, not gone, while the change is saved: the focus stays on it.
      aria-disabled={saving ? true : undefined}
      onClick={onPress}
      onKeyDown={heldKeyPressesNothing}
      {...unfollow.told}
      className={`${BUTTON} ${SHAPE[size]} ${face.look}`}
    >
      <Face word={face.word} />
    </button>
  );

  const under = (
    <div
      onKeyDown={heldKeyPressesNothing}
      // Small, in the first row of a review, which wraps: its lines take a row of their own, under it.
      className={`min-w-0 ${size === "small" ? "order-last basis-full" : ""}`}
    >
      <div className={`flex flex-wrap items-center gap-x-4 ${lines.length > 0 ? "pt-1" : ""}`}>
        {/* Always there while the button is, so a screen reader hears each line as it comes. Empty, it takes no room. */}
        <div role="status" className="flex min-w-0 flex-col gap-0.5">
          {lines}
          {again}
        </div>
        {word}
      </div>
      <CircleLines shown={justFollowed} account={account} />
    </div>
  );

  if (size === "small") {
    return (
      <>
        {drawn}
        {under}
      </>
    );
  }
  return (
    // The button is at the start of its place, as wide as its words; its lines are as wide as the place.
    // Six pixels between them: with the four the lines begin with, the words under the button begin
    // 10 px under the pill, 4 px past where the room it has to tap ends (6 px under the pill), which
    // is the margin the small one has on a desktop.
    <div className="flex min-w-0 flex-col gap-1.5">
      {drawn}
      {linesIn === undefined ? under : linesIn !== null && createPortal(under, linesIn)}
    </div>
  );
}

/**
 * The Follow button for the person whose key is `pubkey`, named `name`, with its lines under it.
 *
 * It never shows for the person signed in themself, nor while their own list of who they follow is
 * not known (it has not been read, or could not be): never a wrong state. It shows from a copy of
 * that list the person has not agreed to yet, when that is what the session holds: a press then
 * asks before anything is changed. Signed out, there is no small one, and the main one is a link to
 * sign in.
 *
 * `small` is there only while there is something to tap or to say: the reviewer is not followed
 * (Follow, with Undo under it for ten seconds after an unfollow); a change to them is being saved; or
 * they were just followed here, a change to them went wrong, the person is asked about one, or this
 * button was tapped, and it says Following. Someone followed before the page was opened has no small
 * button. It gives the row it is in two things: the button, and its lines, which take a row of their
 * own under it where the row wraps. `main` is there in each of those states, and for someone
 * followed all along; its lines are under it, or where the page says (`linesIn`).
 *
 * While Follow is not open (`config.features.follow`, ruling R39) it draws nothing, in either size,
 * for anyone: no button, and no link to sign in.
 *
 * It must be inside the app's shell, whose door to My circle Personalize opens (`CircleDoorProvider`).
 */
export function FollowButton({ pubkey, name, size, linesIn }: FollowButtonProps): JSX.Element | null {
  const { account, restoring } = useAccount();
  const me = useOwnPubkey();
  const of = useFollow(pubkey);
  const who = pubkey.toLowerCase();
  // Whom this button was last tapped for: it stays for them once the tap's lines have gone (after
  // Undo, which leaves nothing to say), for as long as it is drawn.
  const [usedFor, setUsedFor] = useState<string | null>(null);

  if (!config.features.follow) return null;
  if (me === who) return null;
  if (account === undefined) return size === "main" && !restoring ? <SignInToFollow name={name} /> : null;
  if (of.state === "unknown") return null;
  const quiet = of.state === "following" && !of.justFollowed && of.trouble === null && of.asking === null && usedFor !== who;
  if (size === "small" && quiet) return null;
  // A button of its own for each person: what one was shown, or pressed for, is never another's.
  return <Shown key={who} name={name} size={size} of={of} account={account} linesIn={size === "main" ? linesIn : undefined} onUsed={() => setUsedFor(who)} />;
}
