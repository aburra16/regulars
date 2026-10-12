import { act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, type MockedFunction, type MockedObject, vi } from "vitest";

import type * as brainstormClient from "../../src/circle/brainstorm";
import { CIRCLE_KEY } from "../../src/circle/CircleProvider";
import { saveToken } from "../../src/circle/token";
import { config } from "../../src/config";
import { copy } from "../../src/copy/en";
import { type changeFollow, type FollowOutcome, forgetFollowFloor } from "../../src/follow/change";
import { UNFOLLOW_GUARD_MS } from "../../src/follow/FollowButton";
import { TOWNS_WAIT_MS } from "../../src/places/store";
import { ABSENT, buildFollowList, FOLLOW_LIST_TIME, pubkeyAt } from "../fixtures/follow-list";
import { resetWidth } from "./app";
import { setUpRelays, strangers } from "./followWorld";

/*
 * What the tests of the Follow button share (tests/followButton.test.tsx, on a page of the test's
 * own; tests/followOnPlace.test.tsx, on the real page of a place): the people, the lists a change
 * leaves, a change the test plays, Brainstorm's stand-ins, and how each test starts and ends.
 *
 * Each of those files mocks `changeFollow` (around the real one) and Brainstorm's client itself, as a
 * mock must be made in the file that is tested, and hands the mocks to what is here. The keys are
 * thrown away, the relays are held in memory, and nothing opens a socket or reaches the network.
 */

/** `changeFollow`, mocked around the real one: the real change, unless a test plays the next (`played`). */
export type MockedChange = MockedFunction<typeof changeFollow>;
/** Brainstorm's client, its four network calls mocked. */
export type MockedBrainstorm = MockedObject<typeof brainstormClient>;

/** A token as Brainstorm gives one. Made up. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJuIjoxfQ.c2lnbmF0dXJl";

/** The person signed in on a page of the test's own. */
export const SECRET = generateSecretKey();
export const ME = getPublicKey(SECRET);

/** Their list of 1,200 entries; someone it names, at `FRIEND_AT`, with nothing after the key; and two it does not name. */
export const LIST = buildFollowList(SECRET);
export const FRIEND_AT = 8;
export const FRIEND = pubkeyAt(FRIEND_AT);
export const STRANGER = ABSENT;
export const OUTSIDER = pubkeyAt(20_001);

/** A list of theirs with `tags`, made `at` seconds after the first. */
export const listOf = (tags: string[][], at: number) =>
  finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + at, content: LIST.content, tags }, SECRET);

/** The list a follow of the stranger leaves, the one an unfollow of the friend leaves with what it takes out, and the one an Undo of that leaves. */
export const WITH_STRANGER = listOf([...LIST.tags, ["p", STRANGER]], 10);
export const WITHOUT_FRIEND = listOf(LIST.tags.filter((_, place) => place !== FRIEND_AT), 10);
export const TAKEN_OUT = [{ index: FRIEND_AT, tag: ["p", FRIEND] }];
export const PUT_BACK = listOf(LIST.tags, 20);
/** How a follow of the stranger ends when it is saved, and an unfollow of the friend. */
export const FOLLOWED: FollowOutcome = { kind: "saved", list: WITH_STRANGER, confirmed: true };
export const UNFOLLOWED: FollowOutcome = { kind: "saved", list: WITHOUT_FRIEND, confirmed: true, removed: TAKEN_OUT };

/** The scorer of a person's circle, and its relay. Made up. */
export const CIRCLE_SCORER = "5c0e".repeat(16);
export const CIRCLE_RELAY = "wss://circle.example.test";

/** Earlier this session the circle of the person with `pubkey` was where `state` says: the tab kept it, and asks Brainstorm nothing. */
export function circleKept(pubkey: string, state: "off" | "ready"): void {
  config.features.circle = true;
  const kept = state === "ready" ? { pubkey, state, scorer: { pubkey: CIRCLE_SCORER, relay: CIRCLE_RELAY } } : { pubkey, state };
  window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify(kept));
}

/** Moves the fake clock on, and lets what was waiting on it run. */
export const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Taps and keys as a person makes them, on the fake clock. */
export const person = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

/**
 * A person whose hands take `ms` between one thing and the next, on the fake clock: a key they hold
 * down repeats that far apart. What waits on the clock meanwhile runs, as under `after`.
 */
export const slowPerson = (ms: number) => userEvent.setup({ delay: ms, advanceTimers: (wait) => act(() => void vi.advanceTimersByTime(wait)) });

/** A person, as `person` makes one: a mouse, fingers and a keyboard. */
export type Hands = ReturnType<typeof person>;

/** A tap of a finger on `target`: the touch, and after it the mouse's events and the click a browser sends for one. */
export const tap = (user: Hands, target: Element) => user.pointer([{ keys: "[TouchA]", target }]);

/**
 * Unfollows with a mouse (ruling R47): the pointer, which is not on `button`, comes onto it; the
 * button, which said Following, says Unfollow under it; and the click is on that. For a pointer that
 * has left the button since it became Following, or was never on it: one that has stayed on it shows
 * nothing by being there (`unfollowInTwo`).
 */
export async function unfollowByMouse(user: Hands, button: HTMLElement): Promise<void> {
  expect(button).toHaveTextContent(copy.follow.following);
  await user.hover(button);
  expect(button).toHaveTextContent(copy.follow.unfollow);
  await user.click(button);
}

/**
 * Unfollows with two presses on `button` (ruling R47), which says Following and goes on saying so
 * where the press is made: a finger, a key with the focus on it since the follow, a pointer that has
 * not left it, or a click that comes with no pointer at all. The first press shows Unfollow, and
 * changes nothing; the second, made once a double tap's time is over, is on Unfollow.
 */
export async function unfollowInTwo(press: () => unknown, button: HTMLElement): Promise<void> {
  expect(button).toHaveTextContent(copy.follow.following);
  await press();
  expect(button).toHaveTextContent(copy.follow.unfollow);
  await after(UNFOLLOW_GUARD_MS);
  await press();
}

/** The changes a test plays in place of the real one, and what the button asked for. */
export function played(change: MockedChange) {
  return {
    /**
     * The next change the button asks for: it goes on until the test ends it, with `ends` (how it
     * ended) or `fails` (what it threw).
     */
    nextChange() {
      let resolve!: (outcome: FollowOutcome) => void;
      let reject!: (error: unknown) => void;
      change.mockImplementationOnce(
        () =>
          new Promise<FollowOutcome>((res, rej) => {
            resolve = res;
            reject = rej;
          }),
      );
      return {
        ends: (outcome: FollowOutcome) => act(async () => resolve(outcome)),
        fails: (error: unknown) => act(async () => reject(error)),
      };
    },
    /** What the button asked `changeFollow` to do, the `nth` time (from 0), and to whom. */
    asked: (nth: number) => ({ who: change.mock.calls[nth]![1], action: change.mock.calls[nth]![2] }),
  };
}

/** How many times each call that reaches Brainstorm was made: its setup, its sign-in, a run asked about, a run started. */
export const askedOf = (brainstorm: MockedBrainstorm) => () =>
  [brainstorm.scorerOf, brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun].map((call) => call.mock.calls.length);

/**
 * `:focus-visible`, for these tests: a stand-in for the browser's own answer to whether the focus on
 * an element is one to show, which the Follow button asks to tell the keyboard's focus from a
 * pointer's (src/follow/FollowButton.tsx). The app asks the real thing, and jsdom has an answer to it:
 * but that answer goes by what it answered before, kept for the whole document, so a test would be
 * told one thing or another by the tests run before it. Here the rule can be read. The element that
 * has the focus matches while the last thing the person used was the keyboard (any key), and does not
 * once they have pressed with a pointer, as a browser has it for a button: Tab's focus matches, a
 * click's and a tap's do not, and focus a script moves is the keyboard's for someone using the
 * keyboard. Before either is used, it does not match. A test can have it answer as a browser set to
 * show every focus does (`focusRingsAlwaysOn`).
 *
 * So the tests show what the button does with the browser's answer. They do not show that a browser
 * gives that answer.
 */
const standIn = {
  /** Whether the last thing the person used was the keyboard. */
  keyboard: false,
  /** Whether every focus matches, a pointer's too: a browser set to show the focus ring always. */
  always: false,
  /** `Element.prototype.matches` as jsdom has it, while the stand-in is in its place. */
  matches: undefined as typeof Element.prototype.matches | undefined,
  key: () => {
    standIn.keyboard = true;
  },
  pointer: () => {
    standIn.keyboard = false;
  },
};

function standInForFocusVisible(): void {
  const matches = Element.prototype.matches;
  standIn.keyboard = false;
  standIn.always = false;
  standIn.matches = matches;
  // Assigned, not spied on: the queries of a test call `matches` many thousands of times, and a spy keeps each call.
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return selectors === ":focus-visible"
      ? (standIn.keyboard || standIn.always) && this === this.ownerDocument.activeElement
      : matches.call(this, selectors);
  } as typeof matches;
  document.addEventListener("keydown", standIn.key, true);
  for (const press of ["pointerdown", "mousedown"]) document.addEventListener(press, standIn.pointer, true);
}

/**
 * For the rest of the test, `:focus-visible` matches whatever has the focus, however it came by it: a
 * browser that shows the focus ring always (a setting some have, for people who need to see it), in
 * which a tap's own focus is taken for the keyboard's.
 */
export function focusRingsAlwaysOn(): void {
  standIn.always = true;
}

function endStandInForFocusVisible(): void {
  if (standIn.matches !== undefined) Element.prototype.matches = standIn.matches;
  standIn.matches = undefined;
  document.removeEventListener("keydown", standIn.key, true);
  for (const press of ["pointerdown", "mousedown"]) document.removeEventListener(press, standIn.pointer, true);
}

/** What the app warns of or reports as an error, for `endScene` to hold to nothing. */
export type Logs = ReturnType<typeof vi.spyOn>[];

/**
 * How each test starts: a fake clock (the timers, not the date), the follow-list relays' addresses,
 * a tab that has seen no list, the real change, and a Brainstorm that names no scorer, signs a person
 * in at once, has no run, and will not start one, as one was made lately. And `:focus-visible`
 * answered by a rule a test can go by (`standInForFocusVisible`).
 */
export function startScene(change: MockedChange, brainstorm: MockedBrainstorm): Logs {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  standInForFocusVisible();
  setUpRelays(config);
  strangers.length = 0;
  forgetFollowFloor();
  change.mockReset();
  brainstorm.scorerOf.mockReset().mockResolvedValue(null);
  brainstorm.signInToBrainstorm.mockReset().mockImplementation(async (pubkey) => {
    saveToken(pubkey, TOKEN);
    return TOKEN;
  });
  brainstorm.latestRun.mockReset().mockResolvedValue(null);
  brainstorm.startRun.mockReset().mockResolvedValue({ recently: true });
  return (["warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
}

/**
 * How each test ends: the app goes away, so every change, read and run under way is stopped; no timer
 * of theirs is left; no relay that is not the test's own was asked; and nothing was warned of.
 */
export async function endScene(logs: Logs): Promise<void> {
  try {
    cleanup();
    await vi.advanceTimersByTimeAsync(TOWNS_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    endStandInForFocusVisible();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetWidth();
    Reflect.deleteProperty(window, "nostr");
    window.sessionStorage.clear();
  }
}
