import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../src/circle/brainstorm";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { changeFollow } from "../src/follow/change";
import { UNFOLLOW_GUARD_MS } from "../src/follow/FollowButton";
import { personPath, toNpub } from "../src/person/npub";
import { buildFollowList } from "./fixtures/follow-list";
import { DESKTOP, openApp, PHONE } from "./support/app";
import { gate } from "./support/followPage";
import { after, askedOf, circleKept, endScene, FRIEND, type Logs, OUTSIDER, person, startScene, STRANGER, tap } from "./support/followScene";
import { asksForList, everywhere, FOLLOW_RELAYS, type World as FollowWorld } from "./support/followWorld";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import {
  fromExplore,
  newWorld,
  PLACE_PATH,
  places,
  profileOf,
  rankOf,
  rateLink,
  readersOf,
  REVIEW_PATH,
  reviewBy,
  SEARCH,
  signedIn,
  writersOf,
} from "./support/reviewWorld";

/*
 * The Follow button on the real page of a place, in the app itself (src/place/Reviews.tsx): each
 * reviewer's name a link to their page, and Follow, small, beside the name of one the person does
 * not follow. These hold the page to who has a button and who has none; to a tap being the one safe
 * change, by the real `changeFollow` over relays held in memory; to the line under it for a person
 * with a circle and for one without; and to both outlasting the form that reviews the place (ruling
 * R21). (tests/followButton.test.tsx has the button's every state, on a page of the test's own.)
 *
 * Brainstorm's client is mocked: each of its network calls is a stand-in that a test can count. The
 * keys are thrown away, and nothing opens a socket or reaches the network (tests/setup.ts).
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

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
});

afterEach(() => endScene(logs));

describe("Follow, on a place's reviews", () => {
  /** The ranks the house's scorer gives the reviewers inside House picks: none of them is ever shown (decision 19). */
  const RANKS = [80.25, 71.5, 63.75];

  /**
   * Jacafé's page: Fay, whom the person follows, and Sol, whom they do not, inside House picks; Odile,
   * whom they do not follow either, outside it; and, signed in, the person's own review.
   */
  async function openPlace({ px = PHONE, signIn = true, circle }: { px?: number; signIn?: boolean; circle?: "ready" | "off" } = {}) {
    config.reviewRelays = [SEARCH];
    const reviews = newWorld();
    const me = signIn ? signedIn(reviews, { name: "Maya" }) : undefined;
    if (me !== undefined && circle !== undefined) circleKept(me.pubkey, circle);
    const list = me === undefined ? undefined : buildFollowList(me.key);
    const follows = everywhere(list === undefined ? [] : [list]);
    reviews.search.push(profileOf(FRIEND, "Fay"), profileOf(STRANGER, "Sol"), profileOf(OUTSIDER, "Odile"));
    reviews.ranks.push(rankOf(FRIEND, RANKS[0]!), rankOf(STRANGER, RANKS[1]!));
    reviews.search.push(reviewBy(FRIEND, 5, "Get the bolo"), reviewBy(STRANGER, 4, "Sit outside"), reviewBy(OUTSIDER, 2, "Too loud"));
    if (me !== undefined) {
      reviews.ranks.push(rankOf(me.pubkey, RANKS[2]!));
      reviews.search.push(reviewBy(me.pubkey, 4, "My own words"));
    }
    const app = await openApp(PLACE_PATH, {
      events: places,
      px,
      entries: fromExplore(PLACE_PATH),
      readers: (url) => follows.relays[url]?.reader ?? readersOf(reviews)(url),
      writers: (url) => follows.relays[url]?.writer ?? writersOf(reviews)(url),
    });
    await screen.findByRole("heading", { level: 3, name: "Sol" });
    return { ...app, reviews, follows, me, list };
  }

  /** A reviewer's review, by their name over it. */
  const reviewOf = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("article")!;
  /**
   * The two polite statuses under a review's Follow: the first says how a change went wrong and who
   * is no longer followed; the second, what a follow means for the person's circle.
   */
  const changeSaid = (review: HTMLElement) => within(review).getAllByRole("status")[0]!;
  const circleSaid = (review: HTMLElement) => within(review).getAllByRole("status")[1]!;
  const followIn = (name: string) => within(reviewOf(name)).queryByRole("button", { name: copy.follow.followNamed(name) });
  /** No element around `control`, up to the page, cuts off what overflows it: the room to tap that it has beyond its pill is not clipped. */
  function expectNothingCutsOff(control: HTMLElement): void {
    for (let around = control.parentElement; around !== null && around !== document.body; around = around.parentElement) {
      expect(around.getAttribute("class") ?? "", around.tagName).not.toMatch(/(?:^|\s)(?:overflow-|truncate|line-clamp-)/);
    }
  }
  /** How many times each follow-list relay was asked for a follow list. */
  const listReads = (follows: FollowWorld) => FOLLOW_RELAYS.map((url) => follows.relays[url]!.asked.filter(asksForList).length);
  /** The newest follow list the relay at `url` holds. */
  const newestOn = (follows: FollowWorld, url: string) =>
    follows.relays[url]!.held.filter((event) => event.kind === 3).sort((a, b) => b.created_at - a.created_at)[0];

  it("makes each reviewer's name a link to their page: one inside the view, one folded, and the person's own", async () => {
    const user = person();
    const { router, me } = await openPlace();
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));

    for (const [name, pubkey] of [
      ["Fay", FRIEND],
      ["Sol", STRANGER],
      ["Odile", OUTSIDER],
      ["Maya", me!.pubkey],
    ] as const) {
      const link = within(reviewOf(name)).getByRole("link", { name });
      expect(link).toHaveAttribute("href", personPath(pubkey));
      expect(link.getAttribute("href")).toBe(`/person/${toNpub(pubkey)}`);
      // The name is the review's heading still, and a touch target: a line 40 px tall, as the picture
      // beside it is on a phone, with 2 px of its own over and under it that take no room in the row.
      expect(screen.getByRole("heading", { level: 3, name })).toContainElement(link);
      expect(link).toHaveClass("leading-10", "py-0.5", "-my-0.5", "min-w-touch");
    }

    await user.click(within(reviewOf("Sol")).getByRole("link", { name: "Sol" }));
    expect(router.state.location.pathname).toBe(personPath(STRANGER));
  });

  it("links the names for someone signed out too, and shows no Follow: nobody's list is read", async () => {
    const user = person();
    const { follows } = await openPlace({ signIn: false });
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));

    for (const [name, pubkey] of [
      ["Fay", FRIEND],
      ["Sol", STRANGER],
      ["Odile", OUTSIDER],
    ] as const) {
      expect(within(reviewOf(name)).getByRole("link", { name })).toHaveAttribute("href", personPath(pubkey));
      expect(within(reviewOf(name)).queryByRole("button")).not.toBeInTheDocument();
    }
    expect(screen.queryByText(copy.follow.follow)).not.toBeInTheDocument();
    expect(listReads(follows)).toEqual([0, 0, 0]);
  });

  it("shows Follow beside a reviewer the person does not follow, folded or not, and none beside one they follow, nor on their own review", async () => {
    const user = person();
    const { follows } = await openPlace();
    await waitFor(() => expect(followIn("Sol")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));

    const follow = followIn("Sol")!;
    expect(follow).toHaveTextContent(copy.follow.follow);
    // A pill 28 px tall (ruling R46), with 44 px to tap that is the button's own and is not seen.
    expect(follow).toHaveClass("h-7", "relative", "after:absolute", "after:min-h-touch", "after:min-w-touch");
    // Beside the name: in the review's first row, after the name and before when it was written.
    const row = follow.parentElement!;
    expect(row).toContainElement(screen.getByRole("heading", { level: 3, name: "Sol" }));
    expect(row).toContainElement(reviewOf("Sol").querySelector("time"));
    // Nothing around the button cuts off what overflows it: the room to tap is all there.
    expectNothingCutsOff(follow);
    // A folded reviewer has it as anyone has, and nothing says whether the view counts them.
    expect(followIn("Odile")).toHaveTextContent(copy.follow.follow);
    expect(followIn("Odile")!.className).toBe(follow.className);
    expect(reviewOf("Odile")).toHaveAttribute("data-folded", "true");
    // Followed already, and the person themself: no button, of any kind.
    expect(within(reviewOf("Fay")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(reviewOf("Maya")).queryByRole("button", { name: /follow/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(copy.follow.follow)).toHaveLength(2);
    // The list was read once, for all of them, and nothing was changed.
    expect(listReads(follows)).toEqual([1, 1, 1]);
    expect(change).not.toHaveBeenCalled();
    expectNoNumbersAboutPeople(RANKS);
  });

  it("shows no Follow until the person's list has been read", async () => {
    config.reviewRelays = [SEARCH];
    const reviews = newWorld();
    const me = signedIn(reviews, { name: "Maya" });
    const follows = everywhere([buildFollowList(me.key)]);
    const answer = gate();
    for (const url of FOLLOW_RELAYS) follows.relays[url]!.holds = answer.closed;
    reviews.search.push(profileOf(STRANGER, "Sol"), reviewBy(STRANGER, 4, "Sit outside"));
    reviews.ranks.push(rankOf(STRANGER, RANKS[1]!));
    await openApp(PLACE_PATH, {
      events: places,
      readers: (url) => follows.relays[url]?.reader ?? readersOf(reviews)(url),
      writers: (url) => follows.relays[url]?.writer ?? writersOf(reviews)(url),
    });
    await screen.findByRole("heading", { level: 3, name: "Sol" });
    await waitFor(() => expect(listReads(follows)).toEqual([1, 1, 1]));

    expect(followIn("Sol")).not.toBeInTheDocument();

    await answer.open();
    await waitFor(() => expect(followIn("Sol")).toBeInTheDocument());
  });

  it.each([
    ["a reviewer inside the view", "Sol", STRANGER],
    ["a folded reviewer", "Odile", OUTSIDER],
  ])("follows %s on a tap, by the one safe change: one entry more in the list, and the line for a person with a circle", async (_, name, pubkey) => {
    const user = person();
    const { follows, me, list } = await openPlace({ circle: "ready" });
    await user.click(screen.getByRole("button", { name: copy.reviews.show }));
    await waitFor(() => expect(followIn(name)).toBeInTheDocument());
    const button = followIn(name)!;

    await user.click(button);

    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    expect(button).toHaveAccessibleName(copy.follow.followingNamed(name));
    expect(button).toHaveFocus();
    // The list every follow-list relay holds now is the old one and the one entry.
    expect(change).toHaveBeenCalledTimes(1);
    expect(me!.addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) {
      expect(follows.relays[url]!.writer.published).toHaveLength(1);
      expect(newestOn(follows, url)?.tags).toEqual([...list!.tags, ["p", pubkey]]);
      expect(newestOn(follows, url)?.content).toBe(list!.content);
    }
    // Under the review's first row, politely: what the follow means, in the same words for a folded
    // reviewer as for anyone, with Update now. Nothing was asked of Brainstorm.
    expect(changeSaid(reviewOf(name))).toBeEmptyDOMElement();
    expect(circleSaid(reviewOf(name)).textContent).toBe(copy.follow.countsAfterUpdate);
    expect(within(reviewOf(name)).getByRole("button", { name: copy.follow.updateNow })).toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([0, 0, 0, 0]);
    // The other reviewer's button is as it was, and nobody has a number.
    const other = name === "Sol" ? "Odile" : "Sol";
    expect(followIn(other)).toHaveTextContent(copy.follow.follow);
    expectNoNumbersAboutPeople(RANKS);
  });

  it.each([
    ["a phone, by two taps of a finger", PHONE],
    ["a desktop, by a mouse that leaves the button and comes back", DESKTOP],
  ])("follows a reviewer, and then unfollows them on %s: Unfollow is shown before it is done, and the list on every relay is as it was before the follow", async (_, px) => {
    const user = person();
    const { follows, me, list } = await openPlace({ px });
    await waitFor(() => expect(followIn("Sol")).toBeInTheDocument());
    const button = followIn("Sol")!;
    const press = () => (px === PHONE ? tap(user, button) : user.click(button));
    /** What every follow-list relay has been sent, and the newest list it holds. */
    const onEachRelay = (sent: number, tags: string[][]) => {
      for (const url of FOLLOW_RELAYS) {
        expect(follows.relays[url]!.writer.published).toHaveLength(sent);
        expect(newestOn(follows, url)?.tags).toEqual(tags);
        expect(newestOn(follows, url)?.content).toBe(list!.content);
      }
    };

    // Followed: one entry more.
    await press();
    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    onEachRelay(1, [...list!.tags, ["p", STRANGER]]);

    if (px === PHONE) {
      // The first tap shows Unfollow, and nothing is signed or sent. A screen reader is told so (ruling R48).
      await tap(user, button);
      expect(changeSaid(reviewOf("Sol"))).toHaveTextContent(copy.follow.pressAgain("Sol"));
    } else {
      // The pointer is on it still, and it says Following. It leaves and comes back: Unfollow.
      await user.pointer({ target: button });
      expect(button).toHaveTextContent(copy.follow.following);
      await user.unhover(button);
      await user.hover(button);
      expect(changeSaid(reviewOf("Sol"))).toBeEmptyDOMElement();
    }
    expect(button).toHaveTextContent(copy.follow.unfollow);
    expect(button).toHaveAccessibleName(copy.follow.unfollowNamed("Sol"));
    // The same pill, in the accent now: no wider, no taller, and where it was in the row.
    expect(button).toHaveClass("h-7", "border-accent", "text-accent");
    expect(button.parentElement).toContainElement(screen.getByRole("heading", { level: 3, name: "Sol" }));
    expect(change).toHaveBeenCalledTimes(1);
    expect(me!.addOn.signEvent).toHaveBeenCalledTimes(1);
    onEachRelay(1, [...list!.tags, ["p", STRANGER]]);

    // The press on Unfollow: the one safe change again, and the list is as it was before the follow.
    await after(UNFOLLOW_GUARD_MS);
    await press();
    await waitFor(() => expect(button).toHaveTextContent(copy.follow.follow));
    expect(change).toHaveBeenCalledTimes(2);
    expect(change.mock.calls[1]![1]).toBe(STRANGER);
    expect(change.mock.calls[1]![2]).toBe("unfollow");
    expect(me!.addOn.signEvent).toHaveBeenCalledTimes(2);
    onEachRelay(2, list!.tags);
    // And the way back is offered under the review's first row, as before.
    expect(changeSaid(reviewOf("Sol"))).toHaveTextContent(copy.follow.unfollowed("Sol"));
    expect(within(reviewOf("Sol")).getByRole("button", { name: copy.follow.undo })).toBeInTheDocument();
    // The other reviewer's button is as it was, and nobody has a number.
    expect(within(reviewOf("Fay")).queryByRole("button")).not.toBeInTheDocument();
    expectNoNumbersAboutPeople(RANKS);
  });

  it("says it counts once the circle is built, with Personalize, for a person with no circle", async () => {
    config.features.circle = true;
    const user = person();
    await openPlace();
    await waitFor(() => expect(followIn("Sol")).toBeInTheDocument());
    const button = followIn("Sol")!;
    // The tab's one look for a circle built before found none.
    await waitFor(() => expect(askedOfBrainstorm()).toEqual([1, 0, 0, 0]));

    await user.click(button);

    await waitFor(() => expect(button).toHaveTextContent(copy.follow.following));
    expect(circleSaid(reviewOf("Sol"))).toHaveTextContent(copy.follow.countsOnceBuilt);
    expect(within(reviewOf("Sol")).getByRole("button", { name: copy.follow.personalize })).toBeInTheDocument();
    expect(askedOfBrainstorm()).toEqual([1, 0, 0, 0]);
    expectNoNumbersAboutPeople(RANKS);
  });

  it.each([
    ["a phone, where the form takes the page's place", PHONE],
    ["a desktop, where the form is a dialog over the page", DESKTOP],
  ])("keeps Following and its line through the form that reviews the place, on %s, and lets go of both on another page (ruling R21)", async (_, px) => {
    const user = person();
    const { router, reviews } = await openPlace({ px, circle: "ready" });
    await waitFor(() => expect(followIn("Sol")).toBeInTheDocument());
    await user.click(followIn("Sol")!);
    await waitFor(() => expect(circleSaid(reviewOf("Sol"))).toHaveTextContent(copy.follow.countsAfterUpdate));

    // The form opens: the place's address, and the form's under it.
    await user.click(within(screen.getByRole("region", { name: copy.reviews.yours })).getByRole("link", { name: copy.reviews.edit }));
    await waitFor(() => expect(router.state.location.pathname).toBe(REVIEW_PATH));
    await screen.findByRole("radiogroup", { name: copy.review.howWasIt });
    expect(reviews.reviewReads).toBeGreaterThan(0);

    // And closes: the button still says Following, with its line.
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe(PLACE_PATH));
    const sol = await screen.findByRole("heading", { level: 3, name: "Sol" });
    const review = sol.closest("article")!;
    expect(within(review).getByRole("button", { name: copy.follow.followingNamed("Sol") })).toHaveTextContent(copy.follow.following);
    expect(circleSaid(review)).toHaveTextContent(copy.follow.countsAfterUpdate);
    expect(within(review).getByRole("button", { name: copy.follow.updateNow })).toBeInTheDocument();

    // Another page, and back: Sol is followed already, so there is no button, and nothing more to say.
    await act(() => router.navigate("/about"));
    await act(() => router.navigate(PLACE_PATH));
    const back = (await screen.findByRole("heading", { level: 3, name: "Sol" })).closest("article")!;
    expect(within(back).queryByRole("button")).not.toBeInTheDocument();
    expect(within(back).queryByText(copy.follow.countsAfterUpdate)).not.toBeInTheDocument();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("finds Rate this place and the reviews as before: a name that is a link is still the review's heading", async () => {
    const { reviews } = await openPlace({ px: DESKTOP });

    expect(await rateLink(reviews)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent).sort()).toEqual(["Fay", "Maya", "Sol"]);
    expect(screen.getByText("Sit outside")).toBeInTheDocument();
  });
});
