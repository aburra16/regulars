import type { NostrEvent } from "@nostrify/nostrify";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../src/circle/brainstorm";
import { useCircleDoor } from "../src/circle/CircleDoor";
import { CircleContext, type CircleValue, POLL_MS } from "../src/circle/CircleProvider";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { changeFollow, type FollowOutcome } from "../src/follow/change";
import { FollowButton, UNFOLLOW_GUARD_MS, UNFOLLOW_SHOWN_MS } from "../src/follow/FollowButton";
import { UNDO_MS } from "../src/follow/FollowProvider";
import { TOWNS_WAIT_MS } from "../src/places/store";
import { pubkeyAt } from "./fixtures/follow-list";
import { barRegion } from "./support/app";
import { gate, openPageInShell, signedInAs } from "./support/followPage";
import {
  after,
  askedOf,
  CIRCLE_RELAY,
  CIRCLE_SCORER,
  circleKept,
  endScene,
  focusRingsAlwaysOn,
  FOLLOWED,
  FRIEND,
  FRIEND_AT,
  type Hands,
  LIST,
  listOf,
  type Logs,
  ME,
  OUTSIDER,
  person,
  played,
  PUT_BACK,
  SECRET,
  slowPerson,
  startScene,
  STRANGER,
  TAKEN_OUT,
  tap,
  UNFOLLOWED,
  unfollowByMouse,
  unfollowInTwo,
  WITH_STRANGER,
  WITHOUT_FRIEND,
} from "./support/followScene";
import { shapedEvent } from "./support/events";
import { asksForList, BIG, DIRECTORY, everywhere, FOLLOW_RELAYS, NOS, relay, world as followWorld, type World as FollowWorld } from "./support/followWorld";

/*
 * The Follow button (src/follow/FollowButton.tsx), on a page of the test's own inside the app's
 * shell: small as beside a reviewer's name, and the main one a person's page has. These hold it to
 * what it says in each state, and to whom; to its size, and the room it has to tap (ruling R46); to
 * when the small one shows at all; to saying Unfollow before a press unfollows, for a mouse, a
 * finger, a pen and the keyboard (ruling R47); to its lines (how a change went wrong, with Try again;
 * Undo; and what a follow means for the person's circle); and to what it may set off: a change to the
 * list only on its own taps, Brainstorm only on Update now or on the tap in Personalize's own panel.
 * (tests/followOnPlace.test.tsx has it on the real page of a place.)
 *
 * A mouse here is the test's `person()`: its pointer stays where it last was, so a click on a button
 * the pointer is not on comes onto it first, as a mouse does. A finger is `tap`. Whether the focus is
 * the keyboard's is answered by a stand-in for the browser's `:focus-visible`
 * (tests/support/followScene.ts): Tab's focus is, a click's and a tap's are not.
 *
 * The change itself is `changeFollow`'s (tests/followChange.test.ts). Here it is the real one over
 * relays held in memory, unless a test plays it (`nextChange`), to end it as it likes. Brainstorm's
 * client is mocked: each of its network calls is a stand-in that a test can count. The keys are
 * thrown away, and nothing opens a socket or reaches the network (tests/setup.ts).
 */

vi.mock("../src/follow/change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/change")>();
  return { ...actual, changeFollow: vi.fn(actual.changeFollow) };
});
const change = vi.mocked(changeFollow);
const { nextChange, asked } = played(change);

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);
/** How many times each call that reaches Brainstorm was made: its setup, its sign-in, a run asked about, a run started. */
const askedOfBrainstorm = askedOf(brainstorm);

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
});

afterEach(() => endScene(logs));

// ---------------------------------------------------------------------------------------------
// A page of the test's own, inside the app's shell: buttons for whom it likes, in either size.
// ---------------------------------------------------------------------------------------------

interface Shown {
  pubkey: string;
  name: string;
  size: "small" | "main";
}

let showButtons: (buttons: Record<string, Shown>) => void;

/**
 * The buttons a test asks for, each in a part of the page named as the test names it; `showButtons`
 * draws others. And whether the shell's door to My circle is open for anything, in a word.
 */
function Buttons({ first }: { first: Record<string, Shown> }): JSX.Element {
  const [buttons, setButtons] = useState(first);
  showButtons = (next) => act(() => setButtons(next));
  const door = useCircleDoor();
  return (
    <>
      <output data-testid="door">{door.openedBy === null ? "closed" : "open"}</output>
      {Object.entries(buttons).map(([label, button]) => (
        <section key={label} aria-label={label}>
          <FollowButton {...button} />
        </section>
      ))}
    </>
  );
}

/** The three follow-list relays, each holding the person's list, and the relay their circle's scorer writes to. */
const relays = (events: NostrEvent[] = [LIST]): FollowWorld =>
  followWorld({ ...everywhere(events).relays, [CIRCLE_RELAY]: relay() });

/** A circle of the test's own, in place of the provider's: where it stands, and what its taps were. */
function circleOf(over: Partial<CircleValue>): CircleValue {
  return {
    state: "ready",
    ready: true,
    scorer: { pubkey: CIRCLE_SCORER, relay: CIRCLE_RELAY },
    news: null,
    held: false,
    updateStep: "idle",
    edition: 0,
    personalize: vi.fn(),
    retry: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    clearUpdate: vi.fn(),
    ...over,
  };
}

interface PageOptions {
  /** The relays. Default: the three follow-list relays with the person's list, and their circle's. */
  w?: FollowWorld;
  /** A circle in place of the provider's. Default: the provider's own. */
  circle?: CircleValue;
}

/** Opens the test's page with `buttons`, for the person this tab kept signed in (`signedInAs`), or for nobody. */
async function openButtons(buttons: Record<string, Shown>, { w = relays(), circle }: PageOptions = {}) {
  // The scores store reads nothing of its own on this page: every read is the follow list's, or the circle's.
  config.houseTrustRelays = [];
  // A circle of the test's own is one My circle is open for.
  if (circle !== undefined) config.features.circle = true;
  const page = await openPageInShell(w, <Buttons first={buttons} />, (app) =>
    circle === undefined ? app : <CircleContext value={circle}>{app}</CircleContext>,
  );
  return { ...page, w };
}

const MAIN: Shown = { pubkey: STRANGER, name: "Sol", size: "main" };
const SMALL: Shown = { pubkey: STRANGER, name: "Sol", size: "small" };
const MAIN_FRIEND: Shown = { pubkey: FRIEND, name: "Fay", size: "main" };

/** Every word the button can say. */
const WORDS = [copy.follow.follow, copy.follow.following, copy.follow.unfollow, copy.follow.saving];

const part = (label: string) => screen.getByRole("region", { name: label });
/** The Follow button of a part of the page, whatever it says; null when the part has none. */
const buttonIn = (label: string) =>
  within(part(label))
    .queryAllByRole("button")
    .find((each) => WORDS.includes(each.textContent ?? "")) ?? null;
/**
 * The two polite statuses under a part's button: the first says how a change went wrong and who is no
 * longer followed; the second, what a follow means for the person's circle. (Personalize's panel has
 * one of its own after them, while it is open.)
 */
const changeSaid = (label: string) => within(part(label)).getAllByRole("status")[0]!;
const circleSaid = (label: string) => within(part(label)).getAllByRole("status")[1]!;
/** Neither says anything. */
function expectNothingSaid(label: string): void {
  expect(changeSaid(label)).toBeEmptyDOMElement();
  expect(circleSaid(label)).toBeEmptyDOMElement();
}
/** A button in words under a part's button, by its name (Update now, Undo, Try again ...); null when it is not there. */
const wordIn = (label: string, name: string) => within(part(label)).queryByRole("button", { name });
/** Whether the shell's door to My circle is open, for a toggle or for a Follow button's Personalize. */
const doorNow = () => screen.getByTestId("door").textContent;

/** The page with `buttons`, for the person signed in, once their list has been read: the first of its parts has its button. */
async function opened(buttons: Record<string, Shown> = { it: MAIN }, opts: PageOptions = {}) {
  signedInAs(SECRET);
  const page = await openButtons(buttons, opts);
  const first = Object.keys(buttons)[0]!;
  await waitFor(() => expect(buttonIn(first)).not.toBeNull());
  // The places store's short wait for the towns is over: no timer is running but those these tests start.
  await after(TOWNS_WAIT_MS);
  return page;
}

/**
 * The page once the stranger has been followed from the button in `label`, by a change the test
 * played, with a mouse that has gone from the button since: the focus is on the button, and no
 * pointer is. What comes onto the button after that comes onto one that says Following.
 */
async function followed(buttons: Record<string, Shown> = { it: MAIN }, opts: PageOptions = {}, label = "it") {
  const page = await opened(buttons, opts);
  const follow = nextChange();
  const mouse = person();
  await mouse.click(buttonIn(label)!);
  await follow.ends(FOLLOWED);
  expect(buttonIn(label)).toHaveTextContent(copy.follow.following);
  await mouse.unhover(buttonIn(label)!);
  return page;
}

// ---------------------------------------------------------------------------------------------

describe("what the button says, and to whom", () => {
  it.each([
    ["the small one", SMALL, "h-7"],
    ["the main one", MAIN, "h-8"],
  ])("is Follow, Saving… and Following in turn for %s, as tall in each, and the focus stays on it through the change", async (_, shown, tall) => {
    const user = person();
    await opened({ it: shown });

    // Not followed: Follow, named with whom for a screen reader. Its name says where it stands, as
    // the word on it does: it is no toggle that is pressed or not (ruling R29).
    const button = buttonIn("it")!;
    expect(button).toHaveTextContent(copy.follow.follow);
    expect(button).toHaveAccessibleName(copy.follow.followNamed("Sol"));
    expect(button).not.toHaveAttribute("aria-pressed");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass(tall);
    expectNothingSaid("it");

    // Being saved: it says so, is off, and a tap on it does nothing.
    const follow = nextChange();
    await user.click(button);
    expect(buttonIn("it")).toBe(button);
    expect(button).toHaveTextContent(copy.follow.saving);
    expect(button).toHaveAccessibleName(copy.follow.saving);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("aria-pressed");
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await user.click(button);
    expect(change).toHaveBeenCalledTimes(1);
    expect(asked(0)).toEqual({ who: STRANGER, action: "follow" });

    // Followed: Following, named with whom and with what a tap does.
    await follow.ends(FOLLOWED);
    expect(buttonIn("it")).toBe(button);
    expect(button).toHaveTextContent(copy.follow.following);
    expect(button).toHaveAccessibleName(copy.follow.followingNamed("Sol"));
    expect(copy.follow.followingNamed("Sol")).toBe("Following Sol. Unfollow");
    expect(button).not.toHaveAttribute("aria-pressed");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toHaveClass(tall);
    expect(button).toHaveFocus();
  });

  it.each([
    ["the small one", SMALL],
    ["the main one", MAIN],
  ])("makes one change for Enter held down on %s: the key, still down once the follow is saved, does not take it back", async (_, shown) => {
    const user = person();
    await opened({ it: shown });
    // The follow ends as soon as it is asked for: the key is still down when the button says Following.
    change.mockResolvedValueOnce(FOLLOWED);
    act(() => buttonIn("it")!.focus());

    await user.keyboard("{Enter>6/}");

    await waitFor(() => expect(buttonIn("it")).toHaveTextContent(copy.follow.following));
    expect(change).toHaveBeenCalledTimes(1);
    expect(asked(0)).toEqual({ who: STRANGER, action: "follow" });
    // Two presses of its own take it back (ruling R47): the focus has stayed on it since the follow, so
    // the first shows Unfollow, and the second is on that.
    const unfollow = nextChange();
    await unfollowInTwo(() => user.keyboard("{Enter}"), buttonIn("it")!);
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual({ who: STRANGER, action: "unfollow" });
    await unfollow.ends({ kind: "not-approved" });
  });

  it("shows the main one for someone followed already, and no small one: nothing has just been said of them", async () => {
    await opened({ rail: MAIN_FRIEND, review: { ...MAIN_FRIEND, size: "small" } });

    expect(buttonIn("rail")).toHaveTextContent(copy.follow.following);
    expect(buttonIn("rail")).toHaveAccessibleName(copy.follow.followingNamed("Fay"));
    expect(part("review")).toBeEmptyDOMElement();
  });

  it("shows neither for the person themself, whatever case their key is written in", async () => {
    await opened({ stranger: MAIN, mine: { pubkey: ME, name: "Maya", size: "main" }, upper: { pubkey: ME.toUpperCase(), name: "Maya", size: "small" } });

    expect(buttonIn("stranger")).toHaveTextContent(copy.follow.follow);
    expect(part("mine")).toBeEmptyDOMElement();
    expect(part("upper")).toBeEmptyDOMElement();
  });

  it("shows neither until the person's list has been read, and then says what the list says", async () => {
    signedInAs(SECRET);
    const w = relays();
    const answer = gate();
    for (const url of FOLLOW_RELAYS) w.relays[url]!.holds = answer.closed;

    await openButtons({ main: MAIN, small: SMALL, friend: MAIN_FRIEND }, { w });
    await waitFor(() => expect(w.asked().filter(asksForList)).toHaveLength(3));
    for (const label of ["main", "small", "friend"]) expect(part(label)).toBeEmptyDOMElement();

    await answer.open();
    await waitFor(() => expect(buttonIn("main")).toHaveTextContent(copy.follow.follow));
    expect(buttonIn("small")).toHaveTextContent(copy.follow.follow);
    expect(buttonIn("friend")).toHaveTextContent(copy.follow.following);
    expect(change).not.toHaveBeenCalled();
  });

  it("shows neither when the list can't be read: no button says what might be wrong", async () => {
    signedInAs(SECRET);
    const w = relays();
    // No relay can send a list just now; each answers the rest, the person's relay list among it.
    for (const url of FOLLOW_RELAYS) w.relays[url]!.listsDown = true;

    await openButtons({ main: MAIN, small: SMALL }, { w });
    await waitFor(() => expect(w.asked().filter(asksForList)).toHaveLength(3));
    await after(TOWNS_WAIT_MS);

    expect(part("main")).toBeEmptyDOMElement();
    expect(part("small")).toBeEmptyDOMElement();
  });

  describe("when the read of the person's own list cannot be trusted (rulings R43, R44 and R45)", () => {
    const OWN = "wss://own.example.test";
    const SIX = [...FOLLOW_RELAYS, "wss://fourth.example.test", "wss://fifth.example.test", "wss://sixth.example.test"];
    /** The person's list as it was years ago, which does not name the friend; and their relay list, which writes to a relay of their own. */
    const yearsOld = () => listOf([["p", OUTSIDER]], -60 * 60 * 24 * 900);
    const theirs = () => shapedEvent({ kind: 10002, pubkey: ME, tags: [["r", OWN, "write"]] });
    const out = () => {
      const each = relay();
      each.down = true;
      return each;
    };

    it.each<[string, () => FollowWorld]>([
      [
        "the relay list could not be read, and one of the app's relays holds an old copy (scenario A)",
        () => followWorld({ [NOS]: relay([yearsOld()]), [DIRECTORY]: out(), [BIG]: relay(), [OWN]: relay([LIST, theirs()]), [CIRCLE_RELAY]: relay() }),
      ],
      [
        "the relay list could not be read, and enough relays answer with nothing for an account that is new (scenario B)",
        () => {
          config.followListRelays = [...SIX];
          const others = Object.fromEntries(SIX.filter((url) => url !== DIRECTORY).map((url) => [url, relay()]));
          return followWorld({ ...others, [DIRECTORY]: out(), [OWN]: relay([LIST, theirs()]), [CIRCLE_RELAY]: relay() });
        },
      ],
      [
        "the relay list is read, and the relay it writes to is out (scenario C)",
        () => followWorld({ [NOS]: relay([yearsOld()]), [DIRECTORY]: relay([theirs()]), [BIG]: relay(), [OWN]: out(), [CIRCLE_RELAY]: relay() }),
      ],
    ])("shows neither button when %s: none says Follow, which a tap would make a change on a list that is not the person's newest", async (_, relaysOf) => {
      signedInAs(SECRET);
      const w = relaysOf();

      await openButtons({ main: MAIN, small: SMALL, friend: MAIN_FRIEND, old: { pubkey: OUTSIDER, name: "Odile", size: "main" } }, { w });
      await waitFor(() => expect(w.asked().filter((filter) => filter.kinds?.includes(10002) === true).length).toBeGreaterThan(0));
      await after(TOWNS_WAIT_MS);

      for (const label of ["main", "small", "friend", "old"]) expect(part(label)).toBeEmptyDOMElement();
      expect(change).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    });
  });

  it("is a link to sign in, which can come back to the page, for someone signed out; and no small one", async () => {
    const user = person();
    const { router, w, goTo } = await openButtons({ main: MAIN, small: SMALL });
    await goTo("/somewhere?sort=newest");

    expect(part("small")).toBeEmptyDOMElement();
    expect(within(part("main")).queryByRole("button")).not.toBeInTheDocument();
    const link = within(part("main")).getByRole("link", { name: copy.follow.followNamed("Sol") });
    expect(link).toHaveTextContent(copy.follow.follow);
    expect(link).toHaveAttribute("href", "/signin");
    expect(link).toHaveClass("h-8");

    await user.click(link);

    expect(router.state.location.pathname).toBe("/signin");
    expect((router.state.location.state as { from?: { pathname?: string; search?: string } } | null)?.from).toMatchObject({
      pathname: "/somewhere",
      search: "?sort=newest",
    });
    // Nobody's list was read, and nothing was changed: the person taps Follow themself once signed in.
    expect(w.asked()).toEqual([]);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("its size (ruling R46)", () => {
  /**
   * The room a tap has: an unseen part of the button itself, in the middle of it, as tall and as wide
   * as the pill and never less than a touch target either way.
   */
  const TAP_AREA = [
    "relative",
    "after:absolute",
    "after:top-1/2",
    "after:left-1/2",
    "after:h-full",
    "after:w-full",
    "after:min-h-touch",
    "after:min-w-touch",
    "after:-translate-x-1/2",
    "after:-translate-y-1/2",
  ];
  /** What would make the pill itself take more room than its height and its words: padding up or down, a least height or width, a margin, the width of its place. */
  const MAKES_IT_BIGGER = /(?:^|\s)(?:p[ytb]?-|min-h-|min-w-|m[xytrbl]?-|w-full|size-)/;

  /**
   * The control is as wide for one word as for another: it draws the word it says, and with it, unseen
   * and unread, every word it can say, each in the one cell of its grid, which is as wide as the widest.
   * (jsdom lays nothing out, so this holds the button to what makes it so, not to a width. In Chrome
   * the small one is 79.78 px wide and the main one 96.22 px, whichever of its four words it says.)
   */
  function expectAsWideForEveryWord(control: HTMLElement, says: string): void {
    expect(control).toHaveClass("inline-grid", "whitespace-nowrap");
    const [shown, ...unseen] = [...control.children] as HTMLElement[];
    expect(shown).toHaveTextContent(says);
    expect(shown).toHaveClass("col-start-1", "row-start-1");
    expect(unseen.map((each) => each.dataset.word)).toEqual(WORDS);
    for (const each of unseen) {
      expect(each).toHaveClass("invisible", "col-start-1", "row-start-1", "before:content-[attr(data-word)]");
      expect(each).toHaveAttribute("aria-hidden", "true");
      // Drawn by the style sheet from the element's own attribute: not in the page's text, nor in the button's name.
      expect(each).toBeEmptyDOMElement();
    }
    expect(control.textContent).toBe(says);
  }

  it.each([
    ["the small one, a pill 28 px tall with the smaller text", SMALL, ["h-7", "px-2.5", "text-caption", "rounded-chip", "shrink-0"]],
    ["the main one, a pill 32 px tall and as wide as its words", MAIN, ["h-8", "px-4", "text-secondary", "rounded-button", "self-start"]],
  ] as const)("draws %s, with 44 px to tap around it that is not seen, and as wide whatever it says", async (_, shown, shape) => {
    const user = person();
    await opened({ it: shown });
    const button = buttonIn("it")!;

    const held = (says: string) => {
      expect(buttonIn("it")).toBe(button);
      expect(button).toHaveClass(...shape, ...TAP_AREA);
      expect(button.className).not.toMatch(MAKES_IT_BIGGER);
      expectAsWideForEveryWord(button, says);
    };
    held(copy.follow.follow);
    const follow = nextChange();
    await user.click(button);
    held(copy.follow.saving);
    await follow.ends(FOLLOWED);
    held(copy.follow.following);
    // And Unfollow, once the pointer has left it and come back (ruling R47).
    await user.unhover(button);
    await user.hover(button);
    held(copy.follow.unfollow);
  });

  it("draws the link to sign in as the main button is drawn: as tall, as wide, with the same room to tap", async () => {
    await openButtons({ main: MAIN });

    const link = within(part("main")).getByRole("link", { name: copy.follow.followNamed("Sol") });
    expect(link).toHaveClass("h-8", "px-4", "text-secondary", "rounded-button", "self-start", ...TAP_AREA);
    expect(link.className).not.toMatch(MAKES_IT_BIGGER);
    expectAsWideForEveryWord(link, copy.follow.follow);
  });

  it("keeps the lines under it, and their words, the size they were: each word a touch target both ways", async () => {
    circleKept(ME, "ready");
    await followed({ it: SMALL, rail: MAIN });
    for (const label of ["it", "rail"]) {
      expect(circleSaid(label).querySelector("p")).toHaveClass("text-secondary");
      expect(wordIn(label, copy.follow.updateNow)).toHaveClass("min-h-touch", "min-w-touch", "text-secondary");
    }
    // The main button is at the start of its place, and its lines are as wide as the place. Its words
    // begin 10 px under the pill (6 px between the button and its lines, and the lines' own 4): 4 px
    // past where the room the button has to tap ends, the margin the small one has on a desktop.
    const place = buttonIn("rail")!.parentElement!;
    expect(place).toHaveClass("flex", "flex-col", "gap-1.5");
    expect(wordIn("rail", copy.follow.updateNow)!.parentElement).toHaveClass("pt-1");
    expect(place).not.toHaveClass("w-full");
    expect(buttonIn("rail")).toHaveClass("self-start");
    expect(place).toContainElement(circleSaid("rail"));
    expect(circleSaid("rail").closest("[class~=self-start]")).toBeNull();
  });
});

describe("the lines under it: after following", () => {
  it("say the follow counts after the circle's next update, with Update now, for a person who has a circle", async () => {
    circleKept(ME, "ready");
    await followed({ it: SMALL });

    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(copy.follow.countsAfterUpdate).toBe("Counts after your circle's next update.");
    const update = wordIn("it", copy.follow.updateNow)!;
    expect(update).toHaveAccessibleDescription(copy.follow.countsAfterUpdate);
    expect(update).toHaveClass("min-h-touch", "min-w-touch");
    expect(wordIn("it", copy.follow.personalize)).not.toBeInTheDocument();
    // Showing it asked Brainstorm nothing: the tab kept the circle, and a follow is no update.
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["was built lately", "recently"],
    ["was found with nobody in it yet", "unconfirmed"],
  ] as const)("say the same for a circle that %s", async (_, state) => {
    await followed({ it: MAIN }, { circle: circleOf({ state }) });

    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(wordIn("it", copy.follow.updateNow)).toBeInTheDocument();
  });

  it("say it counts once the circle is built, with Personalize, for a person who has none", async () => {
    circleKept(ME, "off");
    await followed({ it: SMALL });

    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsOnceBuilt);
    expect(copy.follow.countsOnceBuilt).toBe("Counts once your circle is built.");
    const personalize = wordIn("it", copy.follow.personalize)!;
    expect(personalize).toHaveAccessibleDescription(copy.follow.countsOnceBuilt);
    expect(personalize).toHaveAttribute("aria-expanded", "false");
    expect(personalize).toHaveClass("min-h-touch", "min-w-touch");
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["Brainstorm was busy", "busy"],
    ["the circle could not be built", "failed"],
    ["Brainstorm could not be reached", "unavailable"],
  ] as const)("offer Personalize too when %s", async (_, state) => {
    await followed({ it: MAIN }, { circle: circleOf({ state, ready: false, scorer: undefined }) });

    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsOnceBuilt);
    expect(wordIn("it", copy.follow.personalize)).toBeInTheDocument();
  });

  it.each([
    ["is being built", "working"],
    ["waits on the person's add-on", "signing"],
  ] as const)("say it counts once the circle is built, and offer nothing, while it %s", async (_, state) => {
    await followed({ it: MAIN }, { circle: circleOf({ state, ready: false, scorer: undefined }) });

    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsOnceBuilt);
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);
  });

  it("say nothing of the circle while the tab still looks for it: it may be there", async () => {
    // Open, and nothing kept: the tab looks for the person's circle once the places are in, which they never are here.
    config.features.circle = true;
    await followed({ it: MAIN });

    expectNothingSaid("it");
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);
  });

  it("say nothing of the circle while My circle is closed", async () => {
    expect(config.features.circle).toBe(false);
    await followed({ it: MAIN });

    expectNothingSaid("it");
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it("are the same on every button for the person, and are drawn by one that appears later without moving the focus or the page", async () => {
    circleKept(ME, "ready");
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      await followed({ it: MAIN, review: SMALL });
      expect(circleSaid("review")).toHaveTextContent(copy.follow.countsAfterUpdate);
      const focused = document.activeElement;
      expect(focused).toBe(buttonIn("it"));

      showButtons({ it: MAIN, review: SMALL, later: SMALL });

      expect(buttonIn("later")).toHaveTextContent(copy.follow.following);
      expect(circleSaid("later")).toHaveTextContent(copy.follow.countsAfterUpdate);
      expect(document.activeElement).toBe(focused);
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("go when the person goes to another page, and the small button with them: the reviewer is followed already", async () => {
    circleKept(ME, "ready");
    const { goTo } = await followed({ it: MAIN, review: SMALL });

    await goTo("/elsewhere");

    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expectNothingSaid("it");
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();
    expect(part("review")).toBeEmptyDOMElement();
  });
});

describe("Update now, under a follow", () => {
  it("calls the circle's update and nothing else of it", async () => {
    const circle = circleOf({});
    const user = person();
    await followed({ it: SMALL }, { circle });
    // The tap of Follow let go of what an earlier update came to, and asked for nothing else.
    expect(circle.clearUpdate).toHaveBeenCalledTimes(1);
    expect(circle.update).not.toHaveBeenCalled();

    await user.click(wordIn("it", copy.follow.updateNow)!);

    expect(circle.update).toHaveBeenCalledTimes(1);
    for (const other of [circle.personalize, circle.retry, circle.cancel]) expect(other).not.toHaveBeenCalled();
    expect(circle.clearUpdate).toHaveBeenCalledTimes(1);
    // And it is no change to the list.
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("reaches Brainstorm with the circle's own update, and nothing reaches it before the tap", async () => {
    circleKept(ME, "ready");
    const user = person();
    const hold = gate();
    brainstorm.startRun.mockImplementation(async () => {
      await hold.closed;
      return { recently: true };
    });
    await followed({ it: SMALL });
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);

    await user.click(wordIn("it", copy.follow.updateNow)!);

    // The update's own steps: the sign-in this tab did not have, and a run asked for. No more.
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.signInToBrainstorm.mock.calls[0]![0]).toBe(ME);
    expect(askedOfBrainstorm()).toEqual([0, 1, 0, 1]);
    // While Brainstorm is asked, the line says so, in the Why page's words, and Update now is not offered.
    expect(circleSaid("it")).toHaveTextContent(copy.why.updating);
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();
    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    // The word went with the focus on it: the focus is by the lines, not on the page, nor on Following.
    expect(document.activeElement).not.toBe(document.body);
    expect(part("it")).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(buttonIn("it"));

    // Brainstorm made one lately, and will not start another: shown under the button, and Update now is back.
    await hold.open();
    await waitFor(() => expect(within(part("it")).getByText(copy.circle.recently)).toBeInTheDocument());
    expect(wordIn("it", copy.follow.updateNow)).toBeInTheDocument();
    // Said aloud once: by the bar at the foot of the page, and not by the button's own status.
    expect(barRegion()).toHaveTextContent(copy.circle.recently);
    expect(circleSaid("it")).not.toHaveTextContent(copy.circle.recently);
    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(askedOfBrainstorm()).toEqual([0, 1, 0, 1]);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("says no more under the button once the circle has been built again, which the bar says; and a follow made after it says what it needs", async () => {
    circleKept(ME, "ready");
    const user = person();
    const run = (done: boolean): client.Run => {
      const status = done ? "success" : "waiting";
      return { status, internalPublicationStatus: status, taStatus: status, countValues: null, othersFirst: 0, createdAt: Date.now(), updatedAt: Date.now() };
    };
    brainstorm.startRun.mockResolvedValue({ run: run(false) });
    brainstorm.latestRun.mockResolvedValue(run(true));
    await followed({ it: SMALL, other: { pubkey: OUTSIDER, name: "Odile", size: "small" } });

    await user.click(wordIn("it", copy.follow.updateNow)!);
    await waitFor(() => expect(circleSaid("it")).toHaveTextContent(copy.why.updating));
    // Brainstorm is asked how the run stands, and it is done.
    await after(POLL_MS);

    await waitFor(() => expect(barRegion()).toHaveTextContent(copy.why.updated));
    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expectNothingSaid("it");
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);

    // Someone else is followed now: what the update came to was said before this follow, and is let go of.
    const follow = nextChange();
    await user.click(buttonIn("other")!);
    await follow.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER], ["p", OUTSIDER]], 20), confirmed: true });

    expect(circleSaid("other")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(wordIn("other", copy.follow.updateNow)).toBeInTheDocument();
    expect(within(part("other")).queryByText(copy.why.updated)).not.toBeInTheDocument();
  });

  it.each([
    ["the person's add-on asks them", "signing", copy.circle.approveBrowser, copy.circle.cancel],
    ["Brainstorm builds the circle again", "updating", copy.why.updating, null],
    ["it is still being built, and can't be followed", "started", copy.why.updateStarted, copy.follow.updateNow],
    ["it could not be updated", "failed", copy.why.updateFailed, copy.follow.updateNow],
  ] as const)("says politely that %s, under what the follow means", async (_, updateStep, line, offered) => {
    const circle = circleOf({ updateStep });
    await followed({ it: MAIN }, { circle });

    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(circleSaid("it")).toHaveTextContent(line);
    const words = within(part("it"))
      .getAllByRole("button")
      .filter((each) => each !== buttonIn("it"))
      .map((each) => each.textContent);
    expect(words).toEqual(offered === null ? [] : [offered]);
  });

  it("stops waiting on the add-on with Cancel, which is the circle's own", async () => {
    const circle = circleOf({ updateStep: "signing" });
    const user = person();
    await followed({ it: MAIN }, { circle });

    await user.click(wordIn("it", copy.circle.cancel)!);

    expect(circle.cancel).toHaveBeenCalledTimes(1);
    expect(circle.update).not.toHaveBeenCalled();
  });

  it("keeps the focus by the lines when Cancel goes, with the focus on it, as the person's add-on answers", async () => {
    circleKept(ME, "ready");
    const user = person();
    const answer = gate();
    brainstorm.signInToBrainstorm.mockImplementation(async () => {
      await answer.closed;
      return "eyJhbGciOiJIUzI1NiJ9.eyJuIjoyfQ.c2lnbmF0dXJl";
    });
    await followed({ it: MAIN });
    await user.click(wordIn("it", copy.follow.updateNow)!);
    await waitFor(() => expect(wordIn("it", copy.circle.cancel)).toBeInTheDocument());
    act(() => wordIn("it", copy.circle.cancel)!.focus());
    expect(wordIn("it", copy.circle.cancel)).toHaveFocus();

    await answer.open();

    await waitFor(() => expect(wordIn("it", copy.circle.cancel)).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(document.body);
    expect(part("it")).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(buttonIn("it"));
  });

  it("shows that the circle was updated lately, which the bar at the foot of the page says aloud, and is not said twice", async () => {
    await followed({ it: MAIN }, { circle: circleOf({ updateStep: "recently" }) });

    expect(within(part("it")).getByText(copy.circle.recently)).toBeInTheDocument();
    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(circleSaid("it")).not.toHaveTextContent(copy.circle.recently);
    expect(wordIn("it", copy.follow.updateNow)).toBeInTheDocument();
  });

  it("says no more of the circle once it has been built again: the follow counts", async () => {
    await followed({ it: MAIN }, { circle: circleOf({ updateStep: "updated" }) });

    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expectNothingSaid("it");
    expect(within(part("it")).queryByText(copy.why.updated)).not.toBeInTheDocument();
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);
  });

  it("leaves the focus on Update now while it stays: nothing moves it but the word going", async () => {
    // A circle whose update does nothing: the word is not replaced.
    const circle = circleOf({});
    const user = person();
    await followed({ it: MAIN }, { circle });

    await user.click(wordIn("it", copy.follow.updateNow)!);

    expect(wordIn("it", copy.follow.updateNow)).toHaveFocus();
  });

  it("makes one call for Enter held down on Update now, which stays under the key: the lines' own guard, not the button's", async () => {
    // A circle whose update does nothing: Update now is not replaced, and keeps the focus while the key is down.
    const circle = circleOf({});
    const user = person();
    await followed({ it: MAIN }, { circle });
    const update = wordIn("it", copy.follow.updateNow)!;
    act(() => update.focus());

    await user.keyboard("{Enter>6/}");

    expect(wordIn("it", copy.follow.updateNow)).toBe(update);
    expect(update).toHaveFocus();
    expect(circle.update).toHaveBeenCalledTimes(1);
    // A press of its own is a call of its own, as before.
    await user.keyboard("{Enter}");
    expect(circle.update).toHaveBeenCalledTimes(2);
    // And it is no change to the list.
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("is let go of only by a tap of Follow: not by Unfollow, nor by Undo", async () => {
    const circle = circleOf({});
    const user = person();
    await opened({ it: MAIN_FRIEND, other: SMALL }, { circle });

    // Unfollow, which Following says under the mouse that comes onto it; and Undo.
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    await user.click(wordIn("it", copy.follow.undo)!);
    await undo.ends({ kind: "saved", list: PUT_BACK, confirmed: true });
    expect(circle.clearUpdate).not.toHaveBeenCalled();

    // A tap of Follow in Undo's ten seconds, which is that Undo (ruling R28): it puts back what was there, and adds nobody.
    // (Unfollowed first, by the mouse, which comes back to the button from Undo.)
    const again = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await again.ends({ kind: "saved", list: listOf(WITHOUT_FRIEND.tags, 30), confirmed: true, removed: TAKEN_OUT });
    expect(buttonIn("it")).toHaveTextContent(copy.follow.follow);
    const back = nextChange();
    await user.click(buttonIn("it")!);
    expect(asked(3).action).toEqual({ restore: TAKEN_OUT, left: listOf(WITHOUT_FRIEND.tags, 30).id });
    await back.ends({ kind: "saved", list: listOf(LIST.tags, 40), confirmed: true });
    expect(circle.clearUpdate).not.toHaveBeenCalled();

    // An unfollow that was not made, tried again: an unfollow still. (The pointer has not left the
    // button since the click that put them back: the first click shows Unfollow, the second is on it.)
    const refused = nextChange();
    await unfollowInTwo(() => user.click(buttonIn("it")!), buttonIn("it")!);
    await refused.ends({ kind: "not-approved" });
    const retried = nextChange();
    await user.click(wordIn("it", copy.follow.tryAgain)!);
    expect(asked(5)).toEqual({ who: FRIEND, action: "unfollow" });
    await retried.ends({ kind: "not-approved" });
    expect(circle.clearUpdate).not.toHaveBeenCalled();

    // An Undo that was not made, tried again with Follow while it is offered still: that Undo.
    const taken = nextChange();
    await user.click(wordIn("it", copy.follow.tryAgain)!);
    await taken.ends({ kind: "saved", list: listOf(WITHOUT_FRIEND.tags, 50), confirmed: true, removed: TAKEN_OUT });
    const notPutBack = nextChange();
    await user.click(wordIn("it", copy.follow.undo)!);
    await notPutBack.ends({ kind: "not-saved" });
    const putBack = nextChange();
    await user.click(buttonIn("it")!);
    expect(asked(8).action).toEqual({ restore: TAKEN_OUT, left: listOf(WITHOUT_FRIEND.tags, 50).id });
    await putBack.ends({ kind: "saved", list: listOf(LIST.tags, 60), confirmed: true });
    expect(circle.clearUpdate).not.toHaveBeenCalled();
    expect(circle.update).not.toHaveBeenCalled();

    // A plain follow, of someone who is not followed: what the last update came to is let go of, once.
    const follow = nextChange();
    await user.click(buttonIn("other")!);
    expect(asked(9)).toEqual({ who: STRANGER, action: "follow" });
    expect(circle.clearUpdate).toHaveBeenCalledTimes(1);
    await follow.ends({ kind: "not-saved" });
    // And so it is when that follow, which was not made, is tried again.
    const tried = nextChange();
    await user.click(wordIn("other", copy.follow.tryAgain)!);
    expect(asked(10)).toEqual({ who: STRANGER, action: "follow" });
    expect(circle.clearUpdate).toHaveBeenCalledTimes(2);
    await tried.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER]], 70), confirmed: true });
    expect(circle.clearUpdate).toHaveBeenCalledTimes(2);
    expect(circle.update).not.toHaveBeenCalled();
  });

  it("is not let go of by a tap that begins nothing: Follow pressed again while its change is being saved", async () => {
    const circle = circleOf({});
    const user = person();
    await opened({ it: MAIN }, { circle });
    const follow = nextChange();
    await user.click(buttonIn("it")!);
    expect(circle.clearUpdate).toHaveBeenCalledTimes(1);

    await user.click(buttonIn("it")!);
    await user.click(buttonIn("it")!);

    expect(change).toHaveBeenCalledTimes(1);
    expect(circle.clearUpdate).toHaveBeenCalledTimes(1);
    await follow.ends(FOLLOWED);
  });
});

describe("Personalize, under a follow", () => {
  /** Personalize under the button, which opens the panel: not the panel's own button of the same name. */
  const opener = () =>
    within(part("it"))
      .getAllByRole("button", { name: copy.follow.personalize })
      .find((each) => each.hasAttribute("aria-expanded"))!;
  /** The panel Personalize opens: the one its button names. */
  const panel = () => document.getElementById(opener().getAttribute("aria-controls") ?? "")!;

  it("opens Personalize's own panel, with its line and its button, and reaches Brainstorm only on that button's tap", async () => {
    circleKept(ME, "off");
    const user = person();
    const hold = gate();
    brainstorm.signInToBrainstorm.mockImplementation(async () => {
      await hold.closed;
      throw new Error("The person said no");
    });
    await followed({ it: SMALL });

    await user.click(opener());

    // The panel the toggle's half opens, here: what it does, the tap that is the person's consent, and Not now.
    expect(opener()).toHaveAttribute("aria-expanded", "true");
    expect(part("it")).toContainElement(panel());
    expect(within(panel()).getByText(copy.circle.consent)).toBeInTheDocument();
    const consent = within(panel()).getByRole("button", { name: copy.circle.personalize });
    expect(consent).toHaveAccessibleDescription(copy.circle.consent);
    expect(consent).toHaveFocus();
    expect(within(panel()).getByRole("button", { name: copy.circle.notNow })).toBeInTheDocument();
    // Opening it asked Brainstorm nothing.
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);

    await user.click(consent);

    // The panel's own tap: the person's add-on is asked, and the panel says so, with Cancel.
    await waitFor(() => expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1));
    expect(askedOfBrainstorm()).toEqual([0, 1, 0, 0]);
    expect(within(part("it")).getByText(copy.circle.approveBrowser)).toBeInTheDocument();
    expect(within(part("it")).getByRole("button", { name: copy.circle.cancel })).toBeInTheDocument();
    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsOnceBuilt);

    // The person says no: Personalize is offered again, and nothing more was asked.
    await hold.open();
    await waitFor(() => expect(within(panel()).getByRole("button", { name: copy.circle.personalize })).toBeInTheDocument());
    expect(askedOfBrainstorm()).toEqual([0, 1, 0, 0]);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("closes on Not now and on Escape, with the focus back on Personalize, asking Brainstorm nothing", async () => {
    circleKept(ME, "off");
    const user = person();
    await followed({ it: MAIN });

    await user.click(opener());
    await user.click(within(panel()).getByRole("button", { name: copy.circle.notNow }));
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(opener()).not.toHaveAttribute("aria-controls");
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(opener()).toHaveFocus();

    await user.click(opener());
    expect(within(part("it")).getByText(copy.circle.consent)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(opener()).toHaveFocus();

    // And a second tap on Personalize closes what the first opened.
    await user.click(opener());
    await user.click(opener());
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it("closes with the line it was opened from when another button takes that line away, and is not there when the line is again", async () => {
    circleKept(ME, "off");
    const user = person();
    await followed({ it: SMALL, rail: MAIN });
    await user.click(opener());
    expect(within(part("it")).getByText(copy.circle.consent)).toBeInTheDocument();
    expect(doorNow()).toBe("open");

    // Unfollowed from the other button for the same person: the line goes from both, and the panel with it.
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("rail")!);
    await unfollow.ends({ kind: "saved", list: listOf(LIST.tags, 20), confirmed: true, removed: [{ index: LIST.tags.length, tag: ["p", STRANGER] }] });
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(doorNow()).toBe("closed");

    // Followed again, once Undo's ten seconds are over: the line is back, and no panel that nobody
    // asked for, which would take the focus to its Personalize.
    await after(UNDO_MS);
    const again = nextChange();
    await user.click(buttonIn("rail")!);
    await again.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER]], 30), confirmed: true });
    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsOnceBuilt);
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(doorNow()).toBe("closed");
    expect(buttonIn("rail")).toHaveFocus();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it("closes when the button it was opened under goes from the page, and is closed when that button is drawn again", async () => {
    circleKept(ME, "off");
    const user = person();
    await followed({ it: MAIN });
    await user.click(opener());
    expect(doorNow()).toBe("open");

    showButtons({});
    expect(doorNow()).toBe("closed");

    // Drawn again in the same visit, it says what it said, as that is the person's: with no panel.
    showButtons({ it: MAIN });
    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsOnceBuilt);
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(part("it")).not.toContainElement(document.activeElement as HTMLElement);
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it("closes when the person unfollows: the line it was under has gone", async () => {
    circleKept(ME, "off");
    const user = person();
    await followed({ it: MAIN });
    await user.click(opener());
    expect(within(part("it")).getByText(copy.circle.consent)).toBeInTheDocument();

    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);

    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    await unfollow.ends({ kind: "not-approved" });
    expect(within(part("it")).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });
});

describe("Unfollow, shown before it is done (ruling R47)", () => {
  /** How an unfollow of Sol ends when it is saved: the list as it was before the follow, with what it took out. */
  const UNFOLLOWED_SOL: FollowOutcome = {
    kind: "saved",
    list: listOf(LIST.tags, 20),
    confirmed: true,
    removed: [{ index: LIST.tags.length, tag: ["p", STRANGER] }],
  };
  /** Someone else the person follows, beside Fay. */
  const GIL = pubkeyAt(FRIEND_AT + 1);

  /**
   * What the button says, with its name for a screen reader and its colours. Following is in the
   * trust colour, as what is about whom the person trusts is; Unfollow is not: the accent's outline
   * and word on the ground.
   */
  function expectSays(button: HTMLElement, says: "following" | "unfollow", name = "Sol"): void {
    if (says === "following") {
      expect(button).toHaveTextContent(copy.follow.following);
      expect(button).toHaveAccessibleName(copy.follow.followingNamed(name));
      expect(button).toHaveClass("border-trust", "bg-trust-tint", "text-trust-ink");
      expect(button.className).not.toMatch(/accent/);
    } else {
      expect(button).toHaveTextContent(copy.follow.unfollow);
      expect(button).toHaveAccessibleName(copy.follow.unfollowNamed(name));
      expect(button).toHaveClass("border-accent", "bg-ground", "text-accent");
      expect(button.className).not.toMatch(/trust/);
    }
    // One button through it all, never off and never pressed: its name says where it stands.
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("aria-pressed");
  }

  /**
   * The page once Sol has been followed by `press` on the button, by a change the test played. What
   * pressed is where it was: the pointer on the button, or the focus.
   */
  async function followedBy(press: (button: HTMLElement) => unknown, shown: Shown = MAIN) {
    const page = await opened({ it: shown });
    const button = buttonIn("it")!;
    const follow = nextChange();
    await press(button);
    expect(asked(0)).toEqual({ who: STRANGER, action: "follow" });
    await follow.ends(FOLLOWED);
    expectSays(button, "following");
    return { ...page, button };
  }

  /** Puts the keyboard's focus on the Follow button of a part of the page, as Tab does: from Sign in, which is before the first of them. */
  async function tabTo(user: Hands, label = "it"): Promise<HTMLElement> {
    act(() => screen.getByRole("button", { name: "sign in" }).focus());
    await user.tab();
    expect(buttonIn(label)).toHaveFocus();
    return buttonIn(label)!;
  }

  /** A press of a pen on `button`: no mouse, and no finger. It is over the button before it is down on it. */
  function penPress(button: HTMLElement): void {
    const pen = { pointerType: "pen", pointerId: 7 };
    fireEvent.pointerOver(button, pen);
    fireEvent.pointerDown(button, pen);
    fireEvent.pointerUp(button, pen);
    fireEvent.click(button);
    fireEvent.pointerOut(button, pen);
  }

  describe("the one rule, for every way of pressing", () => {
    it.each<[string, (user: Hands, button: HTMLElement) => unknown]>([
      ["a mouse whose pointer stays on it", (user, button) => user.click(button)],
      ["a finger", (user, button) => tap(user, button)],
      ["a pen", (_, button) => penPress(button)],
      [
        "Enter, with the focus on it throughout",
        async (user, button) => {
          act(() => button.focus());
          await user.keyboard("{Enter}");
        },
      ],
      [
        "Space, with the focus on it throughout",
        async (user, button) => {
          act(() => button.focus());
          await user.keyboard(" ");
        },
      ],
      ["a click that comes with no pointer and no focus (a screen reader's, or a browser with no pointer events)", (_, button) => fireEvent.click(button)],
    ])("a press by %s on Following shows Unfollow and changes nothing, and only the press on Unfollow unfollows", async (_, press) => {
      const user = person();
      const { button, w } = await followedBy((it) => press(user, it));
      expect(change).toHaveBeenCalledTimes(1);

      // It said Following: the press shows Unfollow, on the same button, and nothing is asked of the list.
      await press(user, button);
      expectSays(button, "unfollow");
      expect(buttonIn("it")).toBe(button);
      expect(change).toHaveBeenCalledTimes(1);
      expect(w.published()).toEqual([]);

      // It says Unfollow: the press unfollows, once.
      await after(UNFOLLOW_GUARD_MS);
      const unfollow = nextChange();
      await press(user, button);
      expect(change).toHaveBeenCalledTimes(2);
      expect(asked(1)).toEqual({ who: STRANGER, action: "unfollow" });
      expect(button).toHaveTextContent(copy.follow.saving);
      expect(button).toHaveAttribute("aria-disabled", "true");

      // Unfollowed: Follow, with who it was and Undo, as before.
      await unfollow.ends(UNFOLLOWED_SOL);
      expect(buttonIn("it")).toBe(button);
      expect(button).toHaveTextContent(copy.follow.follow);
      expect(button).toHaveAccessibleName(copy.follow.followNamed("Sol"));
      expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Sol"));
      expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();
      expect(change).toHaveBeenCalledTimes(2);
    });

    it("has the words given for it (drafts), and its times: ten seconds shown, 400 ms guarded", () => {
      expect(copy.follow.unfollow).toBe("Unfollow");
      expect(copy.follow.unfollowNamed("Sol")).toBe("Unfollow Sol");
      expect(copy.follow.pressAgain("Sol")).toBe("Press again to unfollow Sol.");
      // Ten seconds (ruling R48): room for a second press by someone who cannot make it quickly.
      expect([UNFOLLOW_SHOWN_MS, UNFOLLOW_GUARD_MS]).toEqual([10_000, 400]);
    });

    it("asks for no change, whatever comes that is not a press: a pointer, the focus, time, a press elsewhere, another page", async () => {
      const user = person();
      const { w, goTo } = await opened({ it: MAIN_FRIEND, other: MAIN });
      const button = buttonIn("it")!;

      // A mouse comes and goes; so do a finger's and a pen's pointers, with no press.
      await user.hover(button);
      expectSays(button, "unfollow", "Fay");
      await user.unhover(button);
      for (const pointerType of ["touch", "pen"]) {
        fireEvent.pointerOver(button, { pointerType });
        fireEvent.pointerMove(button, { pointerType });
        fireEvent.pointerOut(button, { pointerType });
      }
      // The keyboard's focus comes and goes.
      await tabTo(user);
      expectSays(button, "unfollow", "Fay");
      await user.tab();
      expectSays(button, "following", "Fay");
      // A press shows it; then a press elsewhere, its time running out, and another page each take it back.
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");
      await tap(user, screen.getByTestId("door"));
      expectSays(button, "following", "Fay");
      await after(UNFOLLOW_GUARD_MS);
      await tap(user, button);
      await after(UNFOLLOW_SHOWN_MS);
      expectSays(button, "following", "Fay");
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");
      await goTo("/elsewhere");
      expectSays(buttonIn("it")!, "following", "Fay");
      await after(UNFOLLOW_SHOWN_MS + UNDO_MS);

      expect(change).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
      expectSays(buttonIn("it")!, "following", "Fay");
    });
  });

  describe("under a mouse", () => {
    it.each([
      ["the small one", SMALL],
      ["the main one", MAIN],
    ])("goes on saying Following on %s right after a follow, with the pointer still on it, and says Unfollow once the pointer has left and come back", async (_, shown) => {
      const user = person();
      const { button } = await followedBy((it) => user.click(it), shown);

      // The pointer has not left since the follow: it says Following, so the person sees the follow was made.
      await user.pointer({ target: button });
      expectSays(button, "following");

      await user.unhover(button);
      expectSays(button, "following");
      await user.hover(button);
      expectSays(button, "unfollow");
      expect(buttonIn("it")).toBe(button);
      // And Following again when it leaves, as often as it comes and goes; none of it is a change.
      await user.unhover(button);
      expectSays(button, "following");
      await user.hover(button);
      expectSays(button, "unfollow");
      expect(change).toHaveBeenCalledTimes(1);
    });

    it("unfollows on one click of Unfollow, and no more: Saving…, which a click does nothing to, then Follow, which the pointer still on it does nothing to", async () => {
      const user = person();
      const { button } = await followedBy((it) => user.click(it));
      await user.unhover(button);
      await user.hover(button);
      expectSays(button, "unfollow");

      const unfollow = nextChange();
      await user.click(button);

      expect(change).toHaveBeenCalledTimes(2);
      expect(asked(1)).toEqual({ who: STRANGER, action: "unfollow" });
      expect(button).toHaveTextContent(copy.follow.saving);
      await user.click(button);
      expect(change).toHaveBeenCalledTimes(2);
      await unfollow.ends(UNFOLLOWED_SOL);
      expect(button).toHaveTextContent(copy.follow.follow);
      expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Sol"));
      await user.pointer({ target: button });
      expect(button).toHaveTextContent(copy.follow.follow);
      expect(change).toHaveBeenCalledTimes(2);

      // Followed again from there (which is Undo): Following, as right after any follow, the pointer not having left.
      const back = nextChange();
      await user.click(button);
      await back.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER]], 30), confirmed: true });
      expectSays(button, "following");
    });

    it("says Unfollow at once under a mouse that comes onto someone followed all along, and nothing of it over Follow or Saving…", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND, other: MAIN });
      const fay = buttonIn("it")!;
      const sol = buttonIn("other")!;

      await user.hover(fay);
      expectSays(fay, "unfollow", "Fay");

      // The pointer goes to Sol's, which says Follow: Fay's says Following again, and Sol's Follow.
      await user.hover(sol);
      expectSays(fay, "following", "Fay");
      expect(sol).toHaveTextContent(copy.follow.follow);
      // Sol's is being saved, and the pointer leaves it and comes back: Saving…
      const follow = nextChange();
      await user.click(sol);
      await user.unhover(sol);
      await user.hover(sol);
      expect(sol).toHaveTextContent(copy.follow.saving);
      // Saved: the pointer came onto it before it said Following, and has not left since.
      await follow.ends(FOLLOWED);
      expectSays(sol, "following");
      expect(change).toHaveBeenCalledTimes(1);
    });

    it("says Following again after an unfollow that was not made, though the pointer has not left; a click then shows Unfollow, and asks for nothing", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const unfollow = nextChange();
      await unfollowByMouse(user, button);
      await unfollow.ends({ kind: "not-approved" });

      expectSays(button, "following", "Fay");
      expect(changeSaid("it")).toHaveTextContent(copy.follow.notApproved);

      await user.click(button);
      expectSays(button, "unfollow", "Fay");
      expect(change).toHaveBeenCalledTimes(1);
    });

    it("takes no pointer that is not a mouse's for one: a finger's and a pen's over it show nothing, nor do the mouse's events a browser sends after a tap", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;

      for (const pointerType of ["touch", "pen"]) {
        fireEvent.pointerOver(button, { pointerType });
        expectSays(button, "following", "Fay");
        fireEvent.pointerOut(button, { pointerType });
      }
      // What a browser sends after a tap, for pages that know only a mouse, and may leave "hovered".
      fireEvent.mouseOver(button);
      fireEvent.mouseMove(button);
      expectSays(button, "following", "Fay");

      // A whole tap: it shows Unfollow because it is a press. Once that has run out, the mouse's
      // events it left behind (over the button, and never out of it) show nothing.
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");
      await after(UNFOLLOW_SHOWN_MS);
      expectSays(button, "following", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("keeps a mouse's place while another pointer comes and goes: a finger lifted from it does not take Unfollow from under the mouse", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await user.hover(button);
      expectSays(button, "unfollow", "Fay");

      fireEvent.pointerOver(button, { pointerType: "touch" });
      fireEvent.pointerOut(button, { pointerType: "touch" });

      expectSays(button, "unfollow", "Fay");
    });
  });

  describe("under a finger", () => {
    it("shows Unfollow on the first tap, and nothing is sent; the second tap unfollows, by the one safe change", async () => {
      const user = person();
      const { w } = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      expectSays(button, "following", "Fay");

      await tap(user, button);

      expectSays(button, "unfollow", "Fay");
      expect(buttonIn("it")).toBe(button);
      expect(change).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
      // Nothing is seen under it. What a screen reader hears is held below (ruling R48).
      expect(changeSaid("it").querySelectorAll("p:not(.sr-only)")).toHaveLength(0);
      expect(circleSaid("it")).toBeEmptyDOMElement();

      await after(UNFOLLOW_GUARD_MS);
      await tap(user, button);

      // The real change, over the relays held in memory: the list every relay holds now is the old one without Fay.
      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await waitFor(() => expect(button).toHaveTextContent(copy.follow.follow));
      expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Fay"));
      expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();
      for (const url of FOLLOW_RELAYS) {
        const sent = w.relays[url]!.writer.published;
        expect(sent).toHaveLength(1);
        expect(sent[0]!.tags).toEqual(WITHOUT_FRIEND.tags);
        expect(sent[0]!.content).toBe(LIST.content);
      }
    });

    it("goes back to Following by itself ten seconds after the tap that showed Unfollow, and a tap then shows it again", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");

      await after(UNFOLLOW_SHOWN_MS / 2);
      expectSays(button, "unfollow", "Fay");
      await after(UNFOLLOW_SHOWN_MS / 2);
      expectSays(button, "following", "Fay");

      // The tap after that is a first tap again: it unfollows nobody.
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it.each<[string, (user: Hands) => unknown]>([
      ["a finger's", (user) => tap(user, screen.getByTestId("door"))],
      ["a mouse's", (user) => user.click(screen.getByTestId("door"))],
      ["a pen's", () => fireEvent.pointerDown(screen.getByTestId("door"), { pointerType: "pen" })],
    ])("goes back to Following on a press anywhere else on the page: %s", async (_, pressElsewhere) => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");

      await pressElsewhere(user);

      expectSays(button, "following", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("goes back to Following on a press of another person's button, which does what it does: nothing is asked for the first", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND, other: MAIN });
      const button = buttonIn("it")!;
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");
      const follow = nextChange();

      await tap(user, buttonIn("other")!);

      expectSays(button, "following", "Fay");
      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: STRANGER, action: "follow" });
      await follow.ends(FOLLOWED);
      expectSays(button, "following", "Fay");
    });

    it("stays on Unfollow for a press on the button itself, and on the words in it", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await tap(user, button);

      // The start of a second tap, on the word the button says: it is on the button, not elsewhere.
      fireEvent.pointerDown(button.firstElementChild!, { pointerType: "touch" });

      expectSays(button, "unfollow", "Fay");
    });

    it("goes back to Following when the button loses the focus", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");
      // The tap gave it the focus, as most browsers do.
      expect(button).toHaveFocus();

      act(() => button.blur());

      expectSays(button, "following", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("goes back to Following when the person goes to another page, and to no other state when they come back to the first", async () => {
      const user = person();
      const { goTo, router } = await opened({ it: MAIN_FRIEND });
      await goTo("/first");
      const button = buttonIn("it")!;
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");

      await goTo("/elsewhere");
      expectSays(buttonIn("it")!, "following", "Fay");
      // Back, to the very page the tap was made on: it says Following there too.
      await act(() => router.navigate(-1));
      expect(router.state.location.pathname).toBe("/first");
      expectSays(buttonIn("it")!, "following", "Fay");

      // A tap there is a first tap.
      await after(UNFOLLOW_GUARD_MS);
      await tap(user, buttonIn("it")!);
      expectSays(buttonIn("it")!, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("takes a double tap for one tap: a second press sooner than 400 ms after the one that showed Unfollow does nothing", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;

      await tap(user, button);
      await tap(user, button);

      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("holds that to the millisecond, and from the last press it took for none: a press 399 ms after one does nothing, and one 400 ms after it unfollows", async () => {
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const unfollow = nextChange();
      // Presses and the clock, with nothing between them that lets time pass by itself.
      const press = () => fireEvent.click(button);
      const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

      // The press that shows it. One 399 ms on is none, and the 400 ms begin again from it.
      press();
      expectSays(button, "unfollow", "Fay");
      pass(UNFOLLOW_GUARD_MS - 1);
      press();
      // 399 ms after that one (798 ms after the first): none still.
      pass(UNFOLLOW_GUARD_MS - 1);
      press();
      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();

      // 400 ms after the last press that was none.
      pass(UNFOLLOW_GUARD_MS);
      press();

      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED);
    });

    it("takes three quick taps for one tap: taps at 0, 200 and 400 ms unfollow nobody, and a press 400 ms after the last of them does", async () => {
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const unfollow = nextChange();
      const press = () => fireEvent.click(button);
      const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

      press();
      pass(200);
      press();
      pass(200);
      press();

      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();

      pass(UNFOLLOW_GUARD_MS);
      press();
      expect(change).toHaveBeenCalledTimes(1);
      await unfollow.ends(UNFOLLOWED);
    });

    it("unfollows on a press 400 ms after the one that showed it, when none came between", async () => {
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const unfollow = nextChange();

      fireEvent.click(button);
      act(() => void vi.advanceTimersByTime(UNFOLLOW_GUARD_MS));
      fireEvent.click(button);

      expect(change).toHaveBeenCalledTimes(1);
      await unfollow.ends(UNFOLLOWED);
    });

    it("holds the ten seconds to the millisecond, from the press that showed it", async () => {
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

      fireEvent.click(button);
      pass(UNFOLLOW_SHOWN_MS - 1);
      expectSays(button, "unfollow", "Fay");
      pass(1);

      expectSays(button, "following", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it.each<[string, (button: HTMLElement) => void]>([
      ["a press elsewhere", () => void fireEvent.pointerDown(document.body, { pointerType: "mouse" })],
      ["the button losing the focus", (button) => act(() => button.blur())],
    ])("keeps the guard though Unfollow has gone, by %s, and is shown again another way: a press sooner than 400 ms after the one that showed it does nothing", async (_, takeBack) => {
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const unfollow = nextChange();
      const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
      // A pointer's focus, which shows nothing.
      act(() => button.focus());
      expectSays(button, "following", "Fay");

      // A press shows it; it is taken back; and a mouse comes onto the button, which shows it again.
      fireEvent.click(button);
      expectSays(button, "unfollow", "Fay");
      takeBack(button);
      expectSays(button, "following", "Fay");
      fireEvent.pointerOver(button, { pointerType: "mouse" });
      expectSays(button, "unfollow", "Fay");

      // All of that in less than a double tap's time: the press is none.
      pass(UNFOLLOW_GUARD_MS - 1);
      fireEvent.click(button);
      expect(change).not.toHaveBeenCalled();
      expectSays(button, "unfollow", "Fay");

      // A double tap's time after that press, which was none.
      pass(UNFOLLOW_GUARD_MS);
      fireEvent.click(button);
      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED);
    });

    it("keeps the guard on another page too: a press at once after the page is left shows nothing new and unfollows nobody", async () => {
      const { goTo } = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      fireEvent.click(button);
      expectSays(button, "unfollow", "Fay");

      await goTo("/elsewhere");
      fireEvent.pointerOver(button, { pointerType: "mouse" });
      expectSays(button, "unfollow", "Fay");
      fireEvent.click(button);

      expect(change).not.toHaveBeenCalled();
    });
  });

  describe("under the keyboard", () => {
    it("says Unfollow when the keyboard's focus comes onto it, and Following when the focus leaves; Enter on Unfollow unfollows, once", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });

      const button = await tabTo(user);
      expectSays(button, "unfollow", "Fay");
      await user.tab();
      expectSays(button, "following", "Fay");
      await user.tab({ shift: true });
      expect(button).toHaveFocus();
      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();

      const unfollow = nextChange();
      await user.keyboard("{Enter}");

      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      expect(button).toHaveTextContent(copy.follow.saving);
      expect(button).toHaveFocus();
      await unfollow.ends(UNFOLLOWED);
      expect(button).toHaveTextContent(copy.follow.follow);
      expect(button).toHaveFocus();
    });

    it("goes on saying Following while the focus has stayed on it since the follow: Enter shows Unfollow, and Enter again unfollows; or the focus leaves and comes back", async () => {
      const user = person();
      await opened({ it: MAIN });
      const button = await tabTo(user);
      const follow = nextChange();
      await user.keyboard("{Enter}");
      await follow.ends(FOLLOWED);

      // The keyboard's focus is on it, and has been since before it said Following.
      expect(button).toHaveFocus();
      expectSays(button, "following");

      await user.keyboard("{Enter}");
      expectSays(button, "unfollow");
      expect(change).toHaveBeenCalledTimes(1);

      // The focus leaves: Following. It comes back, by the keyboard: Unfollow, as for anyone followed.
      await user.tab();
      expectSays(button, "following");
      await user.tab({ shift: true });
      expectSays(button, "unfollow");

      await after(UNFOLLOW_GUARD_MS);
      const unfollow = nextChange();
      await user.keyboard("{Enter}");
      expect(change).toHaveBeenCalledTimes(2);
      expect(asked(1)).toEqual({ who: STRANGER, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED_SOL);
    });

    it("makes no change for a key held down on Following, however long it is held: it shows Unfollow, and the key still down presses nothing", async () => {
      const user = person();
      const { button } = await followedBy(async (it) => {
        act(() => it.focus());
        await user.keyboard("{Enter}");
      });
      // The key repeats a double tap's time apart, so each repeat comes once the guard is over: it is
      // the rule for a held key that keeps it from pressing Unfollow, and not the guard.
      const slow = slowPerson(UNFOLLOW_GUARD_MS);

      await slow.keyboard("{Enter>5/}");

      expectSays(button, "unfollow");
      expect(change).toHaveBeenCalledTimes(1);

      // A press of its own, once a double tap's time is over, unfollows.
      await after(UNFOLLOW_GUARD_MS);
      const unfollow = nextChange();
      await user.keyboard("{Enter}");
      expect(change).toHaveBeenCalledTimes(2);
      await unfollow.ends(UNFOLLOWED_SOL);
    });

    it("makes one change for a key held down on Unfollow: unfollowed, they are not followed again by the key still down", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = await tabTo(user);
      expectSays(button, "unfollow", "Fay");
      // The unfollow ends as soon as it is asked for: the key is still down when the button says Follow.
      change.mockResolvedValueOnce(UNFOLLOWED);

      await user.keyboard("{Enter>8/}");

      await waitFor(() => expect(button).toHaveTextContent(copy.follow.follow));
      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
    });

    describe("when the window goes behind another and comes back (the focus never left the button)", () => {
      /**
       * The window goes behind another one, and comes back. The button has the document's focus
       * throughout: it is told it lost the focus, and then that it has it again, as a browser tells it.
       */
      function windowLeaves(button: HTMLElement): void {
        fireEvent.blur(button);
        fireEvent(window, new Event("blur"));
        expect(document.activeElement).toBe(button);
      }
      function windowReturns(button: HTMLElement): void {
        fireEvent(window, new Event("focus"));
        fireEvent.focus(button);
        // The browser calls that focus the keyboard's, for someone who has used nothing else.
        expect(button.matches(":focus-visible")).toBe(true);
      }

      it("says Following still, after a follow by the keyboard: the focus that comes back with the window is not the keyboard's coming", async () => {
        const user = person();
        await opened({ it: MAIN });
        const button = await tabTo(user);
        const follow = nextChange();
        await user.keyboard("{Enter}");
        await follow.ends(FOLLOWED);
        expectSays(button, "following");

        windowLeaves(button);
        expectSays(button, "following");
        windowReturns(button);

        expectSays(button, "following");
        // Enter shows Unfollow, as wherever the focus has stayed on it since the follow.
        await user.keyboard("{Enter}");
        expectSays(button, "unfollow");
        expect(change).toHaveBeenCalledTimes(1);
      });

      it("says Following when the follow is saved while the window is behind another (a signer's), and the window comes back after", async () => {
        const user = person();
        await opened({ it: MAIN });
        const button = await tabTo(user);
        const follow = nextChange();
        await user.keyboard("{Enter}");
        expect(button).toHaveTextContent(copy.follow.saving);

        // The signer's window comes in front, the person approves there, and the follow is saved.
        windowLeaves(button);
        await follow.ends(FOLLOWED);
        expectSays(button, "following");
        windowReturns(button);

        expectSays(button, "following");
        expect(change).toHaveBeenCalledTimes(1);
      });

      it("says Following on the way back though it said Unfollow under the keyboard's focus before: only focus that comes to the button shows it", async () => {
        const user = person();
        await opened({ it: MAIN_FRIEND });
        const button = await tabTo(user);
        expectSays(button, "unfollow", "Fay");

        windowLeaves(button);
        expectSays(button, "following", "Fay");
        windowReturns(button);
        expectSays(button, "following", "Fay");

        // The focus goes from the button and comes to it again, by the keyboard: Unfollow, as before.
        await user.tab();
        await user.tab({ shift: true });
        expect(button).toHaveFocus();
        expectSays(button, "unfollow", "Fay");
        expect(change).not.toHaveBeenCalled();
      });

      it("takes back an Unfollow a press showed when the window goes, and does not bring it back with the window", async () => {
        const user = person();
        await opened({ it: MAIN_FRIEND });
        const button = buttonIn("it")!;
        await tap(user, button);
        expectSays(button, "unfollow", "Fay");

        windowLeaves(button);
        expectSays(button, "following", "Fay");
        fireEvent(window, new Event("focus"));
        fireEvent.focus(button);

        expectSays(button, "following", "Fay");
        expect(change).not.toHaveBeenCalled();
      });
    });

    it("takes focus a pointer gave it for no keyboard's: a tap's or a click's focus shows nothing by being there", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;

      // A tap shows it as a press does; when that has run out, the focus the tap left on it shows nothing.
      await tap(user, button);
      expect(button).toHaveFocus();
      await after(UNFOLLOW_SHOWN_MS);
      expectSays(button, "following", "Fay");
      expect(button).toHaveFocus();

      // Nor does a mouse's: the click that follows Sol leaves the focus on the button (most browsers),
      // which says Following (`followedBy`); here, a click's focus on one followed all along, the
      // pointer having left again before it could be seen.
      act(() => button.blur());
      fireEvent.pointerDown(button, { pointerType: "mouse" });
      act(() => button.focus());
      expectSays(button, "following", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("takes focus a word handed it as it went for no keyboard's: it says Following, though a browser calls that focus the keyboard's", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND, other: MAIN });
      const button = await tabTo(user);
      // Unfollowed by the keyboard: Follow, with Undo under it.
      const unfollow = nextChange();
      await user.keyboard("{Enter}");
      await unfollow.ends(UNFOLLOWED);
      expect(button).toHaveTextContent(copy.follow.follow);
      // The keyboard's focus goes on to Undo. Sol is followed meanwhile, and the list that change
      // saves names Fay after all (another app put her back): Undo goes with the focus on it, and
      // hands it to Fay's button, which says Following by now.
      await user.tab();
      expect(wordIn("it", copy.follow.undo)).toHaveFocus();
      const other = nextChange();
      fireEvent.click(buttonIn("other")!);
      expect(wordIn("it", copy.follow.undo)).toHaveFocus();

      await other.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER]], 30), confirmed: true });

      expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
      await waitFor(() => expect(button).toHaveFocus());
      // The browser calls it the keyboard's (the person has used nothing else), and it is not taken
      // for it: the person did not put the focus here, and a key meant for Undo would land on Unfollow.
      expect(button.matches(":focus-visible")).toBe(true);
      expectSays(button, "following", "Fay");
      // Enter shows it, and Enter again unfollows, as wherever the focus has stayed.
      await user.keyboard("{Enter}");
      expectSays(button, "unfollow", "Fay");
      expect(change).toHaveBeenCalledTimes(2);
    });
  });

  describe("a click acts on what the button said when its press began (ruling R49)", () => {
    const mouse = { pointerType: "mouse" };
    /** A click a pointer made: it counts itself, as a browser's does, where a key's or a screen reader's counts nothing. */
    const pointerClick = (button: HTMLElement) => fireEvent.click(button, { detail: 1 });

    it("only shows Unfollow for one tap in a browser that reports a finger as a mouse: the pointer comes onto the button and down on it in one go", async () => {
      const { w } = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;

      // What such a browser sends for a tap, with no time between for the page to draw: over the button, and down on it.
      act(() => {
        fireEvent.pointerOver(button, mouse);
        fireEvent.pointerDown(button, mouse);
      });
      // By the time the tap's click comes, a "mouse" is over the button, which says Unfollow.
      expectSays(button, "unfollow", "Fay");
      fireEvent.pointerUp(button, mouse);
      pointerClick(button);

      // The press began on Following: the click shows Unfollow (it is answered as a press that did), and sends nothing.
      expectSays(button, "unfollow", "Fay");
      expect(changeSaid("it")).toHaveTextContent(copy.follow.pressAgain("Fay"));
      expect(change).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);

      // The second tap begins on Unfollow, and unfollows.
      act(() => void vi.advanceTimersByTime(UNFOLLOW_GUARD_MS));
      const unfollow = nextChange();
      fireEvent.pointerDown(button, mouse);
      fireEvent.pointerUp(button, mouse);
      pointerClick(button);
      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED);
    });

    it("only shows Unfollow for one tap in a browser that calls every focus the keyboard's: the tap's own focus shows Unfollow before its click", async () => {
      const user = person();
      focusRingsAlwaysOn();
      const { w } = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;

      await tap(user, button);

      // The tap gave it the focus, which such a browser says is one to show, and so it says Unfollow before the click.
      expect(button).toHaveFocus();
      expect(button.matches(":focus-visible")).toBe(true);
      expectSays(button, "unfollow", "Fay");
      expect(changeSaid("it")).toHaveTextContent(copy.follow.pressAgain("Fay"));
      expect(change).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);

      await after(UNFOLLOW_GUARD_MS);
      const unfollow = nextChange();
      await tap(user, button);
      expect(change).toHaveBeenCalledTimes(1);
      await unfollow.ends(UNFOLLOWED);
    });

    it("only shows Unfollow for a press that began on Following, though the pointer left the button and came back before the click", async () => {
      const user = person();
      const { button } = await followedBy((it) => user.click(it));

      // The mouse comes down on Following (it has not left since the follow), goes off the button and
      // comes back, so that it says Unfollow under it, and is let go there.
      fireEvent.pointerDown(button, mouse);
      fireEvent.pointerOut(button, mouse);
      fireEvent.pointerOver(button, mouse);
      expectSays(button, "unfollow");
      fireEvent.pointerUp(button, mouse);
      pointerClick(button);

      expectSays(button, "unfollow");
      expect(change).toHaveBeenCalledTimes(1);
    });

    it("unfollows on one click of a mouse that was over the button, which said Unfollow, before it pressed", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await user.hover(button);
      expectSays(button, "unfollow", "Fay");

      const unfollow = nextChange();
      fireEvent.pointerDown(button, mouse);
      fireEvent.pointerUp(button, mouse);
      pointerClick(button);

      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED);
    });

    it("shows Unfollow again for a press that began on Unfollow and ends once it has gone: the click is on Following", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      await tap(user, button);
      expectSays(button, "unfollow", "Fay");

      // A finger comes down on Unfollow, and stays down until its ten seconds are over.
      fireEvent.pointerDown(button, { pointerType: "touch" });
      await after(UNFOLLOW_SHOWN_MS);
      expectSays(button, "following", "Fay");
      fireEvent.pointerUp(button, { pointerType: "touch" });
      pointerClick(button);

      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();
    });

    it("lets a press that never became a click decide nothing for a key's click, which acts on what the button says", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      // A finger comes down on Following and slides away: no click comes of it.
      fireEvent.pointerDown(button, { pointerType: "touch" });

      // The keyboard's focus comes to it: Unfollow. Enter is on that.
      await tabTo(user);
      expectSays(button, "unfollow", "Fay");
      const unfollow = nextChange();
      await user.keyboard("{Enter}");

      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED);
    });

    it("only shows Unfollow when a mouse is let go on a press that began on Following, though a key showed Unfollow while it was held: the key's click is not the press's own", async () => {
      const user = person();
      const { w } = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      // The mouse comes down on Following, and is held. Its press gave the button the focus, which is no keyboard's.
      fireEvent.pointerDown(button, mouse);
      act(() => button.focus());
      expectSays(button, "following", "Fay");

      // Enter, with the mouse still down: it said Following, so the key shows Unfollow.
      await user.keyboard("{Enter}");
      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();

      // The mouse is let go, once a double tap's time is over: its click ends a press that began on Following.
      await after(UNFOLLOW_GUARD_MS);
      fireEvent.pointerUp(button, mouse);
      pointerClick(button);

      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    });

    it("lets go of a press that was cancelled (a scroll that began on the button): a click that comes after it with no press of its own acts on what the button says", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      fireEvent.pointerDown(button, { pointerType: "touch" });
      fireEvent.pointerCancel(button, { pointerType: "touch" });

      // A mouse comes onto it: Unfollow. Then a click that counts itself and has no pointer's press
      // before it, as some tools that press for a person send.
      await user.hover(button);
      expectSays(button, "unfollow", "Fay");
      const unfollow = nextChange();
      pointerClick(button);

      expect(change).toHaveBeenCalledTimes(1);
      expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED);
    });

    it("lets go of a press that was dragged away, and never clicked, when the next press begins: a mouse that comes back onto Unfollow and clicks unfollows", async () => {
      const user = person();
      const { button } = await followedBy((it) => user.click(it));
      // Down on Following (the pointer has not left since the follow), off the button, and let go elsewhere: no click.
      fireEvent.pointerDown(button, mouse);
      await user.unhover(button);
      fireEvent.pointerUp(document.body, mouse);

      await user.hover(button);
      expectSays(button, "unfollow");
      const unfollow = nextChange();
      await user.click(button);

      expect(change).toHaveBeenCalledTimes(2);
      expect(asked(1)).toEqual({ who: STRANGER, action: "unfollow" });
      await unfollow.ends(UNFOLLOWED_SOL);
    });

    it("costs one press at most, where a press that never clicked is followed by a click with no press of its own: that click shows Unfollow, and the next unfollows", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      // Down on Following, and dragged away: nothing cancels it, and no click comes.
      fireEvent.pointerDown(button, mouse);
      await user.hover(button);
      expectSays(button, "unfollow", "Fay");

      pointerClick(button);
      expectSays(button, "unfollow", "Fay");
      expect(change).not.toHaveBeenCalled();

      await after(UNFOLLOW_GUARD_MS);
      const unfollow = nextChange();
      pointerClick(button);
      expect(change).toHaveBeenCalledTimes(1);
      await unfollow.ends(UNFOLLOWED);
    });
  });

  describe("what is heard when a press shows it (ruling R48)", () => {
    /**
     * The line that says a press showed Unfollow: in the polite status of the button's own lines,
     * where a screen reader hears it as it comes, and not seen. Null when it is not there.
     */
    const heard = (label: string) => changeSaid(label).querySelector<HTMLElement>("p.sr-only");

    function expectHeard(label: string, name: string): void {
      const line = heard(label);
      expect(line).not.toBeNull();
      expect(line!.textContent).toBe(copy.follow.pressAgain(name));
      // The name is kept apart from the direction of the words around it, as in the button's other lines.
      expect(line!.querySelector("bdi")).toHaveTextContent(name);
      // Said once: nothing else on the page says it.
      expect([...document.querySelectorAll("p")].filter((each) => each.textContent === copy.follow.pressAgain(name))).toEqual([line]);
    }

    it.each<[string, (user: Hands, button: HTMLElement) => unknown]>([
      ["a finger's tap", (user, button) => tap(user, button)],
      ["a click that comes with no pointer and no focus (a screen reader's)", (_, button) => fireEvent.click(button)],
      [
        "a key, with the focus on the button from before",
        async (user, button) => {
          act(() => button.focus());
          await user.keyboard("{Enter}");
        },
      ],
    ])("says Press again to unfollow, politely and unseen, once %s has shown Unfollow", async (_, press) => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      expect(heard("it")).toBeNull();

      await press(user, button);

      expectSays(button, "unfollow", "Fay");
      expectHeard("it", "Fay");
      // Not seen, and given no room: the row of the lines is as it is with nothing in it, so nothing under the button moves.
      expect(changeSaid("it").parentElement).not.toHaveClass("pt-1");
      expect(changeSaid("it").querySelectorAll("p:not(.sr-only)")).toHaveLength(0);
      expect(change).not.toHaveBeenCalled();
    });

    it("says nothing of it when a mouse over the button, or the keyboard's focus coming to it, shows Unfollow: nothing was pressed", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;

      await user.hover(button);
      expectSays(button, "unfollow", "Fay");
      expect(heard("it")).toBeNull();
      await user.unhover(button);

      await tabTo(user);
      expectSays(button, "unfollow", "Fay");
      expect(heard("it")).toBeNull();
      expectNothingSaid("it");
    });

    it.each<[string, (page: { goTo(to: string): Promise<unknown> }, button: HTMLElement) => unknown]>([
      ["its ten seconds are over", () => after(UNFOLLOW_SHOWN_MS)],
      ["a press elsewhere takes Unfollow back", () => void fireEvent.pointerDown(document.body, { pointerType: "touch" })],
      ["the button loses the focus", (_, button) => act(() => button.blur())],
      ["the person goes to another page", (page) => page.goTo("/elsewhere")],
    ])("says it no more once %s: it goes with Unfollow", async (_, ends) => {
      const page = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      act(() => button.focus());
      fireEvent.click(button);
      expectSays(button, "unfollow", "Fay");
      expectHeard("it", "Fay");

      await ends(page, button);

      expectSays(buttonIn("it")!, "following", "Fay");
      expect(heard("it")).toBeNull();
      expectNothingSaid("it");
      expect(change).not.toHaveBeenCalled();
    });

    it("says it no more once Unfollow is pressed: who is no longer followed is said in its place", async () => {
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      fireEvent.click(button);
      expectHeard("it", "Fay");
      act(() => void vi.advanceTimersByTime(UNFOLLOW_GUARD_MS));

      const unfollow = nextChange();
      fireEvent.click(button);

      expect(button).toHaveTextContent(copy.follow.saving);
      expect(heard("it")).toBeNull();
      await unfollow.ends(UNFOLLOWED);
      expect(heard("it")).toBeNull();
      expect(changeSaid("it").textContent).toBe(copy.follow.unfollowed("Fay"));
    });

    it("says it beside what the button has to say already, which keeps its room and its Try again", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const refused = nextChange();
      await unfollowByMouse(user, button);
      await refused.ends({ kind: "not-approved" });
      expect(changeSaid("it").textContent).toBe(copy.follow.notApproved);

      // The pointer has not left: the click shows Unfollow, and asks for nothing.
      await user.click(button);

      expectSays(button, "unfollow", "Fay");
      expectHeard("it", "Fay");
      expect(changeSaid("it")).toHaveTextContent(copy.follow.notApproved);
      expect(changeSaid("it").parentElement).toHaveClass("pt-1");
      expect(wordIn("it", copy.follow.tryAgain)).toBeInTheDocument();
      expect(change).toHaveBeenCalledTimes(1);
    });

    it("says it in the place the page gives the main button's lines, when it gives one", async () => {
      signedInAs(SECRET);
      config.houseTrustRelays = [];
      function Apart(): JSX.Element {
        const [place, setPlace] = useState<HTMLElement | null>(null);
        return (
          <>
            <section aria-label="button">
              <FollowButton {...MAIN_FRIEND} linesIn={place} />
            </section>
            <section aria-label="lines" ref={setPlace} />
          </>
        );
      }
      await openPageInShell(relays(), <Apart />);
      await waitFor(() => expect(buttonIn("button")).not.toBeNull());
      await after(TOWNS_WAIT_MS);

      fireEvent.click(buttonIn("button")!);

      expectSays(buttonIn("button")!, "unfollow", "Fay");
      expectHeard("lines", "Fay");
      expect(within(part("button")).queryAllByRole("status")).toEqual([]);
    });
  });

  describe("what it leaves behind", () => {
    /** How many presses on the page the document is listening for. */
    function listening() {
      const added = vi.spyOn(document, "addEventListener");
      const removed = vi.spyOn(document, "removeEventListener");
      const count = (spy: typeof added | typeof removed) => spy.mock.calls.filter(([type]) => type === "pointerdown").length;
      return () => count(added) - count(removed);
    }

    it("listens for a press elsewhere, and keeps time, only while a press has Unfollow shown", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const listeners = listening();
      const timers = vi.getTimerCount();

      // A mouse over it, and the keyboard's focus on it: Unfollow, with nothing to wait for.
      await user.hover(button);
      expectSays(button, "unfollow", "Fay");
      expect([listeners(), vi.getTimerCount() - timers]).toEqual([0, 0]);
      await user.unhover(button);

      // A press: the ten seconds, the guard, and one listener.
      fireEvent.click(button);
      expectSays(button, "unfollow", "Fay");
      expect([listeners(), vi.getTimerCount() - timers]).toEqual([1, 2]);

      // Once both have run out, nothing.
      await after(UNFOLLOW_SHOWN_MS);
      expectSays(button, "following", "Fay");
      expect([listeners(), vi.getTimerCount() - timers]).toEqual([0, 0]);
    });

    it.each<[string, (page: { goTo(to: string): Promise<unknown> }, button: HTMLElement) => unknown]>([
      ["the button goes from the page", () => showButtons({})],
      ["a press elsewhere takes it back", () => fireEvent.pointerDown(document.body, { pointerType: "touch" })],
      ["the button loses the focus", (_, button) => act(() => button.blur())],
      ["the person goes to another page", (page) => page.goTo("/elsewhere")],
    ])("leaves no timer for Unfollow, and no listener on the document, when %s while Unfollow is shown", async (_, ends) => {
      const page = await opened({ it: MAIN_FRIEND });
      const button = buttonIn("it")!;
      const listeners = listening();
      const timers = vi.getTimerCount();
      act(() => button.focus());
      fireEvent.click(button);
      expectSays(button, "unfollow", "Fay");
      expect(listeners()).toBe(1);

      await ends(page, button);

      expect(listeners()).toBe(0);
      // The guard's 400 ms may be running still, where the button is still there: nothing else is.
      await after(UNFOLLOW_GUARD_MS);
      expect(vi.getTimerCount() - timers).toBe(0);
      expect(change).not.toHaveBeenCalled();
    });

    it("shows nothing of it on a button drawn for someone else in its place: a first press for one person is none for another", async () => {
      const user = person();
      await opened({ it: MAIN_FRIEND });
      await tap(user, buttonIn("it")!);
      expectSays(buttonIn("it")!, "unfollow", "Fay");

      // The same place on the page, for Gil, whom the person follows too.
      showButtons({ it: { pubkey: GIL, name: "Gil", size: "main" } });

      expectSays(buttonIn("it")!, "following", "Gil");
      // A tap on it is a first tap for Gil.
      await tap(user, buttonIn("it")!);
      expectSays(buttonIn("it")!, "unfollow", "Gil");
      expect(change).not.toHaveBeenCalled();
    });
  });
});

describe("unfollowing, and Undo", () => {
  it("takes the person out on a click of Unfollow, which Following says under the mouse that comes onto it, and offers Undo for ten seconds, with who it was", async () => {
    const user = person();
    await opened({ it: MAIN_FRIEND });
    const button = buttonIn("it")!;
    expect(button).toHaveTextContent(copy.follow.following);

    const unfollow = nextChange();
    await unfollowByMouse(user, button);
    expect(change).toHaveBeenCalledTimes(1);
    expect(asked(0)).toEqual({ who: FRIEND, action: "unfollow" });
    expect(button).toHaveTextContent(copy.follow.saving);
    expect(button).toHaveFocus();
    await unfollow.ends(UNFOLLOWED);

    expect(button).toHaveTextContent(copy.follow.follow);
    expect(button).toHaveFocus();
    expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Fay"));
    expect(copy.follow.unfollowed("Fay")).toBe("You no longer follow Fay.");
    const undo = wordIn("it", copy.follow.undo)!;
    expect(undo).toHaveAccessibleDescription(copy.follow.unfollowed("Fay"));
    // A short word, and a touch target all the same.
    expect(undo).toHaveClass("min-h-touch", "min-w-touch");
    // An unfollow says nothing of the circle.
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();

    await after(UNDO_MS / 2);
    expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();
    await after(UNDO_MS / 2);
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    expectNothingSaid("it");
    expect(button).toHaveTextContent(copy.follow.follow);
  });

  it("puts them back on Undo, with the focus on the button, and says nothing of the circle after: nothing changed for it", async () => {
    circleKept(ME, "ready");
    const user = person();
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);

    const undo = nextChange();
    await user.click(wordIn("it", copy.follow.undo)!);
    expect(asked(1)).toEqual({ who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    expect(buttonIn("it")).toHaveTextContent(copy.follow.saving);
    expect(buttonIn("it")).toHaveFocus();
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    await undo.ends({ kind: "saved", list: PUT_BACK, confirmed: true });

    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expect(buttonIn("it")).toHaveFocus();
    expectNothingSaid("it");
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
  });

  it("puts them back as they were on a tap of Follow in Undo's ten seconds too, and says nothing of the circle after (ruling R28)", async () => {
    circleKept(ME, "ready");
    const user = person();
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);
    expect(buttonIn("it")).toHaveTextContent(copy.follow.follow);

    // The button, not Undo: the same is asked for, so the entry goes back where it was, as it was.
    const back = nextChange();
    await user.click(buttonIn("it")!);
    expect(asked(1)).toEqual({ who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    await back.ends({ kind: "saved", list: PUT_BACK, confirmed: true });

    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expectNothingSaid("it");
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
  });

  it("gives the focus to the button when Undo's ten seconds end with the focus on Undo, and leaves it alone when it is elsewhere", async () => {
    const user = person();
    await opened({ it: MAIN_FRIEND, other: MAIN });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);
    act(() => wordIn("it", copy.follow.undo)!.focus());
    expect(wordIn("it", copy.follow.undo)).toHaveFocus();

    await after(UNDO_MS);

    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    expect(buttonIn("it")).toHaveFocus();

    // The other way: Undo goes while the focus is on something else, and the focus stays there.
    // (Followed again, and unfollowed by two clicks: the pointer has not left the button since the follow.)
    const again = nextChange();
    await user.click(buttonIn("it")!);
    await again.ends({ kind: "saved", list: PUT_BACK, confirmed: true });
    const second = nextChange();
    await unfollowInTwo(() => user.click(buttonIn("it")!), buttonIn("it")!);
    await second.ends({ kind: "saved", list: listOf(WITHOUT_FRIEND.tags, 30), confirmed: true, removed: TAKEN_OUT });
    expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();
    act(() => buttonIn("other")!.focus());
    await after(UNDO_MS);
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    expect(buttonIn("other")).toHaveFocus();
  });

  it("makes one change for Enter held down on Undo: put back, they are not taken out again by the key still down", async () => {
    const user = person();
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);
    // The Undo ends as soon as it is asked for: the key is still down when the button says Following.
    change.mockResolvedValueOnce({ kind: "saved", list: PUT_BACK, confirmed: true });
    act(() => wordIn("it", copy.follow.undo)!.focus());

    await user.keyboard("{Enter>6/}");

    await waitFor(() => expect(buttonIn("it")).toHaveTextContent(copy.follow.following));
    expect(buttonIn("it")).toHaveFocus();
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1).action).toEqual({ restore: TAKEN_OUT, left: WITHOUT_FRIEND.id });
  });

  it("keeps the small button's Undo line beside it for its ten seconds, and the button once Undo has put them back", async () => {
    const user = person();
    await followed({ it: SMALL });
    const button = buttonIn("it")!;

    // Unfollowed from the review: the button says Follow again, and Undo is under it.
    const unfollow = nextChange();
    await unfollowByMouse(user, button);
    expect(asked(1)).toEqual({ who: STRANGER, action: "unfollow" });
    await unfollow.ends({ kind: "saved", list: listOf(LIST.tags, 20), confirmed: true, removed: [{ index: LIST.tags.length, tag: ["p", STRANGER] }] });
    expect(buttonIn("it")).toBe(button);
    expect(button).toHaveTextContent(copy.follow.follow);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Sol"));
    expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();

    // Undo: Following again, on the same button, though nothing has just been said of them.
    const undo = nextChange();
    await user.click(wordIn("it", copy.follow.undo)!);
    await undo.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER]], 30), confirmed: true });
    expect(buttonIn("it")).toBe(button);
    expect(button).toHaveTextContent(copy.follow.following);
    expect(button).toHaveFocus();
    expectNothingSaid("it");
  });

  it("offers Undo again when it did not save, with what went wrong, and no Try again beside it until its ten seconds are over", async () => {
    const user = person();
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);

    const undo = nextChange();
    await user.click(wordIn("it", copy.follow.undo)!);
    await undo.ends({ kind: "not-approved" });

    expect(buttonIn("it")).toHaveTextContent(copy.follow.follow);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.notApproved);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Fay"));
    expect(wordIn("it", copy.follow.tryAgain)).not.toBeInTheDocument();
    // Undo asks for the same again: what the unfollow took out, where it was.
    const again = nextChange();
    await user.click(wordIn("it", copy.follow.undo)!);
    expect(asked(2)).toEqual(asked(1));
    await again.ends({ kind: "not-approved" });

    // Its ten seconds over, there is nothing to put back: Try again follows them as anyone is followed.
    await after(UNDO_MS);
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    expect(changeSaid("it")).not.toHaveTextContent(copy.follow.unfollowed("Fay"));
    expect(changeSaid("it")).toHaveTextContent(copy.follow.notApproved);
    const follow = nextChange();
    await user.click(wordIn("it", copy.follow.tryAgain)!);
    expect(asked(3)).toEqual({ who: FRIEND, action: "follow" });
    await follow.ends({ kind: "unchanged", list: PUT_BACK });
  });
});

describe("when it can't be done", () => {
  it.each([
    ["the list could not be loaded", { kind: "not-loaded" }, copy.follow.notLoaded, "We couldn't load the list of people you follow, so nothing was changed."],
    ["it was not approved", { kind: "not-approved" }, copy.follow.notApproved, "That wasn't approved, so nothing was changed."],
    ["nothing took the new list", { kind: "not-saved" }, copy.follow.notSaved, "That didn't save. Nothing was changed."],
  ] as const)("says that %s, with Try again, which follows again", async (_, outcome, line, words) => {
    const user = person();
    await opened({ it: SMALL });
    const button = buttonIn("it")!;
    const follow = nextChange();
    await user.click(button);

    await follow.ends(outcome);

    expect(line).toBe(words);
    expect(button).toHaveTextContent(copy.follow.follow);
    expect(button).toHaveFocus();
    expect(changeSaid("it")).toHaveTextContent(line);
    const again = wordIn("it", copy.follow.tryAgain)!;
    expect(again).toHaveAccessibleDescription(line);
    expect(again).toHaveClass("min-h-touch", "min-w-touch");

    // Try again is the same change again: the line goes, and the focus is on the button, which says Saving.
    const second = nextChange();
    await user.click(again);
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual({ who: STRANGER, action: "follow" });
    expectNothingSaid("it");
    expect(wordIn("it", copy.follow.tryAgain)).not.toBeInTheDocument();
    expect(button).toHaveTextContent(copy.follow.saving);
    expect(button).toHaveFocus();
    await second.ends(FOLLOWED);
    expect(button).toHaveTextContent(copy.follow.following);
  });

  it.each([
    ["a follow", SMALL, STRANGER, "follow"],
    ["an unfollow", MAIN_FRIEND, FRIEND, "unfollow"],
  ] as const)("makes one more change for Enter held down on Try again after %s that was not made: the key, still down once that has ended, makes no other", async (_, shown, who, action) => {
    const user = person();
    await opened({ it: shown });
    const first = nextChange();
    // Follow is a click. Unfollow is a click too, on what Following says under the mouse that comes onto it.
    if (action === "unfollow") await unfollowByMouse(user, buttonIn("it")!);
    else await user.click(buttonIn("it")!);
    expect(asked(0)).toEqual({ who, action });
    await first.ends({ kind: "not-approved" });
    // The change tried again ends as soon as it is asked for, not made again: Try again is back while the key is down.
    change.mockResolvedValueOnce({ kind: "not-approved" });
    act(() => wordIn("it", copy.follow.tryAgain)!.focus());

    await user.keyboard("{Enter>6/}");

    await waitFor(() => expect(changeSaid("it")).toHaveTextContent(copy.follow.notApproved));
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual({ who, action });
    // The word went with the focus on it: the button has it, and the key held down there changed nothing.
    expect(buttonIn("it")).toHaveFocus();
    // A press of its own on Try again is a change of its own, as before.
    const again = nextChange();
    act(() => wordIn("it", copy.follow.tryAgain)!.focus());
    await user.keyboard("{Enter}");
    expect(change).toHaveBeenCalledTimes(3);
    expect(asked(2)).toEqual({ who, action });
    await again.ends({ kind: "not-approved" });
  });

  it("says the same of a change that failed with no name, as one nothing took", async () => {
    const user = person();
    await opened({ it: MAIN });
    const follow = nextChange();
    await user.click(buttonIn("it")!);

    await follow.fails(new Error("something unforeseen"));

    expect(changeSaid("it")).toHaveTextContent(copy.follow.notSaved);
    expect(wordIn("it", copy.follow.tryAgain)).toBeInTheDocument();
  });

  it("says an unfollow was not made, on a button that still says Following, small or main, and Try again unfollows again", async () => {
    const user = person();
    await followed({ rail: MAIN, review: SMALL }, {}, "review");
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("review")!);

    await unfollow.ends({ kind: "not-approved" });

    // Still followed, and nothing was just said of them: the small button stays, to say what went wrong.
    for (const label of ["rail", "review"]) {
      expect(buttonIn(label)).toHaveTextContent(copy.follow.following);
      expect(changeSaid(label)).toHaveTextContent(copy.follow.notApproved);
      expect(circleSaid(label)).not.toHaveTextContent(copy.follow.countsAfterUpdate);
    }
    const again = nextChange();
    await user.click(wordIn("review", copy.follow.tryAgain)!);
    expect(asked(2)).toEqual({ who: STRANGER, action: "unfollow" });
    await again.ends({ kind: "not-approved" });
  });

  it("lets go of a follow that 'didn't save' once the list names the reviewer after all: Following, with no Try again that would take them out (ruling R27)", async () => {
    const user = person();
    await opened({ it: SMALL, other: { pubkey: OUTSIDER, name: "Odile", size: "small" } });
    const follow = nextChange();
    await user.click(buttonIn("it")!);
    await follow.ends({ kind: "not-saved" });
    expect(changeSaid("it")).toHaveTextContent(copy.follow.notSaved);
    expect(wordIn("it", copy.follow.tryAgain)).toBeInTheDocument();

    // Odile is followed. That change read the list afresh and found Sol in it: a relay had taken the
    // first one without saying so in time. It saved, and its list is the one held now.
    const other = nextChange();
    await user.click(buttonIn("other")!);
    await other.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", STRANGER], ["p", OUTSIDER]], 20), confirmed: true });

    // Sol's button says Following, with nothing wrong under it and nothing to try again.
    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expectNothingSaid("it");
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);
    // And nothing more was asked for Sol: one follow each.
    expect(change.mock.calls.map(([, who, action]) => [who, action])).toEqual([
      [STRANGER, "follow"],
      [OUTSIDER, "follow"],
    ]);
  });

  it("lets go of an unfollow that 'wasn't approved' once the list no longer names them: Follow, with no Try again that would follow them (ruling R27)", async () => {
    const user = person();
    await opened({ it: MAIN_FRIEND, other: SMALL });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);
    await unfollow.ends({ kind: "not-approved" });
    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.notApproved);
    expect(wordIn("it", copy.follow.tryAgain)).toBeInTheDocument();

    // Sol is followed, and the list that change saved has no Fay in it: another app took her out.
    const other = nextChange();
    await user.click(buttonIn("other")!);
    await other.ends({ kind: "saved", list: listOf([...WITHOUT_FRIEND.tags, ["p", STRANGER]], 20), confirmed: true });

    expect(buttonIn("it")).toHaveTextContent(copy.follow.follow);
    expectNothingSaid("it");
    expect(within(part("it")).getAllByRole("button")).toEqual([buttonIn("it")]);
    expect(change.mock.calls.map(([, who, action]) => [who, action])).toEqual([
      [FRIEND, "unfollow"],
      [STRANGER, "follow"],
    ]);
  });

  it("says a follow was saved and could not be checked, with the new state and no Try again", async () => {
    circleKept(ME, "ready");
    const user = person();
    await opened({ it: MAIN });
    const follow = nextChange();
    await user.click(buttonIn("it")!);

    await follow.ends({ kind: "saved", list: WITH_STRANGER, confirmed: false });

    expect(buttonIn("it")).toHaveTextContent(copy.follow.following);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.unconfirmed);
    expect(copy.follow.unconfirmed).toBe("Saved, but we couldn't check it yet.");
    expect(circleSaid("it")).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(wordIn("it", copy.follow.tryAgain)).not.toBeInTheDocument();
    expect(wordIn("it", copy.follow.updateNow)).toBeInTheDocument();
  });

  it("says an unfollow was saved and could not be checked, and it can be undone all the same", async () => {
    const user = person();
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    await unfollowByMouse(user, buttonIn("it")!);

    await unfollow.ends({ ...UNFOLLOWED, confirmed: false } as FollowOutcome);

    expect(buttonIn("it")).toHaveTextContent(copy.follow.follow);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.unconfirmed);
    expect(changeSaid("it")).toHaveTextContent(copy.follow.unfollowed("Fay"));
    expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();
    expect(wordIn("it", copy.follow.tryAgain)).not.toBeInTheDocument();
  });
});

describe("a tap in a browser that does not focus a button it is tapped on (Safari)", () => {
  /**
   * A tap as Safari makes it: the click, with the focus left where it was, here on nothing. (A tap
   * elsewhere in these tests is the other browsers', which put the focus on the button tapped.)
   */
  function tapUnfocused(control: HTMLElement): void {
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.body).toHaveFocus();
    fireEvent.click(control);
  }

  it("leaves the focus on the button when Undo is tapped, and goes", async () => {
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    // Two taps (ruling R47): the first shows Unfollow, and the focus is on nothing still.
    await unfollowInTwo(() => tapUnfocused(buttonIn("it")!), buttonIn("it")!);
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();

    tapUnfocused(wordIn("it", copy.follow.undo)!);

    await waitFor(() => expect(buttonIn("it")).toHaveFocus());
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    expect(buttonIn("it")).toHaveTextContent(copy.follow.saving);
    await undo.ends({ kind: "saved", list: PUT_BACK, confirmed: true });
    expect(buttonIn("it")).toHaveFocus();
  });

  it("leaves the focus on the button when Try again is tapped, and goes", async () => {
    await opened({ it: SMALL });
    const follow = nextChange();
    tapUnfocused(buttonIn("it")!);
    await follow.ends({ kind: "not-approved" });
    const again = nextChange();

    tapUnfocused(wordIn("it", copy.follow.tryAgain)!);

    await waitFor(() => expect(buttonIn("it")).toHaveFocus());
    expect(wordIn("it", copy.follow.tryAgain)).not.toBeInTheDocument();
    await again.ends(FOLLOWED);
    expect(buttonIn("it")).toHaveFocus();
  });

  it("leaves the focus by the lines when Update now is tapped, and goes; and when Cancel is", async () => {
    circleKept(ME, "ready");
    const answer = gate();
    brainstorm.signInToBrainstorm.mockImplementation(async () => {
      await answer.closed;
      throw new Error("The person said no");
    });
    await followed({ it: MAIN });

    tapUnfocused(wordIn("it", copy.follow.updateNow)!);

    // The person's add-on is asked: Update now has gone, and Cancel is in its place.
    await waitFor(() => expect(wordIn("it", copy.circle.cancel)).toBeInTheDocument());
    expect(wordIn("it", copy.follow.updateNow)).not.toBeInTheDocument();
    const byTheLines = () => {
      expect(document.activeElement).not.toBe(document.body);
      expect(part("it")).toContainElement(document.activeElement as HTMLElement);
      expect(document.activeElement).not.toBe(buttonIn("it"));
      expect(document.activeElement?.tagName).not.toBe("BUTTON");
    };
    await waitFor(byTheLines);

    tapUnfocused(wordIn("it", copy.circle.cancel)!);

    await waitFor(() => expect(wordIn("it", copy.circle.cancel)).not.toBeInTheDocument());
    await waitFor(byTheLines);
    await answer.open();
  });

  it("leaves the focus on a word that is tapped and stays, as the other browsers do", async () => {
    // A circle whose update does nothing: Update now is not replaced.
    const circle = circleOf({});
    await followed({ it: MAIN }, { circle });
    const update = wordIn("it", copy.follow.updateNow)!;

    tapUnfocused(update);

    expect(circle.update).toHaveBeenCalledTimes(1);
    expect(wordIn("it", copy.follow.updateNow)).toBe(update);
    expect(update).toHaveFocus();
  });

  it("moves the focus for a tap only: a word that comes, and one that goes untapped while the focus is on nothing, move none", async () => {
    await opened({ it: MAIN_FRIEND });
    const unfollow = nextChange();
    // Two taps (ruling R47): the first shows Unfollow, which takes no focus either.
    await unfollowInTwo(() => tapUnfocused(buttonIn("it")!), buttonIn("it")!);

    // Undo comes: nothing takes the focus.
    await unfollow.ends(UNFOLLOWED);
    expect(wordIn("it", copy.follow.undo)).toBeInTheDocument();
    expect(document.body).toHaveFocus();

    // Its ten seconds end: it goes, and the focus is where it was.
    await after(UNDO_MS);
    expect(wordIn("it", copy.follow.undo)).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });
});

describe("the main button's lines, drawn where the page says (`linesIn`)", () => {
  /**
   * A page that gives the main button's lines a place of their own, apart from the button, as a
   * person's page does on a phone; `placed` false is that place not on the page yet.
   */
  function Apart({ shown, placed = true }: { shown: Shown; placed?: boolean }): JSX.Element {
    const [place, setPlace] = useState<HTMLElement | null>(null);
    return (
      <>
        <section aria-label="button">
          <FollowButton {...shown} linesIn={placed ? place : null} />
        </section>
        <section aria-label="lines" ref={setPlace} />
      </>
    );
  }

  async function openApart(shown: Shown, placed = true) {
    signedInAs(SECRET);
    config.houseTrustRelays = [];
    const page = await openPageInShell(relays(), <Apart shown={shown} placed={placed} />);
    await waitFor(() => expect(buttonIn("button")).not.toBeNull());
    await after(TOWNS_WAIT_MS);
    return page;
  }

  it("draws them there and not under the button, with the same words, and Undo there gives the focus back to the button", async () => {
    const user = person();
    await openApart(MAIN_FRIEND);
    // Both statuses are in the place the page gave, empty, from the start: a line that comes is heard.
    expect(within(part("button")).queryAllByRole("status")).toEqual([]);
    expect(within(part("lines")).getAllByRole("status")).toHaveLength(2);
    expectNothingSaid("lines");
    const button = buttonIn("button")!;
    const unfollow = nextChange();
    await unfollowByMouse(user, button);

    await unfollow.ends(UNFOLLOWED);

    expect(changeSaid("lines")).toHaveTextContent(copy.follow.unfollowed("Fay"));
    const undo = wordIn("lines", copy.follow.undo)!;
    // The button's part of the page holds the button and nothing else.
    expect(within(part("button")).getAllByRole("button")).toEqual([button]);
    expect(part("button")).not.toHaveTextContent(copy.follow.unfollowed("Fay"));

    const back = nextChange();
    await user.click(undo);
    await back.ends({ kind: "saved", list: PUT_BACK, confirmed: true });

    expect(button).toHaveTextContent(copy.follow.following);
    expect(undo).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expectNothingSaid("lines");
  });

  it("draws no lines while the page has not drawn their place yet, and the button is there all the same", async () => {
    const user = person();
    await openApart(MAIN_FRIEND, false);
    expect(screen.queryAllByRole("status").filter((status) => part("button").contains(status) || part("lines").contains(status))).toEqual([]);
    const button = buttonIn("button")!;
    const unfollow = nextChange();
    await unfollowByMouse(user, button);
    await unfollow.ends(UNFOLLOWED);

    expect(button).toHaveTextContent(copy.follow.follow);
    expect(part("button")).not.toHaveTextContent(copy.follow.unfollowed("Fay"));
    expect(part("lines")).toBeEmptyDOMElement();
  });

  it("is the main button's alone: a small button keeps its lines with it, in the row it is in", async () => {
    const user = person();
    await openApart({ pubkey: STRANGER, name: "Sol", size: "small" });
    const follow = nextChange();
    await user.click(buttonIn("button")!);
    await follow.ends({ kind: "not-approved" });

    expect(changeSaid("button")).toHaveTextContent(copy.follow.notApproved);
    expect(part("lines")).toBeEmptyDOMElement();
  });
});
