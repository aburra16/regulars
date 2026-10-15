import { act, cleanup, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { changeFollow, type FollowOutcome, forgetFollowFloor } from "../src/follow/change";
import { FOLLOW_REREAD_MS, UNDO_MS } from "../src/follow/FollowProvider";
import { readOwnList } from "../src/follow/read";
import { TOWNS_WAIT_MS } from "../src/places/store";
import { ABSENT, buildFollowList, FOLLOW_LIST_TIME, pubkeyAt } from "./fixtures/follow-list";
import { after, installAddOn, openSignedIn, says, settle, signedInAs, signedInNow, tap, tapSession } from "./support/followPage";
import { asksForList, everywhere, FOLLOW_RELAYS, setUpRelays, strangers, type World } from "./support/followWorld";

/*
 * What the session's own follow list (src/follow/FollowProvider.tsx) asks `changeFollow` for, and
 * what it makes of each way a change can end, with the change itself played by the test: it goes on
 * until the test ends it, with an outcome or with something thrown, at the moment the test chooses.
 * So an outcome can come after its session is over, and a change can fail in a way the real one has
 * no name for, which the relays in memory cannot be made to do (tests/followProvider.test.tsx has the
 * provider over the real change). The list is still read from relays held in memory; the keys are
 * thrown away, and nothing opens a socket.
 */

vi.mock("../src/follow/change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/change")>();
  return { ...actual, changeFollow: vi.fn() };
});
const change = vi.mocked(changeFollow);

// The read of the person's own list (`readOwnList`, the one the provider makes) is the real one, over
// the relays in memory, unless a test makes one fail as those relays cannot: by throwing.
vi.mock("../src/follow/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/read")>();
  return { ...actual, readOwnList: vi.fn(actual.readOwnList) };
});
const read = vi.mocked(readOwnList);

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER_SECRET = generateSecretKey();
const SOMEONE_ELSE = getPublicKey(OTHER_SECRET);

/** The person's list, of 1,200 entries, and one it names, at `FRIEND_AT`, with nothing after the key. */
const LIST = buildFollowList(SECRET);
const FRIEND_AT = 8;
const FRIEND = pubkeyAt(FRIEND_AT);

/** The list an unfollow of the friend leaves, and what it takes out of the one before. */
const WITHOUT_FRIEND = finalizeEvent(
  { kind: 3, created_at: FOLLOW_LIST_TIME + 10, content: LIST.content, tags: LIST.tags.filter((_, place) => place !== FRIEND_AT) },
  SECRET,
);
const TAKEN_OUT = [{ index: FRIEND_AT, tag: ["p", FRIEND] }];
/** How that unfollow ends when it is saved. */
const UNFOLLOWED: FollowOutcome = { kind: "saved", list: WITHOUT_FRIEND, confirmed: true, kept: false, removed: TAKEN_OUT };

/** The list an Undo of that unfollow leaves: the one before it, at a later time. */
const PUT_BACK = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 20, content: LIST.content, tags: LIST.tags }, SECRET);

/** Another person the list does not name. */
const ANOTHER = pubkeyAt(20_001);

/** A list of the person's with `tags`, made `at` seconds after the first. */
const listOf = (tags: string[][], at: number) => finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + at, content: LIST.content, tags }, SECRET);

/** The list a follow of the stranger leaves. */
const WITH_STRANGER = finalizeEvent(
  { kind: 3, created_at: FOLLOW_LIST_TIME + 10, content: LIST.content, tags: [...LIST.tags, ["p", ABSENT]] },
  SECRET,
);

/**
 * The next change the provider asks for: it goes on until the test ends it, with `ends` (how it
 * ended) or `fails` (what it threw).
 */
function nextChange() {
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
}

/** What the provider asked `changeFollow` for, the `nth` time (from 0): whose list, who, what to do, with which relays, on which signal. */
function asked(nth: number) {
  const [account, who, action, deps, signal] = change.mock.calls[nth]!;
  return { by: account.pubkey, who, action, deps, signal };
}

/** How many times each follow-list relay was asked for a follow list, in their order. */
const listReads = (w: World) => FOLLOW_RELAYS.map((url) => w.relays[url]!.asked.filter(asksForList).length);

/** What the app warns of or reports as an error: nothing here may be. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  // The clocks too: how long a list that could not be read is left unread is told by the one that
  // only goes forward (`performance.now()`), which the timers here move.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  setUpRelays(config);
  // The scores store reads nothing of its own here: every read these see is the follow list's.
  config.houseTrustRelays = [];
  strangers.length = 0;
  forgetFollowFloor();
  change.mockReset();
  read.mockReset();
  logs = (["warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    cleanup();
    await vi.advanceTimersByTimeAsync(TOWNS_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "nostr");
    window.sessionStorage.clear();
  }
});

/**
 * The page with a button for the friend, who is followed, one for the stranger, who is not, and one
 * for another person, who is not either, once the list is read.
 */
async function opened() {
  signedInAs(SECRET);
  const w = everywhere([LIST]);
  await openSignedIn(w, { friend: FRIEND, stranger: ABSENT, another: ANOTHER });
  await waitFor(() => expect(says("friend")).toBe("following"));
  expect(says("stranger")).toBe("not-following");
  // The places store's short wait for the towns is over: no timer is running but those these tests start.
  await after(TOWNS_WAIT_MS);
  expect(vi.getTimerCount()).toBe(0);
  return w;
}

// ---------------------------------------------------------------------------------------------

describe("what the provider asks changeFollow for", () => {
  it("is a follow or an unfollow of that person, for the person signed in, with the relays the scores' provider gives, on a signal that sign-out aborts", async () => {
    const w = await opened();
    const follow = nextChange();
    const unfollow = nextChange();

    tap("stranger", "follow");
    tap("friend", "unfollow");

    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(0)).toMatchObject({ by: ME, who: ABSENT, action: "follow" });
    expect(asked(1)).toMatchObject({ by: ME, who: FRIEND, action: "unfollow" });
    for (const each of [asked(0), asked(1)]) {
      expect(each.deps.readers).toBe(w.readers);
      expect(each.deps.writers).toBe(w.writers);
      expect(each.signal.aborted).toBe(false);
    }

    // Neither signal aborts when its change ends: only when the session does.
    await follow.ends({ kind: "saved", list: WITH_STRANGER, confirmed: true, kept: false });
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(asked(0).signal.aborted).toBe(false);
    tapSession("sign out");
    expect(asked(0).signal.aborted).toBe(true);
    expect(asked(1).signal.aborted).toBe(true);
    await unfollow.fails(asked(1).signal.reason);
  });

  it("is, for Undo, what the unfollow took out and the id of the list it left, and that once (ruling R20)", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    expect(says("friend")).toBe("not-following undo");
    const undo = nextChange();

    tap("friend", "undo");

    expect(says("friend")).toBe("saving");
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1)).toMatchObject({ by: ME, who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    // Put back: the button says Following, and not that they were just followed, as nothing has
    // changed for the person's circle (ruling R23). There is nothing more to undo, and no timer left.
    await undo.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("says a follow was just made after a tap of Follow, and not after a tap of Undo (ruling R23)", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    tap("friend", "undo");
    // Saved, though it could not be read back: it says so, and still not that they were just followed.
    await undo.ends({ kind: "saved", list: PUT_BACK, confirmed: false, kept: false });
    expect(says("friend")).toBe("following trouble:unconfirmed");

    // A tap of Follow says it, as before.
    const follow = nextChange();
    tap("stranger", "follow");
    const withBoth = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 30, content: LIST.content, tags: [...LIST.tags, ["p", ABSENT]] }, SECRET);
    await follow.ends({ kind: "saved", list: withBoth, confirmed: true, kept: false });

    expect(says("stranger")).toBe("following just");
    expect(says("friend")).toBe("following trouble:unconfirmed");
  });

  it("is nothing for Undo once its ten seconds are over: what the unfollow took out is kept no longer", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    expect(says("friend")).toBe("not-following undo");

    await after(UNDO_MS);
    expect(says("friend")).toBe("not-following");
    tap("friend", "undo");
    await settle();

    expect(change).toHaveBeenCalledTimes(1);
    expect(says("friend")).toBe("not-following");
  });

  it("is, for a tap of Follow in those ten seconds, the same as for Undo: what the unfollow took out goes back as it was (ruling R28)", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const follow = nextChange();

    tap("friend", "follow");
    expect(says("friend")).toBe("saving");
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1)).toMatchObject({ by: ME, who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });

    // Put back, as by Undo: Following, not just followed (ruling R23), nothing more to undo, and no timer left.
    await follow.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("is a follow as any other for a tap of Follow once those ten seconds are over", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    await after(UNDO_MS);
    expect(says("friend")).toBe("not-following");
    const follow = nextChange();

    tap("friend", "follow");

    expect(asked(1).action).toBe("follow");
    await follow.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following just");
  });

  it("ends the offer of Undo at a tap that unfollows them again: there is nothing of the first unfollow to put back", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    expect(says("friend")).toBe("not-following undo");
    const again = nextChange();

    tap("friend", "unfollow");

    expect(says("friend")).toBe("saving");
    expect(asked(1).action).toBe("unfollow");
    expect(vi.getTimerCount()).toBe(0);
    await again.ends({ kind: "unchanged", list: WITHOUT_FRIEND });
    expect(says("friend")).toBe("not-following");
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("offers no Undo for an unfollow that does not say what it took out: there would be nothing to put back", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");

    await unfollow.ends({ kind: "saved", list: WITHOUT_FRIEND, confirmed: true, kept: false });

    expect(says("friend")).toBe("not-following");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("an Undo that did not save (ruling R22)", () => {
  /** The page once the friend has been unfollowed, with Undo offered. */
  async function unfollowed() {
    const w = await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    expect(says("friend")).toBe("not-following undo");
    return w;
  }

  it.each([
    ["was not approved", { kind: "not-approved" }, "not-approved"],
    ["could not load the list", { kind: "not-loaded" }, "not-loaded"],
    ["was taken by no relay", { kind: "not-saved" }, "not-saved"],
  ] as const)("keeps its offer, and what it puts back, when it %s: the next tap of Undo asks for the same", async (_, outcome, trouble) => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");
    // While it is being saved, the button says so, and offers nothing.
    expect(says("friend")).toBe("saving");

    await undo.ends(outcome);

    expect(says("friend")).toBe(`not-following trouble:${trouble} undo`);
    const again = nextChange();
    tap("friend", "undo");
    expect(says("friend")).toBe("saving");
    expect(change).toHaveBeenCalledTimes(3);
    // What the unfollow took out, each entry as the list wrote it and where it was, and the list it left.
    expect(asked(2)).toMatchObject({ by: ME, who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    expect(asked(2).action).toEqual(asked(1).action);

    await again.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps its offer when it failed in a way changeFollow has no name for", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");

    await undo.fails(new Error("something unforeseen"));

    expect(says("friend")).toBe("not-following trouble:not-saved undo");
    const again = nextChange();
    tap("friend", "undo");
    expect(asked(2).action).toEqual({ restore: TAKEN_OUT, left: WITHOUT_FRIEND.id });
    await again.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following");
  });

  it("does not start its ten seconds again: they are counted from the unfollow", async () => {
    await unfollowed();
    // Half of the ten seconds on, an Undo is not approved.
    await after(UNDO_MS / 2);
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends({ kind: "not-approved" });
    expect(says("friend")).toBe("not-following trouble:not-approved undo");
    // One timer, the unfollow's own: the tap that failed began none.
    expect(vi.getTimerCount()).toBe(1);

    // The other half on, the offer is over, and what the unfollow took out is kept no longer.
    await after(UNDO_MS / 2);
    expect(says("friend")).toBe("not-following trouble:not-approved");
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("has no offer left when its ten seconds end while it is being saved", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");
    expect(says("friend")).toBe("saving");

    await after(UNDO_MS);
    expect(says("friend")).toBe("saving");
    await undo.ends({ kind: "not-saved" });

    expect(says("friend")).toBe("not-following trouble:not-saved");
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("ends its offer when the person is found in the list already: there is nothing to put back", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");

    // Another app has followed them again since.
    await undo.ends({ kind: "unchanged", list: PUT_BACK });

    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("is asked for again by a tap of Follow, or of Try again, while its offer is kept: neither is a plain follow (ruling R28)", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends({ kind: "not-approved" });
    expect(says("friend")).toBe("not-following trouble:not-approved undo");

    // Follow: the same again, and the offer is kept when that fails too, its timer still the unfollow's.
    const follow = nextChange();
    tap("friend", "follow");
    expect(says("friend")).toBe("saving");
    expect(asked(2).action).toEqual({ restore: TAKEN_OUT, left: WITHOUT_FRIEND.id });
    await follow.ends({ kind: "not-saved" });
    expect(says("friend")).toBe("not-following trouble:not-saved undo");
    expect(vi.getTimerCount()).toBe(1);

    // Try again: the same again.
    const retry = nextChange();
    tap("friend", "retry");
    expect(asked(3).action).toEqual({ restore: TAKEN_OUT, left: WITHOUT_FRIEND.id });
    await retry.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a plain follow for Try again once its ten seconds are over: there is nothing left to put back", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends({ kind: "not-approved" });
    await after(UNDO_MS);
    expect(says("friend")).toBe("not-following trouble:not-approved");
    const retry = nextChange();

    tap("friend", "retry");

    expect(asked(2).action).toBe("follow");
    await retry.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: false });
    expect(says("friend")).toBe("following just");
  });

  it("ends the offer it kept when the person signs out, and for the person who signs in after", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends({ kind: "not-approved" });
    expect(says("friend")).toBe("not-following trouble:not-approved undo");

    tapSession("sign out");

    expect(says("friend")).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("following"));
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("ends the offer it kept when someone else signs in, with no sign-out between: it was the first person's", async () => {
    await unfollowed();
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends({ kind: "not-approved" });
    expect(says("friend")).toBe("not-following trouble:not-approved undo");

    // The add-on is someone else's now, who signs in: they follow nobody, as every follow-list relay says.
    installAddOn(OTHER_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(SOMEONE_ELSE));

    await waitFor(() => expect(says("friend")).toBe("not-following"));
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });
});

describe("what went wrong, and the change it was about (ruling R27)", () => {
  /** The list with the stranger and another in it, the one with only another, and the one with another and no friend. */
  const WITH_BOTH = listOf([...LIST.tags, ["p", ABSENT], ["p", ANOTHER]], 30);
  const WITH_ANOTHER = listOf([...LIST.tags, ["p", ANOTHER]], 30);
  const WITH_ANOTHER_NO_FRIEND = listOf([...LIST.tags.filter((_, place) => place !== FRIEND_AT), ["p", ANOTHER]], 30);

  /** Another person is followed, and the list that change saved is `list`: what is held from then on. */
  async function anotherFollowedLeaving(list: typeof LIST) {
    const follow = nextChange();
    tap("another", "follow");
    await follow.ends({ kind: "saved", list, confirmed: true, kept: false });
    expect(says("another")).toBe("following just");
  }

  it.each([
    ["was not saved", { kind: "not-saved" }],
    ["was not approved", { kind: "not-approved" }],
    ["could not load the list", { kind: "not-loaded" }],
  ] as const)("lets go of a follow that %s once the list held names the person: it was made after all, and Try again does nothing", async (_, outcome) => {
    await opened();
    const follow = nextChange();
    tap("stranger", "follow");
    await follow.ends(outcome);
    expect(says("stranger")).toBe(`not-following trouble:${outcome.kind}`);

    // Someone else is followed: that change read the list afresh, found the stranger in it, and saved.
    await anotherFollowedLeaving(WITH_BOTH);

    // Following, with nothing wrong to say: and nothing that would take them out again.
    expect(says("stranger")).toBe("following");
    tap("stranger", "retry");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
    expect(change.mock.calls.filter(([, who]) => who === ABSENT)).toHaveLength(1);
  });

  it("lets go of an unfollow that was not made once the list held no longer names the person, and Try again does nothing", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends({ kind: "not-saved" });
    expect(says("friend")).toBe("following trouble:not-saved");

    await anotherFollowedLeaving(WITH_ANOTHER_NO_FRIEND);

    // Not followed, with nothing wrong to say: and nothing that would follow them again.
    expect(says("friend")).toBe("not-following");
    tap("friend", "retry");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
    expect(change.mock.calls.filter(([, who]) => who === FRIEND)).toHaveLength(1);
  });

  it("keeps what went wrong while the list held agrees with it, and Try again makes the same change again, whatever was saved for others since", async () => {
    await opened();
    const follow = nextChange();
    tap("stranger", "follow");
    await follow.ends({ kind: "not-saved" });
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends({ kind: "not-approved" });

    // The list another's follow leaves has the friend still, and no stranger: both are as they were.
    await anotherFollowedLeaving(WITH_ANOTHER);
    expect(says("stranger")).toBe("not-following trouble:not-saved");
    expect(says("friend")).toBe("following trouble:not-approved");

    const followAgain = nextChange();
    tap("stranger", "retry");
    expect(says("stranger")).toBe("saving");
    expect(asked(3)).toMatchObject({ who: ABSENT, action: "follow" });
    const unfollowAgain = nextChange();
    tap("friend", "retry");
    expect(says("friend")).toBe("saving");
    expect(asked(4)).toMatchObject({ who: FRIEND, action: "unfollow" });
    await followAgain.ends({ kind: "not-saved" });
    await unfollowAgain.ends({ kind: "not-approved" });
    expect(change).toHaveBeenCalledTimes(5);
  });

  it("keeps what went wrong while the list is not known, with nothing to disagree with it, and Try again is the follow that failed", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    // No relay can send a list just now; each answers the rest, the person's relay list among it.
    for (const url of FOLLOW_RELAYS) w.relays[url]!.listsDown = true;
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    expect(says("stranger")).toBe("unknown");

    // A follow asked for while the list could not be read: its own read fails too.
    const follow = nextChange();
    tap("stranger", "follow");
    await follow.ends({ kind: "not-loaded" });
    expect(says("stranger")).toBe("unknown trouble:not-loaded");

    // Try again is a follow, from what the change was: there is no state here to take it from.
    const again = nextChange();
    tap("stranger", "retry");
    expect(asked(1)).toMatchObject({ who: ABSENT, action: "follow" });
    await again.ends({ kind: "not-loaded" });
    expect(says("stranger")).toBe("unknown trouble:not-loaded");
  });

  it("lets go of a follow that was saved and not checked once the list held does not name the person", async () => {
    await opened();
    const follow = nextChange();
    tap("stranger", "follow");
    await follow.ends({ kind: "saved", list: WITH_STRANGER, confirmed: false, kept: false });
    expect(says("stranger")).toBe("following trouble:unconfirmed just");

    // A later list, which another's follow saved, has no stranger in it.
    await anotherFollowedLeaving(WITH_ANOTHER);

    expect(says("stranger")).toBe("not-following");
  });

  it("lets go of an unfollow that was saved and not checked, and of its Undo, once the list held names the person again", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends({ ...UNFOLLOWED, confirmed: false } as FollowOutcome);
    expect(says("friend")).toBe("not-following trouble:unconfirmed undo");

    await anotherFollowedLeaving(WITH_ANOTHER);

    // In the list again: nothing is wrong, and there is nothing to put back.
    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a follow", "stranger", "follow", { kind: "saved", list: WITH_STRANGER, confirmed: false, kept: false }, "following trouble:unconfirmed just"],
    ["an unfollow", "friend", "unfollow", { ...UNFOLLOWED, confirmed: false }, "not-following trouble:unconfirmed undo"],
  ] as const)("has nothing to try again after %s that was saved and not checked, nor when nothing went wrong", async (_, name, what, outcome, told) => {
    await opened();
    tap(name, "retry");
    await settle();
    expect(change).not.toHaveBeenCalled();

    const made = nextChange();
    tap(name, what);
    await made.ends(outcome as FollowOutcome);
    expect(says(name)).toBe(told);

    tap(name, "retry");
    await settle();
    expect(change).toHaveBeenCalledTimes(1);
    expect(says(name)).toBe(told);
  });

  it("lets go of what went wrong at a follow of someone the list held names already", async () => {
    await opened();
    // The friend is followed, as the list read says. A follow of them is asked for all the same, and fails.
    const follow = nextChange();
    tap("friend", "follow");
    await follow.ends({ kind: "not-approved" });

    // Followed as they are, there is no follow to try again.
    expect(says("friend")).toBe("following");
    tap("friend", "retry");
    await settle();
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe("a change that ends once its session is over", () => {
  it("leaves nothing behind when it ends after sign-out: no button is told of it, and no Undo is begun", async () => {
    const w = await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    expect(says("friend")).toBe("saving");

    tapSession("sign out");
    expect(says("friend")).toBe("unknown");
    // It was saved after all, the change says: too late for the session it was made in.
    await unfollow.ends(UNFOLLOWED);

    expect(says("friend")).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);

    // The person who signs in after has the list as the relays hold it, and nothing to undo.
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([2, 2, 2]);
    tap("friend", "undo");
    await settle();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing behind when it ends after the person has signed in again: their buttons are as the list read anew has them", async () => {
    const w = await opened();
    const unfollow = nextChange();
    const follow = nextChange();
    tap("friend", "unfollow");
    tap("stranger", "follow");

    tapSession("sign out");
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([2, 2, 2]);
    // The session before's changes end now, one saved and one failed: neither is this session's.
    await unfollow.ends(UNFOLLOWED);
    await follow.fails(new Error("stopped"));

    expect(says("friend")).toBe("following");
    expect(says("stranger")).toBe("not-following");
    expect(vi.getTimerCount()).toBe(0);
    // And a tap is not held up by them: neither is under way for this session.
    const again = nextChange();
    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");
    expect(change).toHaveBeenCalledTimes(3);
    await again.ends({ kind: "saved", list: WITH_STRANGER, confirmed: true, kept: false });
    expect(says("stranger")).toBe("following just");
  });
});

describe("a read of the list that throws", () => {
  it("leaves the list unknown and unread for thirty seconds, as a read that could not tell does (rulings R26 and R30)", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    read.mockRejectedValueOnce(new Error("something unforeseen"));
    const page = await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await settle();
    expect(says("friend")).toBe("unknown");

    // A button that appears inside the wait has nothing read.
    page.show({ friend: FRIEND, stranger: ABSENT });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(says("stranger")).toBe("unknown");

    // One that appears after it has the list read.
    await after(FOLLOW_REREAD_MS);
    page.show({ friend: FRIEND, stranger: ABSENT, another: ANOTHER });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(listReads(w)).toEqual([1, 1, 1]);
  });
});

describe("a change that fails in a way changeFollow has no name for", () => {
  it("is told as not saved while its session goes on, the buttons are as the list has them, and the next tap is a change as any other", async () => {
    await opened();
    const follow = nextChange();
    const unfollow = nextChange();
    tap("stranger", "follow");
    tap("friend", "unfollow");

    await follow.fails(new Error("something unforeseen"));
    await unfollow.fails(new TypeError("not what was asked for"));

    expect(says("stranger")).toBe("not-following trouble:not-saved");
    // Nothing was taken out, so there is nothing to undo.
    expect(says("friend")).toBe("following trouble:not-saved");
    expect(vi.getTimerCount()).toBe(0);

    const again = nextChange();
    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");
    await again.ends({ kind: "saved", list: WITH_STRANGER, confirmed: true, kept: false });
    expect(says("stranger")).toBe("following just");
    expect(says("friend")).toBe("following trouble:not-saved");
  });
});

describe("a change that says the person may be asked, and what the provider gives changeFollow as their say", () => {
  /**
   * The copy a change says they may be asked about, made up: its id, and when it was last changed.
   * Later than the list on screen: a change asks only about the newest list its read found, which
   * is never older than a list this tab has seen (an older copy is no longer asked about).
   */
  const COPY = { id: "c0".repeat(32), changed: FOLLOW_LIST_TIME + 60 * 60 };
  const ASK: FollowOutcome = { kind: "ask", copy: COPY };
  /** The say the provider gave `changeFollow` the `nth` time it asked for a change (from 0): the id of a list, or nothing. */
  const said = (nth: number) => change.mock.calls[nth]![5];
  /** How a follow of the stranger ends when it is made by the person's say. */
  const FOLLOWED_BY_SAY: FollowOutcome = { kind: "saved", list: WITH_STRANGER, confirmed: true, kept: true, bySay: true };

  it("gives no say with a tap of Follow, of Unfollow, of Undo or of Try again, in a session in which nothing was agreed to", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends({ kind: "not-approved" });
    const follow = nextChange();
    tap("stranger", "follow");
    await follow.ends({ kind: "not-saved" });
    const again = nextChange();
    tap("stranger", "retry");
    await again.ends({ kind: "not-saved" });

    expect(change).toHaveBeenCalledTimes(4);
    for (const nth of [0, 1, 2, 3]) expect(said(nth)).toBeUndefined();
  });

  it("asks the person, and says nothing went wrong: the button is as it was, with when the copy was last changed", async () => {
    await opened();
    const follow = nextChange();
    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");

    await follow.ends(ASK);

    expect(says("stranger")).toBe(`not-following asking:${COPY.changed}`);
    expect(says("friend")).toBe("following");
    expect(says("another")).toBe("not-following");
    // Nothing is held from it, and nothing is left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<[string, "follow" | "unfollow", string, string]>([
    ["a follow", "follow", "stranger", ABSENT],
    ["an unfollow", "unfollow", "friend", FRIEND],
  ])("gives, with Use this copy, the id of the copy they were asked about and nothing else, for %s: the very change that asked", async (_, action, name, who) => {
    await opened();
    const first = nextChange();
    tap(name, action);
    await first.ends(ASK);
    const second = nextChange();

    tap(name, "use");

    expect(says(name)).toBe("saving");
    expect(change).toHaveBeenCalledTimes(2);
    expect(asked(1)).toMatchObject({ by: ME, who, action });
    expect(said(1)).toBe(COPY.id);
    await second.ends({ kind: "not-approved" });
    expect(says(name)).toContain("trouble:not-approved");
  });

  it("gives, with Use this copy, exactly what Undo was to put back, though Undo's ten seconds ended while they were asked; and its offer ends once it is put back", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends(ASK);
    // Asked, and Undo is offered still for what is left of its time.
    expect(says("friend")).toBe(`not-following undo asking:${COPY.changed}`);
    await after(UNDO_MS);
    expect(says("friend")).toBe(`not-following asking:${COPY.changed}`);
    const again = nextChange();

    tap("friend", "use");

    expect(change).toHaveBeenCalledTimes(3);
    expect(asked(2)).toMatchObject({ by: ME, who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    // The very thing Undo asked for, not one like it.
    expect(asked(2).action).toBe(asked(1).action);
    expect(said(2)).toBe(COPY.id);
    await again.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: true, bySay: true });
    expect(says("friend")).toBe("following");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives, with Use this copy after Try again asked, the change that had failed, and never what the button would do by now", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends({ kind: "not-approved" });
    expect(says("friend")).toBe("following trouble:not-approved");
    const retried = nextChange();
    tap("friend", "retry");
    await retried.ends(ASK);
    expect(says("friend")).toBe(`following asking:${COPY.changed}`);
    const answered = nextChange();

    tap("friend", "use");

    expect(asked(2)).toMatchObject({ who: FRIEND, action: "unfollow" });
    expect(said(2)).toBe(COPY.id);
    await answered.ends(UNFOLLOWED);
  });

  it("does nothing on Use this copy for someone they are not asked about, nor once Not now has let the asking go", async () => {
    await opened();
    const follow = nextChange();
    tap("stranger", "follow");
    await follow.ends(ASK);

    tap("friend", "use");
    tap("another", "use");
    tap("another", "not now");
    expect(says("stranger")).toContain("asking");
    tap("stranger", "not now");
    expect(says("stranger")).toBe("not-following");
    tap("stranger", "use");
    await settle();

    expect(change).toHaveBeenCalledTimes(1);
  });

  it("asks about one person at a time: a change for another that asks takes the first one's place, and one that comes to a list lets it go", async () => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const second = nextChange();
    tap("friend", "unfollow");
    // While the second is read for, the first is asked still.
    expect(says("stranger")).toContain("asking");
    const other = { id: "d1".repeat(32), changed: COPY.changed + 500 };

    await second.ends({ kind: "ask", copy: other });

    expect(says("stranger")).toBe("not-following");
    expect(says("friend")).toBe(`following asking:${other.changed}`);
    // A change for a third person that is saved, on a read to trust: nothing is asked of anyone after it.
    const third = nextChange();
    tap("another", "follow");
    expect(says("friend")).toContain("asking");
    await third.ends({ kind: "saved", list: listOf([...LIST.tags, ["p", ANOTHER]], 30), confirmed: true, kept: false });
    expect(says("friend")).toBe("following");
    tap("friend", "use");
    await settle();
    expect(change).toHaveBeenCalledTimes(3);
  });

  it.each<[string, FollowOutcome]>([
    ["was not loaded", { kind: "not-loaded" }],
    ["was not approved", { kind: "not-approved" }],
    ["was not saved", { kind: "not-saved" }],
  ])("keeps what they are asked about one person when a change to another %s: nothing was learned of the list", async (_, outcome) => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const second = nextChange();
    tap("friend", "unfollow");

    await second.ends(outcome);

    expect(says("stranger")).toBe(`not-following asking:${COPY.changed}`);
  });

  it("gives, after a change made by their say has saved, the id of the list it saved with every tap after it; and then of the list the next one saved", async () => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const answered = nextChange();
    tap("stranger", "use");
    await answered.ends(FOLLOWED_BY_SAY);
    expect(says("stranger")).toBe("following just");

    const next = nextChange();
    tap("friend", "unfollow");
    expect(said(2)).toBe(WITH_STRANGER.id);
    const then = listOf([...WITHOUT_FRIEND.tags, ["p", ABSENT]], 40);
    await next.ends({ kind: "saved", list: then, confirmed: true, kept: true, bySay: true, removed: TAKEN_OUT });

    const undo = nextChange();
    tap("friend", "undo");
    expect(said(3)).toBe(then.id);
    await undo.ends({ kind: "not-approved" });
    // A change that did not save changes nothing of it.
    const last = nextChange();
    tap("another", "follow");
    expect(said(4)).toBe(then.id);
    await last.ends({ kind: "not-saved" });
  });

  it("is not begun by a change made by their say that was saved and could not be checked: the list it saved is not known to be the newest, and the next tap is given no say", async () => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const answered = nextChange();
    tap("stranger", "use");
    // Saved, and not confirmed: a relay refused it as older than one it holds, or it was not read back.
    await answered.ends({ kind: "saved", list: WITH_STRANGER, confirmed: false, kept: true, bySay: true });
    expect(says("stranger")).toBe("following trouble:unconfirmed just");

    const next = nextChange();
    tap("friend", "unfollow");
    expect(said(2)).toBeUndefined();
    // And once one is confirmed, that list is gone on from.
    const mine = listOf(WITH_STRANGER.tags.filter((_, place) => place !== FRIEND_AT), 50);
    await next.ends({ kind: "saved", list: mine, confirmed: true, kept: true, bySay: true, removed: TAKEN_OUT });
    const then = nextChange();
    tap("another", "follow");
    expect(said(3)).toBe(mine.id);
    // A later one that could not be checked leaves the confirmed one as it was: no newer list of this tab's is known.
    const unchecked = listOf([...mine.tags, ["p", ANOTHER]], 60);
    await then.ends({ kind: "saved", list: unchecked, confirmed: false, kept: true, bySay: true });
    const last = nextChange();
    tap("another", "unfollow");
    expect(said(4)).toBe(mine.id);
    await last.ends({ kind: "not-approved" });
  });

  it("is not begun by a change saved on a read to trust, nor by one that changed nothing; and what was agreed to before stays through them", async () => {
    await opened();
    // Saved, with no say asked for or noted: a read to trust.
    const trusted = nextChange();
    tap("stranger", "follow");
    await trusted.ends({ kind: "saved", list: WITH_STRANGER, confirmed: true, kept: true });
    const second = nextChange();
    tap("another", "follow");
    expect(said(1)).toBeUndefined();
    // Found to be so already, on a copy they said yes to: nothing was saved, so there is no list of this tab's to go on from.
    await second.ends({ kind: "unchanged", list: WITH_STRANGER, bySay: true });
    const third = nextChange();
    tap("friend", "unfollow");
    expect(said(2)).toBeUndefined();

    // Once one made by their say has saved, a later one saved on a read to trust does not take it away.
    const mine = listOf(WITH_STRANGER.tags.filter((_, place) => place !== FRIEND_AT), 50);
    await third.ends({ kind: "saved", list: mine, confirmed: true, kept: true, bySay: true, removed: TAKEN_OUT });
    const fourth = nextChange();
    tap("another", "follow");
    expect(said(3)).toBe(mine.id);
    await fourth.ends({ kind: "saved", list: listOf([...mine.tags, ["p", ANOTHER]], 60), confirmed: true, kept: false });
    const fifth = nextChange();
    tap("another", "unfollow");
    expect(said(4)).toBe(mine.id);
    await fifth.ends({ kind: "not-approved" });
  });

  it("forgets what was agreed to at sign-out, and for whoever signs in next", async () => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const answered = nextChange();
    tap("stranger", "use");
    await answered.ends(FOLLOWED_BY_SAY);

    tapSession("sign out");
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("following"));
    const again = nextChange();
    tap("another", "follow");
    expect(said(2)).toBeUndefined();
    await again.ends({ kind: "not-approved" });

    installAddOn(OTHER_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(SOMEONE_ELSE));
    await waitFor(() => expect(says("friend")).toBe("not-following"));
    const theirs = nextChange();
    tap("friend", "follow");
    expect(asked(3).by).toBe(SOMEONE_ELSE);
    expect(said(3)).toBeUndefined();
    await theirs.ends({ kind: "not-approved" });
  });

  it("leaves nothing behind when it says so after its session is over: nobody is asked anything", async () => {
    await opened();
    const follow = nextChange();
    tap("stranger", "follow");

    tapSession("sign out");
    await follow.ends(ASK);
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("following"));

    expect(says("stranger")).toBe("not-following");
    tap("stranger", "use");
    await settle();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("asks for the very change that asked, with no say, on any tap for that person while they are asked: never another", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends(ASK);
    // Undo's ten seconds are over: a tap of Follow would be a plain follow, were they not asked.
    await after(UNDO_MS);
    expect(says("friend")).toBe(`not-following asking:${COPY.changed}`);
    const again = nextChange();

    tap("friend", "follow");

    expect(says("friend")).toBe("saving");
    expect(change).toHaveBeenCalledTimes(3);
    // What Undo was to put back, the very thing, and no answer with it.
    expect(asked(2).action).toBe(asked(1).action);
    expect(asked(2)).toMatchObject({ who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    expect(said(2)).toBeUndefined();
    const newer = { id: "e2".repeat(32), changed: COPY.changed + 60 };
    await again.ends({ kind: "ask", copy: newer });
    expect(says("friend")).toBe(`not-following asking:${newer.changed}`);

    // And their answer makes that same change, on the copy they were last shown.
    const answered = nextChange();
    tap("friend", "use");
    expect(asked(3).action).toBe(asked(1).action);
    expect(said(3)).toBe(newer.id);
    await answered.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: true, bySay: true });
    expect(says("friend")).toBe("following");
  });

  it("asks for the change that asked whichever of the hook's taps is made for that person: an unfollow that asked is an unfollow again", async () => {
    await opened();
    const first = nextChange();
    tap("friend", "unfollow");
    await first.ends(ASK);
    expect(says("friend")).toBe(`following asking:${COPY.changed}`);
    const second = nextChange();

    // The button offers no follow of someone followed; were one asked for, it is the unfollow that is asked again.
    tap("friend", "follow");

    expect(asked(1)).toMatchObject({ who: FRIEND, action: "unfollow" });
    expect(said(1)).toBeUndefined();
    await second.ends({ kind: "not-approved" });
  });

  it("asks nothing about a change the list held has already: a follow of someone it names, an unfollow of someone it does not", async () => {
    await opened();
    const follow = nextChange();
    tap("friend", "follow");
    await follow.ends(ASK);
    expect(says("friend")).toBe("following");
    const unfollow = nextChange();
    tap("stranger", "unfollow");
    await unfollow.ends(ASK);
    expect(says("stranger")).toBe("not-following");

    tap("friend", "use");
    tap("stranger", "use");
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
  });

  it.each<[string, FollowOutcome]>([
    ["was not approved", { kind: "not-approved" }],
    ["could not be kept a copy for", { kind: "not-kept" }],
    ["was not saved", { kind: "not-saved" }],
    ["was not loaded", { kind: "not-loaded" }],
  ])("makes again, on Try again, the very change their answer was for when that %s: what Undo was to put back, though its ten seconds are over, and with no say", async (_, outcome) => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends(ASK);
    await after(UNDO_MS);
    const answered = nextChange();
    tap("friend", "use");
    await answered.ends(outcome);
    expect(says("friend")).toBe(`not-following trouble:${outcome.kind}`);
    const again = nextChange();

    tap("friend", "retry");

    expect(change).toHaveBeenCalledTimes(4);
    // The very thing Undo asked for, not a follow in its place: and no answer goes with a press of Try again.
    expect(asked(3).action).toBe(asked(1).action);
    expect(asked(3)).toMatchObject({ who: FRIEND, action: { restore: TAKEN_OUT, left: WITHOUT_FRIEND.id } });
    expect(said(3)).toBeUndefined();
    // Failing again, it is still that change that Try again makes.
    await again.ends({ kind: "not-saved" });
    const third = nextChange();
    tap("friend", "retry");
    expect(asked(4).action).toBe(asked(1).action);
    await third.ends({ kind: "saved", list: PUT_BACK, confirmed: true, kept: true });
    expect(says("friend")).toBe("following");
  });

  it("makes again, on Try again, the change that a press in place of an answer asked for again, when that was not made", async () => {
    await opened();
    const unfollow = nextChange();
    tap("friend", "unfollow");
    await unfollow.ends(UNFOLLOWED);
    const undo = nextChange();
    tap("friend", "undo");
    await undo.ends(ASK);
    await after(UNDO_MS);
    // The button is pressed in place of an answer, and this time the list could not be loaded.
    const pressed = nextChange();
    tap("friend", "follow");
    await pressed.ends({ kind: "not-loaded" });
    expect(says("friend")).toBe("not-following trouble:not-loaded");
    const again = nextChange();

    tap("friend", "retry");

    expect(asked(3).action).toBe(asked(1).action);
    expect(said(3)).toBeUndefined();
    await again.ends({ kind: "not-approved" });
  });

  it("keeps Try again a plain follow for a follow their answer was for: nothing but the change that asked is made again", async () => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const answered = nextChange();
    tap("stranger", "use");
    await answered.ends({ kind: "not-approved" });
    const again = nextChange();

    tap("stranger", "retry");

    expect(asked(2)).toMatchObject({ who: ABSENT, action: "follow" });
    expect(said(2)).toBeUndefined();
    await again.ends({ kind: "saved", list: WITH_STRANGER, confirmed: true, kept: false });
    expect(says("stranger")).toBe("following just");
  });

  it("lets the asking go when the person is tapped for again, and asks again if that change says so", async () => {
    await opened();
    const first = nextChange();
    tap("stranger", "follow");
    await first.ends(ASK);
    const second = nextChange();

    tap("stranger", "follow");

    // A press of the button, not their answer: no say goes with it, and it is saving, with nothing asked meanwhile.
    expect(says("stranger")).toBe("saving");
    expect(said(1)).toBeUndefined();
    const newer = { id: "e2".repeat(32), changed: COPY.changed + 60 };
    await second.ends({ kind: "ask", copy: newer });
    expect(says("stranger")).toBe(`not-following asking:${newer.changed}`);
    // And their answer is for the copy they were last shown.
    const third = nextChange();
    tap("stranger", "use");
    expect(said(2)).toBe(newer.id);
    await third.ends({ kind: "not-approved" });
  });
});
