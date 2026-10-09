import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_KEY } from "../src/account/session";
import * as client from "../src/circle/brainstorm";
import { BAR_MS, CHECK_MS } from "../src/circle/CircleNews";
import { CIRCLE_KEY, OPEN_POLL_MS, POLL_CAP_MS, POLL_MS } from "../src/circle/CircleProvider";
import { WHY_PATH } from "../src/circle/paths";
import { readToken, saveToken, TOKEN_KEY } from "../src/circle/token";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { VIEW_STORAGE_KEY } from "../src/view/ViewProvider";
import raw from "./fixtures/funchal-items.json";
import { barRegion, DESKTOP, openApp, PHONE, resetWidth, resizeTo } from "./support/app";
import { shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

/*
 * Personalize, and knowing when the circle is ready (M3 Task 2). Brainstorm's client is mocked
 * (src/circle/brainstorm.ts, Task 1, has its own tests): its network calls are stand-ins each test
 * sets, and its errors and `runState` are its own. The scorer's ranks are read from a relay in
 * memory. Polling runs on fake timers, which the tests move on; nothing waits on the wall clock, and
 * nothing reaches the network (tests/setup.ts).
 */

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

const fixtures: NostrEvent[] = raw;

/** The relay a person's scorer publishes their circle's ranks to. */
const SCORES = "wss://scores.brainstorm.world";
/** A scorer's key, made up. */
const SCORER = "5c0e".repeat(16);
const SCORER_AT = { pubkey: SCORER, relay: SCORES };
/** A token as Brainstorm gives one. Made up. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJuIjoxfQ.c2lnbmF0dXJl";

/** One rank by the scorer, of someone in the circle. */
const rankEvent = () => shapedEvent({ kind: 30382, pubkey: SCORER, tags: [["d", "a1".repeat(32)], ["rank", "40"]] });

/** A run where `where` says, as the client reads one. */
function run(where: "waiting" | "running" | "done" | "failed"): client.Run {
  const [status, internalPublicationStatus, taStatus] = (
    {
      waiting: ["waiting", "waiting", "waiting"],
      running: ["ongoing", "waiting", "waiting"],
      done: ["success", "success", "success"],
      failed: ["failure", "waiting", "waiting"],
    } as const
  )[where];
  const at = Date.UTC(2026, 9, 8, 12);
  return { status, internalPublicationStatus, taStatus, countValues: null, othersFirst: 0, createdAt: at, updatedAt: at };
}

/** The ranks the scorer's relay holds: a test adds to it as Brainstorm publishes. */
let ranks: NostrEvent[] = [];
const readers = (url: string) => createMemoryReader(url === SCORES ? ranks : []);

/** Signs a person in to the tab with a browser add-on, as a reload of a signed-in tab finds them. */
function signedIn(): string {
  const key = generateSecretKey();
  Object.defineProperty(window, "nostr", {
    configurable: true,
    writable: true,
    value: {
      getPublicKey: async () => getPublicKey(key),
      signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, key),
    },
  });
  const pubkey = getPublicKey(key);
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ how: "browser", pubkey }));
  return pubkey;
}

const open = (px?: number) => openApp("/", { events: fixtures, readers, ...(px === undefined ? {} : { px }) });
const toggle = () => screen.getByRole("group", { name: copy.view.label });
const housePicks = () => within(toggle()).getByRole("button", { name: copy.view.house });
const myCircle = () => within(toggle()).getByRole("button", { name: /^My circle/ });
const workOutAgain = () => screen.findByRole("button", { name: copy.circle.workOutAgain });

/** The mark after My circle's words on its half, when it has one: the turning arrow, or the check. */
const markOf = (half: HTMLElement) => half.querySelector("svg");

/**
 * Fails unless `half` is My circle's while Brainstorm works the circle out (Avi, 2026-10-09): off,
 * "My circle" with no "soon", named for what is going on, with its arrow turning, or, for a person who
 * asks for less motion, fading instead.
 */
function expectWorking(half: HTMLElement): void {
  expect(half).toHaveAccessibleName(copy.view.circleWorking);
  expect(half).toHaveTextContent(/^My circle$/);
  expect(half).toBeDisabled();
  expect(half).not.toHaveAttribute("aria-expanded");
  expect(markOf(half)).toHaveClass("animate-turn", "motion-reduce:animate-breathe");
  // With the hint over it, for a pointer that rests on it, which a screen reader does not hear again.
  expect(hintOf(half)).toBe(copy.circle.workingTitle);
  expect(half).toHaveAccessibleDescription("");
}

/** Fails unless `half` is My circle's, off and plain: while the circle is looked for, or the add-on asks. */
function expectWaiting(half: HTMLElement): void {
  expect(half).toHaveAccessibleName(copy.view.circle);
  expect(half).toHaveTextContent(/^My circle$/);
  expect(half).toBeDisabled();
  expect(half).not.toHaveAttribute("aria-expanded");
  expect(markOf(half)).toBeNull();
  expect(hintOf(half)).toBeUndefined();
}

/** Fails unless `half` is My circle's with the check: on, in the trust green, fading in and out unless motion is reduced. */
function expectChecked(half: HTMLElement): void {
  expect(half).toHaveAccessibleName(copy.view.circle);
  expect(half).toBeEnabled();
  expect(markOf(half)).toHaveClass("text-trust", "animate-check", "motion-reduce:animate-none");
  expect(hintOf(half)).toBeUndefined();
}

/**
 * The hint over My circle's half, shown while the pointer rests on it: the title of the half, or of
 * anything around it inside its toggle. Undefined when there is none.
 */
function hintOf(half: HTMLElement): string | undefined {
  const group = half.closest('[role="group"]')!;
  for (let at: Element | null = half; at !== null && at !== group; at = at.parentElement) {
    const title = at.getAttribute("title");
    if (title !== null) return title;
  }
  return undefined;
}

/** The bar's ×, beside its status. */
const closeBar = () => within(barRegion().parentElement!).getByRole("button", { name: copy.circle.closeBar });
/** What the bar says while Brainstorm works the circle out: two short lines. */
const WORKING = `${copy.circle.workingTitle}${copy.circle.workingBody}`;

/**
 * A run followed since a moment ago, kept for the tab, which Brainstorm says is still under way: a
 * reload carries on following it, and My circle is being worked out from the first paint.
 */
function workingKept(pubkey: string): void {
  window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "working", since: Date.now() }));
  saveToken(pubkey, TOKEN);
  brainstorm.latestRun.mockResolvedValue(run("running"));
}

/** Brainstorm's next answer about the person's latest run, held until the test gives it. */
function heldRun() {
  let answer!: (run: client.Run | null) => void;
  let fail!: (error: Error) => void;
  brainstorm.latestRun.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
  );
  return { answer: (run: client.Run | null) => act(async () => answer(run)), fail: (error: Error) => act(async () => fail(error)) };
}

/**
 * Waits until the returning visitor's look has found the person's circle ready: the half is on before
 * then too, as a plain view's, while the person's session is restored from the tab.
 */
const keptReady = () =>
  waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "null")).toMatchObject({ state: "ready" }));

/** The page's `main`: where the focus goes when what had it before the bar's × is gone. */
const main = () => screen.getByRole("main");

type User = ReturnType<typeof userEvent.setup>;
/** A person at the screen, on the fake clock. */
const aUser = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
/**
 * My circle's half while it is the door to Personalize, its panel closed: "My circle", enabled. It
 * waits for it, as the half is off while the returning visitor's look is under way.
 */
const theDoor = () => within(toggle()).findByRole("button", { name: copy.view.circle, expanded: false });
/** The panel that My circle's half names as the one it opens, while it does. */
const panelOf = (half: HTMLElement) => document.getElementById(half.getAttribute("aria-controls") ?? "");
/** Opens the door from My circle's half, and gives back the Personalize in its panel. */
async function openDoor(user: User): Promise<HTMLElement> {
  await user.click(await theDoor());
  return screen.getByRole("button", { name: copy.circle.personalize });
}

/** Where the toggle is, and the door with it: the phone's Explore, the desktop's top bar, the phone's map. */
const PLACES = [
  ["the phone's Explore", "/", undefined],
  ["the desktop's top bar", "/", DESKTOP],
  ["the phone's map", "/map", undefined],
] as const;
/** Where the door's panel floats over the page: under the desktop's top bar, and over the phone's map. */
const FLOATING = PLACES.slice(1);
/**
 * Every toggle with My circle's half: the phone's Explore, the desktop's top bar, the phone's map, the
 * Why page (on a desktop, beside the top bar's) and the phone's Trending (on a desktop, the top bar's).
 */
const TOGGLES = [
  ...PLACES,
  ["the phone's Why page", WHY_PATH, undefined],
  ["the desktop's Why page", WHY_PATH, DESKTOP],
  ["the phone's Trending", "/trending", undefined],
] as const;
/** The page at `path`, as wide as `px` (a phone's when undefined). */
const openAt = (path: string, px: number | undefined) => openApp(path, { events: fixtures, readers, ...(px === undefined ? {} : { px }) });

/**
 * Brainstorm as api.brainstorm.world answers today for a public key it has no scorer for (ruling R13),
 * through the client's own look: what reaches it is the fetch this gives back, which notes each call.
 */
async function brainstormKnowsNobody() {
  const actual = await vi.importActual<typeof import("../src/circle/brainstorm")>("../src/circle/brainstorm");
  brainstorm.scorerOf.mockImplementation(actual.scorerOf);
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Fails if anything but the returning visitor's one look has asked Brainstorm for something. */
function askedNothingButTheLook(): void {
  expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
  for (const call of [brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) expect(call).not.toHaveBeenCalled();
}

/**
 * The add-on asks the person to let Brainstorm know it is them, and waits: `answer` gives their answer
 * (yes, and the tab has Brainstorm's token; or no). `asked` is the sign-in's signal, once it is asked.
 */
function addOnAsks() {
  let answer: ((yes: boolean) => void) | undefined;
  let asked: AbortSignal | undefined;
  brainstorm.signInToBrainstorm.mockImplementation(
    (pubkey, _signer, signal) =>
      new Promise((resolve, reject) => {
        asked = signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        answer = (yes) => {
          if (!yes) return reject(new Error("User rejected"));
          saveToken(pubkey, TOKEN);
          resolve(TOKEN);
        };
      }),
  );
  return { answer: (yes: boolean) => act(async () => answer?.(yes)), asked: () => asked };
}

/**
 * The desktop's Explore column's Personalize: the top of the list's column, under its heading. It is
 * always there, for its status, once someone signed in is looked at.
 */
const columnPersonalize = () =>
  screen.getByRole("heading", { level: 1, name: copy.pages.explore }).nextElementSibling!.firstElementChild as HTMLElement;
/** Whether the places are still listed: House picks keeps working. */
const placesListed = () => document.querySelectorAll('main a[href^="/place/"]').length > 0;

/** Moves the fake clock on, and lets what was waiting on it run. */
const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  config.features.circle = true;
  ranks = [];
  brainstorm.scorerOf.mockReset().mockResolvedValue(null);
  brainstorm.signInToBrainstorm.mockReset().mockImplementation(async (pubkey) => {
    saveToken(pubkey, TOKEN);
    return TOKEN;
  });
  brainstorm.latestRun.mockReset().mockResolvedValue(null);
  brainstorm.startRun.mockReset().mockResolvedValue({ run: run("waiting") });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
  config.features.circle = false;
});

describe("the copy", () => {
  it("says what personalizing does beside the button (decision 26), and the states in plain words", () => {
    expect(copy.circle.personalize).toBe("Personalize");
    expect(copy.circle.consent).toBe(
      "Personalizing asks Brainstorm, our scoring partner, to work out your circle. It sets up a public scoring profile for you, and your circle is public.",
    );
    expect(copy.circle.workingTitle).toBe("Working out your circle");
    // The bar's two short lines (Avi, 2026-10-09): "Working out your circle. This takes a few minutes."
    expect(copy.circle.workingBody).toBe("This takes a few minutes.");
    expect(copy.view.circleWorking).toBe("My circle, being worked out");
    expect(copy.circle.closeBar).toBe("Close this message");
    expect(copy.circle.ready).toBe("Your circle is ready.");
    expect(copy.circle.recently).toBe("Your circle was updated recently. We'll use that.");
    expect(copy.circle.busy).toBe("Brainstorm is busy right now. Try again in a little while.");
    expect(copy.circle.unavailable).toBe("My circle isn't available right now.");
    expect(copy.circle.notNow).toBe("Not now");
  });
});

describe("Personalize", () => {
  it("waits behind My circle's half on a phone's Explore, for a signed-in person whose circle isn't asked for", async () => {
    signedIn();
    await open();
    const half = await theDoor();
    // The way in: My circle, which can be tapped, though it is not yet a view to choose.
    expect(half).toHaveTextContent(/^My circle$/);
    expect(half).toBeEnabled();
    expect(half).not.toHaveAttribute("aria-pressed");
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(screen.queryByText(copy.circle.consent)).toBeNull();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
  });

  it("is not in the list's column on a desktop: the top bar's toggle is the way to it", async () => {
    signedIn();
    await open(DESKTOP);
    const half = await theDoor();
    expect(within(screen.getByRole("banner")).getByRole("group", { name: copy.view.label })).toContainElement(half);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(screen.queryByText(copy.circle.consent)).toBeNull();
    // Its status is there, empty, so a screen reader hears what comes; empty, it takes no room.
    const column = columnPersonalize();
    expect(within(column).getByRole("status")).toBeEmptyDOMElement();
    expect(column.className).not.toMatch(/(^|\s)-?[mp][trblxy]?-/);
  });

  it("is not there for someone signed out, who asks Brainstorm nothing, and My circle takes them to sign in", async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const { router } = await open();
    await after(POLL_CAP_MS);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(screen.queryByText(copy.circle.consent)).toBeNull();
    for (const call of [brainstorm.scorerOf, brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(myCircle()).not.toHaveAttribute("aria-expanded");
    await user.click(myCircle());
    expect(router.state.location.pathname).toBe("/signin");
  });

  it("is not there while My circle is closed (config.features.circle), and nothing asks Brainstorm", async () => {
    config.features.circle = false;
    signedIn();
    const user = aUser();
    await open();
    await after(POLL_CAP_MS);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(brainstorm.scorerOf).not.toHaveBeenCalled();
    // My circle is not open yet: its half says so, as before, and carries no mark.
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
    expect(myCircle()).toBeDisabled();
    expect(myCircle()).not.toHaveAttribute("aria-expanded");
    expect(markOf(myCircle())).toBeNull();
    await user.click(myCircle());
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
  });

  it("asks Brainstorm nothing but the one look at a returning visitor's scorer, until it is tapped (Review Focus 1)", async () => {
    signedIn();
    await open();
    await theDoor();
    await after(POLL_CAP_MS);
    askedNothingButTheLook();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe("the door: My circle's half, while the person's circle is not asked for (Avi, 2026-10-08)", () => {
  it.each(PLACES)(
    "opens a panel under the toggle on %s, with the consent line and Personalize, reaching nothing at Brainstorm",
    async (_, path, px) => {
      signedIn();
      const fetch = await brainstormKnowsNobody();
      const user = aUser();
      await openAt(path, px);
      const half = await theDoor();
      expect(half).toHaveTextContent(/^My circle$/);
      expect(half).toBeEnabled();
      expect(half).toHaveAttribute("aria-expanded", "false");
      expect(half).not.toHaveAttribute("aria-pressed");
      // The one look of the session (ruling R13): Brainstorm's setup, with no token.
      expect(fetch).toHaveBeenCalledTimes(1);

      await user.click(half);
      const button = screen.getByRole("button", { name: copy.circle.personalize });
      expect(half).toHaveAttribute("aria-expanded", "true");
      const panel = panelOf(half);
      expect(panel).toContainElement(button);
      expect(within(panel!).getByText(copy.circle.consent)).toBeInTheDocument();
      expect(button).toHaveAccessibleDescription(copy.circle.consent);
      expect(within(panel!).getByRole("button", { name: copy.circle.notNow })).toBeInTheDocument();
      expect(button).toHaveFocus();
      // Right after the toggle, for the keyboard too.
      await user.tab({ shift: true });
      expect(half).toHaveFocus();
      await user.tab();
      expect(button).toHaveFocus();

      await after(POLL_CAP_MS);
      expect(fetch).toHaveBeenCalledTimes(1);
      askedNothingButTheLook();
      expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    },
  );

  it.each(PLACES)("closes on Not now and on Escape, on %s, giving the focus back to the half, reaching nothing at Brainstorm", async (_, path, px) => {
    signedIn();
    const fetch = await brainstormKnowsNobody();
    const user = aUser();
    await openAt(path, px);
    const half = await theDoor();

    await user.click(half);
    await user.click(screen.getByRole("button", { name: copy.circle.notNow }));
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(screen.queryByText(copy.circle.consent)).toBeNull();
    expect(half).toHaveAttribute("aria-expanded", "false");
    expect(half).toHaveFocus();

    await user.click(half);
    expect(screen.getByRole("button", { name: copy.circle.personalize })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(half).toHaveAttribute("aria-expanded", "false");
    expect(half).toHaveFocus();

    await after(POLL_CAP_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    askedNothingButTheLook();
  });

  it("closes when the window crosses between the phone's layout and the desktop's, and the toggle that opened it goes", async () => {
    signedIn();
    const user = aUser();
    await open();
    await openDoor(user);
    // A phone turned, or a window widened: the desktop's top bar has the toggle now.
    act(() => resizeTo(DESKTOP));
    expect(await theDoor()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    // And back: the panel under the phone's toggle waits to be opened again.
    act(() => resizeTo(PHONE));
    expect(await theDoor()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    askedNothingButTheLook();
  });

  it.each(FLOATING)("closes on a tap outside it, on %s, reaching nothing at Brainstorm", async (_, path, px) => {
    signedIn();
    const fetch = await brainstormKnowsNobody();
    const user = aUser();
    await openAt(path, px);
    const half = await theDoor();
    await user.click(half);
    expect(screen.getByRole("button", { name: copy.circle.personalize })).toBeInTheDocument();
    await user.click(screen.getByRole("main"));
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(half).toHaveAttribute("aria-expanded", "false");
    expect(fetch).toHaveBeenCalledTimes(1);
    askedNothingButTheLook();
  });

  it.each(FLOATING)("closes when the focus leaves it by Tab, on %s, reaching nothing at Brainstorm", async (_, path, px) => {
    signedIn();
    const user = aUser();
    await openAt(path, px);
    const half = await theDoor();
    await user.click(half);
    const panel = panelOf(half)!;
    expect(screen.getByRole("button", { name: copy.circle.personalize })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: copy.circle.notNow })).toHaveFocus();
    await user.tab();
    expect(panel).not.toBeInTheDocument();
    expect(half).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).not.toBe(document.body);
    askedNothingButTheLook();
  });

  it.each(FLOATING)("closes on another tap of the half, on %s, with the focus on the half", async (_, path, px) => {
    signedIn();
    const user = aUser();
    await openAt(path, px);
    const half = await theDoor();
    await user.click(half);
    expect(screen.getByRole("button", { name: copy.circle.personalize })).toHaveFocus();
    // A click that moves no focus, as Safari's does not: it stays in the panel until the half takes it.
    fireEvent.click(half);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(half).toHaveAttribute("aria-expanded", "false");
    expect(half).toHaveFocus();
    askedNothingButTheLook();
  });

  it("closes on another page, from the desktop's top bar", async () => {
    signedIn();
    const user = aUser();
    const { router } = await open(DESKTOP);
    await user.click(await theDoor());
    expect(screen.getByRole("button", { name: copy.circle.personalize })).toHaveFocus();
    await act(() => router.navigate("/about"));
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(await theDoor()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).not.toBe(document.body);
    askedNothingButTheLook();
  });

  it.each([...PLACES, ["the phone's Why page", WHY_PATH, undefined]] as const)(
    "takes no consent from Enter held down on My circle's half, on %s: Personalize waits for a press of its own",
    async (_, path, px) => {
      signedIn();
      const user = aUser();
      await openAt(path, px);
      // The door, once the person's session is restored from the tab: until then the half is a plain view's.
      await waitFor(() => expect(myCircle()).not.toHaveAttribute("aria-pressed"));
      await waitFor(() => expect(myCircle()).toHaveTextContent(/^My circle$/));
      const half = myCircle();
      act(() => half.focus());
      // The key's first press opens the panel, which takes the focus; the key, still down, repeats there.
      await user.keyboard("{Enter>4/}");
      expect(screen.getByRole("button", { name: copy.circle.personalize })).toHaveFocus();
      await after(POLL_MS);
      expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
      askedNothingButTheLook();
    },
  );

  it("starts the same flow from the phone's Explore panel's Personalize: signing, then the half off, the focus on House picks", async () => {
    const pubkey = signedIn();
    addOnAsks();
    const user = aUser();
    await open();
    await user.click(await openDoor(user));

    await waitFor(() =>
      expect(brainstorm.signInToBrainstorm).toHaveBeenCalledWith(pubkey, expect.anything(), expect.any(AbortSignal), { how: "browser" }),
    );
    expectWaiting(myCircle());
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(housePicks()).toHaveFocus();
    // The panel has closed: its offer is gone. Under the toggle, as before, it says what is going on.
    expect(screen.queryByText(copy.circle.consent)).toBeNull();
    expect(screen.queryByRole("button", { name: copy.circle.notNow })).toBeNull();
    expect(await screen.findByText(copy.circle.approveBrowser)).toBeInTheDocument();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });
});

describe("a floating panel through the sign-in (ruling F1)", () => {
  /** Opens the door on `path`, taps Personalize, and gives back the panel, which the add-on now asks from. */
  async function signingFrom(path: string, px: number | undefined) {
    const pubkey = signedIn();
    const addOn = addOnAsks();
    const user = aUser();
    await openAt(path, px);
    const half = await theDoor();
    await user.click(half);
    const panel = panelOf(half)!;
    await user.click(within(panel).getByRole("button", { name: copy.circle.personalize }));
    await waitFor(() =>
      expect(brainstorm.signInToBrainstorm).toHaveBeenCalledWith(pubkey, expect.anything(), expect.any(AbortSignal), { how: "browser" }),
    );
    return { panel, addOn, user };
  }

  it.each(FLOATING)("stays open on %s, saying the add-on asks, with Cancel only, in its status: said once on the page", async (_, path, px) => {
    const { panel } = await signingFrom(path, px);
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent(copy.circle.approveBrowser);
    expect(within(panel).getByRole("button", { name: copy.circle.cancel })).toBeInTheDocument();
    // One way to stop: Not now beside Cancel would read as a second, and leave the sign-in running.
    expect(within(panel).queryByRole("button", { name: copy.circle.notNow })).toBeNull();
    expect(screen.queryByText(copy.circle.consent)).toBeNull();
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    // The half is off while the circle is asked for, as before: plain, as nothing is worked out yet.
    expectWaiting(myCircle());
    // One region says it: the desktop's list column keeps its status, empty, and has no Cancel of its own.
    expect(screen.getAllByText(copy.circle.approveBrowser)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: copy.circle.cancel })).toHaveLength(1);
    if (px === DESKTOP) expect(within(columnPersonalize()).getByRole("status")).toBeEmptyDOMElement();
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it.each(FLOATING)("goes back to Personalize in the panel on Cancel, on %s, with the focus on the panel", async (_, path, px) => {
    const { panel, addOn, user } = await signingFrom(path, px);
    await user.click(within(panel).getByRole("button", { name: copy.circle.cancel }));
    expect(addOn.asked()?.aborted).toBe(true);
    expect(within(panel).getByText(copy.circle.consent)).toBeInTheDocument();
    expect(panel).toHaveFocus();
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(myCircle()).toHaveAttribute("aria-expanded", "true");
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it.each(FLOATING)("asks once when Enter is pressed twice on Cancel, on %s", async (_, path, px) => {
    const { panel, addOn, user } = await signingFrom(path, px);
    within(panel).getByRole("button", { name: copy.circle.cancel }).focus();
    await user.keyboard("{Enter}{Enter}");
    expect(addOn.asked()?.aborted).toBe(true);
    expect(within(panel).getByText(copy.circle.consent)).toBeInTheDocument();
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it.each(FLOATING)("shows Personalize again when the add-on says no, on %s, with the focus on the panel", async (_, path, px) => {
    const { panel, addOn } = await signingFrom(path, px);
    await addOn.answer(false);
    expect(await within(panel).findByText(copy.circle.consent)).toBeInTheDocument();
    expect(panel).toHaveFocus();
    expect(within(panel).queryByRole("button", { name: copy.circle.cancel })).toBeNull();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it.each(FLOATING)("closes once the circle is being worked out, on %s, with the focus on House picks", async (_, path, px) => {
    const { panel, addOn } = await signingFrom(path, px);
    await addOn.answer(true);
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));
    expect(panel).not.toBeInTheDocument();
    expect(housePicks()).toHaveFocus();
    // The half says it is being worked out, and the bar at the foot of the screen, for a while; the
    // desktop's list column keeps its status, saying nothing.
    expectWorking(myCircle());
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    expect(housePicks()).toHaveFocus();
    if (px === DESKTOP) expect(within(columnPersonalize()).getByRole("status")).toBeEmptyDOMElement();
  });

  it.each(
    FLOATING.flatMap(([where, path, px]) =>
      (["Escape", "a tap outside", "Tab out"] as const).map((how) => [how, where, path, px] as const),
    ),
  )("closes on %s while the add-on asks, on %s, and the sign-in goes on", async (how, _, path, px) => {
    const { panel, addOn, user } = await signingFrom(path, px);
    if (how === "Escape") await user.keyboard("{Escape}");
    if (how === "a tap outside") await user.click(screen.getByRole("main"));
    if (how === "Tab out") for (let tabs = 0; tabs < 4 && panel.isConnected; tabs++) await user.tab();
    expect(panel).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    // Closing it is not Cancel: the add-on still asks, and nothing else has gone to Brainstorm.
    expect(addOn.asked()?.aborted).toBe(false);
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expectWaiting(myCircle());
    // The desktop's list column says it now, with its Cancel.
    if (px === DESKTOP) expect(within(columnPersonalize()).getByRole("status")).toHaveTextContent(copy.circle.approveBrowser);
    await addOn.answer(true);
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));
  });
});

describe("My circle's half, once the circle is asked for", () => {

  it.each(
    PLACES.flatMap(([where, path, px]) => (["failed", "busy", "unavailable"] as const).map((state) => [state, where, path, px] as const)),
  )("offers Try again from the half when the circle is %s, on %s, and Try again starts the flow", async (state, _, path, px) => {
    const pubkey = signedIn();
    // Where the circle got to before, kept for the tab.
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state }));
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    const user = aUser();
    await openAt(path, px);
    // The door, once the person's session is restored from the tab: until then the half is a plain view's.
    await waitFor(() => expect(myCircle()).not.toHaveAttribute("aria-pressed"));
    const half = myCircle();
    expect(half).toHaveTextContent(/^My circle$/);
    expect(half).toBeEnabled();
    expect(half).not.toHaveAttribute("aria-pressed");
    // The phone's Explore shows its line and Try again under the toggle, as before; elsewhere a tap opens them.
    const inline = path === "/" && px === undefined;
    expect(half).toHaveAttribute("aria-expanded", String(inline));

    await user.click(half);
    expect(half).toHaveAttribute("aria-expanded", "true");
    const panel = panelOf(half)!;
    const line = within(panel).getByText(state === "busy" ? copy.circle.busy : copy.circle.unavailable);
    const tryAgain = within(panel).getByRole("button", { name: copy.circle.tryAgain });
    expect(tryAgain).toHaveAccessibleDescription(line.textContent!);
    expect(tryAgain).toHaveFocus();
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();

    await user.click(tryAgain);
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expectWorking(myCircle());
    // Under the phone's toggle the focus waits on the toggle's block: the panel may go if the add-on says no.
    // From a panel that floats, it goes to House picks once the circle is being worked out.
    if (inline) expect(document.activeElement).toBe(toggle().closest('[tabindex="-1"]'));
    else expect(housePicks()).toHaveFocus();
  });

  it.each([
    [
      "checking",
      (_pubkey: string) => {
        // The returning visitor's look, not answered yet.
        brainstorm.scorerOf.mockImplementation(
          (_pubkey, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
        );
      },
    ],
    [
      "signing",
      (pubkey: string) => {
        // Personalize was tapped, and the add-on asks the person, who has not answered yet.
        window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "off" }));
        brainstorm.signInToBrainstorm.mockImplementation(
          (_pubkey, _signer, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
        );
      },
    ],
  ] as const)("is off and plain while the circle is %s, on every toggle: 'My circle', with no mark and no 'soon'", async (state, setUp) => {
    const pubkey = signedIn();
    setUp(pubkey);
    const user = aUser();
    for (const [, path, px] of TOGGLES) {
      const page = await openAt(path, px);
      // The Why page keeps Personalize in view: no door to open.
      if (state === "signing" && path === WHY_PATH) await user.click(await screen.findByRole("button", { name: copy.circle.personalize }));
      else if (state === "signing") await user.click(await openDoor(user));
      const halves = () => screen.getAllByRole("group", { name: copy.view.label }).map((group) => within(group).getAllByRole("button")[1]!);
      await waitFor(() => expect(halves()[0]).toBeDisabled());
      for (const half of halves()) {
        expectWaiting(half);
        expect(half).not.toHaveAttribute("aria-controls");
      }
      page.unmount();
      if (state === "signing") window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "off" }));
    }
  });

  it.each(TOGGLES)(
    "is off while the circle is worked out, on %s: 'My circle' with the arrow turning after it, named for what is going on",
    async (_, path, px) => {
      workingKept(signedIn());
      await openAt(path, px);
      const halves = () => screen.getAllByRole("group", { name: copy.view.label }).map((group) => within(group).getAllByRole("button")[1]!);
      // Once the person's session is restored from the tab: a page that waits for no places shows before.
      await waitFor(() => expectWorking(halves()[0]!));
      // The desktop's Why page has two toggles: the top bar's, and its own.
      expect(halves()).toHaveLength(path === WHY_PATH && px === DESKTOP ? 2 : 1);
      for (const half of halves()) {
        expectWorking(half);
        expect(half).not.toHaveAttribute("aria-controls");
        // Drawn in the words' colour, a line icon of its own, hidden from a screen reader: the name says it.
        expect(markOf(half)).toHaveAttribute("aria-hidden", "true");
        expect(markOf(half)).toHaveAttribute("stroke", "currentColor");
        expect(markOf(half)).toHaveAttribute("width", "16");
      }
      expect(screen.queryByText(copy.view.circleSoon)).toBeNull();
      expect(brainstorm.startRun).not.toHaveBeenCalled();
    },
  );

  it("keeps the words where they are as the mark comes and goes: a slot as wide as the mark on each side of them", async () => {
    const pubkey = signedIn();
    workingKept(pubkey);
    const { unmount } = await open();
    await waitFor(() => expectWorking(myCircle()));
    const slots = (half: HTMLElement) => [...half.firstElementChild!.children].filter((child) => child.tagName === "SPAN");
    const working = slots(myCircle());
    expect(working).toHaveLength(2);
    expect(working[0]).toHaveClass("w-[22px]");
    expect(working[1]).toHaveClass("w-[22px]");
    expect(working[1]).toContainElement(markOf(myCircle()));
    unmount();

    // Ready, with no mark: the same two slots, empty.
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "ready", scorer: SCORER_AT }));
    await open();
    await waitFor(() => expect(myCircle()).toBeEnabled());
    const plain = slots(myCircle());
    expect(plain).toHaveLength(2);
    for (const slot of plain) {
      expect(slot).toHaveClass("w-[22px]");
      expect(slot).toBeEmptyDOMElement();
    }
  });
});

describe("the check on My circle's half, once a run the person started ends in a circle (Avi, 2026-10-09)", () => {
  /** Personalize tapped from the phone's Explore, with Brainstorm working the circle out: it ends on the next poll. */
  async function tappedAndWorking(px?: number) {
    signedIn();
    const user = aUser();
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const page = await open(px);
    if (px === DESKTOP) {
      await user.click(await theDoor());
      await user.click(screen.getByRole("button", { name: copy.circle.personalize }));
    } else {
      await user.click(await openDoor(user));
    }
    await waitFor(() => expectWorking(myCircle()));
    return { user, page };
  }

  it("takes the arrow's place for about 4 s, with the half on, then goes: plain My circle, on", async () => {
    await tappedAndWorking();
    brainstorm.latestRun.mockResolvedValue(run("done"));
    ranks = [rankEvent()];
    await after(POLL_MS);
    await waitFor(() => expectChecked(myCircle()));
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    // Still there half way.
    await after(CHECK_MS / 2);
    expectChecked(myCircle());
    // Gone once its time is up: the plain half, on, where the words were.
    await after(CHECK_MS / 2);
    await waitFor(() => expect(markOf(myCircle())).toBeNull());
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(myCircle()).toHaveAccessibleName(copy.view.circle);
    expect(myCircle()).toBeEnabled();
    expect(myCircle()).toHaveAttribute("aria-pressed", "false");
    // The circle is worked out: no hint says it is being worked out, once the check came, nor after.
    expect(hintOf(myCircle())).toBeUndefined();
  });

  it("carries on fading from where it was on a toggle drawn while it shows: another page's", async () => {
    const { page } = await tappedAndWorking();
    brainstorm.latestRun.mockResolvedValue(run("done"));
    ranks = [rankEvent()];
    await after(POLL_MS);
    await waitFor(() => expectChecked(myCircle()));
    // Drawn as the check came: its fade starts from the start.
    expect(Number.parseFloat(markOf(myCircle())!.style.animationDelay)).toBeGreaterThan(-500);
    await after(CHECK_MS / 2);
    await act(() => page.router.navigate("/map"));
    // The map's toggle is drawn half way through: its fade starts half way through, not from the start.
    expectChecked(myCircle());
    const delay = Number.parseFloat(markOf(myCircle())!.style.animationDelay);
    expect(delay).toBeLessThanOrEqual(-CHECK_MS / 2);
    expect(delay).toBeGreaterThan(-CHECK_MS / 2 - 1_000);
    expect(markOf(myCircle())!.style.animationDelay).toMatch(/ms$/);
  });

  it("shows on the desktop's top bar too, and goes as soon as My circle is chosen", async () => {
    const { user } = await tappedAndWorking(DESKTOP);
    brainstorm.latestRun.mockResolvedValue(run("done"));
    ranks = [rankEvent()];
    await after(POLL_MS);
    await waitFor(() => expectChecked(myCircle()));
    await user.click(myCircle());
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    expect(markOf(myCircle())).toBeNull();
  });

  it("shows for a recent run Brainstorm used, too", async () => {
    signedIn();
    const user = aUser();
    brainstorm.latestRun.mockResolvedValueOnce(run("failed")).mockResolvedValue(run("done"));
    brainstorm.startRun.mockResolvedValue({ recently: true });
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    await open();
    await user.click(await openDoor(user));
    await waitFor(() => expectChecked(myCircle()));
  });

  it("is not there when the returning visitor's quiet look finds their circle, and neither is the bar", async () => {
    signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    await open();
    await waitFor(() => expect(myCircle()).toBeEnabled());
    expect(markOf(myCircle())).toBeNull();
    expect(barRegion()).toBeEmptyDOMElement();
    await after(CHECK_MS);
    expect(markOf(myCircle())).toBeNull();
    expect(barRegion()).toBeEmptyDOMElement();
  });

});

describe("the bar at the foot of the screen (Avi, 2026-10-09)", () => {
  it("says the circle is being worked out once it is tapped, politely, taking no focus, and goes after 10 s", async () => {
    signedIn();
    const user = aUser();
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await open();
    const region = barRegion();
    expect(region).toBeEmptyDOMElement();
    await user.click(await openDoor(user));
    await waitFor(() => expect(region).toHaveTextContent(WORKING));
    // A polite status, always on the page: a screen reader hears it. The focus stays where it was.
    expect(region).toHaveAttribute("role", "status");
    expect(barRegion()).toBe(region);
    expect(housePicks()).toHaveFocus();
    expect(closeBar()).toBeInTheDocument();
    // Its arrow turns as the half's does, and fades instead for a person who asks for less motion; the
    // bar comes up with a fade, unless they do.
    expect(region.parentElement!.querySelector("svg")).toHaveClass("text-trust", "animate-turn", "motion-reduce:animate-breathe");
    expect(region.parentElement).toHaveClass("animate-appear", "motion-reduce:animate-none", "bg-ground", "shadow-float", "rounded-panel");

    await after(BAR_MS / 2);
    expect(region).toHaveTextContent(WORKING);
    await after(BAR_MS / 2);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
    expect(within(region.parentElement!).queryByRole("button")).toBeNull();
    // The half still says it.
    expectWorking(myCircle());
  });

  it("says it once a run, not again on another page", async () => {
    signedIn();
    const user = aUser();
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const { router } = await open();
    await user.click(await openDoor(user));
    const region = barRegion();
    await waitFor(() => expect(region).toHaveTextContent(WORKING));
    // Another page: the same bar, still saying it.
    await act(() => router.navigate("/map"));
    expect(barRegion()).toBe(region);
    expect(region).toHaveTextContent(WORKING);
    await after(BAR_MS);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
    for (const path of ["/trending", "/", WHY_PATH, "/map"]) {
      await act(() => router.navigate(path));
      expect(barRegion()).toBeEmptyDOMElement();
    }
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
  });

  it("says it again on a reload that carries on following the run, once Brainstorm says the run is under way", async () => {
    const pubkey = signedIn();
    workingKept(pubkey);
    const poll = heldRun();
    await open();
    await waitFor(() => expectWorking(myCircle()));
    // Until the first poll answers, nothing is said: the run may have ended, or never been.
    expect(barRegion()).toBeEmptyDOMElement();
    await poll.answer(run("running"));
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    expectWorking(myCircle());
  });

  it("says nothing on a reload whose first poll finds no run", async () => {
    workingKept(signedIn());
    const poll = heldRun();
    await open();
    await waitFor(() => expectWorking(myCircle()));
    expect(barRegion()).toBeEmptyDOMElement();
    await poll.answer(null);
    expect(await theDoor()).toBeEnabled();
    expect(barRegion()).toBeEmptyDOMElement();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
  });

  it("says nothing on a reload that finds the circle ready", async () => {
    const pubkey = signedIn();
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "ready", scorer: SCORER_AT }));
    await open();
    await waitFor(() => expect(myCircle()).toBeEnabled());
    expect(barRegion()).toBeEmptyDOMElement();
    expect(markOf(myCircle())).toBeNull();
  });

  it.each([
    ["ready", copy.circle.ready, () => brainstorm.latestRun.mockResolvedValue(run("done"))],
    [
      "recently",
      copy.circle.recently,
      () => {
        brainstorm.latestRun.mockResolvedValueOnce(run("failed")).mockResolvedValue(run("done"));
        brainstorm.startRun.mockResolvedValue({ recently: true });
      },
    ],
  ] as const)("says the circle is %s when the run the person started ends so, and goes after 10 s", async (_, line, setUp) => {
    signedIn();
    const user = aUser();
    setUp();
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    await open();
    await user.click(await openDoor(user));
    const region = barRegion();
    await waitFor(() => expect(region).toHaveTextContent(line));
    expect(region).not.toHaveTextContent(copy.circle.workingTitle);
    expect(region.parentElement!.querySelector("svg")).toHaveClass("text-trust");
    expect(screen.getAllByText(line)).toHaveLength(1);
    await after(BAR_MS / 2);
    expect(region).toHaveTextContent(line);
    await after(BAR_MS / 2);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
  });

  it("puts the new news in place of what it said: worked out, then ready, for 10 s from then", async () => {
    signedIn();
    const user = aUser();
    // A run done at once, whose scorer Brainstorm names when the test says.
    brainstorm.startRun.mockResolvedValue({ run: run("done") });
    let name!: () => void;
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockImplementation(
      () =>
        new Promise((resolve) => {
          name = () => resolve(SCORER_AT);
        }),
    );
    await open();
    await user.click(await openDoor(user));
    const region = barRegion();
    await waitFor(() => expect(region).toHaveTextContent(WORKING));
    await after(BAR_MS / 2);
    ranks = [rankEvent()];
    await act(async () => name());
    await waitFor(() => expect(region).toHaveTextContent(copy.circle.ready));
    expect(region).not.toHaveTextContent(copy.circle.workingTitle);
    // Ten seconds from the new news, not from the first.
    await after(BAR_MS * 0.75);
    expect(region).toHaveTextContent(copy.circle.ready);
    await after(BAR_MS / 2);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
  });

  /** Personalize tapped from the phone's Explore, with Brainstorm working the circle out: the bar says so. */
  async function barWorking() {
    signedIn();
    const user = aUser();
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const page = await open();
    await user.click(await openDoor(user));
    const region = barRegion();
    await waitFor(() => expect(region).toHaveTextContent(WORKING));
    return { user, region, bar: region.parentElement!, ...page };
  }

  it("goes on its ×, giving the focus back to what had it before", async () => {
    const { user, region } = await barWorking();
    expect(closeBar()).toHaveAccessibleName("Close this message");
    // Personalize, from the panel under the toggle, left the focus on House picks.
    expect(housePicks()).toHaveFocus();
    await user.click(closeBar());
    expect(region).toBeEmptyDOMElement();
    expect(within(region.parentElement!).queryByRole("button")).toBeNull();
    expect(housePicks()).toHaveFocus();
    // Closed is closed: its time running out brings nothing back, and the half still says it.
    await after(BAR_MS);
    expect(region).toBeEmptyDOMElement();
    expectWorking(myCircle());
  });

  it("still gives the focus back to what had it after the person leaves the window and comes back to the ×", async () => {
    const { user, region } = await barWorking();
    expect(housePicks()).toHaveFocus();
    act(() => closeBar().focus());
    // Another app, then back: the focus comes back to the × from no element.
    fireEvent.focusOut(closeBar(), { relatedTarget: null });
    fireEvent.focusIn(closeBar(), { relatedTarget: null });
    await user.click(closeBar());
    expect(region).toBeEmptyDOMElement();
    expect(housePicks()).toHaveFocus();
  });

  it("gives the focus to the page's main when what had it before the × has gone from the page", async () => {
    const { user, region, router } = await barWorking();
    act(() => closeBar().focus());
    // Another page: House picks, which had the focus, is not on it.
    await act(() => router.navigate("/about"));
    expect(closeBar()).toHaveFocus();
    await user.click(closeBar());
    expect(region).toBeEmptyDOMElement();
    expect(main()).toHaveFocus();
    // The main takes the focus for as long as it holds it, and is not in the keyboard's order after.
    expect(main()).toHaveAttribute("tabindex", "-1");
    act(() => screen.getAllByRole("link")[0]!.focus());
    expect(main()).not.toHaveAttribute("tabindex");
  });

  it("gives the focus back when it goes with the focus on its ×, the run ending with no circle", async () => {
    const { region } = await barWorking();
    act(() => closeBar().focus());
    brainstorm.latestRun.mockRejectedValue(new client.Unavailable());
    await after(POLL_MS * 3);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
    expect(housePicks()).toHaveFocus();
  });

  it("holds its 10 s while it has the focus, and counts on from where it was once the focus leaves", async () => {
    const { region } = await barWorking();
    await after(BAR_MS / 2);
    act(() => closeBar().focus());
    await after(BAR_MS * 2);
    expect(region).toHaveTextContent(WORKING);
    act(() => housePicks().focus());
    await after(BAR_MS / 4);
    expect(region).toHaveTextContent(WORKING);
    await after(BAR_MS / 2);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
  });

  it("holds its 10 s while the pointer is over it", async () => {
    const { user, region, bar } = await barWorking();
    await after(BAR_MS / 2);
    await user.hover(bar);
    await after(BAR_MS * 2);
    expect(region).toHaveTextContent(WORKING);
    await user.unhover(bar);
    await after(BAR_MS / 4);
    expect(region).toHaveTextContent(WORKING);
    await after(BAR_MS / 2);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
  });

  it("stops saying the circle is worked out as soon as working it out ends without one, before its 10 s are up", async () => {
    signedIn();
    const user = aUser();
    // Brainstorm's first answer about the run, after the sign-in: held, then a failure to reach it.
    const poll = heldRun();
    await open();
    await user.click(await openDoor(user));
    const region = barRegion();
    await waitFor(() => expect(region).toHaveTextContent(WORKING));
    await after(2_000);
    await poll.fail(new client.Unavailable());
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
    // Well inside the bar's 10 s: it has gone with the run.
    expect(region).toBeEmptyDOMElement();
  });

  it.each([
    ["the phone's Explore", "/", undefined],
    ["the desktop's list column", "/", DESKTOP],
    ["the phone's Why page", WHY_PATH, undefined],
    ["the desktop's Why page", WHY_PATH, DESKTOP],
  ] as const)("is the only thing that says the circle is worked out, on %s: no banner on the page", async (_, path, px) => {
    workingKept(signedIn());
    await openAt(path, px);
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    expect(screen.getAllByText(copy.circle.workingTitle)).toHaveLength(1);
    expect(screen.getAllByText(copy.circle.workingBody)).toHaveLength(1);
    expect(barRegion()).toContainElement(screen.getByText(copy.circle.workingTitle));
    // The desktop's list column keeps its status, for what comes next, saying nothing now.
    if (path === "/" && px === DESKTOP) expect(within(columnPersonalize()).getByRole("status")).toBeEmptyDOMElement();
    await after(BAR_MS);
    await waitFor(() => expect(screen.queryByText(copy.circle.workingTitle)).toBeNull());
    expect(screen.queryByText(copy.circle.workingBody)).toBeNull();
  });

  /** Makes `node` say it is drawn at `box` (jsdom lays nothing out), and the window say it was resized. */
  function laidOut(node: HTMLElement, box: { top: number; bottom: number }): void {
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      ...box,
      left: 0,
      right: window.innerWidth,
      x: 0,
      y: box.top,
      width: window.innerWidth,
      height: box.bottom - box.top,
      toJSON: () => box,
    });
    act(() => window.dispatchEvent(new Event("resize")));
  }

  it("sits at the foot of the screen, by its classes, on a page with no controls of its own there", async () => {
    workingKept(signedIn());
    await open();
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    const bar = barRegion().parentElement!;
    expect(bar).toHaveClass("bottom-[calc(var(--tab-bar-height)+12px)]");
    expect(bar.style.top).toBe("");
    expect(bar.style.bottom).toBe("");
  });

  it("sits 12 px above the Filters page's Clear all and Show places, and back at the foot once that page is left", async () => {
    workingKept(signedIn());
    const { router } = await openAt("/filters", undefined);
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    const footer = screen.getByRole("button", { name: copy.filters.clearAll }).parentElement!;
    laidOut(footer, { top: window.innerHeight - 100, bottom: window.innerHeight });
    const bar = barRegion().parentElement!;
    expect(bar.style.bottom).toBe("112px");
    expect(bar.style.top).toBe("");

    await act(() => router.navigate("/"));
    expect(bar.style.bottom).toBe("");
  });

  it("sits at the top of the phone's map, 12 px under its search field and toggle, clear of its buttons and docked card", async () => {
    workingKept(signedIn());
    await openAt("/map", undefined);
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    // What floats at the top of the map: its search field, and the toggle under it.
    const floating = toggle().closest(".absolute") as HTMLElement;
    expect(floating).toHaveClass("top-4");
    laidOut(floating, { top: 16, bottom: 150 });
    const bar = barRegion().parentElement!;
    expect(bar.style.top).toBe("162px");
    expect(bar.style.bottom).toBe("auto");
  });
});

describe("a returning visitor", () => {
  it("has My circle ready at once when their scorer has ranks on its relay: no sign-in, no token, no Personalize", async () => {
    const pubkey = signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    await open();
    await keptReady();
    await waitFor(() => expect(myCircle()).toBeEnabled());
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(brainstorm.scorerOf).toHaveBeenCalledWith(pubkey, expect.any(AbortSignal));
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    // Nothing to announce: it was ready before they came, and the view stays where it was.
    expect(screen.queryByText(copy.circle.ready)).toBeNull();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
  });

  it("is unconfirmed when their scorer has no ranks yet: empty for now, with Work out my circle again (rulings R7, R10)", async () => {
    signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    await open();
    // The scorer exists from Brainstorm's sign-in on: whether a run is done, under way or failed is not known.
    expect(await workOutAgain()).toBeInTheDocument();
    expect(screen.getByText(copy.explore.circleEmpty)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(myCircle()).toBeEnabled();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "null")).toMatchObject({ state: "unconfirmed", scorer: SCORER_AT });
  });

  it("is offered Personalize, behind My circle's half, when Brainstorm has no scorer for them", async () => {
    signedIn();
    await open();
    expect(await theDoor()).toBeEnabled();
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
  });

  it("is offered Personalize, quietly, when Brainstorm can't be reached for the look", async () => {
    signedIn();
    brainstorm.scorerOf.mockRejectedValue(new client.Unavailable());
    await open();
    expect(await theDoor()).toBeEnabled();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
  });

  it("is offered Personalize, quietly, when Brainstorm has never seen them: the live server's 404 (ruling R13)", async () => {
    const pubkey = signedIn();
    const actual = await vi.importActual<typeof import("../src/circle/brainstorm")>("../src/circle/brainstorm");
    brainstorm.scorerOf.mockImplementation(actual.scorerOf);
    // What api.brainstorm.world answers today for a public key it has no scorer for.
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await open();
    expect(await theDoor()).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://api.brainstorm.world/setup/${pubkey}`);
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(myCircle()).toHaveTextContent(/^My circle$/);
  });

  it("is offered Personalize, quietly, when its scorer's relay can't be read for the look", async () => {
    signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    const down = (url: string): RelayReader => ({
      async *req(filter, signal) {
        if (url === SCORES) throw new Error("The relay answered 503");
        yield* readers(url).req(filter, signal);
      },
    });
    await openApp("/", { events: fixtures, readers: down });
    expect(await theDoor()).toBeEnabled();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is looked at only once the places have loaded, and once a session", async () => {
    signedIn();
    const opening = openApp("/", { events: fixtures, readers, delayMs: 300 });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(brainstorm.scorerOf).not.toHaveBeenCalled();
    const { unmount } = await opening;
    await theDoor();
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);

    // A reload of the tab.
    unmount();
    await open();
    expect(await theDoor()).toBeEnabled();
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
  });
});

describe("an unconfirmed circle, worked out again (ruling R10)", () => {
  /** A returning visitor whose scorer has no ranks: unconfirmed, until they tap Work out my circle again. */
  async function unconfirmed() {
    signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();
    await user.click(await workOutAgain());
    return user;
  }

  it("is confirmed empty when the latest run is done, and kept so for the session", async () => {
    brainstorm.latestRun.mockResolvedValue(run("done"));
    await unconfirmed();
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: copy.circle.workOutAgain })).toBeNull();
    expect(myCircle()).toBeEnabled();
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "null")).toMatchObject({ state: "ready" }));
  });

  it("follows a run under way, starting none, and is ready with its ranks once it is done", async () => {
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await unconfirmed();
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    expectWorking(myCircle());
    brainstorm.latestRun.mockResolvedValue(run("done"));
    ranks = [rankEvent()];
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(myCircle()).toBeEnabled();
  });

  it.each([
    ["the latest run failed", () => run("failed")],
    ["there is no run at all", () => null],
  ])("starts a run when %s", async (_, latest) => {
    brainstorm.latestRun.mockResolvedValueOnce(latest()).mockResolvedValue(run("running"));
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    await unconfirmed();
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: copy.circle.workOutAgain })).toBeNull();
  });
});

describe("an unconfirmed circle, when working it out again does not end in a circle (ruling R13)", () => {
  /** A returning visitor whose scorer has no ranks, looking at My circle. */
  async function unconfirmedInMyCircle() {
    signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();
    await workOutAgain();
    await user.click(myCircle());
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    return user;
  }

  it.each([
    ["cancelled while the add-on asks", "cancel"],
    ["declined in the add-on", "decline"],
    ["met by Brainstorm not answering", "unavailable"],
    ["met by a failed run", "failed"],
    ["met by Brainstorm being busy", "busy"],
  ] as const)("is put back as it was, with My circle as the view, when it is %s", async (_, how) => {
    if (how === "cancel") {
      brainstorm.signInToBrainstorm.mockImplementation(
        (_pubkey, _signer, signal) =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      );
    }
    if (how === "decline") brainstorm.signInToBrainstorm.mockRejectedValue(new Error("User rejected"));
    if (how === "unavailable") brainstorm.signInToBrainstorm.mockRejectedValue(new client.Unavailable());
    if (how === "failed") {
      brainstorm.latestRun.mockResolvedValue(run("failed"));
      brainstorm.startRun.mockResolvedValue({ run: run("failed") });
    }
    if (how === "busy") brainstorm.startRun.mockResolvedValue({ recently: true });
    const user = await unconfirmedInMyCircle();

    await user.click(await workOutAgain());
    if (how === "cancel") await user.click(await screen.findByRole("button", { name: copy.circle.cancel }));

    expect(await workOutAgain()).toBeInTheDocument();
    expect(screen.getByText(copy.explore.circleEmpty)).toBeInTheDocument();
    for (const text of [copy.circle.unavailable, copy.circle.busy, copy.circle.workingTitle]) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    expect(window.sessionStorage.getItem(VIEW_STORAGE_KEY)).toBe("circle");
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "null")).toMatchObject({ state: "unconfirmed", scorer: SCORER_AT }),
    );
  });

  it("puts My circle back as the view once the circle is worked out", async () => {
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const user = await unconfirmedInMyCircle();
    await user.click(await workOutAgain());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    // While it is worked out, My circle can't be shown: House picks is, for now.
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expectWorking(myCircle());

    brainstorm.latestRun.mockResolvedValue(run("done"));
    ranks = [rankEvent()];
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    // The chosen half carries no check: the bar says it is ready.
    expect(markOf(myCircle())).toBeNull();
  });

  it("is put back after a reload while it was worked out, when the run then fails", async () => {
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const user = await unconfirmedInMyCircle();
    await user.click(await workOutAgain());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "null")).toMatchObject({ state: "working" }));

    // The tab is reloaded, and the run fails.
    cleanup();
    brainstorm.latestRun.mockResolvedValue(run("failed"));
    await open();
    expect(await workOutAgain()).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the tap", () => {
  it("asks the add-on, then works out the circle, polling every 15 s, then says it's ready and turns My circle on, never switching to it", async () => {
    const pubkey = signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    let signIn!: () => void;
    brainstorm.signInToBrainstorm.mockImplementation(
      (who) =>
        new Promise((resolve) => {
          signIn = () => {
            saveToken(who, TOKEN);
            resolve(TOKEN);
          };
        }),
    );
    brainstorm.startRun.mockResolvedValue({ run: run("waiting") });
    await open();
    await user.click(await openDoor(user));

    // Signing: the add-on asks them, which the line says. Nothing is worked out yet: the bar says nothing.
    expect(await screen.findByText(copy.circle.approveBrowser)).toBeInTheDocument();
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledWith(pubkey, expect.anything(), expect.any(AbortSignal), { how: "browser" });
    expectWaiting(myCircle());
    expect(barRegion()).toBeEmptyDOMElement();

    // Working: the bar says so, for a while, and My circle's half, with its arrow turning, all along.
    await act(async () => signIn());
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    expectWorking(myCircle());
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));
    expect(brainstorm.startRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));

    // Polling the run every 15 s.
    const polled = brainstorm.latestRun.mock.calls.length;
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await after(POLL_MS);
    await waitFor(() => expect(brainstorm.latestRun).toHaveBeenCalledTimes(polled + 1));
    // The clock moves on a little by itself (fake timers that follow real time, which a busy machine
    // stretches), so half a poll is left either side.
    await after(POLL_MS / 2);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(polled + 1);
    await after(POLL_MS / 2);
    await waitFor(() => expect(brainstorm.latestRun).toHaveBeenCalledTimes(polled + 2));
    // The bar has gone; the half still says it.
    expect(barRegion()).toBeEmptyDOMElement();
    expectWorking(myCircle());

    // Done, and the scorer can be read: ready, said in the bar, with the check on the half.
    brainstorm.latestRun.mockResolvedValue(run("done"));
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    await after(POLL_MS);
    await waitFor(() => expect(barRegion()).toHaveTextContent(copy.circle.ready));
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expectChecked(myCircle());
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    // The view is theirs to change.
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(myCircle()).toHaveAttribute("aria-pressed", "false");
    // And polling has stopped.
    const calls = brainstorm.latestRun.mock.calls.length;
    await after(POLL_MS * 4);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(calls);
    expect(markOf(myCircle())).toBeNull();
    expect(barRegion()).toBeEmptyDOMElement();

    await user.click(myCircle());
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
  });

  it("follows a run that is already under way, starting none", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_MS * 3);
    expect(brainstorm.latestRun.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it("is ready at once when the latest run is done and its scorer can be read (brief § 6, step 2)", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    brainstorm.latestRun.mockResolvedValue(run("done"));
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(myCircle()).toBeEnabled();
  });

  it("uses the sign-in this tab already has, asking the add-on nothing", async () => {
    const pubkey = signedIn();
    saveToken(pubkey, TOKEN);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal)));
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
  });

  it("asks the add-on again, once tapped, when the sign-in this tab had has run out", async () => {
    const pubkey = signedIn();
    saveToken(pubkey, "eyJhbGciOiJIUzI1NiJ9.eyJvbGQiOjF9.b2xk");
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockRejectedValueOnce(new client.TokenExpired());
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal)));
    expect(readToken(pubkey)).toBe(TOKEN);
  });
});

describe("recently", () => {
  it("says the circle was updated recently, and uses that run, when Brainstorm won't start another", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValueOnce(run("failed")).mockResolvedValue(run("done"));
    brainstorm.startRun.mockResolvedValue({ recently: true });
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.recently)).toBeInTheDocument();
    expect(myCircle()).toBeEnabled();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
  });

  it("follows the recent run while it is still under way", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValueOnce(null).mockResolvedValue(run("running"));
    brainstorm.startRun.mockResolvedValue({ recently: true });
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_MS);
    brainstorm.latestRun.mockResolvedValue(run("done"));
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
  });

  it("says Brainstorm is busy, with Try again, when it won't start a run and the person has none yet (a shared address's 429)", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ recently: true });
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.busy)).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.recently)).toBeNull();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    // The half is the door again, whose panel, showing under the toggle, has Try again.
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(myCircle()).toBeEnabled();
    expect(placesListed()).toBe(true);

    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    await user.click(screen.getByRole("button", { name: copy.circle.tryAgain }));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    expect(brainstorm.startRun).toHaveBeenCalledTimes(2);
    // The sign-in is the one they had: no second ask of the add-on.
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
  });
});

describe("when it goes wrong (Review Focus 4)", () => {
  it("says My circle isn't available, with Try again, when the run fails; House picks keeps working", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    brainstorm.latestRun.mockResolvedValue(run("failed"));
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(myCircle()).toBeEnabled();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(placesListed()).toBe(true);

    // Try again starts a new run.
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    await user.click(screen.getByRole("button", { name: copy.circle.tryAgain }));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["can't be reached for the sign-in", () => brainstorm.signInToBrainstorm.mockRejectedValue(new client.Unavailable())],
    ["refuses the login", () => brainstorm.signInToBrainstorm.mockRejectedValue(new client.SignInRefused(400))],
    ["can't be reached for the first look at the run", () => brainstorm.latestRun.mockRejectedValue(new client.Unavailable(500))],
    ["can't be reached to start a run", () => brainstorm.startRun.mockRejectedValue(new client.Unavailable())],
  ])("says My circle isn't available, with Try again, when Brainstorm %s", async (_, fail) => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    fail();
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.circle.tryAgain })).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expect(placesListed()).toBe(true);
  });

  it("stops polling and says so when Brainstorm can't be reached poll after poll (offline, or a 500 without CORS)", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValueOnce(null);
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    brainstorm.latestRun.mockRejectedValue(new client.Unavailable());
    // One poll that fails is not the end of it.
    await after(POLL_MS);
    expectWorking(myCircle());
    await after(POLL_MS * 3);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
    const calls = brainstorm.latestRun.mock.calls.length;
    await after(POLL_MS * 4);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(calls);
  });

  it("never spins past 45 minutes: a run that never ends is given up on", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValueOnce(null).mockResolvedValue(run("running"));
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_CAP_MS - POLL_MS);
    expectWorking(myCircle());
    await after(POLL_MS * 2);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
  });

  it.each([
    ["does not sign the login in time", () => new client.NotSigned()],
    ["says no", () => new Error("User rejected")],
  ])("goes back to the door, quietly, when the add-on %s", async (_, refusal) => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.signInToBrainstorm.mockRejectedValue(refusal());
    await open();
    await user.click(await openDoor(user));
    expect(await theDoor()).toBeEnabled();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it("goes back to the door when the person cancels while the add-on asks, and stops the ask", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    let asked: AbortSignal | undefined;
    brainstorm.signInToBrainstorm.mockImplementation(
      (_pubkey, _signer, signal) =>
        new Promise((_resolve, reject) => {
          asked = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    await open();
    await user.click(await openDoor(user));
    await screen.findByText(copy.circle.approveBrowser);
    await user.click(screen.getByRole("button", { name: copy.circle.cancel }));
    expect(await theDoor()).toBeEnabled();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    // The panel has gone with Cancel: the focus is on the toggle's block, not lost.
    expect(document.activeElement).not.toBe(document.body);
    expect(asked?.aborted).toBe(true);
    expect(screen.queryByText(copy.circle.approveBrowser)).toBeNull();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });
});

describe("a reload while the circle is worked out (Review Focus 3)", () => {
  it("carries on polling the run under way, starting no new run and asking the add-on nothing", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    const first = await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));

    // The tab is reloaded: the bar says it again, for the run the reload follows.
    first.unmount();
    brainstorm.latestRun.mockClear().mockResolvedValue(run("running"));
    await open();
    await waitFor(() => expect(barRegion()).toHaveTextContent(WORKING));
    await waitFor(() => expect(brainstorm.latestRun).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expectWorking(myCircle());

    brainstorm.latestRun.mockResolvedValue(run("done"));
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(myCircle()).toBeEnabled();
  });

  it("keeps the 45 minutes counted from when the run was known, not from the reload", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValueOnce(null).mockResolvedValue(run("running"));
    const first = await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_CAP_MS / 2);
    first.unmount();
    await open();
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_CAP_MS / 2 + POLL_MS);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
  });

  it("starts afresh when the tab is reloaded before a run is known: the door to Personalize again, polling nothing", async () => {
    const pubkey = signedIn();
    saveToken(pubkey, TOKEN);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    // Brainstorm has not said yet whether there is a run.
    brainstorm.latestRun.mockImplementation(
      (_token, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    );
    const first = await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(1);

    // The tab is reloaded.
    first.unmount();
    brainstorm.latestRun.mockReset().mockResolvedValue(run("running"));
    await open();
    expect(await theDoor()).toBeEnabled();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    await after(POLL_MS * 2);
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(myCircle()).toHaveTextContent(/^My circle$/);
  });

  it("goes back to the door, quietly, when the reload finds no run at all", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    const first = await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));

    // The tab is reloaded, and Brainstorm has no run for the person.
    first.unmount();
    brainstorm.latestRun.mockClear().mockResolvedValue(null);
    await open();
    expect(await theDoor()).toBeEnabled();
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await after(POLL_MS * 2);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(1);
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
  });

  it("looks again, as on a returning visitor's first load, at a run kept from more than 45 minutes ago, polling nothing (ruling R13)", async () => {
    const pubkey = signedIn();
    saveToken(pubkey, TOKEN);
    // The tab's session, restored days later.
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "working", since: Date.now() - POLL_CAP_MS - 60_000 }));
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    await open();
    await keptReady();
    await waitFor(() => expect(myCircle()).toBeEnabled());
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    await after(POLL_MS * 2);
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    for (const text of [copy.circle.workingTitle, copy.circle.unavailable, copy.circle.ready]) expect(screen.queryByText(text)).toBeNull();
  });

  it("starts one run for one tap in React's strict mode, with every effect run twice (ruling R13)", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValueOnce(null).mockResolvedValue(run("running"));
    await openApp("/", { events: fixtures, readers, strict: true });
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_MS * 3);
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
  });

  it("keeps a ready circle ready, and its view, over a reload", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    const first = await open();
    await keptReady();
    await waitFor(() => expect(myCircle()).toBeEnabled());
    await user.click(myCircle());
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    first.unmount();
    await open();
    await waitFor(() => expect(myCircle()).toHaveAttribute("aria-pressed", "true"));
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
  });
});

describe("a sign-in that runs out while polling", () => {
  it("is let go of without asking the person again, and the circle is looked for without it every 60 s until it is ready", async () => {
    const pubkey = signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));

    brainstorm.latestRun.mockRejectedValue(new client.TokenExpired());
    brainstorm.scorerOf.mockClear().mockResolvedValue(SCORER_AT);
    await after(POLL_MS);
    // The token is gone, and the scorer is looked for at once, with no token.
    await waitFor(() => expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1));
    expect(readToken(pubkey)).toBeNull();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    const polled = brainstorm.latestRun.mock.calls.length;

    // Not ready (no ranks on the relay yet): looked for again a minute later, not before (half a
    // minute later is two polls with a token), with half a minute left either side.
    await after(OPEN_POLL_MS / 2);
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    expectWorking(myCircle());
    await after(OPEN_POLL_MS / 2);
    await waitFor(() => expect(brainstorm.scorerOf).toHaveBeenCalledTimes(2));

    ranks = [rankEvent()];
    await after(OPEN_POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(polled);
  });
});

describe("someone else signing in to the tab", () => {
  it("gives them nothing of the person before: no circle, no scorer, no sign-in to Brainstorm", async () => {
    // What the tab keeps of the person who was signed in before.
    const before = "a1".repeat(32);
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey: before, state: "ready", scorer: SCORER_AT }));
    window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ pubkey: before, token: TOKEN }));
    const pubkey = signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();

    // The door to Personalize: no circle of the other person's to choose.
    expect(await theDoor()).toBeEnabled();
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    expect(myCircle()).not.toHaveAttribute("aria-pressed");
    expect(screen.queryByText(copy.circle.ready)).toBeNull();
    // Their own returning look, not the other person's circle.
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    expect(brainstorm.scorerOf).toHaveBeenCalledWith(pubkey, expect.any(AbortSignal));
    expect(readToken(pubkey)).toBeNull();
    // What the tab keeps is theirs now, in place of the other person's.
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "null")).toEqual({ pubkey, state: "off" }));

    // The other person's token is not theirs: the tap asks their own add-on.
    let used: string | undefined;
    brainstorm.latestRun.mockImplementation(async (token) => {
      used = token;
      return null;
    });
    brainstorm.signInToBrainstorm.mockImplementation(async (who) => {
      saveToken(who, "eyJhbGciOiJIUzI1NiJ9.eyJ3aG8iOjJ9.dGhlaXJz");
      return "eyJhbGciOiJIUzI1NiJ9.eyJ3aG8iOjJ9.dGhlaXJz";
    });
    await user.click(await openDoor(user));
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalled());
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledWith(pubkey, expect.anything(), expect.any(AbortSignal), { how: "browser" });
    expect(used).not.toBe(TOKEN);
  });
});

describe("signing out", () => {
  it("forgets the circle and Brainstorm's sign-in, and the view goes back to House picks", async () => {
    const pubkey = signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValue(run("done"));
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    const { router } = await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    await user.click(myCircle());
    expect(readToken(pubkey)).toBe(TOKEN);
    expect(window.sessionStorage.getItem(CIRCLE_KEY)).not.toBeNull();

    await act(() => router.navigate("/you"));
    await user.click(await screen.findByRole("button", { name: copy.you.signOut }));
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(CIRCLE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(VIEW_STORAGE_KEY)).toBe("house");

    await act(() => router.navigate("/"));
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(myCircle()).toHaveTextContent(/^My circle$/);
  });

  it("stops polling a run under way", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const { router } = await open();
    await user.click(await openDoor(user));
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await act(() => router.navigate("/you"));
    await user.click(await screen.findByRole("button", { name: copy.you.signOut }));
    const calls = brainstorm.latestRun.mock.calls.length;
    await after(POLL_MS * 4);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(calls);
  });
});
