import type { NostrEvent } from "@nostrify/nostrify";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { get, set } from "idb-keyval";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "../src/account/AccountProvider";
import * as client from "../src/circle/brainstorm";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { changeFollow, type FollowOutcome, putBackList } from "../src/follow/change";
import { KeptCopies } from "../src/follow/KeptCopies";
import { CopiesContext, OwnCopies, type OwnSession, type PutBackOf, usePutBack } from "../src/follow/keptStore";
import { keepCopy, type KeptFor, keptCopies } from "../src/follow/kept";
import { YouPage } from "../src/you/YouPage";
import { FOLLOW_LIST_TIME, pubkeyAt } from "./fixtures/follow-list";
import { asksFirst, installAddOn, openPageInShell, signedInAs, signedInNow, tapSession } from "./support/followPage";
import { endScene, type Logs, person, startScene } from "./support/followScene";
import { asksForList, everywhere, FOLLOW_RELAYS, relay } from "./support/followWorld";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import {
  ANA,
  FLO,
  followButton,
  followingButton,
  listReads,
  main,
  MAYA,
  MAYA_LIST,
  MAYA_LIST_WITH_SOL,
  MAYA_SECRET,
  newestOn,
  open,
  scene,
  type Scene,
  SOL,
  SOL_PATH,
} from "./support/personScene";
import { profileOf, rankOf } from "./support/reviewWorld";

/*
 * The copies kept of who a person follows, on their own page (src/follow/KeptCopies.tsx, on You):
 * the list as it was before each change they made in this browser, with the way to put one back.
 * These hold the section to when it is there at all (signed in, Follow open, a copy to show, and the
 * device's storage read for nothing else), to what each row says, to asking before it replaces a
 * list, to the one press that does, and to what that leaves: the person's list on the relays as the
 * copy has it, and every Follow button showing from it.
 *
 * It is the real page at its own address, over relays held in memory, with the real change and the
 * real putting back, each mocked around the real one so that a test can count it, or play its end.
 * The device's storage is the one tests have (tests/setup.ts). Brainstorm's client is mocked, the
 * keys are thrown away, and nothing opens a socket.
 */

vi.mock("../src/follow/change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/change")>();
  return { ...actual, changeFollow: vi.fn(actual.changeFollow), putBackList: vi.fn(actual.putBackList) };
});
const change = vi.mocked(changeFollow);
const putBack = vi.mocked(putBackList);

vi.mock("../src/follow/kept", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/kept")>();
  return { ...actual, keepCopy: vi.fn(actual.keepCopy), keptCopies: vi.fn(actual.keptCopies) };
});
/** Each read of a person's copies from the device's storage, and each copy kept in it. */
const storageReads = vi.mocked(keptCopies);
const storageWrites = vi.mocked(keepCopy);

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);

/** When the copies here were kept, in seconds: a morning in March, in Greenwich, as the tests' clock is. */
const KEPT_AT = Date.UTC(2027, 2, 4, 9, 5, 0) / 1000;
/** That time as the page writes it for a browser in American English, whatever space the language puts before AM. */
const KEPT_WHEN = /^March 4, 2027 at 9:05\sAM$/;

/** A list of Maya's with `tags`, made `at` seconds after her first. */
const listOf = (tags: string[][], at: number) => finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + at, content: "", tags }, MAYA_SECRET);

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** Keeps `list` for `pubkey` in this browser, as a change of theirs did earlier: `at` seconds after `KEPT_AT`. */
async function kept(list: NostrEvent, why: KeptFor, at = 0, pubkey = MAYA): Promise<void> {
  expect(await keepCopy(pubkey, asSent(list), why, KEPT_AT + at)).toBe(true);
  storageWrites.mockClear();
  storageReads.mockClear();
}

/** The section, once it is on the page: its code is fetched when there is a copy to show. */
const section = () => screen.findByRole("region", { name: copy.follow.keptHeading });
/** The section, when the page has it. */
const sectionNow = () => screen.queryByRole("region", { name: copy.follow.keptHeading });
/** The copies' rows, in the order the page lists them. */
const rows = (part: HTMLElement) => within(part).getAllByRole("listitem");
/** What each row says its copy was kept before. */
const befores = (part: HTMLElement) => rows(part).map((row) => row.querySelector("p")!.textContent);
const putBackWord = (row: HTMLElement) => within(row).getByRole("button", { name: copy.follow.putBack });
const keepButton = (part: HTMLElement) => within(part).getByRole("button", { name: copy.follow.keepAsItIs });
const putItBackButton = (part: HTMLElement) => within(part).getByRole("button", { name: copy.follow.putItBack });
/** The asking, when a row has one open. */
const asking = (part: HTMLElement) => within(part).queryByRole("group", { name: copy.follow.putBackQuestion });
/** A row's polite status: what the last putting back of its copy came to. It is there for as long as the row is. */
const statusOf = (row: HTMLElement) => within(row).getByRole("status");
/** What the section says the last putting back came to, politely, in whichever row; nothing while it has nothing to say. */
const saidIn = (part: HTMLElement) =>
  within(part)
    .getAllByRole("status")
    .map((each) => each.textContent)
    .join("");
/** The row that says so, when one does. */
const rowSaying = (part: HTMLElement) => rows(part).find((row) => statusOf(row).textContent !== "");
/** The section's heading. */
const headingOf = (part: HTMLElement) => within(part).getByRole("heading", { level: 2, name: copy.follow.keptHeading });
/** The section's own polite status, at its head: the one that is in no row. It is there for as long as the section is. */
const headStatus = (part: HTMLElement) => within(part).getAllByRole("status").find((each) => each.closest("li") === null)!;

/** Maya's page, You, over relays that hold `lists` of hers. She is signed in unless a test says not. */
async function openYou(lists: NostrEvent[], opts: { signedIn?: boolean; strict?: boolean } = {}) {
  const addOn = opts.signedIn === false ? installAddOn(MAYA_SECRET) : signedInAs(MAYA_SECRET);
  const s = scene({ follows: lists });
  const app = await open(s, "/you", { strict: opts.strict });
  return { ...app, s, addOn };
}

/** The putting back a test plays in place of the real one: it goes on until the test ends it. */
function nextPutBack() {
  let resolve!: (outcome: FollowOutcome) => void;
  let reject!: (error: unknown) => void;
  putBack.mockImplementationOnce(
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
}

/** How many times each follow-list relay was asked for a follow list of Maya's, in their order. */
const reads = (s: Scene) => listReads(s.follows);

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
  putBack.mockReset();
  storageReads.mockClear();
  storageWrites.mockClear();
});

afterEach(() => endScene(logs));

// ---------------------------------------------------------------------------------------------

describe("when the section is not there", () => {
  it("is not on You for someone signed out, and the device's storage is not read, though it holds copies", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });

    await openYou([MAYA_LIST_WITH_SOL], { signedIn: false });

    expect(await within(main()).findByText(copy.you.signedOut)).toBeInTheDocument();
    expect(sectionNow()).not.toBeInTheDocument();
    expect(main()).not.toHaveTextContent(copy.follow.putBack);
    expect(storageReads).not.toHaveBeenCalled();
  });

  it("is not on You with Follow off, for a person signed in whose copies are kept here, and the storage is not read", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    config.features.follow = false;

    const { s } = await openYou([MAYA_LIST_WITH_SOL]);
    await screen.findByRole("heading", { level: 1, name: "Maya" });
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(sectionNow()).not.toBeInTheDocument();
    expect(main()).not.toHaveTextContent(/cop(?:y|ies)/i);
    expect(storageReads).not.toHaveBeenCalled();
    expect(putBack).not.toHaveBeenCalled();
    expect(s.follows.asked()).toEqual([]);
    config.features.follow = true;
  });

  it("is not on You for a person signed in with no copy kept: nothing of it is drawn, and nothing else on the page has moved", async () => {
    const { s } = await openYou([MAYA_LIST]);
    await screen.findByRole("heading", { level: 1, name: "Maya" });
    await waitFor(() => expect(storageReads).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(sectionNow()).not.toBeInTheDocument();
    expect(main()).not.toHaveTextContent(copy.follow.keptHeading);
    expect(storageReads).toHaveBeenCalledWith(MAYA);
    // The page's own things are there as ever, and the page asks no relay for her list: it shows none.
    expect(within(main()).getByRole("link", { name: copy.you.yourReviews })).toBeInTheDocument();
    expect(within(main()).getByRole("button", { name: copy.you.signOut })).toBeInTheDocument();
    expect(reads(s)).toEqual([0, 0, 0]);
  });

  it("shows nothing of copies that are another person's, kept in the same browser", async () => {
    const other = generateSecretKey();
    const theirs = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", SOL]] }, other);
    await kept(theirs, { did: "follow", who: SOL }, 0, getPublicKey(other));

    await openYou([MAYA_LIST]);
    await waitFor(() => expect(storageReads).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(sectionNow()).not.toBeInTheDocument();
    expect(storageReads.mock.calls).toEqual([[MAYA]]);
  });

  it("reads the device's storage for no other page: a person's page has a Follow button, and no copies were read for it", async () => {
    signedInAs(MAYA_SECRET);
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const s = scene({ follows: [MAYA_LIST_WITH_SOL] });

    await open(s, SOL_PATH);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());

    expect(storageReads).not.toHaveBeenCalled();
    expect(sectionNow()).not.toBeInTheDocument();
  });
});

describe("the copies, on You", () => {
  it("is there for a person signed in with a copy kept, under the page's settings: its heading, what the copies are, and a row", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });

    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);

    const part = await section();
    expect(within(part).getByRole("heading", { level: 2, name: copy.follow.keptHeading })).toBeInTheDocument();
    expect(within(part).getByText(copy.follow.keptAbout)).toBeInTheDocument();
    expect(rows(part)).toHaveLength(1);
    const [row] = rows(part);
    // Until their name is read they are someone, as anyone the app has no name for is.
    expect(befores(part)[0]).toMatch(/^Before you followed (?:someone|Sol)$/);
    await waitFor(() => expect(befores(part)).toEqual(["Before you followed Sol"]));
    // Whom, by the name their profile gives, kept apart from the line's direction; never by a code.
    expect(row!.querySelector("bdi")).toHaveTextContent(/^Sol$/);
    // When, in the browser's language, with the time of day.
    const when = row!.querySelector("time")!;
    expect(when.textContent).toMatch(KEPT_WHEN);
    expect(when).toHaveAttribute("datetime", "2027-03-04T09:05:00.000Z");
    // And the way to put it back: a word, 44 px to tap, said with what the copy is.
    const word = putBackWord(row!);
    expect(word).toHaveClass("min-h-touch", "min-w-touch");
    expect(word).toHaveAccessibleDescription(/^Before you followed Sol March 4, 2027 at 9:05\sAM$/);
    // It comes after everything else on the page: nothing above it moves when it comes in.
    const darkMode = within(main()).getByRole("switch", { name: copy.nav.darkMode });
    expect(darkMode.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Drawing it read the storage once, and asked no relay for her list; nothing was signed or sent.
    expect(storageReads.mock.calls).toEqual([[MAYA]]);
    expect(reads(s)).toEqual([0, 0, 0]);
    expect(putBack).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("says what each copy was kept before, the newest first, and names nobody by a code", async () => {
    const ARABIC = pubkeyAt(30_009);
    const lists = [0, 1, 2, 3, 4, 5].map((at) => listOf([["p", pubkeyAt(at)]], at));
    await kept(lists[0]!, { did: "follow", who: SOL }, 0);
    await kept(lists[1]!, { did: "unfollow", who: ANA }, 60);
    await kept(lists[2]!, { did: "undo", who: ANA }, 120);
    await kept(lists[3]!, { did: "put-back" }, 180);
    // Someone the app has no name for, and someone whose name is in another script.
    await kept(lists[4]!, { did: "follow", who: FLO }, 240);
    await kept(lists[5]!, { did: "unfollow", who: ARABIC }, 300);
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [lists[5]!] });
    s.search.held.push(profileOf(ANA, "Ana"), profileOf(ARABIC, "ليلى"));
    await open(s, "/you");

    const part = await section();
    await waitFor(() => expect(befores(part)).toContain("Before you unfollowed Ana"));

    expect(befores(part)).toEqual([
      "Before you unfollowed ليلى",
      "Before you followed someone",
      copy.follow.keptBeforePutBack,
      copy.follow.keptBeforeUndo,
      "Before you unfollowed Ana",
      "Before you followed Sol",
    ]);
    expect(copy.follow.keptBeforePutBack).toBe("Before a copy was put back");
    expect(copy.follow.keptBeforeUndo).toBe("Before an Undo");
    // A name in another script is marked as such, and kept apart from the line's direction.
    expect(rows(part)[0]!.querySelector("bdi")).toHaveAttribute("lang", "ar");
    // Each has its time, a minute apart, the newest first.
    expect(rows(part).map((row) => row.querySelector("time")!.getAttribute("datetime"))).toEqual(
      [300, 240, 180, 120, 60, 0].map((at) => new Date((KEPT_AT + at) * 1000).toISOString()),
    );
    // Nobody is named by a key, in any spelling of one: not in the text, nor in what a screen reader hears.
    expect(part.textContent).not.toMatch(/[0-9a-f]{16}|npub1/i);
    for (const element of part.querySelectorAll("*")) {
      for (const attribute of ["aria-label", "aria-description", "title"]) expect(element.getAttribute(attribute) ?? "").not.toMatch(/[0-9a-f]{16}|npub1/i);
    }
  });

  it("lists nothing kept at a time no date can hold, should the storage hold such a copy, and the page stands: the copies around it are listed", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    // As something else that writes to the storage might leave it: a copy of hers at a time that is none.
    const place = `regulars.follow.kept.${MAYA}`;
    const held = (await get(place)) as unknown[];
    await set(place, [{ list: asSent(MAYA_LIST_WITH_SOL), at: Number.MAX_SAFE_INTEGER, for: { did: "unfollow", who: SOL } }, ...held]);

    await openYou([MAYA_LIST_WITH_SOL]);

    const part = await section();
    await waitFor(() => expect(befores(part)).toEqual(["Before you followed Sol"]));
    expect(rows(part)[0]!.querySelector("time")).toHaveAttribute("datetime", "2027-03-04T09:05:00.000Z");
    expect(rows(part)[0]!.querySelector("time")!.textContent).toMatch(KEPT_WHEN);
  });

  it("shows no number about anyone: not how many people a copy holds, nor anyone's rank", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    await kept(MAYA_LIST_WITH_SOL, { did: "unfollow", who: ANA }, 60);
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST_WITH_SOL] });
    s.search.held.push(profileOf(ANA, "Ana"));
    s.house.ranks.push(rankOf(SOL, 87.37), rankOf(ANA, 64.2));
    await open(s, "/you");
    const part = await section();
    await waitFor(() => expect(befores(part)).toContain("Before you unfollowed Ana"));

    expectNoNumbersAboutPeople([87.37, 64.2]);
    // Nor a count of the people a copy holds, of 1,200 entries or of 1,201: the only digits are a date's and a time's.
    const digits = (part.textContent ?? "").replace(/March 4, 2027 at 9:0[56]\sAM/g, "");
    expect(digits).not.toMatch(/\d/);

    // The same while a row asks, and once a copy has been put back.
    const user = person();
    await user.click(putBackWord(rows(part)[1]!));
    expectNoNumbersAboutPeople([87.37, 64.2]);
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    expectNoNumbersAboutPeople([87.37, 64.2]);
    expect(saidIn(part) + befores(part).join(" ")).not.toMatch(/\d/);
  });

  it("is read once in React's strict mode, and nothing is put back by an effect that runs twice", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });

    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL], { strict: true });
    const part = await section();
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(rows(part)).toHaveLength(1);
    expect(storageReads).toHaveBeenCalledTimes(1);
    expect(putBack).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("lists a copy kept by a follow made on another page, once the person is back on You", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    const user = person();
    const { router } = await open(s, SOL_PATH);
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    expect(storageReads).not.toHaveBeenCalled();

    await user.click(followButton()!);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    await act(() => router.navigate("/you"));

    const part = await section();
    expect(befores(part)).toEqual(["Before you followed Sol"]);
    // The copy is the list the follow was built on, as the relays sent it.
    expect((await keptCopies(MAYA)).map((each) => each.list)).toEqual([asSent(MAYA_LIST)]);
  });
});

describe("asking first", () => {
  /** Maya's You page, with one copy: her list before she followed Sol, whom the list on the relays names. */
  async function withOneCopy() {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const app = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    return { ...app, part, user: person() };
  }

  it("shows the asking in place of Put back, with the focus on Keep my list as it is, and changes nothing", async () => {
    const { part, user, s, addOn } = await withOneCopy();
    const [row] = rows(part);

    await user.click(putBackWord(row!));

    // In its row, in place of the word: what it does and what it loses, and its two answers.
    const group = asking(part)!;
    expect(row).toContainElement(group);
    expect(within(row!).queryByRole("button", { name: copy.follow.putBack })).not.toBeInTheDocument();
    expect(group).toHaveTextContent("Putting this back replaces your list as it is now. Anyone you have followed since, here or in another app, would be lost.");
    expect(keepButton(group)).toHaveFocus();
    expect(putItBackButton(group)).toBeInTheDocument();
    // Both 44 px tall, and the answer that changes nothing comes first.
    for (const button of [keepButton(group), putItBackButton(group)]) expect(button).toHaveClass("h-11");
    expect(keepButton(group).compareDocumentPosition(putItBackButton(group)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing was asked of anyone: no list read, nothing kept, signed or sent.
    expect(putBack).not.toHaveBeenCalled();
    expect(storageWrites).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(reads(s)).toEqual([0, 0, 0]);
    expect(s.follows.published()).toEqual([]);
    expect(saidIn(part)).toBe("");
  });

  it("goes away on Keep my list as it is, with the focus back on Put back, and nothing changed", async () => {
    const { part, user, s } = await withOneCopy();
    await user.click(putBackWord(rows(part)[0]!));

    await user.click(keepButton(part));

    expect(asking(part)).not.toBeInTheDocument();
    expect(putBackWord(rows(part)[0]!)).toHaveFocus();
    expect(putBack).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
    expect(saidIn(part)).toBe("");
  });

  it.each(["Keep my list as it is", "Put it back"])("goes away on Escape, with the focus on %s, and the focus is back on Put back", async (focused) => {
    const { part, user, s } = await withOneCopy();
    await user.click(putBackWord(rows(part)[0]!));
    within(part).getByRole("button", { name: focused }).focus();

    await user.keyboard("{Escape}");

    expect(asking(part)).not.toBeInTheDocument();
    expect(putBackWord(rows(part)[0]!)).toHaveFocus();
    expect(putBack).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("opens by the keyboard too, and Tab goes from Keep my list as it is to Put it back", async () => {
    const { part, user } = await withOneCopy();
    putBackWord(rows(part)[0]!).focus();

    await user.keyboard("{Enter}");
    expect(keepButton(part)).toHaveFocus();
    await user.tab();

    expect(putItBackButton(part)).toHaveFocus();
    expect(putBack).not.toHaveBeenCalled();
  });

  it("has a polite status in every row from the start, empty until there is something to say of that row's copy", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    await kept(MAYA_LIST_WITH_SOL, { did: "unfollow", who: SOL }, 60);
    await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();

    // One for each row, and the section's own at its head, there before anything is said, so that a
    // screen reader hears a line as it comes.
    expect(within(part).getAllByRole("status")).toHaveLength(3);
    for (const row of rows(part)) expect(statusOf(row)).toBeEmptyDOMElement();
    expect(headStatus(part)).toBeEmptyDOMElement();
    expect(headStatus(part).compareDocumentPosition(rows(part)[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const older = rows(part)[1]!;
    const itsStatus = statusOf(older);

    await user.click(putBackWord(older));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));

    // The very element that was there, in the row of the copy that was put back: no other row says anything.
    expect(itsStatus).toHaveTextContent(copy.follow.putBackDone);
    expect(older).toContainElement(itsStatus);
    expect(rows(part).filter((row) => statusOf(row).textContent !== "")).toEqual([older]);
    expect(within(part).getAllByRole("status")).toHaveLength(rows(part).length + 1);
    // The section's own says nothing while the copy's row is there to say it.
    expect(headStatus(part)).toBeEmptyDOMElement();
  });

  it("asks in one row at a time: Put back in another row moves the asking there", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    await kept(MAYA_LIST_WITH_SOL, { did: "unfollow", who: SOL }, 60);
    await openYou([MAYA_LIST]);
    const part = await section();
    const user = person();
    const [newer, older] = rows(part);

    await user.click(putBackWord(older!));
    expect(older).toContainElement(asking(part));
    await user.click(putBackWord(newer!));

    expect(within(part).getAllByRole("group")).toHaveLength(1);
    expect(newer).toContainElement(asking(part));
    expect(putBackWord(older!)).toBeInTheDocument();
    expect(keepButton(part)).toHaveFocus();
    expect(putBack).not.toHaveBeenCalled();
  });

  it("takes the second click of a double click for no answer: neither a yes nor a no", async () => {
    const { part, user } = await withOneCopy();
    await user.click(putBackWord(rows(part)[0]!));

    // As a browser sends the second click of a double click to whatever is under the pointer by then.
    fireEvent.click(putItBackButton(part), { detail: 2 });
    fireEvent.click(keepButton(part), { detail: 2 });

    expect(asking(part)).toBeInTheDocument();
    expect(putBack).not.toHaveBeenCalled();
  });

  it("makes no press of a key held down on Put back: the asking opens, and the key still down answers nothing", async () => {
    const { part, user, s } = await withOneCopy();
    putBackWord(rows(part)[0]!).focus();

    await user.keyboard("{Enter>6/}");

    // Open still, with the focus on the answer that changes nothing, and nothing asked for.
    expect(asking(part)).toBeInTheDocument();
    expect(keepButton(part)).toHaveFocus();
    expect(putBack).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("makes one press of a key held down on Keep my list as it is: closed, it is not opened again by the key still down", async () => {
    const { part, user } = await withOneCopy();
    await user.click(putBackWord(rows(part)[0]!));
    expect(keepButton(part)).toHaveFocus();

    await user.keyboard("{Enter>6/}");

    expect(asking(part)).not.toBeInTheDocument();
    expect(putBackWord(rows(part)[0]!)).toHaveFocus();
    expect(putBack).not.toHaveBeenCalled();
  });
});

describe("putting a copy back", () => {
  it("replaces the list on the relays with the copy, entry for entry, on Put it back, and says so", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();

    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    expect(copy.follow.putBackDone).toBe("Your list is as it was then.");
    // One putting back, of that copy, signed once: and the list every relay holds is the copy's, whole.
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(putBack.mock.calls[0]![1]).toEqual(asSent(MAYA_LIST));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) {
      const now = newestOn(s.follows, url)!;
      expect(JSON.stringify(now.tags)).toBe(JSON.stringify(MAYA_LIST.tags));
      expect(now.content).toBe(MAYA_LIST.content);
      expect(now.created_at).toBeGreaterThan(MAYA_LIST_WITH_SOL.created_at);
      expect(s.follows.relays[url]!.writer.published).toHaveLength(1);
    }
    // The asking is gone, with no Try again: there is nothing to try.
    expect(asking(part)).not.toBeInTheDocument();
    expect(within(part).queryByRole("button", { name: copy.follow.tryAgain })).not.toBeInTheDocument();
    // The list that was replaced was kept first, and is the newest copy: putting back can be put back.
    await waitFor(() => expect(befores(part)).toEqual([copy.follow.keptBeforePutBack, "Before you followed Sol"]));
    const copies = await keptCopies(MAYA);
    expect(copies.map((each) => [each.list.id, each.for.did])).toEqual([
      [MAYA_LIST_WITH_SOL.id, "put-back"],
      [MAYA_LIST.id, "follow"],
    ]);
    expect(copies[0]!.list).toEqual(asSent(MAYA_LIST_WITH_SOL));
  });

  it("says Saving… on the button while it is saved, which keeps the focus, and every Put back is off meanwhile", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    await kept(MAYA_LIST_WITH_SOL, { did: "unfollow", who: SOL }, 60);
    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    const asked = asksFirst(addOn, MAYA_SECRET);

    await user.click(putBackWord(rows(part)[1]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    // The same asking, in the same row, its button saying so: off, not gone.
    const saving = within(asking(part)!).getByRole("button", { name: copy.follow.saving });
    expect(rows(part)[1]).toContainElement(saving);
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(saving).toHaveFocus();
    expect(keepButton(part)).toHaveAttribute("aria-disabled", "true");
    expect(putBackWord(rows(part)[0]!)).toHaveAttribute("aria-disabled", "true");
    // A press on any of them, or Escape, does nothing while it is saved.
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(keepButton(part));
    await user.click(saving);
    await user.keyboard("{Escape}");
    expect(saving).toHaveFocus();
    expect(asking(part)).toBeInTheDocument();
    expect(within(part).getAllByRole("group")).toHaveLength(1);
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(s.follows.published()).toEqual([]);

    await asked.yes();
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    // The button it was on has gone, and Put back is in its row again: the focus is on that, a control
    // the person can see it on, and the row says under it what came of the putting back.
    expect(asking(part)).not.toBeInTheDocument();
    const row = rowSaying(part)!;
    expect(befores(part)[rows(part).indexOf(row)]).toBe("Before you followed Sol");
    expect(putBackWord(row)).toHaveFocus();
    expect(statusOf(row)).toHaveTextContent(copy.follow.putBackDone);
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("leaves the focus where the person has put it meanwhile: it is moved only when the asking goes with the focus in it", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    const asked = asksFirst(addOn, MAYA_SECRET);
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));
    // While it is saved, the person goes to another control on the page.
    const signOut = within(main()).getByRole("button", { name: copy.you.signOut });
    signOut.focus();

    await asked.yes();
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));

    expect(signOut).toHaveFocus();
  });

  it("makes one putting back for Enter held down on Put it back: the key, still down once it has ended, puts nothing back again", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    await user.click(putBackWord(rows(part)[0]!));
    putItBackButton(part).focus();

    await user.keyboard("{Enter>6/}");

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    await user.keyboard("{Enter>6/}");
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) expect(s.follows.relays[url]!.writer.published).toHaveLength(1);
  });

  it("is what every Follow button shows from after: the person the copy does not name is not followed, and no list is read again for it", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, router } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    // The putting back read the list afresh, and read it back: and that is all.
    expect(reads(s)).toEqual([2, 2, 2]);

    await act(() => router.navigate(SOL_PATH));

    // She followed Sol when the page was opened; the copy is from before that.
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    expect(followingButton()).not.toBeInTheDocument();
    expect(reads(s)).toEqual([2, 2, 2]);
    // And a follow from there is built on the list that was put back.
    await user.click(followButton()!);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual([...MAYA_LIST.tags, ["p", SOL]]);
  });

  it("can itself be put back: the list that was replaced is the newest copy, and putting that back brings it again", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(befores(part)).toEqual([copy.follow.keptBeforePutBack, "Before you followed Sol"]));

    await user.click(putBackWord(rows(part)[0]!));
    // What the last one came to has been heard: it is not said beside a new asking.
    expect(saidIn(part)).toBe("");
    await user.click(putItBackButton(part));

    await waitFor(() => expect(befores(part)).toHaveLength(3));
    expect(saidIn(part)).toBe(copy.follow.putBackDone);
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual(MAYA_LIST_WITH_SOL.tags);
    expect(putBack).toHaveBeenCalledTimes(2);
  });

  it("says the list is already so, and signs nothing, when the list on the relays is the copy's", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, addOn } = await openYou([MAYA_LIST]);
    const part = await section();
    const user = person();

    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackAlready));
    expect(copy.follow.putBackAlready).toBe("Your list is already as it was then.");
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
    expect(within(part).queryByRole("button", { name: copy.follow.tryAgain })).not.toBeInTheDocument();
    expect(asking(part)).not.toBeInTheDocument();
  });

  it("goes on while the person is on another page, and shows its asking again, still saving, when they come back", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { addOn, router } = await openYou([MAYA_LIST_WITH_SOL]);
    const user = person();
    const asked = asksFirst(addOn, MAYA_SECRET);
    await user.click(putBackWord(rows(await section())[0]!));
    await user.click(putItBackButton(await section()));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    await act(() => router.navigate("/about"));
    expect(sectionNow()).not.toBeInTheDocument();
    await act(() => router.navigate("/you"));

    // Drawn anew for a putting back under way: its asking, saving, and nothing has taken the focus for it.
    const part = await section();
    const saving = within(asking(part)!).getByRole("button", { name: copy.follow.saving });
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(part).not.toContainElement(document.activeElement as HTMLElement);

    await asked.yes();
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    expect(putBack).toHaveBeenCalledTimes(1);
  });

  it("says nothing of one that ended while the person was on another page, once they are back: coming to the page is leaving another", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { addOn, router, s } = await openYou([MAYA_LIST_WITH_SOL]);
    const user = person();
    const asked = asksFirst(addOn, MAYA_SECRET);
    await user.click(putBackWord(rows(await section())[0]!));
    await user.click(putItBackButton(await section()));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    await act(() => router.navigate("/about"));
    await asked.yes();
    await waitFor(() => expect(newestOn(s.follows, FOLLOW_RELAYS[0])?.tags).toEqual(MAYA_LIST.tags));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(() => router.navigate("/you"));

    // It was put back, and the rows show it: the list that was replaced is the newest copy. No line says so.
    const part = await section();
    await waitFor(() => expect(befores(part)).toEqual([copy.follow.keptBeforePutBack, "Before you followed Sol"]));
    expect(saidIn(part)).toBe("");
    expect(asking(part)).not.toBeInTheDocument();
  });

  it("says what it came to for the visit it was said in: gone once the person has left the page and come back", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { router } = await openYou([MAYA_LIST_WITH_SOL]);
    const user = person();
    await user.click(putBackWord(rows(await section())[0]!));
    await user.click(putItBackButton(await section()));
    await waitFor(async () => expect(saidIn(await section())).toBe(copy.follow.putBackDone));

    await act(() => router.navigate("/about"));
    await act(() => router.navigate("/you"));

    const part = await section();
    expect(saidIn(part)).toBe("");
    expect(befores(part)).toEqual([copy.follow.keptBeforePutBack, "Before you followed Sol"]);
  });
});

describe("a putting back that did not simply succeed", () => {
  /** Maya's You page with one copy, the asking open, and the putting back that Put it back starts played by the test. */
  async function pressed() {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const app = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    const played = nextPutBack();
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));
    expect(putBack).toHaveBeenCalledTimes(1);
    return { ...app, part, user, played };
  }

  it.each<[string, FollowOutcome, string]>([
    ["the list could not be loaded", { kind: "not-loaded" }, "We couldn't load the list of people you follow, so nothing was changed."],
    ["it was not approved", { kind: "not-approved" }, "That wasn't approved, so nothing was changed."],
    ["it did not save", { kind: "not-saved" }, "That didn't save. Nothing was changed."],
    ["the list as it is now could not be kept first", { kind: "not-kept" }, "We couldn't keep a copy of your list in this browser, so nothing was changed."],
  ])("says so when %s, in the words a follow has, with Try again, which asks again and writes nothing", async (_, outcome, line) => {
    const { part, user, played, s } = await pressed();

    await played.ends(outcome);

    expect(saidIn(part)).toBe(line);
    expect(asking(part)).not.toBeInTheDocument();
    // Said in the row of the copy it was of, under its words, with Try again beside it; and the focus is
    // on that row's Put back, which is back where the asking was.
    const [row] = rows(part);
    expect(statusOf(row!)).toHaveTextContent(line);
    expect(putBackWord(row!)).toHaveFocus();
    const tryAgain = within(row!).getByRole("button", { name: copy.follow.tryAgain });
    expect(tryAgain).toHaveClass("min-h-touch");
    expect(tryAgain).toHaveAccessibleDescription(line);
    // The copies are as they were: nothing was put back.
    expect(befores(part)).toEqual(["Before you followed Sol"]);

    // Try again is no yes: it opens the asking for that copy again, and only Put it back writes.
    await user.click(tryAgain);
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(rows(part)[0]).toContainElement(asking(part));
    expect(keepButton(part)).toHaveFocus();
    expect(saidIn(part)).toBe("");
    expect(within(part).queryByRole("button", { name: copy.follow.tryAgain })).not.toBeInTheDocument();

    // And then it is the real putting back, of the same copy.
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    expect(putBack).toHaveBeenCalledTimes(2);
    expect(putBack.mock.calls[1]![1]).toEqual(asSent(MAYA_LIST));
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual(MAYA_LIST.tags);
  });

  it("says it was saved and could not be checked yet, with nothing to try again, and the buttons show from the list that was saved", async () => {
    const { part, played, router } = await pressed();
    const saved = finalizeEvent({ kind: 3, created_at: MAYA_LIST_WITH_SOL.created_at + 60, content: MAYA_LIST.content, tags: MAYA_LIST.tags }, MAYA_SECRET);

    await played.ends({ kind: "saved", list: saved, confirmed: false, kept: true });

    expect(saidIn(part)).toBe("Saved, but we couldn't check it yet.");
    expect(within(part).queryByRole("button", { name: copy.follow.tryAgain })).not.toBeInTheDocument();
    await act(() => router.navigate(SOL_PATH));
    await waitFor(() => expect(followButton()).toBeInTheDocument());
  });

  it("says it did not save when the putting back fails in a way that has no name", async () => {
    const { part, played } = await pressed();

    await played.fails(new TypeError("Not a list the person signed"));

    expect(saidIn(part)).toBe(copy.follow.notSaved);
    expect(within(part).getByRole("button", { name: copy.follow.tryAgain })).toBeInTheDocument();
  });

  it("says it was saved and could not be checked, and never that the list is as it was then, when the relay the person writes to did not answer: what it holds is not known", async () => {
    const OWN = "wss://own.example.test";
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    signedInAs(MAYA_SECRET);
    // Her relay list names a relay of her own, which is out; the app's three hold her list as it is now.
    const theirs = finalizeEvent({ kind: 10002, created_at: FOLLOW_LIST_TIME, content: "", tags: [["r", OWN, "write"]] }, MAYA_SECRET);
    const own = relay([MAYA_LIST_WITH_SOL]);
    own.down = true;
    const s = scene({
      followRelays: {
        [FOLLOW_RELAYS[0]]: relay([MAYA_LIST_WITH_SOL]),
        [FOLLOW_RELAYS[1]]: relay([MAYA_LIST_WITH_SOL, theirs]),
        [FOLLOW_RELAYS[2]]: relay([MAYA_LIST_WITH_SOL]),
        [OWN]: own,
      },
    });
    await open(s, "/you");
    const part = await section();
    const user = person();

    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.unconfirmed));
    expect(copy.follow.unconfirmed).toBe("Saved, but we couldn't check it yet.");
    expect(part).not.toHaveTextContent(copy.follow.putBackDone);
    // It was saved where it could be: the three hold the copy's entries, and there is nothing to try again.
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual(MAYA_LIST.tags);
    expect(within(part).queryByRole("button", { name: copy.follow.tryAgain })).not.toBeInTheDocument();
  });

  it("is not approved, and the list on the relays is as it was, when the person's add-on says no", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    addOn.signEvent.mockRejectedValueOnce(new Error("The person said no"));

    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.notApproved));
    expect(s.follows.published()).toEqual([]);
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.id).toBe(MAYA_LIST_WITH_SOL.id);
  });

  it("says a copy could not be kept, and signs nothing, when the list as it is now cannot be kept first: not that the list could not be loaded, which it was", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    storageWrites.mockResolvedValueOnce(false);

    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.notKept));
    expect(copy.follow.notKept).toBe("We couldn't keep a copy of your list in this browser, so nothing was changed.");
    expect(storageWrites).toHaveBeenCalledTimes(1);
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
    // It can be tried again, as the other failures can, and with the storage back it is put back.
    await user.click(within(part).getByRole("button", { name: copy.follow.tryAgain }));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
  });
});

/** How many copies are kept for a person. */
const TEN = 10;

/** Ten more lists of Maya's are kept, as her changes in another tab keep them: whatever was kept before gives way. */
async function tenMoreKeptElsewhere() {
  for (let at = 1; at <= TEN; at++) {
    expect(await keepCopy(MAYA, asSent(listOf([["p", pubkeyAt(at)]], at)), { did: "follow", who: pubkeyAt(at) }, KEPT_AT + at * 60)).toBe(true);
  }
}

describe("a putting back whose copy is no longer listed as it ends", () => {

  /**
   * Maya's You page with one copy, its putting back under way (played by the test) with the focus
   * on the asking's button; and meanwhile that copy has been pushed out of the device's storage.
   */
  async function pushedOutWhileSaving() {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const app = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    const played = nextPutBack();
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));
    expect(within(asking(part)!).getByRole("button", { name: copy.follow.saving })).toHaveFocus();
    await tenMoreKeptElsewhere();
    return { ...app, part, user, played };
  }

  /** The rows are the ten kept elsewhere, and none of them is the copy that was put back. */
  async function expectRowGone(part: HTMLElement) {
    await waitFor(() => expect(rows(part)).toHaveLength(TEN));
    expect(befores(part)).not.toContain("Before you followed Sol");
    expect(new Set(befores(part))).toEqual(new Set(["Before you followed someone"]));
  }

  it("says the list is as it was then at the section's head, with the focus on the section's heading, when it saved", async () => {
    const { part, played } = await pushedOutWhileSaving();
    const saved = finalizeEvent({ kind: 3, created_at: MAYA_LIST_WITH_SOL.created_at + 60, content: MAYA_LIST.content, tags: MAYA_LIST.tags }, MAYA_SECRET);
    const status = headStatus(part);

    await played.ends({ kind: "saved", list: saved, confirmed: true, kept: true });
    await expectRowGone(part);

    // Said once, in the status that was there all along; no row says anything, and none asks.
    await waitFor(() => expect(status).toHaveTextContent(copy.follow.putBackDone));
    expect(headStatus(part)).toBe(status);
    expect(saidIn(part)).toBe(copy.follow.putBackDone);
    expect(rowSaying(part)).toBeUndefined();
    expect(asking(part)).not.toBeInTheDocument();
    // The control the focus was on went with its row: it is on the heading, not on nothing.
    expect(headingOf(part)).toHaveFocus();
    expect(headingOf(part)).toHaveAttribute("tabindex", "-1");
    // Every Put back is on again.
    for (const row of rows(part)) expect(putBackWord(row)).not.toHaveAttribute("aria-disabled");
  });

  it.each<[string, FollowOutcome, string]>([
    ["it was not approved", { kind: "not-approved" }, copy.follow.notApproved],
    ["the list could not be loaded", { kind: "not-loaded" }, copy.follow.notLoaded],
  ])("says so at the section's head, with the focus on its heading and nothing to try again, when %s", async (_, outcome, line) => {
    const { part, played, s } = await pushedOutWhileSaving();

    await played.ends(outcome);
    await expectRowGone(part);

    await waitFor(() => expect(headStatus(part)).toHaveTextContent(line));
    expect(saidIn(part)).toBe(line);
    expect(rowSaying(part)).toBeUndefined();
    expect(headingOf(part)).toHaveFocus();
    // The copy is no longer there to put back: nothing offers to try it again.
    expect(within(part).queryByRole("button", { name: copy.follow.tryAgain })).not.toBeInTheDocument();
    expect(s.follows.published()).toEqual([]);
  });

  it("says it no more once the person asks about another copy, or has left the page", async () => {
    const { part, played, user, router } = await pushedOutWhileSaving();
    await played.ends({ kind: "not-approved" });
    await expectRowGone(part);
    await waitFor(() => expect(headStatus(part)).toHaveTextContent(copy.follow.notApproved));

    await user.click(putBackWord(rows(part)[0]!));
    expect(saidIn(part)).toBe("");
    await user.click(keepButton(part));
    expect(saidIn(part)).toBe("");

    await act(() => router.navigate("/about"));
    await act(() => router.navigate("/you"));
    expect(saidIn(await section())).toBe("");
  });

  it("leaves the focus where the person has put it meanwhile", async () => {
    const { part, played } = await pushedOutWhileSaving();
    const signOut = within(main()).getByRole("button", { name: copy.you.signOut });
    signOut.focus();

    await played.ends({ kind: "not-approved" });
    await expectRowGone(part);

    await waitFor(() => expect(headStatus(part)).toHaveTextContent(copy.follow.notApproved));
    expect(signOut).toHaveFocus();
  });
});

describe("with ten copies kept, and the oldest of them put back", () => {
  /** Ten lists of Maya's kept a minute apart, each before she followed someone else; her list as it is now is another. */
  const lists = Array.from({ length: TEN }, (_, at) => listOf([["p", pubkeyAt(at)]], at));
  /** What the rows say, the newest first: each was kept before a follow of someone the app has no name for. */
  const whens = (part: HTMLElement) => rows(part).map((row) => row.querySelector("time")!.getAttribute("datetime"));
  const keptAtMinute = (minute: number) => new Date((KEPT_AT + minute * 60) * 1000).toISOString();

  /** Maya's You page with those ten copies, over relays that hold her list as it is now and answer what they are sent as `writes` says. */
  async function withTen(followRelays?: Parameters<typeof scene>[0]) {
    for (const [at, list] of lists.entries()) await kept(list, { did: "follow", who: pubkeyAt(at) }, at * 60);
    const addOn = signedInAs(MAYA_SECRET);
    const s = scene(followRelays ?? { follows: [MAYA_LIST_WITH_SOL] });
    await open(s, "/you");
    const part = await section();
    expect(whens(part)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(keptAtMinute));
    return { s, addOn, part, user: person() };
  }

  /** The rows once a putting back of the oldest has kept the list it would replace: that list first, and the oldest still the last. */
  async function expectOldestStillListed(part: HTMLElement) {
    await waitFor(() => expect(befores(part)[0]).toBe(copy.follow.keptBeforePutBack));
    expect(rows(part)).toHaveLength(TEN);
    // The second oldest made room; the oldest is where it was among the others, by age.
    expect(whens(part).slice(1)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 0].map(keptAtMinute));
    expect((await keptCopies(MAYA)).at(-1)!.list).toEqual(asSent(lists[0]!));
  }

  it("still lists that copy when the add-on says no, in its place, and Try again then Put it back puts it back", async () => {
    const { s, addOn, part, user } = await withTen();
    addOn.signEvent.mockRejectedValueOnce(new Error("The person said no"));

    await user.click(putBackWord(rows(part)[TEN - 1]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.notApproved));

    // Nothing was changed, as the line says: the relays hold her list as it was, and the copy is still hers to put back.
    expect(s.follows.published()).toEqual([]);
    await expectOldestStillListed(part);

    await user.click(within(part).getByRole("button", { name: copy.follow.tryAgain }));
    expect(rows(part)[TEN - 1]).toContainElement(asking(part));
    await user.click(putItBackButton(part));

    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual(lists[0]!.tags);
    // And no other copy gave way for the second try: the list it replaced was kept the first time.
    await expectOldestStillListed(part);
  });

  it("still lists that copy when no relay takes the list, and it is put back once one does", async () => {
    // Each relay refuses the first list it is sent, and takes the next.
    const refusingOnce = () => relay([MAYA_LIST_WITH_SOL], { writes: { answers: [{ refuse: "blocked: not this time" }] } });
    const { s, part, user } = await withTen({ followRelays: { [FOLLOW_RELAYS[0]]: refusingOnce(), [FOLLOW_RELAYS[1]]: refusingOnce(), [FOLLOW_RELAYS[2]]: refusingOnce() } });

    await user.click(putBackWord(rows(part)[TEN - 1]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.notSaved));

    await expectOldestStillListed(part);

    await user.click(within(part).getByRole("button", { name: copy.follow.tryAgain }));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(saidIn(part)).toBe(copy.follow.putBackDone));
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual(lists[0]!.tags);
  });

  it("still holds that copy when the person signs out while their add-on is asked: it is there when they are back", async () => {
    const { s, addOn, part, user } = await withTen();
    const asked = asksFirst(addOn, MAYA_SECRET);
    await user.click(putBackWord(rows(part)[TEN - 1]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    await user.click(within(main()).getByRole("button", { name: copy.you.signOut }));
    await asked.yes();
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(s.follows.published()).toEqual([]);
    const copies = await keptCopies(MAYA);
    expect(copies).toHaveLength(TEN);
    expect(copies[0]!.list).toEqual(asSent(MAYA_LIST_WITH_SOL));
    expect(copies.at(-1)!.list).toEqual(asSent(lists[0]!));
  });
});

describe("the session's own hold on what may be put back", () => {
  const other = generateSecretKey();
  const OTHER = getPublicKey(other);
  /** What `usePutBack` gave at the last drawing, for each person it was asked about. */
  const given = new Map<string, PutBackOf>();
  function Asks({ who }: { who: string }): null {
    given.set(who, usePutBack(who));
    return null;
  }

  /** A page that asks for Maya's copies and for someone else's, with Maya signed in and one copy of hers kept. */
  async function opened() {
    given.clear();
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const addOn = signedInAs(MAYA_SECRET);
    const w = everywhere([MAYA_LIST_WITH_SOL]);
    await openPageInShell(
      w,
      <>
        <Asks who={MAYA} />
        <Asks who={OTHER} />
      </>,
    );
    await waitFor(() => expect(given.get(MAYA)!.copies).toHaveLength(1));
    return { w, addOn, held: given.get(MAYA)!.copies[0]! };
  }

  /** Nothing came of it: no putting back was begun, no relay was asked for a list, and nothing was kept, signed or sent. */
  async function expectNothingDone(w: ReturnType<typeof everywhere>, addOn: ReturnType<typeof signedInAs>) {
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(putBack).not.toHaveBeenCalled();
    expect(given.get(MAYA)!.saving).toBeNull();
    expect(w.asked().filter(asksForList)).toEqual([]);
    expect(storageWrites).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  }

  it("puts back nothing it does not hold: a list of the person's own that was never kept", async () => {
    const { w, addOn, held } = await opened();
    // Truly hers, and truly signed: but no copy the session read from the device's storage.
    const madeUp = { list: asSent(listOf([["p", pubkeyAt(1)]], 5)), at: held.at, for: held.for };

    act(() => given.get(MAYA)!.putBack(madeUp));

    await expectNothingDone(w, addOn);
  });

  it("puts back nothing but the copy as it holds it: one that is like it in every field, and is another object, is none of its copies", async () => {
    const { w, addOn, held } = await opened();
    const twin = structuredClone({ list: held.list, at: held.at, for: held.for });
    expect(twin).toEqual(held);

    act(() => given.get(MAYA)!.putBack(twin));

    await expectNothingDone(w, addOn);
  });

  it("puts back nothing for a person who is not the one signed in, though the copy is one it holds", async () => {
    const { w, addOn, held } = await opened();
    // Nothing is told of Maya's copies to whoever asks for another person's.
    expect(given.get(OTHER)!.copies).toEqual([]);

    act(() => given.get(OTHER)!.putBack(held));

    await expectNothingDone(w, addOn);
  });

  it("tells a page that stays open of the session's end, and reads the copies again for the same person signed in anew", async () => {
    const { held } = await opened();
    expect(storageReads).toHaveBeenCalledTimes(1);

    // The page goes on asking for Maya's copies while she signs out: it is told there are none to show.
    tapSession("sign out");
    await waitFor(() => expect(signedInNow()).toBe("nobody"));
    expect(given.get(MAYA)!.copies).toEqual([]);
    act(() => given.get(MAYA)!.putBack(held));
    expect(putBack).not.toHaveBeenCalled();

    // She signs in again, with the page still open: her copies are read anew, for her.
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(MAYA));
    await waitFor(() => expect(given.get(MAYA)!.copies).toHaveLength(1));
    expect(storageReads.mock.calls).toEqual([[MAYA], [MAYA]]);
    // What was held for the session before is none of this session's copies.
    expect(given.get(MAYA)!.copies[0]).not.toBe(held);
    expect(given.get(MAYA)!.copies[0]).toEqual(held);
    act(() => given.get(MAYA)!.putBack(held));
    expect(putBack).not.toHaveBeenCalled();
  });

  it("puts back the copy it holds, once, however often it is asked while that is under way", async () => {
    const { w, addOn, held } = await opened();
    const asked = asksFirst(addOn, MAYA_SECRET);

    act(() => given.get(MAYA)!.putBack(held));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));
    // While it is being saved, asked again, for that copy and for nothing it holds.
    act(() => given.get(MAYA)!.putBack(given.get(MAYA)!.copies[0]!));
    act(() => given.get(MAYA)!.putBack(held));
    expect(given.get(MAYA)!.saving).toEqual(held);

    await asked.yes();
    await waitFor(() => expect(given.get(MAYA)!.ended?.how).toBe("done"));
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(putBack.mock.calls[0]![1]).toEqual(asSent(MAYA_LIST));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) expect(w.relays[url]!.writer.published).toHaveLength(1);
  });
});

/**
 * A copies' store of the test's own, with one copy of Maya's kept, made by a host that serves her
 * session whatever Follow is: one that does not look. (The store of the person's own list, which is
 * the app's only host, does look.) A test tells it what its host would: that a write has ended, say.
 */
async function storeOfItsOwn() {
  await kept(MAYA_LIST, { did: "follow", who: SOL });
  const w = everywhere([MAYA_LIST_WITH_SOL]);
  const by = { getPublicKey: async () => MAYA, signEvent: vi.fn() };
  const stop = new AbortController();
  const session: OwnSession = {
    account: { pubkey: MAYA, signer: by, how: "browser" },
    signal: stop.signal,
    writing: () => ({ readers: w.readers, writers: w.writers }),
  };
  const wasPutBack = vi.fn();
  const store = new OwnCopies({ live: () => session, wasPutBack });
  return { store, w, by, wasPutBack, listen: () => store.subscribe(() => {}) };
}

describe("an asking whose copy is no longer listed", () => {
  /** The section over a store of the test's own, inside the app's shell, with the asking open on its one row. */
  async function askingOpen() {
    const made = await storeOfItsOwn();
    await openPageInShell(
      made.w,
      <CopiesContext value={made.store}>
        <KeptCopies pubkey={MAYA} />
      </CopiesContext>,
    );
    const part = await section();
    const user = person();
    await user.click(putBackWord(rows(part)[0]!));
    expect(keepButton(part)).toHaveFocus();
    return { ...made, part, user };
  }

  it("is let go of: it goes with its row, the focus is on the section's heading, and it does not open again by itself when that copy is listed again", async () => {
    const { store, part } = await askingOpen();

    // Changes in another tab push the copy out, and a write in this one has the copies read again.
    await tenMoreKeptElsewhere();
    act(() => store.written());
    await waitFor(() => expect(rows(part)).toHaveLength(TEN));

    expect(asking(part)).not.toBeInTheDocument();
    expect(headingOf(part)).toHaveFocus();
    expect(saidIn(part)).toBe("");

    // The very same copy is kept again, at the same time: its row is back, and asks nothing.
    expect(await keepCopy(MAYA, asSent(MAYA_LIST), { did: "follow", who: SOL }, KEPT_AT)).toBe(true);
    act(() => store.written());
    await waitFor(() => expect(befores(part)[0]).toMatch(/^Before you followed (?:someone|Sol)$/));
    expect(rows(part)[0]!.querySelector("time")).toHaveAttribute("datetime", new Date(KEPT_AT * 1000).toISOString());

    expect(asking(part)).not.toBeInTheDocument();
    expect(putBackWord(rows(part)[0]!)).toBeInTheDocument();
    expect(putBack).not.toHaveBeenCalled();
  });

  it("stays open while its copy is listed, whatever else is kept meanwhile", async () => {
    const { store, part } = await askingOpen();

    // One more copy is kept elsewhere: the asking's own is still among the ten.
    expect(await keepCopy(MAYA, asSent(listOf([["p", pubkeyAt(1)]], 1)), { did: "follow", who: pubkeyAt(1) }, KEPT_AT + 60)).toBe(true);
    act(() => store.written());
    await waitFor(() => expect(rows(part)).toHaveLength(2));

    expect(rows(part)[1]).toContainElement(asking(part));
    expect(keepButton(part)).toHaveFocus();
  });
});

describe("the copies' store itself, whoever makes it", () => {
  const madeCarelessly = storeOfItsOwn;

  /** Lets what was begun go on: a read of the device's storage is not waited for by anything here. */
  const settled = () => act(() => vi.advanceTimersByTimeAsync(1_000));

  it("reads the copies for a page that lists them, and puts back the one it holds, with Follow on: the store below is the same store", async () => {
    const { store, listen } = await madeCarelessly();
    const played = nextPutBack();

    const stop = listen();
    await waitFor(() => expect(store.of(MAYA).copies).toHaveLength(1));
    expect(storageReads.mock.calls).toEqual([[MAYA]]);
    store.putBack(MAYA, store.of(MAYA).copies[0]!);

    expect(putBack).toHaveBeenCalledTimes(1);
    expect(store.of(MAYA).saving).toBe(store.of(MAYA).copies[0]);
    await played.ends({ kind: "not-approved" });
    stop();
  });

  it("reads no storage, holds nothing and puts nothing back with Follow off, though its host serves a session", async () => {
    config.features.follow = false;
    const { store, w, by, wasPutBack, listen } = await madeCarelessly();
    const copies = await keptCopies(MAYA);
    storageReads.mockClear();

    const stop = listen();
    // Whatever it is told of the session, of a write or of a page left.
    store.sessionChanged();
    store.written();
    store.leftPage();
    await settled();

    expect(storageReads).not.toHaveBeenCalled();
    expect(store.of(MAYA)).toEqual({ copies: [], saving: null, ended: null });
    // Nor is a copy put back, were it the person's own and truly kept: nothing is held to put back.
    store.putBack(MAYA, copies[0]!);
    await settled();
    expect(putBack).not.toHaveBeenCalled();
    expect(store.of(MAYA).saving).toBeNull();
    expect(storageWrites).not.toHaveBeenCalled();
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(wasPutBack).not.toHaveBeenCalled();
    expect(w.asked()).toEqual([]);
    expect(w.published()).toEqual([]);
    stop();
  });

  it("holds nothing once Follow is turned off under it, and puts back nothing it held before", async () => {
    const { store, w, by, listen } = await madeCarelessly();
    const stop = listen();
    await waitFor(() => expect(store.of(MAYA).copies).toHaveLength(1));
    const held = store.of(MAYA).copies[0]!;
    storageReads.mockClear();

    config.features.follow = false;

    expect(store.of(MAYA)).toEqual({ copies: [], saving: null, ended: null });
    store.putBack(MAYA, held);
    store.written();
    store.sessionChanged();
    await settled();
    expect(putBack).not.toHaveBeenCalled();
    expect(storageReads).not.toHaveBeenCalled();
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.asked()).toEqual([]);
    expect(w.published()).toEqual([]);
    stop();
  });
});

describe("when the person signed in changes", () => {
  it("is gone as the person signs out, on the page they signed out on", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    await openYou([MAYA_LIST_WITH_SOL]);
    await section();
    const user = person();

    await user.click(within(main()).getByRole("button", { name: copy.you.signOut }));

    expect(sectionNow()).not.toBeInTheDocument();
    expect(await within(main()).findByText(copy.you.signedOut)).toBeInTheDocument();
    expect(main()).not.toHaveTextContent(copy.follow.putBack);
    // The copies stay in the browser: they are hers when she signs in again.
    expect(await keptCopies(MAYA)).toHaveLength(1);
  });

  it("stops a putting back that was under way as the person signs out, and nothing is signed after", async () => {
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    const { s, addOn } = await openYou([MAYA_LIST_WITH_SOL]);
    const part = await section();
    const user = person();
    const asked = asksFirst(addOn, MAYA_SECRET);
    await user.click(putBackWord(rows(part)[0]!));
    await user.click(putItBackButton(part));
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    await user.click(within(main()).getByRole("button", { name: copy.you.signOut }));
    await asked.yes();
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(s.follows.published()).toEqual([]);
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.id).toBe(MAYA_LIST_WITH_SOL.id);
  });

  it("shows nothing of one person's copies to the next, not for one drawing, when someone else signs in with no sign-out between", async () => {
    const other = generateSecretKey();
    const OTHER = getPublicKey(other);
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    signedInAs(MAYA_SECRET);
    const w = everywhere([MAYA_LIST_WITH_SOL]);
    /** At each drawing of the page: who was signed in, and whether the copies' heading was on it. */
    const drawn: Array<[who: string | undefined, copies: boolean]> = [];
    function Watch(): null {
      const { account } = useAccount();
      useLayoutEffect(() => {
        drawn.push([account?.pubkey, document.body.textContent?.includes(copy.follow.keptHeading) === true]);
      });
      return null;
    }
    await openPageInShell(
      w,
      <>
        <YouPage />
        <Watch />
      </>,
    );
    const part = await section();
    // Maya has an asking open as the next person signs in.
    await person().click(putBackWord(rows(part)[0]!));
    expect(asking(part)).toBeInTheDocument();
    expect(drawn.filter(([who]) => who !== MAYA && who !== undefined)).toEqual([]);

    // The add-on is now the other person's, who signs in with it: no sign-out between.
    installAddOn(other);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(OTHER));
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(sectionNow()).not.toBeInTheDocument();
    expect(drawn.filter(([who]) => who === OTHER).length).toBeGreaterThan(0);
    expect(drawn.filter(([who, copies]) => who !== MAYA && copies)).toEqual([]);
    // The storage was read for each of them, by their own key, and for nobody else.
    expect(new Set(storageReads.mock.calls.map(([pubkey]) => pubkey))).toEqual(new Set([MAYA, OTHER]));
    expect(putBack).not.toHaveBeenCalled();
    expect(w.asked().filter(asksForList)).toEqual([]);
  });

  it("shows the next person their own copies, and none of the person's before them", async () => {
    const other = generateSecretKey();
    const OTHER = getPublicKey(other);
    const theirs = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", ANA]] }, other);
    await kept(MAYA_LIST, { did: "follow", who: SOL });
    await kept(theirs, { did: "unfollow", who: SOL }, 60, OTHER);
    signedInAs(MAYA_SECRET);
    const w = everywhere([MAYA_LIST_WITH_SOL, theirs]);
    await openPageInShell(w, <YouPage />);
    expect(befores(await section())).toEqual(["Before you followed someone"]);

    installAddOn(other);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(OTHER));

    await waitFor(async () => expect(befores(await section())).toEqual(["Before you unfollowed someone"]));
    expect(rows(await section())).toHaveLength(1);
  });
});
