import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { FOLLOW_KIND, followed, names, newestList, type Removed, removedBy, withFollow, withoutFollow, withRestored } from "../src/follow/list";
import {
  ABSENT,
  buildFollowList,
  DUPLICATE_AGAIN_AT,
  DUPLICATE_AT,
  DUPLICATED,
  FOLLOW_LIST_CONTENT,
  FOLLOW_LIST_SIZE,
  FOLLOW_LIST_TIME,
  FOLLOWED_IN_LIST,
  pubkeyAt,
  UPPER_CASE_AT,
  UPPER_CASE_KEY,
  UPPER_CASED,
} from "./fixtures/follow-list";
import { hex64, shapedEvent } from "./support/events";

/*
 * The rules of a follow list (kind 3): which one is the newest, who it names, the one entry a follow
 * or an unfollow changes, and what Undo puts back. They are pure: nothing here reads a relay or
 * signs (the lists an unfollow leaves are signed here only so that each has its own id). The big
 * list is synthetic (tests/fixtures/follow-list.ts), with the shapes old and new clients write.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER = hex64("2");

const list = (fields: Partial<NostrEvent> = {}) => shapedEvent({ kind: FOLLOW_KIND, pubkey: ME, ...fields });

/** What the synthetic list's entries that are not follows have in a key's place: none of them is a key. */
const NOT_KEYS = ["", "not-a-key", "z".repeat(64), pubkeyAt(1).slice(1)];

describe("newestList", () => {
  it("is the one made last", () => {
    const old = list({ created_at: 100, id: hex64("1") });
    const recent = list({ created_at: 200, id: hex64("f") });
    expect(newestList([old, recent], ME)).toBe(recent);
    expect(newestList([recent, old], ME)).toBe(recent);
  });

  it("is the one with the lower id when two were made at the same time", () => {
    const low = list({ created_at: 100, id: hex64("1") });
    const high = list({ created_at: 100, id: hex64("f") });
    expect(newestList([low, high], ME)).toBe(low);
    expect(newestList([high, low], ME)).toBe(low);
  });

  it("leaves out other kinds and other authors, however new", () => {
    const mine = list({ created_at: 100 });
    const relays = shapedEvent({ kind: 10_002, pubkey: ME, created_at: 900 });
    const theirs = shapedEvent({ kind: FOLLOW_KIND, pubkey: OTHER, created_at: 900 });
    expect(newestList([relays, theirs, mine], ME)).toBe(mine);
  });

  it("is null when there is none of theirs", () => {
    expect(newestList([], ME)).toBeNull();
    expect(newestList([shapedEvent({ kind: FOLLOW_KIND, pubkey: OTHER }), shapedEvent({ kind: 0, pubkey: ME })], ME)).toBeNull();
  });
});

describe("the synthetic list", () => {
  it("is signed, with 1,200 tags of every shape", () => {
    const event = buildFollowList(SECRET);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(ME);
    expect(event.kind).toBe(FOLLOW_KIND);
    expect(event.tags).toHaveLength(FOLLOW_LIST_SIZE);
    expect(event.content).toBe(FOLLOW_LIST_CONTENT);
    expect(JSON.parse(event.content)).toBeTypeOf("object");
    const shapes = new Set(event.tags.map((tag) => `${tag[0]}/${tag.length}`));
    // A plain key, a hint, a hint and a petname; an `e` and a `client` tag; an empty tag; a lone `p`.
    for (const shape of ["p/2", "p/3", "p/4", "e/3", "client/2", "undefined/0", "p/1"]) expect(shapes).toContain(shape);
    expect(event.tags.filter((tag) => tag[0] === "p" && tag[1] === DUPLICATED)).toHaveLength(2);
    expect(event.tags.filter((tag) => tag[1] === UPPER_CASED)).toHaveLength(1);
  });

  it("is the same list each time for one key and time, and a copy a test may change", () => {
    const first = buildFollowList(SECRET);
    expect(buildFollowList(SECRET).id).toBe(first.id);
    first.tags.pop();
    expect(buildFollowList(SECRET).tags).toHaveLength(FOLLOW_LIST_SIZE);
  });
});

describe("names", () => {
  const event = buildFollowList(SECRET);

  it("is true for a person in a p tag, whatever else the tag carries", () => {
    expect(names(event, pubkeyAt(0))).toBe(true);
    expect(names(event, pubkeyAt(1))).toBe(true);
    expect(names(event, pubkeyAt(2))).toBe(true);
    expect(names(event, pubkeyAt(3))).toBe(true);
    expect(names(event, DUPLICATED)).toBe(true);
  });

  it("is true for a person named in upper-case hex, asked for in either case", () => {
    expect(names(event, UPPER_CASE_KEY)).toBe(true);
    expect(names(event, UPPER_CASED)).toBe(true);
  });

  it("is false for a person who is not in a p tag", () => {
    expect(names(event, ABSENT)).toBe(false);
    // Their key is in an `e` tag's place, but that is not a follow.
    expect(names({ tags: [["e", ABSENT], ["client", ABSENT]] }, ABSENT)).toBe(false);
  });

  it("is false when there is no list", () => {
    expect(names(null, ABSENT)).toBe(false);
  });

  it.each(NOT_KEYS)("is false for %j, which is no key, though an entry in the list is written just so", (who) => {
    expect(event.tags).toContainEqual(["p", who]);
    expect(names(event, who)).toBe(false);
  });

  it("is false for anything else that is no key", () => {
    expect(names({ tags: [["p", "nope"], ["p", `${ABSENT}0`]] }, "nope")).toBe(false);
    expect(names({ tags: [["p", "nope"], ["p", `${ABSENT}0`]] }, `${ABSENT}0`)).toBe(false);
    expect(names({ tags: [["p", "npub1example"]] }, "npub1example")).toBe(false);
  });
});

describe("followed", () => {
  it("is the valid keys the list names, in order, each once, in lower case", () => {
    const keys = followed(buildFollowList(SECRET));
    expect(keys).toEqual(FOLLOWED_IN_LIST);
    // What every test compares with is the same for each: no test can change it.
    expect(Object.isFrozen(FOLLOWED_IN_LIST)).toBe(true);
    expect(keys).toHaveLength(new Set(keys).size);
    expect(keys.filter((key) => key === DUPLICATED)).toHaveLength(1);
    expect(keys).toContain(UPPER_CASE_KEY);
    expect(keys).not.toContain(UPPER_CASED);
  });

  it("skips entries that are not keys and keeps the others", () => {
    const good = pubkeyAt(5);
    const tags = [
      ["p"],
      ["p", ""],
      ["p", "nope"],
      ["p", "g".repeat(64)],
      ["p", good.slice(1)],
      ["p", `${good}0`],
      ["e", pubkeyAt(6)],
      [],
      ["p", good],
    ];
    expect(followed({ tags })).toEqual([good]);
  });

  it("names a person once, whether the copies are alike or not", () => {
    const good = pubkeyAt(5);
    const tags = [["p", good], ["p", good, "wss://a.example.test", "five"], ["p", good.toUpperCase()]];
    expect(followed({ tags })).toEqual([good]);
  });

  it("is empty when there is no list", () => {
    expect(followed(null)).toEqual([]);
  });
});

describe("withFollow", () => {
  const old = buildFollowList(SECRET);
  const who = ABSENT;

  it("adds the person at the end and changes nothing else", () => {
    const next = withFollow(old, who, FOLLOW_LIST_TIME + 50)!;
    expect(next.kind).toBe(FOLLOW_KIND);
    expect(next.content).toBe(old.content);
    expect(next.tags).toHaveLength(FOLLOW_LIST_SIZE + 1);
    expect(next.tags).toEqual([...old.tags, ["p", who]]);
  });

  it("is made at the time asked when that is after the old list's", () => {
    expect(withFollow(old, who, FOLLOW_LIST_TIME + 50)!.created_at).toBe(FOLLOW_LIST_TIME + 50);
  });

  it("is made one second after the old list when the clock is behind it, or level with it", () => {
    expect(withFollow(old, who, FOLLOW_LIST_TIME - 1_000)!.created_at).toBe(FOLLOW_LIST_TIME + 1);
    expect(withFollow(old, who, FOLLOW_LIST_TIME)!.created_at).toBe(FOLLOW_LIST_TIME + 1);
    expect(withFollow(old, who, FOLLOW_LIST_TIME + 1)!.created_at).toBe(FOLLOW_LIST_TIME + 1);
  });

  it("is null when the list names the person already", () => {
    expect(withFollow(old, pubkeyAt(0), FOLLOW_LIST_TIME + 50)).toBeNull();
    expect(withFollow(old, DUPLICATED, FOLLOW_LIST_TIME + 50)).toBeNull();
  });

  it("is null when the list names the person in upper-case hex", () => {
    expect(withFollow(old, UPPER_CASE_KEY, FOLLOW_LIST_TIME + 50)).toBeNull();
  });

  it("makes a fresh list when there is none", () => {
    expect(withFollow(null, who, 1_800_000_000)).toEqual({
      kind: 3,
      created_at: 1_800_000_000,
      content: "",
      tags: [["p", who]],
    });
  });

  it("leaves the list it is given as it was, and shares no tag with it", () => {
    const before = structuredClone(old.tags);
    const next = withFollow(old, who, FOLLOW_LIST_TIME + 50)!;
    expect(old.tags).toEqual(before);
    next.tags[0]![1] = "changed";
    expect(old.tags).toEqual(before);
  });

  it("adds a person asked for in upper-case hex in lower case, and knows them already there", () => {
    expect(withFollow(old, who.toUpperCase(), FOLLOW_LIST_TIME + 50)!.tags.at(-1)).toEqual(["p", who]);
    expect(withFollow(null, who.toUpperCase(), FOLLOW_LIST_TIME)!.tags).toEqual([["p", who]]);
    expect(withFollow(old, pubkeyAt(0).toUpperCase(), FOLLOW_LIST_TIME + 50)).toBeNull();
  });

  it.each([...NOT_KEYS, `${ABSENT}0`, "npub1example", ` ${ABSENT}`])("throws for %j, which is no key: nothing is added, to a list or to a fresh one", (notAKey) => {
    expect(() => withFollow(old, notAKey, FOLLOW_LIST_TIME + 50)).toThrow(TypeError);
    expect(() => withFollow(null, notAKey, FOLLOW_LIST_TIME + 50)).toThrow(TypeError);
  });
});

describe("withoutFollow", () => {
  const old = buildFollowList(SECRET);

  it("takes out every p tag that names the person, and nothing else", () => {
    const next = withoutFollow(old, DUPLICATED, FOLLOW_LIST_TIME + 50)!;
    expect(next.kind).toBe(FOLLOW_KIND);
    expect(next.content).toBe(old.content);
    expect(next.tags).toHaveLength(FOLLOW_LIST_SIZE - 2);
    expect(next.tags).toEqual(old.tags.filter((_, place) => place !== DUPLICATE_AT && place !== DUPLICATE_AGAIN_AT));
    expect(names(next, DUPLICATED)).toBe(false);
  });

  it("takes out a person named in upper-case hex", () => {
    const next = withoutFollow(old, UPPER_CASE_KEY, FOLLOW_LIST_TIME + 50)!;
    expect(next.tags).toEqual(old.tags.filter((_, place) => place !== UPPER_CASE_AT));
  });

  it("takes out one plain entry from a list of one", () => {
    const next = withoutFollow(list({ tags: [["p", ABSENT]], content: "kept" }), ABSENT, 1_800_000_000)!;
    expect(next).toEqual({ kind: 3, created_at: 1_800_000_000, content: "kept", tags: [] });
  });

  it("is made at the time asked, or one second after the old list when the clock is behind it", () => {
    expect(withoutFollow(old, pubkeyAt(0), FOLLOW_LIST_TIME + 50)!.created_at).toBe(FOLLOW_LIST_TIME + 50);
    expect(withoutFollow(old, pubkeyAt(0), FOLLOW_LIST_TIME - 1_000)!.created_at).toBe(FOLLOW_LIST_TIME + 1);
    expect(withoutFollow(old, pubkeyAt(0), FOLLOW_LIST_TIME)!.created_at).toBe(FOLLOW_LIST_TIME + 1);
  });

  it("is null when the list does not name the person", () => {
    expect(withoutFollow(old, ABSENT, FOLLOW_LIST_TIME + 50)).toBeNull();
    // Named in an `e` tag is not a follow.
    expect(withoutFollow(list({ tags: [["e", ABSENT]] }), ABSENT, FOLLOW_LIST_TIME + 50)).toBeNull();
  });

  it("is null when there is no list", () => {
    expect(withoutFollow(null, ABSENT, FOLLOW_LIST_TIME)).toBeNull();
  });

  it("takes out a person asked for in upper-case hex, however the list wrote them", () => {
    expect(withoutFollow(old, DUPLICATED.toUpperCase(), FOLLOW_LIST_TIME + 50)!.tags).toEqual(
      old.tags.filter((_, place) => place !== DUPLICATE_AT && place !== DUPLICATE_AGAIN_AT),
    );
    expect(withoutFollow(old, UPPER_CASED, FOLLOW_LIST_TIME + 50)!.tags).toEqual(old.tags.filter((_, place) => place !== UPPER_CASE_AT));
  });

  it.each(NOT_KEYS)("never takes out the entry written %j, which is no follow: asked to, it changes nothing", (notAKey) => {
    expect(old.tags).toContainEqual(["p", notAKey]);
    expect(withoutFollow(old, notAKey, FOLLOW_LIST_TIME + 50)).toBeNull();
  });

  it("is null for anything else that is no key, though the list has an entry written so", () => {
    const odd = list({ tags: [["p", "nope"], ["p", `${ABSENT}0`], ["p", ABSENT]] });
    expect(withoutFollow(odd, "nope", FOLLOW_LIST_TIME + 50)).toBeNull();
    expect(withoutFollow(odd, `${ABSENT}0`, FOLLOW_LIST_TIME + 50)).toBeNull();
  });

  it("leaves the list it is given as it was, and shares no tag with it", () => {
    const before = structuredClone(old.tags);
    const next = withoutFollow(old, DUPLICATED, FOLLOW_LIST_TIME + 50)!;
    expect(old.tags).toEqual(before);
    next.tags[0]![1] = "changed";
    expect(old.tags).toEqual(before);
  });
});

describe("a follow and then an unfollow", () => {
  it("bring the list back to what it was, apart from the time", () => {
    const old = buildFollowList(SECRET);
    const added = withFollow(old, ABSENT, FOLLOW_LIST_TIME + 10)!;
    const back = withoutFollow({ ...old, ...added }, ABSENT, FOLLOW_LIST_TIME + 20)!;
    expect(back.tags).toEqual(old.tags);
    expect(back.content).toBe(old.content);
  });
});

describe("removedBy", () => {
  const old = buildFollowList(SECRET);

  it("is every p tag that names the person, each as the list wrote it, with its place among the tags", () => {
    expect(removedBy(old, DUPLICATED)).toEqual([
      { index: DUPLICATE_AT, tag: ["p", DUPLICATED] },
      { index: DUPLICATE_AGAIN_AT, tag: ["p", DUPLICATED, "wss://relay.example.test", "met twice"] },
    ]);
    expect(removedBy(old, pubkeyAt(10))).toEqual([{ index: 10, tag: ["p", pubkeyAt(10), "wss://relay.example.test", "petname-10"] }]);
  });

  it("keeps a key the list wrote in upper-case hex as it wrote it, asked for in either case", () => {
    const entry = [{ index: UPPER_CASE_AT, tag: ["p", UPPER_CASED] }];
    expect(removedBy(old, UPPER_CASE_KEY)).toEqual(entry);
    expect(removedBy(old, UPPER_CASED)).toEqual(entry);
  });

  it("is what withoutFollow takes out: the tags at those places, and no other", () => {
    for (const who of [DUPLICATED, UPPER_CASE_KEY, pubkeyAt(0), pubkeyAt(FOLLOW_LIST_SIZE - 1)]) {
      const places = new Set(removedBy(old, who).map((entry) => entry.index));
      expect(withoutFollow(old, who, FOLLOW_LIST_TIME + 50)!.tags).toEqual(old.tags.filter((_, place) => !places.has(place)));
    }
  });

  it("is nothing when the list does not name the person, when there is no list, and for what is no key", () => {
    expect(removedBy(old, ABSENT)).toEqual([]);
    expect(removedBy(null, DUPLICATED)).toEqual([]);
    // Named in an `e` tag is not a follow.
    expect(removedBy(list({ tags: [["e", ABSENT]] }), ABSENT)).toEqual([]);
    for (const notAKey of NOT_KEYS) expect(removedBy(old, notAKey)).toEqual([]);
  });

  it("shares no tag with the list", () => {
    const before = structuredClone(old.tags);
    removedBy(old, DUPLICATED)[1]!.tag[3] = "changed";
    expect(old.tags).toEqual(before);
  });
});

describe("withRestored", () => {
  const old = buildFollowList(SECRET);
  const HINT = "wss://relay.example.test";

  /** The list an unfollow of `who` leaves of `from`, signed so that it has its id, and what the unfollow took out. */
  function unfollowed(who: string, from: NostrEvent = old): { left: NostrEvent; removed: Removed[] } {
    return { left: finalizeEvent(withoutFollow(from, who, FOLLOW_LIST_TIME + 50)!, SECRET), removed: removedBy(from, who) };
  }

  /** A list like `event`, with `tags` in place of its own: another one, a second later. */
  const changedTo = (event: NostrEvent, tags: string[][]) =>
    finalizeEvent({ kind: FOLLOW_KIND, created_at: event.created_at + 1, content: event.content, tags }, SECRET);

  it.each([
    ["named twice, once with a relay hint and a petname", DUPLICATED],
    ["written in upper-case hex", UPPER_CASE_KEY],
    ["at the start of the list", pubkeyAt(0)],
    ["at its end, with a petname", pubkeyAt(FOLLOW_LIST_SIZE - 1)],
    ["with a hint and a petname", pubkeyAt(10)],
  ])("puts a person %s back where they were: the tags are as before the unfollow, entry for entry", (_, who) => {
    const { left, removed } = unfollowed(who);

    const back = withRestored(left, removed, FOLLOW_LIST_TIME + 60, left.id)!;

    expect(back.tags).toEqual(old.tags);
    expect(back.content).toBe(old.content);
    expect(back.kind).toBe(FOLLOW_KIND);
  });

  it("is made at the time asked, or one second after the list when the clock is behind it", () => {
    const { left, removed } = unfollowed(DUPLICATED);
    expect(withRestored(left, removed, left.created_at + 30, left.id)!.created_at).toBe(left.created_at + 30);
    expect(withRestored(left, removed, left.created_at - 1_000, left.id)!.created_at).toBe(left.created_at + 1);
    expect(withRestored(left, removed, left.created_at, left.id)!.created_at).toBe(left.created_at + 1);
  });

  it("is null when the list names the person already", () => {
    const { left, removed } = unfollowed(DUPLICATED);
    // Followed again since, by another app.
    const again = changedTo(left, [...left.tags, ["p", DUPLICATED]]);
    expect(withRestored(again, removed, FOLLOW_LIST_TIME + 60, left.id)).toBeNull();
    // And the list they were taken out of names them still.
    expect(withRestored(old, removed, FOLLOW_LIST_TIME + 60, left.id)).toBeNull();
  });

  it("puts them at the end, in the order they had, when the list is not the one the unfollow left: an entry was added since", () => {
    const { left, removed } = unfollowed(DUPLICATED);
    const since = changedTo(left, [...left.tags, ["p", ABSENT]]);

    const back = withRestored(since, removed, FOLLOW_LIST_TIME + 60, left.id)!;

    expect(back.tags).toEqual([...since.tags, ["p", DUPLICATED], ["p", DUPLICATED, HINT, "met twice"]]);
    expect(back.content).toBe(old.content);
  });

  it("puts them at the end when an entry was taken out since: their places are counted in a list that is no more", () => {
    const { left, removed } = unfollowed(pubkeyAt(10));
    const since = changedTo(left, left.tags.slice(1));

    expect(withRestored(since, removed, FOLLOW_LIST_TIME + 60, left.id)!.tags).toEqual([...since.tags, ["p", pubkeyAt(10), HINT, "petname-10"]]);
  });

  it("puts them at the end when the list is as long as the one the unfollow left, and is another", () => {
    const { left, removed } = unfollowed(pubkeyAt(10));
    // One entry taken out and one added since: the same number of tags, and other places.
    const since = changedTo(left, [...left.tags.slice(1), ["p", ABSENT]]);

    expect(withRestored(since, removed, FOLLOW_LIST_TIME + 60, left.id)!.tags).toEqual([...since.tags, ["p", pubkeyAt(10), HINT, "petname-10"]]);
  });

  it("puts them at the end when a place is past the end of the list, or two of them share one", () => {
    const short = finalizeEvent({ kind: FOLLOW_KIND, created_at: FOLLOW_LIST_TIME, content: "kept", tags: [["p", pubkeyAt(1)], ["e", "x"]] }, SECRET);
    const plain = ["p", ABSENT];
    const hinted = ["p", ABSENT, HINT];

    // The last place a tag can go back to is one past the list's last.
    expect(withRestored(short, [{ index: 2, tag: plain }], FOLLOW_LIST_TIME + 60, short.id)!.tags).toEqual([["p", pubkeyAt(1)], ["e", "x"], plain]);
    expect(withRestored(short, [{ index: 3, tag: plain }], FOLLOW_LIST_TIME + 60, short.id)!.tags).toEqual([["p", pubkeyAt(1)], ["e", "x"], plain]);
    expect(withRestored(short, [{ index: 0, tag: plain }, { index: 9, tag: hinted }], FOLLOW_LIST_TIME + 60, short.id)!.tags).toEqual([
      ["p", pubkeyAt(1)],
      ["e", "x"],
      plain,
      hinted,
    ]);
    expect(withRestored(short, [{ index: 1, tag: plain }, { index: 1, tag: hinted }], FOLLOW_LIST_TIME + 60, short.id)!.tags).toEqual([
      ["p", pubkeyAt(1)],
      ["e", "x"],
      plain,
      hinted,
    ]);
    // In their places, when each has one: the first goes in before the second is counted.
    expect(withRestored(short, [{ index: 3, tag: hinted }, { index: 0, tag: plain }], FOLLOW_LIST_TIME + 60, short.id)!.tags).toEqual([
      plain,
      ["p", pubkeyAt(1)],
      ["e", "x"],
      hinted,
    ]);
  });

  it("makes nothing when there is no list: there is none to put them back into, and what was taken out is no list of its own", () => {
    const { left, removed } = unfollowed(DUPLICATED);

    expect(withRestored(null, removed, 1_800_000_000, left.id)).toBeNull();
    // Whatever list the unfollow left, and however few the entries.
    expect(withRestored(null, [{ index: 0, tag: ["p", ABSENT] }], 1_800_000_000, "0".repeat(64))).toBeNull();
  });

  it.each<[string, Removed[]]>([
    ["nothing", []],
    ["a tag that is not a p tag", [{ index: 0, tag: ["e", ABSENT] }]],
    ["a p tag that names no key", [{ index: 0, tag: ["p", "not-a-key"] }]],
    ["a p tag with no key", [{ index: 0, tag: ["p"] }]],
    ["an empty tag", [{ index: 0, tag: [] }]],
    ["entries of two people", [{ index: 0, tag: ["p", ABSENT] }, { index: 1, tag: ["p", pubkeyAt(20_001)] }]],
    ["a place before the list's first", [{ index: -1, tag: ["p", ABSENT] }]],
    ["a place that is no whole number", [{ index: 1.5, tag: ["p", ABSENT] }]],
  ])("throws for %s: nothing but one person's own entries is ever put back, into a list or a fresh one", (_, removed) => {
    const { left } = unfollowed(DUPLICATED);
    expect(() => withRestored(left, removed, FOLLOW_LIST_TIME + 60, left.id)).toThrow(TypeError);
    expect(() => withRestored(null, removed, FOLLOW_LIST_TIME + 60, left.id)).toThrow(TypeError);
  });

  it("leaves what it is given as it was, and shares no tag with it", () => {
    const { left, removed } = unfollowed(DUPLICATED);
    const tagsBefore = structuredClone(left.tags);
    const removedBefore = structuredClone(removed);

    const back = withRestored(left, removed, FOLLOW_LIST_TIME + 60, left.id)!;
    back.tags[0]![1] = "changed";
    back.tags[DUPLICATE_AGAIN_AT]![3] = "changed";

    expect(left.tags).toEqual(tagsBefore);
    expect(removed).toEqual(removedBefore);
  });
});

describe("an unfollow and then Undo", () => {
  it("bring the list back to what it was, apart from the time, whoever is taken out", () => {
    const old = buildFollowList(SECRET);
    for (const who of FOLLOWED_IN_LIST.filter((_, at) => at % 97 === 0)) {
      const left = finalizeEvent(withoutFollow(old, who, FOLLOW_LIST_TIME + 10)!, SECRET);
      const back = withRestored(left, removedBy(old, who), FOLLOW_LIST_TIME + 20, left.id)!;
      expect(back.tags).toEqual(old.tags);
      expect(back.content).toBe(old.content);
    }
  });
});
