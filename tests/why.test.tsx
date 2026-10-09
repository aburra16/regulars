import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_KEY } from "../src/account/session";
import * as client from "../src/circle/brainstorm";
import { CHECK_MS } from "../src/circle/CircleNews";
import { CIRCLE_KEY, forgetCircle, POLL_CAP_MS, POLL_MS } from "../src/circle/CircleProvider";
import { COUNT_KEY, countRanks, floorFromRun, RANK_PAGE, RANK_PAGES } from "../src/circle/circleSize";
import { readToken, saveToken } from "../src/circle/token";
import { WHY_PATH } from "../src/circle/paths";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import type { RelayReader } from "../src/nostr/events";
import { buildIndexes } from "../src/places/indexes";
import { parsePlaces } from "../src/places/load";
import { REVIEW_KIND } from "../src/reviews/review";
import { VIEW_STORAGE_KEY } from "../src/view/ViewProvider";
import raw from "./fixtures/funchal-items.json";
import { barRegion, DESKTOP, openApp, resetWidth, resizeTo } from "./support/app";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";

/*
 * Why you see what you see (M3 Task 4; the brief's screen 12 and D4): how a score is worked out, the
 * person's circle in a count, and Update now. Brainstorm's client is mocked: its network calls are
 * stand-ins each test sets, and its errors and `runState` are its own. The scorer's ranks are read
 * from a relay in memory. Polling runs on fake timers, which the tests move on; nothing waits on the
 * wall clock, and nothing reaches the network (tests/setup.ts).
 */

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

const fixtures: NostrEvent[] = raw;

/** The relay a person's scorer publishes their circle's ranks to. */
const SCORES = "wss://scores.brainstorm.world";
/** The person's scorer, made up. */
const SCORER = "5c0e".repeat(16);
const SCORER_AT = { pubkey: SCORER, relay: SCORES };
/** A token as Brainstorm gives one. Made up. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJuIjoxfQ.c2lnbmF0dXJl";

/** Noon on 8 October 2026, on the person's own clock: the fake clock starts here. */
const NOW = new Date(2026, 9, 8, 12, 0, 0);
const DAY_S = 86_400;
const nowS = () => Math.floor(NOW.getTime() / 1000);

const [ANA, BEN, CAT, DAN, EVA] = ["a", "b", "c", "d", "e"].map(hex64) as [string, string, string, string, string];

/** A rank by the scorer of `subject`, `hops` from the person (none: no tag), published at `at` (seconds). */
const rankOf = (subject: string, rank: number, { hops, at = nowS() - 2 * DAY_S }: { hops?: number; at?: number } = {}) =>
  shapedEvent({
    kind: 30382,
    pubkey: SCORER,
    created_at: at,
    tags: [["d", subject], ["rank", String(rank)], ...(hops === undefined ? [] : [["hops", String(hops)]])],
  });

/**
 * The person's circle, as the scorer published it two days ago: Ana, whom they trust; Ben, Cat and
 * Eva, whom people they trust trust; Dan below the line (5); and the person themself, who is not
 * counted. Four people, one of them trusted directly.
 */
const circleOf = (me: string) => [
  rankOf(me, 100, { hops: 0 }),
  rankOf(ANA, 87.37, { hops: 1 }),
  rankOf(BEN, 63.41, { hops: 2 }),
  rankOf(CAT, 58.29, { hops: 3 }),
  rankOf(DAN, 4.38, { hops: 2 }),
  rankOf(EVA, 77.13),
];
/** Every rank the circle above has: none of them, nor their weights, is ever shown (decision 19). */
const RANKS = [87.37, 63.41, 58.29, 4.38, 77.13];

/** A run where `where` says, as the client reads one, last updated `daysAgo` days before now. */
function run(where: "waiting" | "running" | "done" | "failed", { daysAgo = 0, countValues = null as string | null } = {}): client.Run {
  const [status, internalPublicationStatus, taStatus] = (
    {
      waiting: ["waiting", "waiting", "waiting"],
      running: ["ongoing", "waiting", "waiting"],
      done: ["success", "success", "success"],
      failed: ["failure", "waiting", "waiting"],
    } as const
  )[where];
  const at = NOW.getTime() - daysAgo * DAY_S * 1000;
  return { status, internalPublicationStatus, taStatus, countValues, othersFirst: 0, createdAt: at, updatedAt: at };
}

/** Where the reviews are, in a test that has some. */
const SEARCH = "wss://search.brainstorm.world";
const JACAFE = buildIndexes(parsePlaces(fixtures)).byD.get("osm-node-11330857543")!;
const reviewOf = (reviewer: string, stars: number) =>
  shapedEvent({
    kind: REVIEW_KIND,
    pubkey: reviewer,
    tags: [["d", `place:${JACAFE.address}`], ["a", JACAFE.address], ["m", "place"], ["s", String(stars)]],
  });

/**
 * What the relays hold: the scorer's ranks, which a test changes as Brainstorm publishes, and
 * reviews. Each read of the scorer's ranks is noted: those that count the circle (`rankReads`), and
 * those of the scores store, which name the reviewers (`storeRankReads`).
 */
let ranks: NostrEvent[] = [];
let reviews: NostrEvent[] = [];
let rankReads: NostrFilter[] = [];
let storeRankReads: NostrFilter[] = [];
const readers = (url: string): RelayReader => ({
  async *req(filter, signal) {
    if (url === SCORES && filter.kinds?.includes(30382)) (filter["#d"] === undefined ? rankReads : storeRankReads).push(filter);
    yield* createMemoryReader(url === SCORES ? ranks : url === SEARCH ? reviews : []).req(filter, signal);
  },
});

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

/** Earlier this session the circle of the person with `pubkey` was ready: the tab kept it, and asks Brainstorm nothing. */
function ready(pubkey: string): void {
  window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey, state: "ready", scorer: SCORER_AT }));
}

const openWhy = (px?: number) => openApp(WHY_PATH, { events: fixtures, readers, ...(px === undefined ? {} : { px }) });
const heading = (name: string | RegExp, level?: number) => screen.getByRole("heading", { name, ...(level === undefined ? {} : { level }) });
const toggle = () => screen.getByRole("group", { name: copy.view.label });
const updateNow = () => screen.getByRole("button", { name: copy.why.updateNow });
/** The panel with the circle's count in it. */
const circlePanel = () => screen.getByRole("region", { name: copy.why.circleHeading });
/** The panel once it is on the page: on a slow machine the page may not have drawn it yet. */
const findCirclePanel = () => screen.findByRole("region", { name: copy.why.circleHeading });
/** The polite status beside Update now: the panel's one. */
const updateStatus = () => within(circlePanel()).getByRole("status");

/** Moves the fake clock on, and lets what was waiting on it run. */
const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  config.features.circle = true;
  ranks = [];
  reviews = [];
  rankReads = [];
  storeRankReads = [];
  brainstorm.scorerOf.mockReset().mockResolvedValue(null);
  brainstorm.signInToBrainstorm.mockReset().mockImplementation(async (pubkey) => {
    saveToken(pubkey, TOKEN);
    return TOKEN;
  });
  brainstorm.latestRun.mockReset().mockResolvedValue(null);
  brainstorm.startRun.mockReset().mockResolvedValue({ run: run("waiting") });
});

afterEach(() => {
  vi.useRealTimers();
  resetWidth();
  Reflect.deleteProperty(window, "nostr");
  config.features.circle = false;
});

describe("the words", () => {
  it("are the design's where it has them (Trust.dc.html, DeskTrust.dc.html)", () => {
    expect(copy.why.title).toBe("Why you see what you see");
    expect(copy.why.intro).toBe(
      "There is no single score for a place. Every score here is worked out from a set of people. You choose which set.",
    );
    expect(copy.why.rulesHeading).toBe("How a score is worked out");
    expect(copy.why.rules.only.title).toBe("Only your circle counts");
    expect(copy.why.rules.closer.title).toBe("Closer people count for more");
    expect(copy.why.rules.oneSay.title).toBe("One say each");
    expect(copy.why.foldedHeading).toBe("What gets folded away");
    expect(copy.why.houseHeading).toBe("And House picks?");
    expect(copy.why.updateNow).toBe("Update now");
    expect(copy.why.inYourCircle(212)).toBe("people in your circle");
    expect(copy.why.workedOut(2, 0)).toBe("Worked out 2 days ago");
  });

  it("point at nothing the app does not have yet (ruling R11): trusting people is done in their own apps today", () => {
    for (const text of [copy.why.foldedBody, copy.why.foldedBodyDesk, copy.why.emptyBody]) {
      expect(text).not.toMatch(/\bTrust a reviewer\b|\bTrust button\b|\btap Trust\b/i);
    }
    expect(copy.why.foldedBody).toMatch(/one tap opens them\./);
    expect(copy.why.foldedBodyDesk).toMatch(/one click opens them\./);
    expect(copy.why.foldedBody).toMatch(/in another app/);
  });
});

describe("the way in: How this works", () => {
  it.each([
    ["a phone", undefined],
    ["a desktop", DESKTOP],
  ])("goes from beside the toggle on Explore to the page, on %s", async (_, px) => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const { router } = await openApp("/", { events: fixtures, readers, ...(px === undefined ? {} : { px }) });
    await user.click(await screen.findByRole("link", { name: copy.explore.howThisWorks }));
    expect(router.state.location.pathname).toBe(WHY_PATH);
    expect(await screen.findByRole("heading", { level: 1, name: copy.why.title })).toBeInTheDocument();
    expect(document.title).toBe(copy.titles.why);
  });
});

describe("signed out", () => {
  it("explains the views, how a score is worked out and what is folded, with the toggle and Sign in", async () => {
    const { router } = await openWhy();
    expect(heading(copy.why.title, 1)).toBeInTheDocument();
    expect(screen.getByText(copy.why.intro)).toBeInTheDocument();
    expect(screen.getByText(copy.why.lookingThrough)).toBeInTheDocument();
    expect(within(toggle()).getByRole("button", { name: copy.view.house })).toHaveAttribute("aria-pressed", "true");
    // Both views: My circle, and what signing in does for it; House picks, below.
    expect(heading(copy.view.circle, 2)).toBeInTheDocument();
    expect(screen.getByText(copy.signin.intro)).toBeInTheDocument();
    expect(heading(copy.why.houseHeading, 2)).toBeInTheDocument();
    expect(heading(copy.why.rulesHeading, 2)).toBeInTheDocument();
    expect(heading(copy.why.foldedHeading, 2)).toBeInTheDocument();
    // No circle to count, and no Update now.
    expect(screen.queryByRole("region", { name: copy.why.circleHeading })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.why.updateNow })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.circle.personalize })).not.toBeInTheDocument();

    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(screen.getByRole("link", { name: copy.signin.button }));
    expect(router.state.location.pathname).toBe("/signin");
    expect((router.state.location.state as { from?: { pathname?: string } } | null)?.from?.pathname).toBe(WHY_PATH);
    // Nothing was asked of Brainstorm.
    for (const call of [brainstorm.scorerOf, brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("lists the three rules, numbered, as a list on a phone", async () => {
    await openWhy();
    const rules = within(screen.getByRole("list", { name: copy.why.rulesHeading })).getAllByRole("listitem");
    expect(rules).toHaveLength(3);
    expect(rules[0]).toHaveTextContent(`${copy.why.rules.only.title}. ${copy.why.rules.only.body}`);
    expect(rules[1]).toHaveTextContent(`${copy.why.rules.closer.title}. ${copy.why.rules.closer.body}`);
    expect(rules[2]).toHaveTextContent(`${copy.why.rules.oneSay.title}. ${copy.why.rules.oneSay.body}`);
    for (const rule of rules) expect(rule).not.toHaveClass("border-token");
    expect(screen.getByText(copy.why.foldedBody)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.why.about })).toHaveAttribute("href", "/about");
  });

  it("puts the rules in cards side by side on a desktop, and the views in a side rail", async () => {
    await openWhy(DESKTOP);
    const rules = within(screen.getByRole("list", { name: copy.why.rulesHeading })).getAllByRole("listitem");
    expect(rules).toHaveLength(3);
    for (const rule of rules) expect(rule).toHaveClass("border-token", "border-line", "rounded-card");
    expect(rules[1]).toHaveTextContent(`${copy.why.rules.closer.title}${copy.why.rules.closer.body}`);
    // The design's desktop words: a click, not a tap.
    expect(screen.getByText(copy.why.foldedBodyDesk)).toBeInTheDocument();
    // The rail is not named as the panel in it is: one landmark of each name.
    const rail = screen.getByRole("complementary");
    expect(rail).not.toHaveAccessibleName(copy.why.circleHeading);
    expect(within(rail).getByRole("heading", { name: copy.view.circle })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: copy.why.about })).toBeInTheDocument();
  });
});

describe("signed in, before personalizing", () => {
  it("offers Personalize, with the line that says what it does, and counts nothing", async () => {
    signedIn();
    await openWhy();
    expect(await screen.findByRole("button", { name: copy.circle.personalize })).toBeInTheDocument();
    expect(screen.getByText(copy.circle.consent)).toBeInTheDocument();
    expect(screen.getByText(copy.why.housePicksNow)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: copy.why.circleHeading })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.signin.button })).not.toBeInTheDocument();
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
  });

  it.each([
    ["a phone", undefined, 1],
    ["a desktop", DESKTOP, 2],
  ])("keeps Personalize in view without a tap on %s, and My circle's half, on each toggle, goes to it", async (_, px, toggles) => {
    signedIn();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await openWhy(px);
    const button = await screen.findByRole("button", { name: copy.circle.personalize });
    expect(screen.getByText(copy.circle.consent)).toBeInTheDocument();
    // The page's own toggle, and on a desktop the top bar's.
    const groups = screen.getAllByRole("group", { name: copy.view.label });
    expect(groups).toHaveLength(toggles);
    for (const group of groups) {
      const half = within(group).getByRole("button", { name: copy.view.circle });
      expect(half).toBeEnabled();
      expect(half).not.toHaveAttribute("aria-pressed");
      // Its panel is this page's, which shows already.
      expect(half).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(half.getAttribute("aria-controls") ?? "")).toContainElement(button);
      await user.click(half);
      expect(button).toHaveFocus();
    }
    // No second panel: one Personalize, and no Not now, which only a panel opened from the half has.
    expect(screen.getAllByRole("button", { name: copy.circle.personalize })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: copy.circle.notNow })).not.toBeInTheDocument();
    expect(brainstorm.scorerOf).toHaveBeenCalledTimes(1);
    for (const call of [brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) expect(call).not.toHaveBeenCalled();
  });
});

describe("your circle, once it is ready", () => {
  it("counts the people at or above the line from the scorer's ranks, with no token, and says when it was worked out", async () => {
    const me = signedIn();
    ready(me);
    ranks = circleOf(me);
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    const panel = circlePanel();
    expect(within(panel).getByText(copy.why.youTrust).parentElement).toHaveTextContent(`${copy.why.youTrust}1`);
    expect(within(panel).getByText(copy.why.theyTrust).parentElement).toHaveTextContent(`${copy.why.theyTrust}3`);
    expect(within(panel).getByText(copy.why.workedOut(2, 0))).toBeInTheDocument();
    expect(updateNow()).toBeInTheDocument();
    // The toggle can go to My circle.
    expect(within(toggle()).getByRole("button", { name: copy.view.circle })).toBeEnabled();
    // With no token in the tab, Brainstorm is asked nothing: the count is the relay's.
    expect(brainstorm.latestRun).not.toHaveBeenCalled();
    expect(rankReads.length).toBeGreaterThan(0);
  });

  it.each([
    ["on a desktop", DESKTOP, "counted"],
    ["on a phone", undefined, "counted"],
    ["with nobody in the circle", undefined, "empty"],
    ["with only a floor", undefined, "floor"],
    ["signed out", undefined, "signedOut"],
  ] as const)("never shows a number about a person (decision 19), %s", async (_, px, version) => {
    if (version !== "signedOut") {
      const me = signedIn();
      ready(me);
      ranks = version === "empty" ? [rankOf(me, 100, { hops: 0 }), rankOf(DAN, 4.38, { hops: 1 })] : circleOf(me);
      if (version === "floor") {
        saveToken(me, TOKEN);
        brainstorm.latestRun.mockResolvedValue(run("done", { countValues: JSON.stringify({ high: { "1": 87, "2": 6341 } }) }));
      }
    }
    await openWhy(px);
    if (version === "counted") await waitFor(() => expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4)));
    if (version === "empty") await within(await findCirclePanel()).findByRole("heading", { name: copy.why.emptyTitle });
    if (version === "floor") await waitFor(() => expect(circlePanel()).toHaveTextContent(`6,400+ ${copy.why.inYourCircle(6400)}`));
    if (version === "signedOut") expect(screen.getByRole("link", { name: copy.signin.button })).toBeInTheDocument();
    // "Closer people count for more" is a rule about the sums, the design's own words, not a number on anyone.
    expectNoNumbersAboutPeople(RANKS, { allow: [copy.why.rules.closer.title] });
  });

  it("takes the count from the run when the tab has a token and the run's counts are past what the relay is read for", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    // At or above the line for sure: high, medium_high and medium (rank 7 and up), past hop 0 (the person).
    const countValues = JSON.stringify({
      high: { "0": 1, "1": 40, "2": 900 },
      medium_high: { "2": 700 },
      medium: { "3": 800 },
      medium_low: { "2": 5000 },
      low: { "3": 90000 },
      low_and_reported_by_2_or_more_trusted_pubkeys: { "2": 3 },
    });
    brainstorm.latestRun.mockResolvedValue(run("done", { daysAgo: 3, countValues }));
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`2,400+ ${copy.why.inYourCircle(2400)}`));
    expect(within(circlePanel()).getByText(copy.why.atLeast(2400))).toHaveClass("sr-only");
    expect(within(circlePanel()).getByText(copy.why.workedOut(3, 0))).toBeInTheDocument();
    expect(brainstorm.latestRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
    // The split by who trusts whom is for a count that is exact.
    expect(within(circlePanel()).queryByText(copy.why.youTrust)).not.toBeInTheDocument();
    // The relay was asked at the same time, and stopped once the run's floor was past what it can count.
    expect(rankReads.length).toBeLessThanOrEqual(1);
  });

  it("asks Brainstorm and reads the relay at the same time", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    let answer!: (value: client.Run | null) => void;
    brainstorm.latestRun.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await openWhy();
    // The relay is read while Brainstorm has not answered.
    await waitFor(() => expect(rankReads.length).toBeGreaterThan(0));
    expect(brainstorm.latestRun).toHaveBeenCalledTimes(1);
    expect(within(circlePanel()).getByText(copy.why.counting)).toBeInTheDocument();
    await act(async () => answer(run("done", { daysAgo: 1 })));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    expect(within(circlePanel()).getByText(copy.why.workedOut(1, 0))).toBeInTheDocument();
  });

  it("gives the run's floor when the relay can't be read", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    brainstorm.latestRun.mockResolvedValue(run("done", { countValues: JSON.stringify({ medium: { "2": 437 } }) }));
    const down = (url: string): RelayReader => ({
      async *req(filter, signal) {
        if (url === SCORES) throw new Error("The relay answered 503");
        yield* readers(url).req(filter, signal);
      },
    });
    await openApp(WHY_PATH, { events: fixtures, readers: down });
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`430+ ${copy.why.inYourCircle(430)}`));
  });

  it("keeps the count for the tab: coming back reads nothing again, until Update now has the circle worked out again", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    const { router } = await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    const reads = rankReads.length;
    const asks = brainstorm.latestRun.mock.calls.length;

    await act(() => router.navigate("/about"));
    await act(() => router.navigate(WHY_PATH));
    // At once, from what the tab keeps: no "Counting your circle…", and nothing read.
    expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`);
    expect(within(circlePanel()).getByText(copy.why.workedOut(2, 0))).toBeInTheDocument();
    await after(100);
    expect(rankReads.length).toBe(reads);
    expect(brainstorm.latestRun.mock.calls.length).toBe(asks);

    // Worked out again: counted again, and kept.
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    const at = nowS();
    ranks = [...circleOf(me).map((ev) => ({ ...ev, created_at: at })), rankOf(hex64("f"), 30.5, { hops: 1, at })];
    brainstorm.latestRun.mockResolvedValue(run("done"));
    await after(POLL_MS);
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`5 ${copy.why.inYourCircle(5)}`));
    expect(rankReads.length).toBeGreaterThan(reads);
  });

  it("keeps the count while the scores store reads the circle's ranks: Why, Explore, then Why reads nothing again (ruling R13)", async () => {
    config.reviewRelays = [SEARCH];
    const me = signedIn();
    ready(me);
    ranks = circleOf(me);
    reviews = [reviewOf(ANA, 5), reviewOf(BEN, 3)];
    const { router } = await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));

    await act(() => router.navigate("/"));
    await waitFor(() => expect(storeRankReads.some((filter) => filter.authors?.includes(SCORER))).toBe(true));
    await waitFor(() => expect(screen.getByRole("link", { name: "Jacafé" })).toBeInTheDocument());
    await after(200);
    const reads = rankReads.length;

    await act(() => router.navigate(WHY_PATH));
    expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`);
    await after(200);
    expect(rankReads.length).toBe(reads);
    expect(window.sessionStorage.getItem(COUNT_KEY)).not.toBeNull();
  });

  it("counts again once an unconfirmed circle is confirmed by ranks the scores store finds", async () => {
    config.reviewRelays = [SEARCH];
    const me = signedIn();
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey: me, state: "unconfirmed", scorer: SCORER_AT }));
    const { router } = await openWhy();
    expect(await within(await findCirclePanel()).findByRole("heading", { name: copy.why.emptyTitle })).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(COUNT_KEY)).not.toBeNull());

    // Brainstorm has published since: the store finds ranks for the reviewers on Explore.
    ranks = circleOf(me);
    reviews = [reviewOf(ANA, 5), reviewOf(BEN, 3)];
    await act(() => router.navigate("/"));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "{}")).toMatchObject({ state: "ready" }));
    expect(window.sessionStorage.getItem(COUNT_KEY)).toBeNull();
    await act(() => router.navigate(WHY_PATH));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
  });

  it("keeps no floor of nobody: Try again counts again (ruling R13)", async () => {
    const me = signedIn();
    ready(me);
    // A full page of ranks from one second, all under the line: the relay's pages get no further back
    // in time, and nobody at or above the line was counted. A floor of nobody says nothing.
    const at = nowS() - DAY_S;
    ranks = Array.from({ length: RANK_PAGE }, (_, n) => rankOf((n + 1).toString(16).padStart(64, "0"), 3, { hops: 2, at }));
    await openWhy();
    expect(await within(await findCirclePanel()).findByText(copy.why.countFailed)).toBeInTheDocument();
    expect(window.sessionStorage.getItem(COUNT_KEY)).toBeNull();

    const reads = rankReads.length;
    ranks = circleOf(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(within(circlePanel()).getByRole("button", { name: copy.load.retry }));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    expect(rankReads.length).toBeGreaterThan(reads);
  });

  it("keeps no floor the relay did not count: coming back counts again, from the relay once it answers (ruling R13)", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    brainstorm.latestRun.mockResolvedValue(run("done", { countValues: JSON.stringify({ medium: { "2": 437 } }) }));
    let down = true;
    const failing = (url: string): RelayReader => ({
      async *req(filter, signal) {
        if (down && url === SCORES) throw new Error("The relay answered 503");
        yield* readers(url).req(filter, signal);
      },
    });
    const { router } = await openApp(WHY_PATH, { events: fixtures, readers: failing });
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`430+ ${copy.why.inYourCircle(430)}`));
    expect(window.sessionStorage.getItem(COUNT_KEY)).toBeNull();

    down = false;
    ranks = circleOf(me);
    await act(() => router.navigate("/about"));
    await act(() => router.navigate(WHY_PATH));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    await waitFor(() => expect(window.sessionStorage.getItem(COUNT_KEY)).not.toBeNull());
  });

  it("forgets the count kept for the tab when the person signs out", async () => {
    const me = signedIn();
    ready(me);
    ranks = circleOf(me);
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    // The count is kept for the tab once it is read, which may be a moment after it shows.
    await waitFor(() => expect(window.sessionStorage.getItem(COUNT_KEY)).not.toBeNull());
    forgetCircle();
    expect(window.sessionStorage.getItem(COUNT_KEY)).toBeNull();
  });

  it("counts from the relay when the run's counts are smaller, and says when the run was worked out", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    brainstorm.latestRun.mockResolvedValue(run("done", { daysAgo: 1, countValues: JSON.stringify({ high: { "1": 2 } }) }));
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    expect(within(circlePanel()).getByText(copy.why.workedOut(1, 0))).toBeInTheDocument();
  });

  it("lets go of a token Brainstorm refuses, and counts from the relay", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    brainstorm.latestRun.mockRejectedValue(new client.TokenExpired());
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    expect(readToken(me)).toBeNull();
    // Nobody is asked to sign anything: they did not act.
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
  });

  it("says plainly when nobody is in the circle yet", async () => {
    const me = signedIn();
    ready(me);
    ranks = [rankOf(me, 100, { hops: 0 }), rankOf(DAN, 4.38, { hops: 1 })];
    await openWhy();
    expect(await within(await findCirclePanel()).findByRole("heading", { name: copy.why.emptyTitle })).toBeInTheDocument();
    expect(within(circlePanel()).getByText(copy.why.emptyBody)).toBeInTheDocument();
    expect(within(circlePanel()).queryByText(copy.why.youTrust)).not.toBeInTheDocument();
    expect(updateNow()).toBeInTheDocument();
  });

  it("says when the circle can't be counted, and counts again on Try again", async () => {
    const me = signedIn();
    ready(me);
    let down = true;
    const failing = (url: string): RelayReader => ({
      async *req(filter, signal) {
        if (down && url === SCORES) throw new Error("The relay answered 503");
        yield* readers(url).req(filter, signal);
      },
    });
    ranks = circleOf(me);
    await openApp(WHY_PATH, { events: fixtures, readers: failing });
    expect(await within(await findCirclePanel()).findByText(copy.why.countFailed)).toBeInTheDocument();
    down = false;
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(within(circlePanel()).getByRole("button", { name: copy.load.retry }));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
  });

  it("does not show the people the person trusts one by one: that comes with the Trust button", async () => {
    const me = signedIn();
    ready(me);
    ranks = circleOf(me);
    await openWhy(DESKTOP);
    await waitFor(() => expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4)));
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: copy.why.youTrust })).not.toBeInTheDocument();
  });
});

describe("Update now", () => {
  /** The page, ready, with the circle counted. */
  async function openCounted(me: string) {
    ready(me);
    ranks = circleOf(me);
    const opened = await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4)));
    return opened;
  }

  it("says the circle was updated recently when Brainstorm will not start a run, and asks for no sign-in with a token", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    brainstorm.latestRun.mockResolvedValue(run("done", { daysAgo: 0 }));
    brainstorm.startRun.mockResolvedValue({ recently: true });
    await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    expect(updateStatus()).toHaveAttribute("role", "status");
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.circle.recently));
    expect(brainstorm.startRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    // It can be tapped again.
    expect(updateNow()).toBeEnabled();
  });

  it("asks the person to approve Brainstorm's sign-in when the tab has no token, then starts a run and follows it until it is done", async () => {
    const me = signedIn();
    await openCounted(me);
    let signIn!: () => void;
    brainstorm.signInToBrainstorm.mockImplementation(
      (pubkey) =>
        new Promise((resolve) => {
          signIn = () => {
            saveToken(pubkey, TOKEN);
            resolve(TOKEN);
          };
        }),
    );
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());

    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.circle.approveBrowser));
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledWith(me, expect.anything(), expect.any(AbortSignal), { how: "browser" });
    expect(screen.queryByRole("button", { name: copy.why.updateNow })).not.toBeInTheDocument();
    await act(async () => signIn());

    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    expect(brainstorm.startRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await after(POLL_MS);
    expect(brainstorm.latestRun).toHaveBeenCalledWith(TOKEN, expect.any(AbortSignal));
    expect(updateStatus()).toHaveTextContent(copy.why.updating);

    // Brainstorm publishes the new circle: Fay joins it, whom the person trusts.
    ranks = [...circleOf(me).map((ev) => ({ ...ev, created_at: nowS() })), rankOf(hex64("f"), 30.5, { hops: 1, at: nowS() })];
    brainstorm.latestRun.mockResolvedValue(run("done"));
    const readsBefore = rankReads.length;
    await after(POLL_MS);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updated));
    // Counted again, from what Brainstorm published.
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`5 ${copy.why.inYourCircle(5)}`));
    expect(within(circlePanel()).getByText(copy.why.youTrust).parentElement).toHaveTextContent(`${copy.why.youTrust}2`);
    expect(rankReads.length).toBeGreaterThan(readsBefore);
    expect(within(circlePanel()).getByText(copy.why.workedOut(0, 0))).toBeInTheDocument();
    expect(updateNow()).toBeInTheDocument();
  });

  it("goes back to Update now when the person cancels the sign-in", async () => {
    const me = signedIn();
    await openCounted(me);
    let seen: AbortSignal | undefined;
    brainstorm.signInToBrainstorm.mockImplementation(
      (_pubkey, _signer, signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await user.click(await screen.findByRole("button", { name: copy.circle.cancel }));
    expect(seen?.aborted).toBe(true);
    expect(updateNow()).toBeInTheDocument();
    expect(updateStatus()).toHaveTextContent("");
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });

  it("signs in again once, as the person asked, when Brainstorm says the tab's token has run out", async () => {
    const me = signedIn();
    saveToken(me, "eyJvbGQiOjF9.eyJvbGQiOjF9.b2xk");
    brainstorm.latestRun.mockResolvedValue(null);
    brainstorm.startRun.mockRejectedValueOnce(new client.TokenExpired()).mockResolvedValueOnce({ recently: true });
    await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.circle.recently));
    expect(brainstorm.signInToBrainstorm).toHaveBeenCalledTimes(1);
    expect(brainstorm.startRun).toHaveBeenCalledTimes(2);
    expect(brainstorm.startRun).toHaveBeenLastCalledWith(TOKEN, expect.any(AbortSignal));
  });

  it("says the circle couldn't be updated when Brainstorm can't be reached, and keeps Update now", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    brainstorm.startRun.mockRejectedValue(new client.Unavailable());
    await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updateFailed));
    expect(updateNow()).toBeEnabled();
    // The circle and its count stay as they were.
    expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4));
  });

  it("says so when the run fails, and never spins on: three polls unanswered, or 45 minutes, end it", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    brainstorm.latestRun.mockResolvedValue(run("failed"));
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    await after(POLL_MS);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updateFailed));

    brainstorm.latestRun.mockRejectedValue(new client.Unavailable());
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    await after(POLL_MS * 3);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updateFailed));

    brainstorm.latestRun.mockResolvedValue(run("running"));
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    await after(POLL_CAP_MS);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updateFailed));
  });

  it("has the scores store read the circle's ranks again once the run is done", async () => {
    config.reviewRelays = [SEARCH];
    const me = signedIn();
    saveToken(me, TOKEN);
    ready(me);
    ranks = circleOf(me);
    reviews = [reviewOf(ANA, 5), reviewOf(BEN, 3)];
    const placePath = `/place/${encodeURIComponent(JACAFE.d)}`;
    const { router } = await openApp(placePath, { events: fixtures, readers });
    await waitFor(() => expect(storeRankReads.some((filter) => filter.authors?.includes(SCORER))).toBe(true));
    await act(() => router.navigate(WHY_PATH));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4)));

    // Without an update, going back reads nothing again: the store holds the circle's ranks.
    const held = storeRankReads.length;
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    brainstorm.latestRun.mockResolvedValue(run("done"));
    await after(POLL_MS);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updated));
    await act(() => router.navigate(placePath));
    await waitFor(() => expect(storeRankReads.length).toBeGreaterThan(held));
    expect(storeRankReads.at(-1)?.authors).toEqual([SCORER]);
  });

  it("stops following, and says what comes next, when the token runs out while the run is followed", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    brainstorm.latestRun.mockRejectedValue(new client.TokenExpired());
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    await after(POLL_MS);
    await waitFor(() => expect(readToken(me)).toBeNull());
    // Still being worked out: the status says what happens next, and ends; Update now is back, and
    // nobody is asked to sign anything.
    expect(updateStatus()).toHaveTextContent(copy.why.updateStarted);
    expect(updateStatus()).not.toHaveTextContent(copy.why.updating);
    expect(updateNow()).toBeEnabled();
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    const polls = brainstorm.latestRun.mock.calls.length;
    await after(POLL_MS * 2);
    expect(brainstorm.latestRun.mock.calls.length).toBe(polls);
  });

  it("keeps following once the page is left, and My circle on Explore takes the new circle when it is done", async () => {
    config.reviewRelays = [SEARCH];
    const me = signedIn();
    saveToken(me, TOKEN);
    ready(me);
    window.sessionStorage.setItem(VIEW_STORAGE_KEY, "circle");
    ranks = circleOf(me);
    reviews = [reviewOf(ANA, 5), reviewOf(BEN, 3)];
    const { router } = await openApp(WHY_PATH, { events: fixtures, readers, px: DESKTOP });
    await waitFor(() => expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4)));
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    brainstorm.latestRun.mockResolvedValue(run("running"));

    await act(() => router.navigate("/"));
    const jacafe = () => screen.getByRole("link", { name: "Jacafé" });
    await waitFor(() => expect(jacafe()).toHaveTextContent(copy.score.ratedByCircle(2)));
    await after(POLL_MS);
    // The poll that the timer starts asks Brainstorm when it gets to it.
    await waitFor(() => expect(brainstorm.latestRun).toHaveBeenLastCalledWith(TOKEN, expect.any(AbortSignal)));

    // Brainstorm publishes the new circle, with Ben under the line now.
    const at = nowS();
    ranks = [rankOf(me, 100, { hops: 0, at }), rankOf(ANA, 87.37, { hops: 1, at }), rankOf(BEN, 3.71, { hops: 2, at })];
    brainstorm.latestRun.mockResolvedValue(run("done"));
    await after(POLL_MS);
    await waitFor(() => expect(jacafe()).toHaveTextContent(copy.score.ratedByCircle(1)));
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
    // Away from the Why page, the bar says so. My circle is the view: its half carries no check.
    await waitFor(() => expect(barRegion()).toHaveTextContent(copy.why.updated));
    expect(within(screen.getByRole("group", { name: copy.view.label })).getByRole("button", { name: copy.view.circle }).querySelector("svg")).toBeNull();

    // Back on the page: it says so, and counts the new circle; the bar, which would say it twice, goes.
    await act(() => router.navigate(WHY_PATH));
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updated));
    expect(barRegion()).toBeEmptyDOMElement();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`1 ${copy.why.inYourCircle(1)}`));
    // Said there, it is not said again on the next page.
    await act(() => router.navigate("/"));
    expect(barRegion()).toBeEmptyDOMElement();
  });

  it("leaves an unconfirmed circle unconfirmed while it is updated, and confirms it once the run is done", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    window.sessionStorage.setItem(CIRCLE_KEY, JSON.stringify({ pubkey: me, state: "unconfirmed", scorer: SCORER_AT }));
    const kept = () => JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "{}") as { state?: string };
    await openWhy();
    expect(await within(await findCirclePanel()).findByRole("heading", { name: copy.why.emptyTitle })).toBeInTheDocument();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    brainstorm.latestRun.mockResolvedValue(run("running"));
    await after(POLL_MS);
    expect(kept().state).toBe("unconfirmed");

    const at = nowS();
    ranks = circleOf(me).map((ev) => ({ ...ev, created_at: at }));
    brainstorm.latestRun.mockResolvedValue(run("done"));
    await after(POLL_MS);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updated));
    await waitFor(() => expect(kept().state).toBe("ready"));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
  });

  it.each([
    ["the circle was updated recently", "recently"],
    ["the circle couldn't be updated", "failed"],
  ] as const)("says no more that %s once the person has left the page (ruling R13)", async (_, outcome) => {
    const me = signedIn();
    saveToken(me, TOKEN);
    if (outcome === "recently") brainstorm.startRun.mockResolvedValue({ recently: true });
    else brainstorm.startRun.mockRejectedValue(new client.Unavailable());
    const { router } = await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(outcome === "recently" ? copy.circle.recently : copy.why.updateFailed));

    await act(() => router.navigate("/about"));
    await act(() => router.navigate(WHY_PATH));
    await waitFor(() => expect(circlePanel()).toHaveTextContent(copy.why.inYourCircle(4)));
    expect(updateStatus()).toHaveTextContent("");
    expect(updateNow()).toBeEnabled();
  });

  it.each([
    // Done at the first poll.
    ["done", copy.why.updated, true, () => brainstorm.latestRun.mockResolvedValue(run("done"))],
    // Brainstorm would not start one: at once.
    ["one Brainstorm made lately", copy.circle.recently, false, () => brainstorm.startRun.mockResolvedValue({ recently: true })],
  ] as const)(
    "shows the check on My circle's half for a moment once the run is %s, and says it on the page, not again in the bar",
    async (_, line, polled, setUp) => {
      const me = signedIn();
      saveToken(me, TOKEN);
      await openCounted(me);
      setUp();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      const half = within(toggle()).getByRole("button", { name: copy.view.circle });
      expect(half.querySelector("svg")).toBeNull();
      await user.click(updateNow());
      if (polled) await after(POLL_MS);
      await waitFor(() => expect(updateStatus()).toHaveTextContent(line));
      // The check, in the trust green; the half's name stays as it is, and the page's status says it, once.
      expect(half.querySelector("svg")).toHaveClass("text-trust", "animate-check", "motion-reduce:animate-none");
      expect(half).toHaveAccessibleName(copy.view.circle);
      expect(half).toBeEnabled();
      expect(barRegion()).toBeEmptyDOMElement();
      expect(screen.getAllByText(line)).toHaveLength(1);
      await after(CHECK_MS);
      await waitFor(() => expect(half.querySelector("svg")).toBeNull());
      expect(half).toHaveTextContent(/^My circle$/);
    },
  );

  it("says nothing in the bar, nor on the half, while the run is followed: the page says it", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    await openCounted(me);
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    const half = within(toggle()).getByRole("button", { name: copy.view.circle });
    expect(half).toBeEnabled();
    expect(half.querySelector("svg")).toBeNull();
    expect(barRegion()).toBeEmptyDOMElement();
  });

  it("starts one run for one tap of Update now in React's strict mode (ruling R13)", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    brainstorm.latestRun.mockResolvedValue(run("done", { daysAgo: 1 }));
    await openApp(WHY_PATH, { events: fixtures, readers, strict: true });
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    await after(POLL_MS * 3);
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
  });

  it("asks Brainstorm nothing after a reload in the middle of an update: the reload ends its following, not its run (ruling R13)", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    const first = await openCounted(me);
    brainstorm.latestRun.mockResolvedValue(run("running"));
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);

    // The tab is reloaded.
    first.unmount();
    for (const call of [brainstorm.scorerOf, brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) call.mockClear();
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    await after(POLL_MS * 3);
    for (const call of [brainstorm.scorerOf, brainstorm.signInToBrainstorm, brainstorm.latestRun, brainstorm.startRun]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(updateStatus()).toHaveTextContent("");
    expect(JSON.parse(window.sessionStorage.getItem(CIRCLE_KEY) ?? "{}")).toMatchObject({ state: "ready" });
  });

  it("keeps following across the switch between the phone's layout and the desktop's", async () => {
    const me = signedIn();
    saveToken(me, TOKEN);
    await openCounted(me);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(updateNow());
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updating));
    brainstorm.latestRun.mockResolvedValue(run("running"));

    act(() => resizeTo(DESKTOP));
    await waitFor(() => expect(screen.getByRole("complementary")).toBeInTheDocument());
    expect(updateStatus()).toHaveTextContent(copy.why.updating);
    await after(POLL_MS);
    expect(brainstorm.latestRun).toHaveBeenLastCalledWith(TOKEN, expect.any(AbortSignal));

    brainstorm.latestRun.mockResolvedValue(run("done"));
    act(() => resizeTo(390));
    await after(POLL_MS);
    await waitFor(() => expect(updateStatus()).toHaveTextContent(copy.why.updated));
    expect(brainstorm.startRun).toHaveBeenCalledTimes(1);
  });
});

describe("opening the page starts nothing: only the person's tap does", () => {
  it.each([
    ["no token", "none"],
    ["a token", "valid"],
    ["a token Brainstorm refuses", "expired"],
  ] as const)("with %s in the tab, it asks for no sign-in and starts no run", async (_, token) => {
    const me = signedIn();
    ready(me);
    ranks = circleOf(me);
    if (token !== "none") saveToken(me, TOKEN);
    if (token === "expired") brainstorm.latestRun.mockRejectedValue(new client.TokenExpired());
    else brainstorm.latestRun.mockResolvedValue(run("done", { daysAgo: 1 }));
    brainstorm.signInToBrainstorm.mockImplementation(() => {
      throw new Error("Opening the page must not sign anyone in to Brainstorm");
    });
    brainstorm.startRun.mockImplementation(() => {
      throw new Error("Opening the page must not start a run");
    });
    await openWhy();
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    await after(POLL_MS * 3);
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
    expect(updateStatus()).toHaveTextContent("");
  });

  it("in React's strict mode, with every effect run twice, as well", async () => {
    const me = signedIn();
    ready(me);
    saveToken(me, TOKEN);
    ranks = circleOf(me);
    brainstorm.latestRun.mockResolvedValue(run("done", { daysAgo: 1 }));
    brainstorm.startRun.mockImplementation(() => {
      throw new Error("Opening the page must not start a run");
    });
    await openApp(WHY_PATH, { events: fixtures, readers, strict: true });
    await waitFor(() => expect(circlePanel()).toHaveTextContent(`4 ${copy.why.inYourCircle(4)}`));
    await after(POLL_MS * 3);
    expect(brainstorm.signInToBrainstorm).not.toHaveBeenCalled();
    expect(brainstorm.startRun).not.toHaveBeenCalled();
  });
});

describe("counting the circle", () => {
  const ME = hex64("9");
  const reader = (events: NostrEvent[]) => createMemoryReader(events);

  it("pages back through the scorer's ranks until a page is not full, and is exact", async () => {
    // 1,200 people, one a second, 7 in 12 at or above the line (4 of those 7 trusted directly).
    const events = Array.from({ length: 1200 }, (_, i) =>
      rankOf(`${i.toString(16).padStart(4, "0")}${"0".repeat(60)}`, i % 12 < 7 ? 40 : 3, { hops: i % 2 === 0 ? 1 : 2, at: 1_800_000_000 - i }),
    );
    const memory = reader(events);
    const counted = await countRanks(memory, SCORER, ME, 5, new AbortController().signal);
    expect(counted.size).toEqual({ kind: "exact", total: 700, direct: 400, further: 300 });
    expect(counted.newest).toBe(1_800_000_000);
    expect(memory.requests.length).toBe(3);
    expect(memory.requests.every((filter) => filter.limit === RANK_PAGE)).toBe(true);
  });

  it("gives a floor, not a count, when a full page gets no further back in time", async () => {
    const events = Array.from({ length: 800 }, (_, i) => rankOf(`${i.toString(16).padStart(4, "0")}${"1".repeat(60)}`, 40, { hops: 1, at: 1_800_000_000 }));
    const counted = await countRanks(reader(events), SCORER, ME, 5, new AbortController().signal);
    expect(counted.size).toEqual({ kind: "atLeast", n: 500 });
  });

  it(`reads at most ${RANK_PAGES} pages, and gives a floor past them`, async () => {
    const events = Array.from({ length: RANK_PAGE * RANK_PAGES + 10 }, (_, i) =>
      rankOf(`${i.toString(16).padStart(5, "0")}${"2".repeat(59)}`, 40, { at: 1_800_000_000 - i }),
    );
    const memory = reader(events);
    const counted = await countRanks(memory, SCORER, ME, 5, new AbortController().signal);
    expect(memory.requests).toHaveLength(RANK_PAGES);
    expect(counted.size.kind).toBe("atLeast");
  });

  it("reads the run's counts as a floor: tiers wholly at or above the line, past the person", () => {
    const values = JSON.stringify({
      high: { "0": 1, "1": 2, "2": 3 },
      medium_high: { "1": 10 },
      medium: { "2": 100 },
      medium_low: { "1": 1000 },
      low: { "1": 10000 },
    });
    expect(floorFromRun(values, 5)).toBe(115);
    expect(floorFromRun(values, 8)).toBe(15);
    expect(floorFromRun(values, 21)).toBe(5);
    expect(floorFromRun(values, 51)).toBe(0);
    for (const unreadable of [null, "", "[]", "{", '{"high":7}', '{"high":{"1":"many"}}']) {
      expect(floorFromRun(unreadable, 5)).toBe(0);
    }
  });
});
