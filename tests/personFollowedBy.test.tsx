import type { NostrEvent } from "@nostrify/nostrify";
import { act, screen, waitFor, within } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { type JSX, StrictMode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "../src/account/AccountProvider";
import * as client from "../src/circle/brainstorm";
import { copy } from "../src/copy/en";
import { changeFollow } from "../src/follow/change";
import { FOLLOW_READ_MS } from "../src/follow/read";
import { useOwnFollowed } from "../src/follow/FollowProvider";
import { useFollowedBy } from "../src/person/useFollowedBy";
import { FOLLOW_LIST_TIME, FOLLOWED_IN_LIST, pubkeyAt } from "./fixtures/follow-list";
import { DESKTOP, PHONE } from "./support/app";
import { hex64 } from "./support/events";
import { gate, installAddOn, openPageInShell, signedInAs, signedInNow, tapSession } from "./support/followPage";
import { after, endScene, type Logs, person, startScene } from "./support/followScene";
import { asksForFollower, asksForList, asksForProfile, BIG, DIRECTORY, failingWhen, FOLLOW_RELAYS, NOS, relay, type RelayOptions, world } from "./support/followWorld";
import { expectNoNumbersAboutPeople } from "./support/noNumbers";
import { ANA, at, BEN, bothHold, CLEO, DEV, ELI, expectNoProtocolWords, FLO, followButton, followedByLine, followerAsks, followerReads, followingButton, FRIEND_PROFILES, header, JACAFE, listBy, lists, main, MAYA, MAYA_LIST, MAYA_SECRET, mayaFollows, openFollowedBy, openSol, reviewsPart, scene, SOL, SOL_SECRET, solOn, ZED } from "./support/personScene";
import { profileOf, wholeText } from "./support/reviewWorld";

/*
 * Who follows a person, among the people the person signed in follows: the line under the person's
 * name on their page (src/person/useFollowedBy.ts, src/person/PersonPage.tsx). Names, three at most,
 * and never how many (decision 19); what is asked of the follow-list relays; and that an answer is
 * for one person signed in and one person's page, and is never drawn for another.
 * (tests/personPage.test.tsx has the page's frame.)
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

let logs: Logs;

beforeEach(() => {
  logs = startScene(change, brainstorm);
});

afterEach(() => endScene(logs));

describe("who follows a person, among the people the person signed in follows", () => {
  const EVERYONE = [ANA, BEN, CLEO, DEV, ELI, ZED];

  it.each([
    ["one", [ANA], "Followed by Ana, who you follow"],
    ["two", [ANA, BEN], "Followed by Ana and Ben, people you follow"],
    ["three", [ANA, BEN, CLEO], "Followed by Ana, Ben and Cleo, people you follow"],
    ["five: three names, and never how many more", [ANA, BEN, CLEO, DEV, ELI], "Followed by Ana, Ben and Cleo, people you follow"],
  ])("names them under the person's name: %s", async (_, followers, words) => {
    const { s } = await openFollowedBy(EVERYONE, followers);

    const line = await within(header()).findByText(wholeText(words));
    expect(line.tagName).toBe("P");
    // Each name is kept apart from the direction of the words around it, and drawn heavier than them:
    // whatever a name is written like, it reads as a name (ruling R36).
    const drawnNames = [...line.querySelectorAll("bdi")];
    expect(drawnNames.map((name) => name.textContent)).toEqual(words.match(/Ana|Ben|Cleo/g));
    for (const name of drawnNames) expect(name).toHaveClass("font-semibold");
    expect(line).not.toHaveClass("font-semibold", "font-bold");
    // Under the name, and in the trust colour: it is about whom the person trusts.
    expect(within(main()).getByRole("heading", { level: 1 }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line).toHaveClass("text-trust");
    // No number, and no word that stands for one: not of the names left out, nor of anything else about Sol.
    expect(line.textContent).not.toMatch(/\d|other|more|\+|…/i);
    expect(main()).not.toHaveTextContent(/Dev|Eli/);
    expectNoNumbersAboutPeople([]);
    expectNoProtocolWords();
    // It read, and wrote nothing.
    expect(change).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("draws a follower whose name is written like a count as a name: heavier than the line's words, and nothing else of the line is", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({ follows: [mayaFollows([ANA, BEN]), listBy(ANA, [SOL]), listBy(BEN, [SOL])] });
    s.search.held.push(profileOf(ANA, "Ana"), profileOf(BEN, "12 others"));
    await openSol(s);

    const line = await within(header()).findByText(wholeText("Followed by Ana and 12 others, people you follow"));
    const heavy = [...line.querySelectorAll(".font-semibold")].map((each) => each.textContent);
    expect(heavy).toEqual(["Ana", "12 others"]);
    expect([...line.querySelectorAll("bdi")].map((each) => each.textContent)).toEqual(heavy);
  });

  it("keeps a long name with no break in it inside the page: the line breaks it where it must", async () => {
    signedInAs(MAYA_SECRET);
    const unbroken = "Bartholomew".repeat(6).slice(0, 60);
    expect(unbroken).toHaveLength(60);
    const s = scene({ follows: [mayaFollows([ANA]), listBy(ANA, [SOL])] });
    s.search.held.push(profileOf(ANA, unbroken));
    await openSol(s);

    const line = await within(header()).findByText(wholeText(`Followed by ${unbroken}, who you follow`));
    expect(line).toHaveClass("wrap-break-word");
    // As the page's heading does, for the person's own name.
    expect(within(main()).getByRole("heading", { level: 1 })).toHaveClass("wrap-break-word");
  });

  it("names them in the order of the person's own list, whatever the relays send first", async () => {
    signedInAs(MAYA_SECRET);
    // Cleo's list is the newest and Ana's the oldest: a relay sends Cleo's first. Maya's list has Ben first.
    const s = scene({ follows: [mayaFollows([ZED, BEN, CLEO, ANA]), listBy(ANA, [SOL], 10), listBy(BEN, [SOL], 20), listBy(CLEO, [SOL], 30)] });
    s.search.held.push(...FRIEND_PROFILES);
    await openSol(s);

    expect(await within(header()).findByText(wholeText("Followed by Ben, Cleo and Ana, people you follow"))).toBeInTheDocument();
  });

  it("leaves out a follower whose profile gives no name, and never calls them Someone", async () => {
    await openFollowedBy([FLO, ANA, ZED], [FLO, ANA]);

    expect(await within(header()).findByText(wholeText("Followed by Ana, who you follow"))).toBeInTheDocument();
    expect(header()).not.toHaveTextContent(copy.reviews.someone);
  });

  it("says nothing when the only followers have no name", async () => {
    const { s } = await openFollowedBy([FLO, ZED], [FLO]);
    await waitFor(() => expect(s.search.asked.filter(asksForProfile).some((filter) => filter.authors?.includes(FLO))).toBe(true));
    await after(1_000);

    expect(followedByLine()).not.toBeInTheDocument();
    expect(header()).not.toHaveTextContent(copy.reviews.someone);
  });

  it("never names the person themself, nor the one whose page it is", async () => {
    signedInAs(MAYA_SECRET);
    // Maya follows herself and Sol, as people do; both lists name Sol.
    const s = scene({ follows: [mayaFollows([MAYA, SOL, ANA]), listBy(SOL, [SOL]), listBy(ANA, [SOL])] });
    s.search.held.push(...FRIEND_PROFILES);
    await openSol(s);

    expect(await within(header()).findByText(wholeText("Followed by Ana, who you follow"))).toBeInTheDocument();
    // Neither was asked about.
    expect(followerAsks(s.follows.relays[NOS]!).map((filter) => filter.authors)).toEqual([[ANA]]);
  });

  it("is left out when none of the people the person follows follows them", async () => {
    const { s } = await openFollowedBy(EVERYONE, []);
    await waitFor(() => expect(followerAsks(s.follows.relays[NOS]!)).toHaveLength(1));
    await after(1_000);

    expect(followedByLine()).not.toBeInTheDocument();
    expect(header()).not.toHaveTextContent(/Followed/);
  });

  it("is left out, and nothing is asked, for someone signed out", async () => {
    const s = scene({ follows: [listBy(ANA, [SOL])] });
    s.search.held.push(...FRIEND_PROFILES);
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s);
    await lists([JACAFE]);
    await after(1_000);

    expect(followedByLine()).not.toBeInTheDocument();
    expect(s.follows.asked()).toEqual([]);
  });

  it("is left out, and nothing is asked, when the person follows nobody", async () => {
    const { s } = await openFollowedBy([], [ANA]);
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    await after(1_000);

    expect(followedByLine()).not.toBeInTheDocument();
    expect(s.follows.asked().filter(asksForFollower)).toEqual([]);
  });

  it("is left out, and nothing is asked, on the person's own page", async () => {
    signedInAs(SOL_SECRET);
    const s = scene({
      follows: [finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", ANA]] }, SOL_SECRET), listBy(ANA, [SOL])],
    });
    s.search.held.push(...FRIEND_PROFILES);
    await openSol(s);
    await within(header()).findByText(copy.person.you);
    await after(1_000);

    expect(followedByLine()).not.toBeInTheDocument();
    expect(s.follows.asked().filter(asksForFollower)).toEqual([]);
  });

  it("is not there until it has been read: nothing stands in for it, and the page waits for nothing", async () => {
    signedInAs(MAYA_SECRET);
    const held = gate();
    const slow = followerReads({ until: held.closed });
    const lists3 = [mayaFollows([ANA]), listBy(ANA, [SOL])];
    const s = scene({ followRelays: Object.fromEntries(FOLLOW_RELAYS.map((url) => [url, relay(lists3, { reads: slow.reads })])) });
    s.search.held.push(...FRIEND_PROFILES);
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s);
    await waitFor(() => expect(slow.asks).toHaveLength(3));

    // The rest of the page is all there meanwhile.
    await lists([JACAFE]);
    expect(followButton()).toBeInTheDocument();
    expect(followedByLine()).not.toBeInTheDocument();

    await held.open();

    expect(await within(header()).findByText(wholeText("Followed by Ana, who you follow"))).toBeInTheDocument();
  });
});

describe("how who follows a person is read", () => {
  it("asks the follow-list relays alone, for the lists of the person's follows that name them: 500 of them to a request, in the order of their list", async () => {
    signedInAs(MAYA_SECRET);
    // Her list of 1,200 entries: every key it names, in its order, each once.
    const s = scene({ follows: [MAYA_LIST] });
    await openSol(s);
    await waitFor(() => expect(followerAsks(s.follows.relays[NOS]!)).toHaveLength(3));

    expect(FOLLOWED_IN_LIST.length).toBeGreaterThan(1_000);
    for (const url of FOLLOW_RELAYS) {
      expect(followerAsks(s.follows.relays[url]!)).toEqual([
        { kinds: [3], authors: FOLLOWED_IN_LIST.slice(0, 500), "#p": [SOL], limit: 500 },
        { kinds: [3], authors: FOLLOWED_IN_LIST.slice(500, 1_000), "#p": [SOL], limit: 500 },
        { kinds: [3], authors: FOLLOWED_IN_LIST.slice(1_000), "#p": [SOL], limit: FOLLOWED_IN_LIST.length - 1_000 },
      ]);
    }
    // No review relay is asked who follows anyone, and nobody else's list is asked for whole.
    expect([...s.search.asked, ...s.second.asked].filter((filter) => filter.kinds?.includes(3))).toEqual([]);
    expect(s.follows.asked().filter((filter) => asksForList(filter) && filter["#p"] === undefined).every((filter) => filter.authors?.length === 1 && filter.authors[0] === MAYA)).toBe(true);
    expect(followedByLine()).not.toBeInTheDocument();
    expect(s.follows.published()).toEqual([]);
  });

  it("asks about the first 1,500 of the person's follows and no more", async () => {
    signedInAs(MAYA_SECRET);
    const many = Array.from({ length: 1_700 }, (_, i) => pubkeyAt(40_000 + i));
    // The 1,600th follows Sol: past what is asked about.
    const s = scene({ follows: [mayaFollows(many), listBy(many[1_599]!, [SOL])] });
    s.search.held.push(profileOf(many[1_599]!, "Past the end"));
    await openSol(s);
    await waitFor(() => expect(followerAsks(s.follows.relays[NOS]!)).toHaveLength(3));
    await after(1_000);

    expect(followerAsks(s.follows.relays[NOS]!).map((filter) => filter.authors)).toEqual([many.slice(0, 500), many.slice(500, 1_000), many.slice(1_000, 1_500)]);
    expect(followedByLine()).not.toBeInTheDocument();
  });

  it("asks about no more of the person's follows once it has read as many names as it will: those it could not name are not asked about", async () => {
    signedInAs(MAYA_SECRET);
    // The first 30 of 600 follows follow Sol, and none of those has a name; one in the second 500 does, and has.
    const many = Array.from({ length: 600 }, (_, i) => pubkeyAt(40_000 + i));
    const s = scene({ follows: [mayaFollows(many), ...many.slice(0, 30).map((author) => listBy(author, [SOL])), listBy(many[550]!, [SOL])] });
    s.search.held.push(profileOf(many[550]!, "In the second batch"));
    await openSol(s);
    await waitFor(() => expect(s.search.asked.filter(asksForProfile).filter((filter) => filter.authors?.includes(many[0]!) || filter.authors?.includes(many[10]!) || filter.authors?.includes(many[20]!))).toHaveLength(3));
    await after(1_000);

    // Thirty followers' names were read, ten at a time, and none had one: the reading ends there.
    expect(followerAsks(s.follows.relays[NOS]!).map((filter) => filter.authors?.length)).toEqual([500]);
    expect(s.search.asked.filter(asksForProfile).some((filter) => filter.authors?.includes(many[550]!))).toBe(false);
    expect(followedByLine()).not.toBeInTheDocument();
  });

  it("asks no further once it has three names", async () => {
    signedInAs(MAYA_SECRET);
    const many = Array.from({ length: 700 }, (_, i) => pubkeyAt(40_000 + i));
    const s = scene({ follows: [mayaFollows([ANA, BEN, CLEO, ...many]), listBy(ANA, [SOL]), listBy(BEN, [SOL]), listBy(CLEO, [SOL]), listBy(many[600]!, [SOL])] });
    s.search.held.push(...FRIEND_PROFILES, profileOf(many[600]!, "Later"));
    await openSol(s);

    expect(await within(header()).findByText(wholeText("Followed by Ana, Ben and Cleo, people you follow"))).toBeInTheDocument();
    await after(1_000);
    expect(followerAsks(s.follows.relays[NOS]!)).toHaveLength(1);
  });

  it("counts a follower by the newest of their lists that the relays send: one who has taken the person out since is not named", async () => {
    signedInAs(MAYA_SECRET);
    const lists2 = [mayaFollows([ANA, BEN])];
    // One relay still has the lists that named Sol; another, which takes no notice of whom a list names, has Ana's newer one, which does not.
    const s = scene({
      followRelays: {
        [NOS]: relay([...lists2, listBy(ANA, [SOL], 10), listBy(BEN, [SOL], 10)]),
        [BIG]: relay([...lists2, listBy(ANA, [ZED], 50), listBy(BEN, [SOL], 10)], {
          reads: (reader) => ({
            async *req(filter, signal) {
              const { "#p": _, ...rest } = filter;
              yield* reader.req(rest, signal);
            },
          }),
        }),
        [DIRECTORY]: relay(lists2),
      },
    });
    s.search.held.push(...FRIEND_PROFILES);
    await openSol(s);

    expect(await within(header()).findByText(wholeText("Followed by Ben, who you follow"))).toBeInTheDocument();
  });

  it("leaves out a follow-list relay that does not answer in time, and names whom the others have", async () => {
    signedInAs(MAYA_SECRET);
    const held = [mayaFollows([ANA]), listBy(ANA, [SOL])];
    const stalled = followerReads("silent");
    const s = scene({
      followRelays: {
        [NOS]: relay(held),
        [BIG]: relay(held, { reads: stalled.reads }),
        [DIRECTORY]: relay(held),
      },
    });
    s.search.held.push(...FRIEND_PROFILES);
    await openSol(s);
    await waitFor(() => expect(stalled.asks).toHaveLength(1));
    await waitFor(() => expect(followerAsks(s.follows.relays[NOS]!)).toHaveLength(1));
    expect(followedByLine()).not.toBeInTheDocument();

    await after(FOLLOW_READ_MS);

    expect(await within(header()).findByText(wholeText("Followed by Ana, who you follow"))).toBeInTheDocument();
  });

  it("shows nothing and says nothing when it cannot be read, and does not ask again", async () => {
    signedInAs(MAYA_SECRET);
    const held = [mayaFollows([ANA]), listBy(ANA, [SOL])];
    const down = followerReads("fails");
    const s = scene({ followRelays: Object.fromEntries(FOLLOW_RELAYS.map((url) => [url, relay(held, { reads: down.reads })])) });
    s.search.held.push(...FRIEND_PROFILES);
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    await openSol(s);
    await waitFor(() => expect(down.asks).toHaveLength(3));
    await lists([JACAFE]);
    await after(FOLLOW_READ_MS * 3);

    expect(followedByLine()).not.toBeInTheDocument();
    // The page is whole without it: the button, the reviews, and no word of what could not be read.
    expect(followButton()).toBeInTheDocument();
    expect(main()).not.toHaveTextContent(/couldn't|could not|try again/i);
    // Each relay was asked once, and not again.
    expect(down.asks).toHaveLength(3);
    expect(s.search.asked.filter(asksForProfile).some((filter) => filter.authors?.includes(ANA))).toBe(false);
  });

  it("shows nothing when the followers' names cannot be read", async () => {
    signedInAs(MAYA_SECRET);
    const s = scene({
      follows: [mayaFollows([ANA]), listBy(ANA, [SOL])],
      search: { reads: failingWhen((filter) => asksForProfile(filter) && filter.authors?.includes(ANA) === true) },
      second: { reads: failingWhen((filter) => asksForProfile(filter) && filter.authors?.includes(ANA) === true) },
    });
    s.search.held.push(...FRIEND_PROFILES);
    await openSol(s);
    await waitFor(() => expect(followerAsks(s.follows.relays[NOS]!)).toHaveLength(1));
    await after(1_000);

    expect(followedByLine()).not.toBeInTheDocument();
    expect(header()).not.toHaveTextContent(copy.reviews.someone);
  });

  it("stops when the person leaves the page, and takes nothing that comes after", async () => {
    signedInAs(MAYA_SECRET);
    const held = gate();
    const slow = followerReads({ until: held.closed });
    const lists3 = [mayaFollows([ANA]), listBy(ANA, [SOL])];
    const s = scene({ followRelays: Object.fromEntries(FOLLOW_RELAYS.map((url) => [url, relay(lists3, { reads: slow.reads })])) });
    s.search.held.push(...FRIEND_PROFILES);
    const { router } = await openSol(s);
    await waitFor(() => expect(slow.signals).toHaveLength(3));
    expect(slow.signals.every((signal) => !signal.aborted)).toBe(true);

    await act(() => router.navigate("/about"));

    expect(slow.signals.every((signal) => signal.aborted)).toBe(true);
    await held.open();
    expect(await screen.findByRole("heading", { level: 1, name: copy.about.title })).toBeInTheDocument();
    expect(s.search.asked.filter(asksForProfile).some((filter) => filter.authors?.includes(ANA))).toBe(false);
  });

  it("is not read again, and stays as it is, when the person follows the one whose page it is", async () => {
    const { s } = await openFollowedBy([ANA, ZED], [ANA]);
    const user = person();
    const line = await within(header()).findByText(wholeText("Followed by Ana, who you follow"));
    let gone = false;
    const watch = new MutationObserver(() => {
      if (!line.isConnected) gone = true;
    });
    watch.observe(document.body, { subtree: true, childList: true });

    await user.click(followButton()!);
    await waitFor(() => expect(followingButton()).toBeInTheDocument());
    await after(1_000);

    watch.disconnect();
    expect(gone).toBe(false);
    expect(line).toHaveTextContent("Followed by Ana, who you follow");
    for (const url of FOLLOW_RELAYS) expect(followerAsks(s.follows.relays[url]!)).toHaveLength(1);
  });

  it("is in the header on a desktop too, under the name, and the button is in the rail", async () => {
    await openFollowedBy([ANA, BEN], [ANA, BEN], { px: DESKTOP });

    const line = await within(header()).findByText(wholeText("Followed by Ana and Ben, people you follow"));
    expect(within(main()).getByRole("heading", { level: 1 }).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(followButton()).toBeInTheDocument());
    expect(header()).not.toContainElement(followButton());
  });

  it.each([
    ["a phone", PHONE],
    ["a desktop", DESKTOP],
  ])("is read after the name and before the Follow button, with the reviews last, on %s (ruling R34)", async (_, px) => {
    await openFollowedBy([ANA, BEN], [ANA, BEN], { px });
    const line = await within(main()).findByText(wholeText("Followed by Ana and Ben, people you follow"));
    await waitFor(() => expect(followButton()).toBeInTheDocument());

    // The order a keyboard and a screen reader meet them in: the heading, which has the focus on arrival, and then the page's one action.
    const inOrder = [within(main()).getByRole("heading", { level: 1 }), line, followButton()!, reviewsPart()];
    for (let at = 1; at < inOrder.length; at++) {
      expect(inOrder[at - 1]!.compareDocumentPosition(inOrder[at]!) & Node.DOCUMENT_POSITION_FOLLOWING, `part ${at} is after part ${at - 1}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// An answer is for one person signed in, and one person's page.
// ---------------------------------------------------------------------------------------------

describe("who follows a person: an answer that is no longer the answer", () => {
  /** A second person who signs in, Noor, and a second person whose page it is, Odile. */
  const NOOR_SECRET = generateSecretKey();
  const NOOR = getPublicKey(NOOR_SECRET);
  const ODILE = hex64("d");
  const whoIs = (key: string | undefined) => (key === undefined ? "nobody" : key === MAYA ? "maya" : key === NOOR ? "noor" : "someone else");

  /** Every drawing of the names that reached the page, in order: who was signed in, whose page it was, and the names. */
  let drawn: string[];

  /** A page's part that names who follows `whose`, as the page's own does, and notes each drawing of it that reaches the page. */
  function Names({ whose }: { whose: string }): JSX.Element {
    const { account } = useAccount();
    const names = useFollowedBy(whose);
    const said = names.join(", ");
    useLayoutEffect(() => {
      drawn.push(`${whoIs(account?.pubkey)} looks at ${whose === SOL ? "sol" : "odile"}: ${said}`);
    });
    return <output data-testid="names">{said}</output>;
  }

  /** Sol's page, with a way to go straight to Odile's: the same part of the page, for another person. */
  function Pages(): JSX.Element {
    const [whose, setWhose] = useState(SOL);
    return (
      <>
        <button type="button" onClick={() => setWhose(ODILE)}>
          to odile
        </button>
        <Names whose={whose} />
      </>
    );
  }

  const names = () => screen.getByTestId("names").textContent;
  /** The drawings made for `who` looking at `whose` page. */
  const drawnFor = (who: string, whose: string) => drawn.filter((each) => each.startsWith(`${who} looks at ${whose}: `)).map((each) => each.split(": ")[1]);

  /** The relays: each follow-list relay holds `lists`, read as `opts` says, and the review relay the friends' profiles. */
  const relays = (lists: NostrEvent[], opts: RelayOptions = {}) =>
    world(Object.fromEntries(FOLLOW_RELAYS.map((url) => [url, relay(lists, opts)])), relay(FRIEND_PROFILES));

  beforeEach(() => {
    drawn = [];
  });

  it("is let go of when the page is another person's: nothing of the one before is drawn, not for one drawing", async () => {
    signedInAs(MAYA_SECRET);
    // Ana follows Sol, and Ben follows Odile. What is asked about Odile waits.
    const held = gate();
    const w = relays([mayaFollows([ANA, BEN]), listBy(ANA, [SOL]), listBy(BEN, [ODILE])], {
      reads: (reader) => ({
        async *req(filter, signal) {
          if (asksForFollower(filter) && filter["#p"]?.includes(ODILE)) await held.closed;
          yield* reader.req(filter, signal);
        },
      }),
    });
    await openPageInShell(w, <Pages />);
    await waitFor(() => expect(names()).toBe("Ana"));

    await person().click(screen.getByRole("button", { name: "to odile" }));

    expect(names()).toBe("");
    expect(drawnFor("maya", "odile")).toEqual([""]);

    await held.open();

    await waitFor(() => expect(names()).toBe("Ben"));
    expect(new Set(drawnFor("maya", "odile"))).toEqual(new Set(["", "Ben"]));
    expect(w.published()).toEqual([]);
  });

  it("is let go of at sign-out, at once, and nothing more is asked", async () => {
    signedInAs(MAYA_SECRET);
    const w = relays([mayaFollows([ANA]), listBy(ANA, [SOL])]);
    await openPageInShell(w, <Pages />);
    await waitFor(() => expect(names()).toBe("Ana"));
    const asked = w.asked().length;

    tapSession("sign out");

    expect(signedInNow()).toBe("nobody");
    expect(names()).toBe("");
    expect(new Set(drawnFor("nobody", "sol"))).toEqual(new Set([""]));
    await after(1_000);
    expect(names()).toBe("");
    expect(w.asked()).toHaveLength(asked);
  });

  it("is never drawn for the next person to sign in, with no sign-out between: they have their own", async () => {
    signedInAs(MAYA_SECRET);
    // Ana and Ben both follow Sol. Maya follows Ana, and Noor follows Ben.
    const noorFollows = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", BEN]] }, NOOR_SECRET);
    const w = relays([mayaFollows([ANA]), noorFollows, listBy(ANA, [SOL]), listBy(BEN, [SOL])]);
    await openPageInShell(w, <Pages />);
    await waitFor(() => expect(names()).toBe("Ana"));

    // The add-on is Noor's now, who signs in.
    installAddOn(NOOR_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(NOOR));

    await waitFor(() => expect(names()).toBe("Ben"));
    expect(new Set(drawnFor("noor", "sol"))).toEqual(new Set(["", "Ben"]));
    expect(drawn.filter((each) => !each.startsWith("maya ")).some((each) => each.endsWith("Ana"))).toBe(false);
    // Nothing was asked for Noor from Maya's list: the session still holds it for one drawing after
    // Noor signs in, and it is known for Maya's by its owner.
    for (const url of FOLLOW_RELAYS) {
      expect(w.relays[url]!.asked.filter(asksForFollower).map((filter) => filter.authors)).toEqual([[ANA], [BEN]]);
    }
    expect(w.published()).toEqual([]);
  });

  it("takes nothing from a reading begun for the person before, when it ends after the next has signed in", async () => {
    signedInAs(MAYA_SECRET);
    const noorFollows = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", BEN]] }, NOOR_SECRET);
    // What is asked about Maya's follows waits until the test lets it go.
    const held = gate();
    const w = relays([mayaFollows([ANA]), noorFollows, listBy(ANA, [SOL]), listBy(BEN, [SOL])], {
      reads: (reader) => ({
        async *req(filter, signal) {
          if (asksForFollower(filter) && filter.authors?.includes(ANA)) await held.closed;
          yield* reader.req(filter, signal);
        },
      }),
    });
    await openPageInShell(w, <Pages />);
    await waitFor(() => expect(w.relays[NOS]!.asked.filter(asksForList).some((filter) => filter.authors?.[0] === MAYA)).toBe(true));
    await after(100);
    expect(names()).toBe("");

    installAddOn(NOOR_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(NOOR));
    await waitFor(() => expect(names()).toBe("Ben"));

    await held.open();
    await after(1_000);

    expect(names()).toBe("Ben");
    expect(drawn.some((each) => each.endsWith("Ana"))).toBe(false);
  });

  it("reads once in React's strict mode, which runs every effect twice: each relay is asked once, and whom it found is named", async () => {
    signedInAs(MAYA_SECRET);
    const w = relays([mayaFollows([ANA]), listBy(ANA, [SOL])]);
    /** The names' part of the page, drawn only once the person asks: by then their list has been read, so its first effect has a list to read with. */
    function Later(): JSX.Element {
      const [shown, setShown] = useState(false);
      useOwnFollowed();
      return shown ? (
        <Names whose={SOL} />
      ) : (
        <button type="button" onClick={() => setShown(true)}>
          show names
        </button>
      );
    }
    await openPageInShell(w, <Later />, (app) => <StrictMode>{app}</StrictMode>);
    await waitFor(() => expect(w.relays[NOS]!.asked.filter(asksForList).some((filter) => filter.authors?.[0] === MAYA)).toBe(true));
    await after(100);
    await person().click(screen.getByRole("button", { name: "show names" }));

    await waitFor(() => expect(names()).toBe("Ana"));
    await after(1_000);
    // The effect that strict mode stops as soon as it has begun asks nothing.
    for (const url of FOLLOW_RELAYS) expect(w.relays[url]!.asked.filter(asksForFollower)).toHaveLength(1);
    expect(w.reviews.asked.filter(asksForProfile)).toHaveLength(1);
  });
});
