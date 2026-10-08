import type { NostrEvent } from "@nostrify/nostrify";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_KEY } from "../src/account/session";
import * as client from "../src/circle/brainstorm";
import { CIRCLE_KEY, OPEN_POLL_MS, POLL_CAP_MS, POLL_MS } from "../src/circle/CircleProvider";
import { readToken, saveToken, TOKEN_KEY } from "../src/circle/token";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { VIEW_STORAGE_KEY } from "../src/view/ViewProvider";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, resetWidth } from "./support/app";
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
const personalize = () => screen.findByRole("button", { name: copy.circle.personalize });
const workOutAgain = () => screen.findByRole("button", { name: copy.circle.workOutAgain });
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
      "Personalizing asks Brainstorm, our scoring partner, to work out your circle. It sets up a public scoring profile for you, and your circle's scores are public.",
    );
    expect(copy.circle.workingTitle).toBe("Working out your circle");
    expect(copy.circle.workingBody).toMatch(/^This takes a few minutes\./);
    expect(copy.circle.ready).toBe("Your circle is ready.");
    expect(copy.circle.recently).toBe("Your circle was updated recently. We'll use that.");
    expect(copy.circle.busy).toBe("Brainstorm is busy right now. Try again in a little while.");
    expect(copy.circle.unavailable).toBe("My circle isn't available right now.");
  });
});

describe("Personalize", () => {
  it("sits under the toggle on a phone, with the line beside it, for a signed-in person whose circle isn't ready", async () => {
    signedIn();
    await open();
    const button = await personalize();
    const line = screen.getByText(copy.circle.consent);
    expect(button).toHaveAccessibleDescription(copy.circle.consent);
    expect(toggle().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByRole("main")).getByRole("button", { name: copy.circle.personalize })).toBe(button);
    // Not ready: My circle reads "soon", and the view is House picks.
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
    expect(myCircle()).toBeDisabled();
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
  });

  it("sits in the list's column on a desktop, below the top bar's toggle", async () => {
    signedIn();
    await open(DESKTOP);
    const button = await personalize();
    const column = screen.getByRole("heading", { level: 1, name: copy.pages.explore }).closest("section");
    expect(column).toContainElement(button);
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(within(column!).getByText(copy.circle.consent)).toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByRole("group", { name: copy.view.label })).toBeInTheDocument();
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
    await user.click(myCircle());
    expect(router.state.location.pathname).toBe("/signin");
  });

  it("is not there while My circle is closed (config.features.circle), and nothing asks Brainstorm", async () => {
    config.features.circle = false;
    signedIn();
    await open();
    await after(POLL_CAP_MS);
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(brainstorm.scorerOf).not.toHaveBeenCalled();
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
  });

  it("asks Brainstorm nothing but the one look at a returning visitor's scorer, until it is tapped (Review Focus 1)", async () => {
    signedIn();
    await open();
    await personalize();
    await after(POLL_CAP_MS);
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe("a returning visitor", () => {
  it("has My circle ready at once when their scorer has ranks on its relay: no sign-in, no token, no Personalize", async () => {
    const pubkey = signedIn();
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    await open();
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

  it("is offered Personalize when Brainstorm has no scorer for them", async () => {
    signedIn();
    await open();
    expect(await personalize()).toBeInTheDocument();
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    expect(myCircle()).toBeDisabled();
  });

  it("is offered Personalize, quietly, when Brainstorm can't be reached for the look", async () => {
    signedIn();
    brainstorm.scorerOf.mockRejectedValue(new client.Unavailable());
    await open();
    expect(await personalize()).toBeInTheDocument();
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
    expect(await personalize()).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://api.brainstorm.world/setup/${pubkey}`);
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(myCircle()).toBeDisabled();
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
    expect(await personalize()).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is looked at only once the places have loaded, and once a session", async () => {
    signedIn();
    const opening = openApp("/", { events: fixtures, readers, delayMs: 300 });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(brainstorm.scorerOf).not.toHaveBeenCalled();
    const { unmount } = await opening;
    await personalize();
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);

    // A reload of the tab.
    unmount();
    await open();
    expect(await personalize()).toBeInTheDocument();
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
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
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
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);

    brainstorm.latestRun.mockResolvedValue(run("done"));
    ranks = [rankEvent()];
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
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
    await user.click(await personalize());

    // Signing: the add-on asks them, which the line says.
    expect(await screen.findByText(copy.circle.approveBrowser)).toBeInTheDocument();
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledWith(pubkey, expect.anything(), expect.any(AbortSignal), { how: "browser" });
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);

    // Working: the banner (screen 11), My circle "soon".
    await act(async () => signIn());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.circle.workingBody)).toBeInTheDocument();
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
    expect(myCircle()).toBeDisabled();
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
    expect(screen.getByText(copy.circle.workingTitle)).toBeInTheDocument();

    // Done, and the scorer can be read: ready.
    brainstorm.latestRun.mockResolvedValue(run("done"));
    brainstorm.scorerOf.mockResolvedValue(SCORER_AT);
    ranks = [rankEvent()];
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expect(myCircle()).toBeEnabled();
    expect(myCircle()).toHaveTextContent(/^My circle$/);
    // The view is theirs to change.
    expect(housePicks()).toHaveAttribute("aria-pressed", "true");
    expect(myCircle()).toHaveAttribute("aria-pressed", "false");
    // And polling has stopped.
    const calls = brainstorm.latestRun.mock.calls.length;
    await after(POLL_MS * 4);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(calls);

    await user.click(myCircle());
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    // Choosing My circle puts the notice away.
    expect(screen.queryByText(copy.circle.ready)).toBeNull();
  });

  it("puts the notice away with Dismiss, leaving the focus near where it was", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ run: run("done") });
    brainstorm.scorerOf.mockResolvedValueOnce(null).mockResolvedValue(SCORER_AT);
    await open();
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.circle.dismiss }));
    expect(screen.queryByText(copy.circle.ready)).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(myCircle()).toBeEnabled();
  });

  it("follows a run that is already under way, starting none", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await open();
    await user.click(await personalize());
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.ready)).toBeInTheDocument();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(myCircle()).toBeEnabled();
  });

  it("uses the sign-in this tab already has, asking the add-on nothing", async () => {
    const pubkey = signedIn();
    saveToken(pubkey, TOKEN);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();
    await user.click(await personalize());
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
    await user.click(await personalize());
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
    await user.click(await personalize());
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
    await user.click(await personalize());
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.busy)).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.recently)).toBeNull();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expect(myCircle()).toBeDisabled();
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    brainstorm.latestRun.mockResolvedValue(run("failed"));
    await after(POLL_MS);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    expect(myCircle()).toBeDisabled();
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
    await user.click(await personalize());
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    brainstorm.latestRun.mockRejectedValue(new client.Unavailable());
    // One poll that fails is not the end of it.
    await after(POLL_MS);
    expect(screen.getByText(copy.circle.workingTitle)).toBeInTheDocument();
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_CAP_MS - POLL_MS);
    expect(screen.getByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_MS * 2);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
  });

  it.each([
    ["does not sign the login in time", () => new client.NotSigned()],
    ["says no", () => new Error("User rejected")],
  ])("goes back to Personalize, quietly, when the add-on %s", async (_, refusal) => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.signInToBrainstorm.mockRejectedValue(refusal());
    await open();
    await user.click(await personalize());
    expect(await personalize()).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.unavailable)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it("goes back to Personalize when the person cancels while the add-on asks, and stops the ask", async () => {
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
    await user.click(await personalize());
    await screen.findByText(copy.circle.approveBrowser);
    await user.click(screen.getByRole("button", { name: copy.circle.cancel }));
    expect(await personalize()).toBeInTheDocument();
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));

    // The tab is reloaded.
    first.unmount();
    brainstorm.latestRun.mockClear().mockResolvedValue(run("running"));
    await open();
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.latestRun).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).toBeNull();
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);

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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_CAP_MS / 2);
    first.unmount();
    await open();
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await after(POLL_CAP_MS / 2 + POLL_MS);
    expect(await screen.findByText(copy.circle.unavailable)).toBeInTheDocument();
  });

  it("starts afresh when the tab is reloaded before a run is known: Personalize again, polling nothing", async () => {
    const pubkey = signedIn();
    saveToken(pubkey, TOKEN);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    // Brainstorm has not said yet whether there is a run.
    brainstorm.latestRun.mockImplementation(
      (_token, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    );
    const first = await open();
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(1);

    // The tab is reloaded.
    first.unmount();
    brainstorm.latestRun.mockReset().mockResolvedValue(run("running"));
    await open();
    expect(await personalize()).toBeInTheDocument();
    expect(screen.queryByText(copy.circle.workingTitle)).toBeNull();
    await after(POLL_MS * 2);
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
  });

  it("goes back to Personalize, quietly, when the reload finds no run at all", async () => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    const first = await open();
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await waitFor(() => expect(brainstorm.startRun).toHaveBeenCalledTimes(1));

    // The tab is reloaded, and Brainstorm has no run for the person.
    first.unmount();
    brainstorm.latestRun.mockClear().mockResolvedValue(null);
    await open();
    expect(await personalize()).toBeInTheDocument();
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
    await user.click(await personalize());
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
    await waitFor(() => expect(myCircle()).toBeEnabled());
    await user.click(myCircle());
    first.unmount();
    await open();
    expect(myCircle()).toHaveAttribute("aria-pressed", "true");
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
  });
});

describe("a sign-in that runs out while polling", () => {
  it("is let go of without asking the person again, and the circle is looked for without it every 60 s until it is ready", async () => {
    const pubkey = signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.startRun.mockResolvedValue({ run: run("running") });
    await open();
    await user.click(await personalize());
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
    expect(screen.getByText(copy.circle.workingTitle)).toBeInTheDocument();
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
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey: before, state: "ready", scorer: SCORER_AT, notice: true }));
    window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ pubkey: before, token: TOKEN }));
    const pubkey = signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await open();

    expect(await personalize()).toBeInTheDocument();
    expect(myCircle()).toHaveTextContent(copy.view.circleSoon);
    expect(myCircle()).toBeDisabled();
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
    await user.click(await personalize());
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
    await user.click(await personalize());
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
    await user.click(await personalize());
    expect(await screen.findByText(copy.circle.workingTitle)).toBeInTheDocument();
    await act(() => router.navigate("/you"));
    await user.click(await screen.findByRole("button", { name: copy.you.signOut }));
    const calls = brainstorm.latestRun.mock.calls.length;
    await after(POLL_MS * 4);
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(calls);
  });
});
