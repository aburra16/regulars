import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectPhone } from "../src/account/connect";
import * as client from "../src/circle/brainstorm";
import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { changeFollow } from "../src/follow/change";
import { FOLLOW_REREAD_MS } from "../src/follow/FollowProvider";
import { personPath } from "../src/person/npub";
import { buildFollowList } from "./fixtures/follow-list";
import { openApp } from "./support/app";
import { MemoryConnectRelay } from "./support/connectRelay";
import { followedNow, forgetFollowedSeen, openSignedIn, ownedNow, says, signedInAs, tap } from "./support/followPage";
import { after, endScene, FRIEND, LIST, type Logs, OUTSIDER, person, SECRET, startScene, STRANGER } from "./support/followScene";
import { everywhere } from "./support/followWorld";
import { noted } from "./support/notedReaders";
import {
  ANA,
  at,
  BEN,
  bothHold,
  followControls,
  followedByLine,
  followLink,
  FRIEND_PROFILES,
  JACAFE,
  listBy,
  lists,
  main,
  MAYA_SECRET,
  mayaFollows,
  readersOf as personReaders,
  scene,
  SOL,
  SOL_PATH,
  SOL_SECRET,
  solOn,
} from "./support/personScene";
import { fromExplore, newWorld, PLACE_PATH, places, profileOf, rankOf, readersOf, reviewBy, SEARCH, signedIn, writersOf } from "./support/reviewWorld";

/*
 * Follow, off (ruling R39; `config.features.follow`): Follow is on for everyone, and this is its off
 * switch, set in src/config.ts and deployed. Off means that nobody's follow list is read or changed
 * by any way in: these count what every relay held in memory was asked, on a place's page and on a
 * person's, and hold the taps to doing nothing. Beside each, the same page with Follow on, which
 * shows that the count would have seen a read.
 *
 * Every other test runs with Follow on (tests/setup.ts). Here each test turns it off itself, and it
 * is put back on after each. `changeFollow` is mocked around the real one, to be counted, and
 * Brainstorm's client is mocked. The keys are thrown away, and nothing opens a socket.
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
  forgetFollowedSeen();
});

afterEach(async () => {
  config.features.follow = true;
  await endScene(logs);
});

/** Long enough for anything that waits before it reads: the wait after a read that could not tell, and more. */
const afterEveryWait = () => after(2 * FOLLOW_REREAD_MS);

describe("a place's page", () => {
  /** Jacafé's page for Maya, signed in, whose list names Fay: with reviews by Fay, by Sol and by Odile, whom the view folds away. */
  async function openPlace() {
    config.reviewRelays = [SEARCH];
    const reviews = newWorld();
    const me = signedIn(reviews, { name: "Maya" });
    const follows = everywhere([buildFollowList(me.key)]);
    reviews.search.push(profileOf(FRIEND, "Fay"), profileOf(STRANGER, "Sol"), profileOf(OUTSIDER, "Odile"));
    reviews.ranks.push(rankOf(FRIEND, 80), rankOf(STRANGER, 70));
    reviews.search.push(reviewBy(FRIEND, 5, "Get the bolo"), reviewBy(STRANGER, 4, "Sit outside"), reviewBy(OUTSIDER, 2, "Too loud"));
    const relays = noted((url) => follows.relays[url]?.reader ?? readersOf(reviews)(url));
    await openApp(PLACE_PATH, {
      events: places,
      entries: fromExplore(PLACE_PATH),
      readers: relays.readers,
      writers: (url) => follows.relays[url]?.writer ?? writersOf(reviews)(url),
    });
    await screen.findByRole("heading", { level: 3, name: "Sol" });
    await person().click(screen.getByRole("button", { name: copy.reviews.show }));
    await screen.findByRole("heading", { level: 3, name: "Odile" });
    return { relays, follows, me };
  }

  const reviewOf = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("article")!;

  it("has no Follow button with Follow off, and no relay was asked for a follow list, or for anything on its account", async () => {
    config.features.follow = false;

    const { relays, follows, me } = await openPlace();
    await afterEveryWait();

    // The reviews are there, each reviewer's name a link to their page, and no button beside any.
    for (const [name, pubkey] of [
      ["Fay", FRIEND],
      ["Sol", STRANGER],
      ["Odile", OUTSIDER],
    ] as const) {
      expect(within(reviewOf(name)).getByRole("link", { name })).toHaveAttribute("href", personPath(pubkey));
      expect(within(reviewOf(name)).queryByRole("button")).not.toBeInTheDocument();
    }
    expect(screen.queryByText(copy.follow.follow)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.follow.following)).not.toBeInTheDocument();
    // No relay was asked for a follow list (kind 3), by anyone or naming anyone; nor for the person's
    // relay list (kind 10002), which is read only to find their follow list; and the relays that keep
    // follow lists were asked nothing at all.
    expect(relays.ofKind(3)).toEqual([]);
    expect(relays.ofKind(10002)).toEqual([]);
    expect(follows.asked()).toEqual([]);
    // The page's own reads went on as ever.
    expect(relays.ofKind(34259).length).toBeGreaterThan(0);
    expect(change).not.toHaveBeenCalled();
    expect(me.addOn.signEvent).not.toHaveBeenCalled();
    expect(follows.published()).toEqual([]);
  });

  it("has the button with Follow on, and the count sees its read: the page above is the same page", async () => {
    const { relays, follows } = await openPlace();

    await waitFor(() => expect(within(reviewOf("Sol")).getByRole("button", { name: copy.follow.followNamed("Sol") })).toBeInTheDocument());
    expect(within(reviewOf("Odile")).getByRole("button", { name: copy.follow.followNamed("Odile") })).toBeInTheDocument();
    expect(relays.ofKind(3)).toHaveLength(3);
    expect(relays.ofKind(10002).length).toBeGreaterThan(0);
    expect(follows.asked().length).toBeGreaterThan(0);
  });
});

describe("a person's page", () => {
  /** Sol's page, over relays on which Ana and Ben, whom Maya follows, follow Sol. */
  async function openSol() {
    const s = scene({ follows: [mayaFollows([ANA, BEN]), listBy(ANA, [SOL]), listBy(BEN, [SOL])] });
    s.search.held.push(...FRIEND_PROFILES);
    bothHold(s, [solOn(JACAFE, 5, "Get the bolo de caco", at(2))]);
    const relays = noted(personReaders(s));
    await openApp(SOL_PATH, { events: places, readers: relays.readers, writers: (url) => s.follows.relays[url]?.writer ?? writersOf(s.house)(url) });
    await screen.findByRole("heading", { level: 1, name: "Sol" });
    await lists([JACAFE]);
    return { relays, s };
  }

  it("has no button, no line of who follows them, and asked for no follow list, with Follow off, for a person signed in", async () => {
    config.features.follow = false;
    const addOn = signedInAs(MAYA_SECRET);

    const { relays, s } = await openSol();
    await afterEveryWait();

    expect(followControls()).toEqual([]);
    expect(followLink()).not.toBeInTheDocument();
    expect(followedByLine()).not.toBeInTheDocument();
    expect(main()).not.toHaveTextContent(/follow/i);
    expect(relays.ofKind(3)).toEqual([]);
    expect(relays.ofKind(10002)).toEqual([]);
    expect(s.follows.asked()).toEqual([]);
    // The page itself is as it was: their name, and their reviews, each a link to its place.
    expect(within(main()).getByRole("heading", { level: 1 })).toHaveTextContent("Sol");
    expect(relays.ofKind(34259).length).toBeGreaterThan(0);
    expect(change).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(s.follows.published()).toEqual([]);
  });

  it("has no link to sign in where the button would be, with Follow off, for someone signed out", async () => {
    config.features.follow = false;

    const { relays, s } = await openSol();
    await afterEveryWait();

    expect(followLink()).not.toBeInTheDocument();
    expect(followControls()).toEqual([]);
    expect(main().querySelector('a[href="/signin"]')).toBeNull();
    expect(followedByLine()).not.toBeInTheDocument();
    expect(relays.ofKind(3)).toEqual([]);
    expect(s.follows.asked()).toEqual([]);
  });

  it("says This is you on the person's own page all the same", async () => {
    config.features.follow = false;
    signedInAs(SOL_SECRET);

    const { relays } = await openSol();

    expect(within(main()).getByText(copy.person.you)).toBeInTheDocument();
    expect(followControls()).toEqual([]);
    expect(relays.ofKind(3)).toEqual([]);
  });

  it("is linked from You as Your reviews with Follow off", async () => {
    config.features.follow = false;
    signedInAs(SOL_SECRET);
    const s = scene();

    await openApp("/you", { events: places, readers: personReaders(s), writers: (url) => writersOf(s.house)(url) });

    await screen.findByRole("heading", { level: 1, name: "Sol" });
    expect(within(main()).getByRole("link", { name: copy.you.yourReviews })).toHaveAttribute("href", SOL_PATH);
  });

  it("has the button and the line with Follow on, and the count sees their reads: the page above is the same page", async () => {
    signedInAs(MAYA_SECRET);

    const { relays } = await openSol();

    await waitFor(() => expect(followedByLine()).toHaveTextContent("Followed by Ana and Ben, people you follow"));
    expect(followControls()).toHaveLength(1);
    // Her own list from each of the three relays, and who of those on it follows Sol from each.
    expect(relays.ofKind(3)).toHaveLength(6);
    expect(relays.ofKind(10002).length).toBeGreaterThan(0);
  });

  it("has the link to sign in with Follow on, for someone signed out", async () => {
    await openSol();

    expect(followLink()).toBeInTheDocument();
  });
});

describe("the taps, with Follow off", () => {
  it("do nothing, whichever is called: nothing is read, signed or sent, and no change is asked for", async () => {
    config.features.follow = false;
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);

    await openSignedIn(w, { stranger: STRANGER, friend: FRIEND }, { lists: true });
    await afterEveryWait();

    // Nothing is known of anyone, as before a list has been read.
    expect(says("stranger")).toBe("unknown");
    expect(says("friend")).toBe("unknown");
    expect(followedNow()).toBeNull();
    expect(ownedNow()).toBeNull();
    for (const name of ["stranger", "friend"]) {
      for (const what of ["follow", "unfollow", "undo", "retry"] as const) tap(name, what);
    }
    await afterEveryWait();

    expect(change).not.toHaveBeenCalled();
    expect(says("stranger")).toBe("unknown");
    expect(says("friend")).toBe("unknown");
    expect(w.asked()).toEqual([]);
    expect(w.published()).toEqual([]);
    expect(addOn.signEvent).not.toHaveBeenCalled();
  });

  it("do nothing once it is turned off under a page that had the list read", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: STRANGER, friend: FRIEND });
    await waitFor(() => expect(says("friend")).toBe("following"));
    const asked = w.asked().length;

    config.features.follow = false;
    for (const name of ["stranger", "friend"]) {
      for (const what of ["follow", "unfollow", "undo", "retry"] as const) tap(name, what);
    }
    await afterEveryWait();

    expect(change).not.toHaveBeenCalled();
    expect(w.asked()).toHaveLength(asked);
    expect(w.published()).toEqual([]);
  });

  it("reach the one change with Follow on: the taps above are the same taps", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: STRANGER });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toContain("following just"));
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe("what a phone app is asked to sign without asking each time", () => {
  /** What the link a phone is shown asks for, by the link itself. */
  async function permsAsked(): Promise<string[] | undefined> {
    const stop = new AbortController();
    let shown!: (uri: string) => void;
    const link = new Promise<string>((resolve) => {
      shown = resolve;
    });
    const account = connectPhone({ onLink: shown, signal: stop.signal, relays: () => new MemoryConnectRelay() });
    const perms = new URL((await link).replace(/^nostrconnect:/, "https:")).searchParams.get("perms")?.split(",");
    stop.abort();
    await expect(account).rejects.toThrow();
    return perms;
  }

  it("is not the follow list with Follow off: who the person is and their reviews, and nothing more", async () => {
    config.features.follow = false;

    expect(await permsAsked()).toEqual(["get_public_key", "sign_event:34259"]);
  });

  it("is the follow list too with Follow on", async () => {
    expect(await permsAsked()).toEqual(["get_public_key", "sign_event:34259", "sign_event:3"]);
  });
});
