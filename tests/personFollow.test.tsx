import { act, screen, waitFor, within } from "@testing-library/react";
import { finalizeEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../src/circle/brainstorm";
import { copy } from "../src/copy/en";
import { changeFollow } from "../src/follow/change";
import { UNFOLLOW_GUARD_MS } from "../src/follow/FollowButton";
import { UNDO_MS } from "../src/follow/FollowProvider";
import { personPath } from "../src/person/npub";
import { buildFollowList } from "./fixtures/follow-list";
import { DESKTOP, PHONE, resizeTo } from "./support/app";
import { hex64 } from "./support/events";
import { gate, installAddOn, signedInAs } from "./support/followPage";
import { after, askedOf, circleKept, endScene, type Logs, person, startScene, tap, unfollowByMouse } from "./support/followScene";
import { FOLLOW_RELAYS } from "./support/followWorld";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import { at, bothHold, expectNoProtocolWords, followButton, followControls, followingButton, followLink, header, headerCell, hollow, JACAFE, listReads, lists, MAIA, main, MAYA, MAYA_LIST, MAYA_LIST_WITH_SOL, MAYA_SECRET, newestOn, open, openSol, placePath, reviewOf, reviewsPart, scene, SOL, SOL_PATH, SOL_SECRET, solOn, TAKES_ROOM } from "./support/personScene";
import { profileOf, rankOf, reviewOfPlace, wholeText } from "./support/reviewWorld";

/*
 * The Follow button on a person's page (src/person/PersonPage.tsx): the one main button, where it is
 * on a phone and on a desktop, a tap being the one safe change by the real `changeFollow`, the link
 * to sign in for someone signed out, "This is you" on the person's own page and the way to it from
 * You, and the page of a reviewer a place's page folds away, which is anyone's.
 * (tests/followButton.test.tsx has the button's every state; tests/personPage.test.tsx the page's frame.)
 *
 * `changeFollow` is mocked around the real one, and Brainstorm's client is mocked: each of its network
 * calls is a stand-in that a test can count. The relays are held in memory, the keys are thrown away,
 * and nothing opens a socket or reaches the network (tests/setup.ts; the set-up is shared with the
 * page's other tests, tests/support/personScene.ts).
 */

vi.mock("../src/follow/change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/change")>();
  return { ...actual, changeFollow: vi.fn(actual.changeFollow) };
});
const change = vi.mocked(changeFollow);

vi.mock("../src/circle/brainstorm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/circle/brainstorm")>();
  return { ...actual, signInToBrainstorm: vi.fn(), latestRun: vi.fn(), startRun: vi.fn(), scorerOf: vi.fn() };
});
const brainstorm = vi.mocked(client);
/** How many times each call that reaches Brainstorm was made: its setup, its sign-in, a run asked about, a run started. */
const askedOfBrainstorm = askedOf(brainstorm);

// The sign-in page looks, for a moment, for an add-on that comes late (src/signin/addOn.ts): here the
// page has just loaded, and the look ends at once with what the page has.
vi.mock("../src/signin/addOn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/signin/addOn")>();
  return { ...actual, msSinceLoad: () => 0, lookForAddOn: async () => actual.hasAddOn() };
});

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
});

afterEach(() => endScene(logs));

describe("Follow, on a person's page", () => {
  it("has the one main button in the header, beside the picture, for a person signed in who does not follow them", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s);

    const button = await waitFor(() => {
      expect(followButton()).toBeInTheDocument();
      return followButton()!;
    });
    expect(button).toHaveTextContent(copy.follow.follow);
    // The page's button: a pill 32 px tall, as wide as its words (ruling R46), and the only one on the page.
    expect(button).toHaveClass("h-8", "self-start");
    expect(button).not.toHaveClass("w-full");
    expect(followControls()).toEqual([button]);
    expect(header()).toContainElement(button);
    // Drawn in the row the picture is in, at the end of it and level with the picture's middle, with
    // the name in the row under them: the header places each by a grid, and the row is no taller for
    // the button.
    const picture = header().querySelector("[aria-hidden=true]")!;
    const name = within(main()).getByRole("heading", { level: 1 });
    expect(header()).toHaveClass("grid");
    expect(headerCell(picture)).toHaveClass("row-start-1", "col-start-1");
    expect(headerCell(button)).toHaveClass("row-start-1", "col-start-2", "self-center", "justify-self-end");
    // Nothing around it cuts off what overflows it: its 44 px to tap are all there.
    for (let around = button.parentElement; around !== null && around !== document.body; around = around.parentElement) {
      expect(around.getAttribute("class") ?? "", around.tagName).not.toMatch(/(?:^|\s)(?:overflow-|truncate|line-clamp-)/);
    }
    expect(headerCell(name)).toHaveClass("row-start-2", "col-span-2");
    // Read after the name all the same: the heading has the focus on arrival, and the page's one action comes after it (ruling R34).
    expect(name.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(reviewsPart()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Her list was read once, and nothing was changed.
    expect(listReads(s.follows)).toEqual([1, 1, 1]);
    expect(change).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("follows them on a tap, by the one safe change: one entry more in the list, and the line for a person with a circle", async () => {
    const addOn = signedInAs(MAYA_SECRET);
    circleKept(MAYA, "ready");
    const s = scene({ follows: [MAYA_LIST] });
    const user = person();
    await openSol(s);
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    const button = followButton()!;

    await user.click(button);

    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    expect(button).toHaveAccessibleName(copy.follow.followingNamed("Sol"));
    expect(button).toHaveFocus();
    expect(change).toHaveBeenCalledTimes(1);
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) {
      expect(s.follows.relays[url]!.writer.published).toHaveLength(1);
      expect(newestOn(s.follows, url)?.tags).toEqual([...MAYA_LIST.tags, ["p", SOL]]);
      expect(newestOn(s.follows, url)?.content).toBe(MAYA_LIST.content);
    }
    // Under it, politely: what the follow means for her circle, with Update now. Nothing was asked of Brainstorm.
    expect(within(header()).getByText(copy.follow.countsAfterUpdate)).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: copy.follow.updateNow })).toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
    expect(followControls()).toEqual([button]);
    expectNoProtocolWords();
  });

  it("draws what a tap leaves to say under the header, as wide as the page, and the button stays where it was, beside the picture", async () => {
    signedInAs(MAYA_SECRET);
    circleKept(MAYA, "ready");
    const s = scene({ follows: [MAYA_LIST] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const user = person();
    await openSol(s);
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    const button = followButton()!;
    const cell = headerCell(button);
    const placed = cell.className;

    await user.click(button);

    const line = await within(header()).findByText(copy.follow.countsAfterUpdate);
    // The button's place holds the button and nothing else: nothing under it makes its row taller, so it does not move.
    expect(headerCell(button)).toBe(cell);
    expect(cell.className).toBe(placed);
    expect(cell).not.toContainElement(line);
    expect(within(cell).queryAllByRole("status")).toEqual([]);
    expect(within(cell).getAllByRole("button")).toEqual([button]);
    // Its lines have a row of their own, the last of the header, across both columns.
    const lines = headerCell(line);
    expect(lines).toHaveClass("row-start-4", "col-span-2");
    expect(lines).toContainElement(within(header()).getByRole("button", { name: copy.follow.updateNow }));
    // Read in order: the name, the button, what it says, the reviews.
    const inOrder = [within(main()).getByRole("heading", { level: 1 }), button, line, reviewsPart()];
    for (let at = 1; at < inOrder.length; at++) {
      expect(inOrder[at - 1]!.compareDocumentPosition(inOrder[at]!) & Node.DOCUMENT_POSITION_FOLLOWING, `part ${at} is after part ${at - 1}`).toBeTruthy();
    }
  });

  it("gives the focus back to the button when Undo, which is drawn apart from it, goes as it is tapped", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST_WITH_SOL] });
    const user = person();
    await openSol(s);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    const button = followingButton()!;
    // Unfollowed with a mouse: it comes onto the button, which says Unfollow, and the click is on that.
    await unfollowByMouse(user, button);
    const undo = await within(header()).findByRole("button", { name: copy.follow.undo });
    expect(headerCell(undo)).not.toBe(headerCell(button));
    expect(within(header()).getByText(wholeText(copy.follow.unfollowed("Sol")))).toBeInTheDocument();

    await user.click(undo);

    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    expect(undo).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("opens Personalize's panel in the row under the header, closes it with Not now and with Escape, and keeps the focus on Personalize, as under a review's button", async () => {
    signedInAs(MAYA_SECRET);
    circleKept(MAYA, "off");
    const s = scene({ follows: [MAYA_LIST] });
    const user = person();
    await openSol(s);
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    await user.click(followButton()!);
    const line = await within(header()).findByText(copy.follow.countsOnceBuilt);
    const button = followingButton()!;
    /** Personalize beside the line, which opens the panel: not the panel's own button of the same name. */
    const opener = () =>
      within(header())
        .getAllByRole("button", { name: copy.follow.personalize })
        .find((each) => each.hasAttribute("aria-expanded"))!;
    const panel = () => document.getElementById(opener().getAttribute("aria-controls") ?? "")!;
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(opener()).toHaveAccessibleDescription(copy.follow.countsOnceBuilt);

    await user.click(opener());

    // The panel is with the lines, as wide as the page: not beside the picture, where the button is.
    expect(opener()).toHaveAttribute("aria-expanded", "true");
    expect(headerCell(panel())).toBe(headerCell(line));
    expect(headerCell(panel())).toHaveClass("row-start-4", "col-span-2");
    expect(headerCell(button)).not.toContainElement(panel());
    expect(within(panel()).getByText(copy.circle.consent)).toBeInTheDocument();
    // The focus is on the panel's own button, whose tap is the person's consent; opening it asked Brainstorm nothing.
    expect(within(panel()).getByRole("button", { name: copy.circle.personalize })).toHaveFocus();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);

    await user.click(within(panel()).getByRole("button", { name: copy.circle.notNow }));
    expect(opener()).toHaveAttribute("aria-expanded", "false");
    expect(opener()).not.toHaveAttribute("aria-controls");
    expect(within(header()).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(opener()).toHaveFocus();

    await user.click(opener());
    expect(within(header()).getByText(copy.circle.consent)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(header()).queryByText(copy.circle.consent)).not.toBeInTheDocument();
    expect(opener()).toHaveFocus();

    // The button is where it was through all of it, and nothing was asked of Brainstorm or changed again.
    expect(headerCell(button)).toHaveClass("row-start-1", "col-start-2");
    expect(button).toHaveTextContent(copy.follow.following);
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("makes one change for Enter held down on Undo, which is drawn apart from the button: put back, they are not taken out again by the key still down", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST_WITH_SOL] });
    const user = person();
    await openSol(s);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    const button = followingButton()!;
    // Unfollowed with a mouse: it comes onto the button, which says Unfollow, and the click is on that.
    await unfollowByMouse(user, button);
    const undo = await within(header()).findByRole("button", { name: copy.follow.undo });
    expect(headerCell(undo)).not.toBe(headerCell(button));
    expect(change).toHaveBeenCalledTimes(1);
    // The Undo ends as soon as it is asked for: the key is still down when the button says Following again.
    const putBack = finalizeEvent({ kind: 3, created_at: Math.floor(Date.now() / 1000) + 60, content: MAYA_LIST.content, tags: MAYA_LIST_WITH_SOL.tags }, MAYA_SECRET);
    change.mockResolvedValueOnce({ kind: "saved", list: putBack, confirmed: true });
    act(() => undo.focus());

    await user.keyboard("{Enter>6/}");

    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    expect(button).toHaveFocus();
    // The unfollow, and one Undo: no change more for the key held down, on Undo or on the button the focus went to.
    expect(change).toHaveBeenCalledTimes(2);
    expect(change.mock.calls[1]![1]).toBe(SOL);
    expect(change.mock.calls[1]![2]).toMatchObject({ restore: [{ tag: ["p", SOL] }] });
    await after(UNDO_MS);
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("leaves no room for the button's lines while it has none: the row they come in is empty", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    await openSol(s);
    await waitFor(() => expect(followButton()).toBeInTheDocument());

    const lines = [...header().children].find((cell) => cell.classList.contains("row-start-4"))!;
    expect(lines).toHaveTextContent(/^$/);
    for (const each of [lines, ...hollow(lines)]) expect(each.className).not.toMatch(TAKES_ROOM);
  });

  it("gives the place for the button's lines no room for a line that is not seen: a first tap on Following, which only a screen reader is told of, moves nothing", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST_WITH_SOL] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const user = person();
    await openSol(s);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    const button = followingButton()!;
    const place = [...header().children].find((cell) => cell.classList.contains("row-start-4")) as HTMLElement;
    // The place takes room of its own (a margin over it) by what is in it: each of its classes that
    // says so, as the selector it asks of what it holds. jsdom lays nothing out, so this is what can
    // be held here: that no such selector finds anything in it. (In Chrome the header is as tall
    // after the tap as before it, at 320 and at 390 px.)
    const roomFor = [...place.classList].flatMap((name) => /^has-\[(.+)\]:-?[mp][trblxy]?-/.exec(name)?.[1] ?? []);
    expect(roomFor.length).toBeGreaterThan(0);
    const takesRoom = () => roomFor.some((selector) => place.matches(`:has(${selector})`));
    expect(takesRoom()).toBe(false);

    await tap(user, button);

    // The tap showed Unfollow, and is answered for a screen reader in the place: a line that is not seen, and nothing else.
    expect(button).toHaveTextContent(copy.follow.unfollow);
    expect(within(place).getByText(wholeText(copy.follow.pressAgain("Sol")))).toHaveClass("sr-only");
    expect(place.querySelectorAll("p:not(.sr-only), button")).toHaveLength(0);
    expect(takesRoom()).toBe(false);
    // Nor does anything inside it take room for that line.
    for (const each of place.querySelectorAll<HTMLElement>("*")) {
      if (each.classList.contains("sr-only") || each.closest(".sr-only") !== null) continue;
      expect(each.className, each.tagName).not.toMatch(/(?:^|\s)(?:has-\[|p[trblxy]?-|m[trblxy]?-)/);
    }

    // A line that is seen gives the place its room, as before: the second tap unfollows, and says who is no longer followed.
    await after(UNFOLLOW_GUARD_MS);
    await tap(user, button);
    await within(place).findByText(wholeText(copy.follow.unfollowed("Sol")));
    expect(takesRoom()).toBe(true);
  });

  it("says Following of someone the person follows already, in the trust colour, and changes nothing by being there", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST_WITH_SOL] });
    await openSol(s);

    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    expect(followingButton()).toHaveTextContent(copy.follow.following);
    expect(followingButton()).toHaveClass("h-8", "bg-trust-tint");
    expect(followControls()).toEqual([followingButton()]);
    expect(change).not.toHaveBeenCalled();
  });

  it.each([
    ["a phone, by two taps of a finger", PHONE],
    ["a desktop, by a mouse that leaves the button and comes back", DESKTOP],
  ])("follows them, and then unfollows them on %s: Unfollow is shown before it is done, and the list on every relay is as it was before the follow", async (_, px) => {
    const addOn = signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    const user = person();
    await openSol(s, { px });
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    const button = followButton()!;
    const press = () => (px === PHONE ? tap(user, button) : user.click(button));
    /** What every follow-list relay has been sent, and the newest list it holds. */
    const onEachRelay = (sent: number, tags: string[][]) => {
      for (const url of FOLLOW_RELAYS) {
        expect(s.follows.relays[url]!.writer.published).toHaveLength(sent);
        expect(newestOn(s.follows, url)?.tags).toEqual(tags);
        expect(newestOn(s.follows, url)?.content).toBe(MAYA_LIST.content);
      }
    };

    // Followed: one entry more.
    await press();
    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    onEachRelay(1, [...MAYA_LIST.tags, ["p", SOL]]);

    if (px === PHONE) {
      // The first tap shows Unfollow, and nothing is signed or sent. A screen reader is told so (ruling R48).
      await tap(user, button);
      expect(within(header()).getByText(wholeText(copy.follow.pressAgain("Sol")))).toHaveClass("sr-only");
    } else {
      // The pointer is on it still, and it says Following. It leaves and comes back: Unfollow.
      await user.pointer({ target: button });
      expect(button).toHaveTextContent(copy.follow.following);
      await user.unhover(button);
      await user.hover(button);
    }
    expect(button).toHaveTextContent(copy.follow.unfollow);
    expect(button).toHaveAccessibleName(copy.follow.unfollowNamed("Sol"));
    expect(followControls()).toEqual([button]);
    expect(change).toHaveBeenCalledTimes(1);
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    onEachRelay(1, [...MAYA_LIST.tags, ["p", SOL]]);

    // The press on Unfollow: the one safe change again, and the list is as it was before the follow.
    await after(UNFOLLOW_GUARD_MS);
    await press();
    await waitFor(() => expect(button).toHaveTextContent(copy.follow.follow));
    expect(change).toHaveBeenCalledTimes(2);
    expect(change.mock.calls[1]![1]).toBe(SOL);
    expect(change.mock.calls[1]![2]).toBe("unfollow");
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
    onEachRelay(2, MAYA_LIST.tags);
    // And the way back is offered, as before.
    expect(within(main()).getByText(wholeText(copy.follow.unfollowed("Sol")))).toBeInTheDocument();
    expect(within(main()).getByRole("button", { name: copy.follow.undo })).toBeInTheDocument();
    expect(followControls()).toEqual([button]);
    expectNoProtocolWords();
  });

  it("draws nothing where the button goes until the person's list has been read, and leaves no hole there", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const answer = gate();
    for (const url of FOLLOW_RELAYS) s.follows.relays[url]!.holds = answer.closed;
    // No link to sign in is ever drawn for her: not while the session this tab kept is restored, either.
    let signInSeen = false;
    const watch = new MutationObserver(() => {
      if (document.querySelector('main a[href="/signin"]') !== null) signInSeen = true;
    });
    watch.observe(document.body, { subtree: true, childList: true });
    await openSol(s);
    await lists([JACAFE]);
    await waitFor(() => expect(listReads(s.follows)).toEqual([1, 1, 1]));

    expect(followControls()).toEqual([]);
    expect(within(main()).queryByText(copy.person.you)).not.toBeInTheDocument();
    // Nothing empty in the header takes room, or draws a box: the page looks whole without the button.
    for (const each of hollow(header())) expect(each.className).not.toMatch(TAKES_ROOM);
    const before = [...header().children].map((cell) => cell.className);

    await answer.open();

    await waitFor(() => expect(followButton()).toBeInTheDocument());
    // And the row it comes into is the row that was there.
    expect([...header().children].map((cell) => cell.className)).toEqual(before);
    expect(headerCell(followButton()!)).toHaveClass("row-start-1", "col-start-2");
    watch.disconnect();
    expect(signInSeen).toBe(false);
  });

  it("draws nothing there when the person's list could not be read: no button says what might be wrong", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    // No relay can send a list just now; each answers the rest, her relay list among it.
    for (const url of FOLLOW_RELAYS) s.follows.relays[url]!.listsDown = true;
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s);
    await lists([JACAFE]);
    await waitFor(() => expect(listReads(s.follows)).toEqual([1, 1, 1]));
    await after(1_000);

    expect(followControls()).toEqual([]);
    for (const each of hollow(header())) expect(each.className).not.toMatch(TAKES_ROOM);
    // The page says nothing of it, and asks for the list no more.
    expect(main()).not.toHaveTextContent(copy.follow.notLoaded);
    expect(listReads(s.follows)).toEqual([1, 1, 1]);
  });

  it("is a link to sign in for someone signed out, which comes back to the page and follows nobody: the person taps Follow themself", async () => {
    const s = scene({ follows: [MAYA_LIST] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const user = person();
    const { router } = await openSol(s);
    await lists([JACAFE]);

    const link = followLink()!;
    expect(link).toHaveTextContent(copy.follow.follow);
    expect(link).toHaveAttribute("href", "/signin");
    expect(link).toHaveClass("h-8");
    expect(followControls()).toEqual([link]);
    expect(header()).toContainElement(link);
    // Nobody's list is read for someone signed out.
    expect(s.follows.asked()).toEqual([]);

    // She signs in with her add-on, and is back on Sol's page.
    const addOn = installAddOn(MAYA_SECRET);
    await user.click(link);
    expect(router.state.location.pathname).toBe("/signin");
    await user.click(await screen.findByRole("button", { name: copy.signin.continueButton }));
    await waitFor(() => expect(router.state.location.pathname).toBe(SOL_PATH));
    await screen.findByRole("heading", { level: 1, name: "Sol" });

    // Signing in followed nobody: the button says Follow, and nothing was signed or sent.
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    expect(followLink()).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.id).toBe(MAYA_LIST.id);

    // The tap is hers.
    await user.click(followButton()!);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    expect(change).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) expect(newestOn(s.follows, url)?.tags).toEqual([...MAYA_LIST.tags, ["p", SOL]]);
  });

  it("says This is you on the person's own page, where the button would be, with no button and nothing about who follows them", async () => {
    signedInAs(SOL_SECRET);
    const s = scene({ follows: [buildFollowList(SOL_SECRET)] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s);
    await lists([JACAFE]);

    const you = within(header()).getByText(copy.person.you);
    expect(you).toHaveTextContent(/^This is you$/);
    // Where the button is for anyone else, and as tall: in the picture's row, at the end of it.
    expect(headerCell(you)).toHaveClass("row-start-1", "col-start-2", "self-center", "justify-self-end");
    expect(you).toHaveClass("min-h-8");
    expect(followControls()).toEqual([]);
    await after(1_000);
    expect(followControls()).toEqual([]);
    expect(main()).not.toHaveTextContent(/Followed by/);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("Follow, on a person's page on a desktop", () => {
  /** The side rail: what is beside the column with the name and the reviews. */
  const rail = () => main().querySelector<HTMLElement>(".w-rail")!;

  it("has the one main button in the side rail, and none in the header", async () => {
    signedInAs(MAYA_SECRET);
    circleKept(MAYA, "ready");
    const s = scene({ follows: [MAYA_LIST] });
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const user = person();
    await openSol(s, { px: DESKTOP });

    await waitFor(() => expect(followButton()).toBeInTheDocument());
    const button = followButton()!;
    expect(followControls()).toEqual([button]);
    expect(rail()).toContainElement(button);
    expect(header()).not.toContainElement(button);
    expect(rail()).not.toContainElement(reviewsPart());
    // At the start of the rail, level with the name's first line, as wide as its words: not the width of the rail.
    expect(rail()).toHaveClass("mt-2.5");
    expect(button).toHaveClass("h-8", "self-start");
    expect(button).not.toHaveClass("w-full");
    expect(button.parentElement).not.toHaveClass("w-full");

    await user.click(button);
    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    // Its lines are in the rail with it.
    expect(within(rail()).getByText(copy.follow.countsAfterUpdate)).toBeInTheDocument();
    expect(within(rail()).getByRole("button", { name: copy.follow.updateNow })).toBeInTheDocument();
    // After the name and before the reviews, for a keyboard and a screen reader, as on a phone.
    expect(header().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(reviewsPart()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(followControls()).toEqual([button]);
  });

  it("keeps the rail's room while the button is not there, so nothing moves when it comes", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    const answer = gate();
    for (const url of FOLLOW_RELAYS) s.follows.relays[url]!.holds = answer.closed;
    await openSol(s, { px: DESKTOP });
    await waitFor(() => expect(listReads(s.follows)).toEqual([1, 1, 1]));

    expect(followControls()).toEqual([]);
    // As wide as a rail, and empty: no box, and no part of the page a screen reader is told of.
    const empty = rail();
    expect(empty).toHaveClass("w-rail", "shrink-0");
    expect(empty).toBeEmptyDOMElement();
    expect(empty.className).not.toMatch(/(?:^|\s)(?:border|bg-|rounded|p[xytrbl]?-)/);
    expect(empty.tagName).toBe("DIV");
    expect(empty).not.toHaveAttribute("role");

    await answer.open();

    await waitFor(() => expect(followButton()).toBeInTheDocument());
    // The rail that was there, with the button in it.
    expect(rail()).toBe(empty);
    expect(empty).toContainElement(followButton());
  });

  it("has the link to sign in there for someone signed out, and This is you on the person's own page", async () => {
    const s = scene();
    const first = await openSol(s, { px: DESKTOP });
    expect(rail()).toContainElement(followLink());
    expect(followControls()).toEqual([followLink()]);
    first.unmount();

    signedInAs(SOL_SECRET);
    await openSol(s, { px: DESKTOP });
    expect(within(rail()).getByText(copy.person.you)).toBeInTheDocument();
    expect(followControls()).toEqual([]);
  });

  it("has one button still when the window crosses 900 px, either way", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    await openSol(s, { px: PHONE });
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    expect(header()).toContainElement(followButton());

    act(() => resizeTo(DESKTOP));
    expect(followControls()).toEqual([followButton()]);
    expect(rail()).toContainElement(followButton());

    act(() => resizeTo(PHONE));
    expect(followControls()).toEqual([followButton()]);
    expect(header()).toContainElement(followButton());
    expect(main().querySelector(".w-rail")).toBeNull();
  });
});

describe("the page of a reviewer the view folds away", () => {
  /** The ranks the house's scorer gives: none of them is ever shown (decision 19). */
  const RANKS = [80.25, 2.75, 63.5];
  /** Fay, whom the house trusts, and Odile, whom it does not: on a place's page her review is folded away. */
  const FAY = hex64("f");
  const ODILE = hex64("d");

  /** Everything the page draws that could tell one person's page from another's by more than their words: each element's tag and classes. */
  const drawn = () => [...main().querySelectorAll("*")].map((each) => `${each.tagName} ${each.getAttribute("class") ?? ""} ${[...each.attributes].filter((a) => a.name.startsWith("data-") || a.name === "aria-hidden").map((a) => `${a.name}=${a.value}`).join(" ")}`);

  async function scenery() {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [MAYA_LIST] });
    s.search.held.push(profileOf(FAY, "Fay"), profileOf(ODILE, "Odile"));
    s.house.ranks.push(rankOf(FAY, RANKS[0]!), rankOf(ODILE, RANKS[1]!), rankOf(MAYA, RANKS[2]!));
    bothHold(s, [
      reviewOfPlace(FAY, JACAFE, 5, "Get the bolo de caco", at(2)),
      reviewOfPlace(FAY, MAIA, 4, "Worth the walk", at(9)),
      // The same stars as Fay gave: what tells the two apart is whom the house trusts, and nothing they wrote.
      reviewOfPlace(ODILE, JACAFE, 5, "Too loud for me", at(3)),
      reviewOfPlace(ODILE, MAIA, 4, "Never again", at(8)),
    ]);
    return s;
  }

  it("is the page anyone has, reached from their folded review: their reviews, and the same Follow button", async () => {
    const s = await scenery();
    const user = person();
    const { router } = await open(s, placePath(JACAFE), { entries: ["/", placePath(JACAFE)] });
    // On the place's page she is folded away, outside House picks.
    await user.click(await screen.findByRole("button", { name: copy.reviews.show }));
    const folded = (await screen.findByRole("heading", { level: 3, name: "Odile" })).closest("article")!;
    expect(folded).toHaveAttribute("data-folded", "true");

    await user.click(within(folded).getByRole("link", { name: "Odile" }));

    expect(router.state.location.pathname).toBe(personPath(ODILE));
    expect(await within(main()).findByRole("heading", { level: 1, name: "Odile" })).toHaveFocus();
    await lists([JACAFE, MAIA]);
    expect(within(reviewOf(JACAFE)).getByText("Too loud for me")).toBeInTheDocument();
    const button = await within(main()).findByRole("button", { name: copy.follow.followNamed("Odile") });
    expect(button).toHaveClass("h-8");
    // Nothing on it says whether the view counts her, and nothing is dimmed.
    expect(main().querySelector("[data-folded]")).toBeNull();
    expect(main()).not.toHaveTextContent(/outside|folded|house|circle|trust/i);
    expectNoNumbersAboutPeople(RANKS);
  });

  it("is drawn exactly as the page of a reviewer the house trusts: the same elements, in the same classes", async () => {
    const s = await scenery();
    const trusted = await open(s, personPath(FAY));
    await within(main()).findByRole("heading", { level: 1, name: "Fay" });
    await lists([JACAFE, MAIA]);
    await within(main()).findByRole("button", { name: copy.follow.followNamed("Fay") });
    const fay = drawn();
    expectNoNumbersAboutPeople(RANKS);
    trusted.unmount();

    await open(s, personPath(ODILE));
    await within(main()).findByRole("heading", { level: 1, name: "Odile" });
    await lists([JACAFE, MAIA]);
    await within(main()).findByRole("button", { name: copy.follow.followNamed("Odile") });

    expect(drawn()).toEqual(fay);
    expectNoNumbersAboutPeople(RANKS);
  });
});

// ---------------------------------------------------------------------------------------------
// The way to the person's own page.
// ---------------------------------------------------------------------------------------------

describe("the person's own page, from You", () => {
  it("is linked from You for a person signed in, and opens their page, which says it is theirs", async () => {
    signedInAs(SOL_SECRET);
    const s = scene();
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const user = person();
    const { router } = await open(s, "/you");
    await screen.findByRole("heading", { level: 1, name: "Sol" });

    const link = within(main()).getByRole("link", { name: copy.you.yourReviews });
    expect(link).toHaveAttribute("href", SOL_PATH);
    expect(link).toHaveClass("min-h-touch");
    // Nothing of the address is on the page: the link says where it goes in plain words.
    expect(main()).not.toHaveTextContent(/npub/i);

    await user.click(link);

    expect(router.state.location.pathname).toBe(SOL_PATH);
    expect(await within(main()).findByRole("heading", { level: 1, name: "Sol" })).toHaveFocus();
    expect(within(main()).getByText(copy.person.you)).toBeInTheDocument();
    await lists([JACAFE]);
    expect(followControls()).toEqual([]);
  });

  it("is not on You for someone signed out", async () => {
    const s = scene();
    await open(s, "/you");

    expect(await within(main()).findByText(copy.you.signedOut)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.you.yourReviews })).not.toBeInTheDocument();
    expect(main().querySelector('a[href^="/person/"]')).toBeNull();
  });
});
