import type { NostrEvent } from "@nostrify/nostrify";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { config } from "../src/config";
import { newestSaved, SAVED_D, SAVED_KIND, SAVED_TITLE, savedAddresses, withSaved, withoutSaved } from "../src/saved/list";
import { hex64, shapedEvent } from "./support/events";

/*
 * The rules of a person's saved places: one bookmark set (kind 30003) named `regulars-saved`, each
 * place in it an `a` tag with the place's address. Which of several lists is the newest, the places
 * one holds, and the one entry a save or an unsave changes, keeping everything else in the record
 * as it was: other apps may keep their own entries in it. They are pure: nothing here reads a relay
 * or signs.
 */

const ME = getPublicKey(generateSecretKey());
const OTHER = hex64("2");
const HUB = config.placesRelay;
const NOW = 1_800_000_000;

/** A place of the list the app shows: its address is the house's, with `d`. */
const placeAt = (d: string) => ({ address: `39999:${config.houseHex}:${d}` });
const CAFE = placeAt("cafe-funchal");
const BAR = placeAt("bar-funchal");
const TEA = placeAt("tea-funchal");

/** A saved list of the person's, named as the app names it and with its title, over `fields`. */
const saved = (fields: Partial<NostrEvent> = {}) =>
  shapedEvent({ kind: 30003, pubkey: ME, created_at: NOW - 100, tags: [["d", "regulars-saved"], ["title", "Saved places"]], ...fields });

/** Another app's entries in the same record, and the text it keeps encrypted in `content`. */
const THEIRS = [
  ["a", `30023:${OTHER}:a-long-post`, "wss://writing.example.com"],
  ["e", hex64("e"), "wss://notes.example.com"],
  ["t", "x"],
  ["image", "https://pictures.example.com/cover.jpg"],
  ["r", "https://example.com/a-page"],
];
const ENCRYPTED = "  Ag8kZ0vN3l+q1Kc/0aW9qQ==?iv=k9d+/F7ql2hzIJVlQ6Z1Ug==\né中 ";

describe("the record", () => {
  it("is the person's bookmark set named regulars-saved, titled Saved places when it is first made", () => {
    expect(SAVED_KIND).toBe(30003);
    expect(SAVED_D).toBe("regulars-saved");
    expect(SAVED_TITLE).toBe("Saved places");
  });
});

describe("withSaved", () => {
  it("makes a first list of its name, its title and the place, with the list hub as the place's hint", () => {
    expect(withSaved(null, CAFE, NOW)).toEqual({
      kind: 30003,
      created_at: NOW,
      tags: [
        ["d", "regulars-saved"],
        ["title", "Saved places"],
        ["a", CAFE.address, "wss://dcosl.brainstorm.world"],
      ],
      content: "",
    });
  });

  it("keeps another app's entries in their order and the content byte for byte, with the place added last", () => {
    const list = saved({ tags: [["d", "regulars-saved"], ["title", "Saved places"], ...THEIRS, ["a", BAR.address, HUB]], content: ENCRYPTED });

    const next = withSaved(list, CAFE, NOW);

    expect(next?.tags).toEqual([["d", "regulars-saved"], ["title", "Saved places"], ...THEIRS, ["a", BAR.address, HUB], ["a", CAFE.address, HUB]]);
    expect(next?.content).toBe(ENCRYPTED);
    expect(next?.kind).toBe(30003);
    // A copy: what is signed is never the list that was read.
    expect(next?.tags[2]).not.toBe(list.tags[2]);
  });

  it("keeps a title the list has been given elsewhere, and adds none", () => {
    const list = saved({ tags: [["d", "regulars-saved"], ["title", "Lunch"]] });

    expect(withSaved(list, CAFE, NOW)?.tags).toEqual([["d", "regulars-saved"], ["title", "Lunch"], ["a", CAFE.address, HUB]]);
  });

  it("adds no title to a list that has none", () => {
    const list = saved({ tags: [["d", "regulars-saved"], ["a", BAR.address, HUB]] });

    expect(withSaved(list, CAFE, NOW)?.tags).toEqual([["d", "regulars-saved"], ["a", BAR.address, HUB], ["a", CAFE.address, HUB]]);
  });

  it("gives nothing to save for a place the list holds already, whatever its hint, or with none", () => {
    expect(withSaved(saved({ tags: [["d", "regulars-saved"], ["a", CAFE.address, "wss://another.example.com"]] }), CAFE, NOW)).toBeNull();
    expect(withSaved(saved({ tags: [["d", "regulars-saved"], ["a", CAFE.address]] }), CAFE, NOW)).toBeNull();
  });

  it("is made a second after the list when the list is ahead of the clock, and at the clock's time when it is not", () => {
    expect(withSaved(saved({ created_at: NOW + 500 }), CAFE, NOW)?.created_at).toBe(NOW + 501);
    expect(withSaved(saved({ created_at: NOW - 500 }), CAFE, NOW)?.created_at).toBe(NOW);
    expect(withSaved(saved({ created_at: NOW }), CAFE, NOW)?.created_at).toBe(NOW + 1);
  });

  it("adds nothing that is not a place of the list the app shows: another curator's, another kind, or no name", () => {
    for (const address of [`39999:${OTHER}:cafe-funchal`, `30023:${config.houseHex}:cafe-funchal`, `39999:${config.houseHex}:`, "cafe-funchal"]) {
      expect(() => withSaved(null, { address }, NOW), address).toThrow(TypeError);
      expect(() => withSaved(saved(), { address }, NOW), address).toThrow(TypeError);
    }
  });
});

describe("withoutSaved", () => {
  it("takes out every entry for the place, whatever its hint, and nothing else", () => {
    const list = saved({
      tags: [["d", "regulars-saved"], ["title", "Saved places"], ["a", CAFE.address, HUB], ...THEIRS, ["a", BAR.address, HUB], ["a", CAFE.address, "wss://another.example.com"]],
      content: ENCRYPTED,
    });

    const next = withoutSaved(list, CAFE.address, NOW);

    expect(next).toEqual({
      kind: 30003,
      created_at: NOW,
      tags: [["d", "regulars-saved"], ["title", "Saved places"], ...THEIRS, ["a", BAR.address, HUB]],
      content: ENCRYPTED,
    });
  });

  it("leaves the list's name and title when the last place is taken out", () => {
    const list = saved({ tags: [["d", "regulars-saved"], ["title", "Saved places"], ["a", CAFE.address, HUB]] });

    expect(withoutSaved(list, CAFE.address, NOW)?.tags).toEqual([["d", "regulars-saved"], ["title", "Saved places"]]);
  });

  it("gives nothing to save for a place the list does not hold, or when there is no list", () => {
    expect(withoutSaved(saved({ tags: [["d", "regulars-saved"], ["a", BAR.address, HUB]] }), CAFE.address, NOW)).toBeNull();
    expect(withoutSaved(null, CAFE.address, NOW)).toBeNull();
  });

  it("takes out nothing that is not a place: another app's entry stays, whatever is asked", () => {
    const list = saved({ tags: [["d", "regulars-saved"], ...THEIRS] });

    expect(withoutSaved(list, `30023:${OTHER}:a-long-post`, NOW)).toBeNull();
    expect(withoutSaved(list, hex64("e"), NOW)).toBeNull();
  });

  it("is made a second after the list when the list is ahead of the clock", () => {
    const list = saved({ created_at: NOW + 500, tags: [["d", "regulars-saved"], ["a", CAFE.address, HUB]] });

    expect(withoutSaved(list, CAFE.address, NOW)?.created_at).toBe(NOW + 501);
  });
});

describe("savedAddresses", () => {
  it("gives the places newest saved first, each once", () => {
    const list = saved({
      tags: [["d", "regulars-saved"], ["a", CAFE.address, HUB], ["a", BAR.address, HUB], ["a", CAFE.address, "wss://another.example.com"], ["a", TEA.address, HUB]],
    });

    expect(savedAddresses(list)).toEqual([TEA.address, CAFE.address, BAR.address]);
  });

  it("leaves out entries of another curator or another kind, and what is not a place's address", () => {
    const list = saved({
      tags: [
        ["d", "regulars-saved"],
        ["a", `39999:${OTHER}:cafe-funchal`, HUB],
        ["a", `30023:${config.houseHex}:cafe-funchal`, HUB],
        ["a", `39999:${config.houseHex}:`, HUB],
        ["a", `39999:${config.houseHex}: `, HUB],
        ["a"],
        ["e", hex64("e")],
        ["p", config.houseHex],
        ...THEIRS,
        ["a", BAR.address, HUB],
      ],
    });

    expect(savedAddresses(list)).toEqual([BAR.address]);
  });

  it("gives none for no list", () => {
    expect(savedAddresses(null)).toEqual([]);
  });
});

describe("newestSaved", () => {
  it("is the one made last, and of two made in the same second, the one with the lower id", () => {
    const old = saved({ created_at: 100, id: hex64("1") });
    const recent = saved({ created_at: 200, id: hex64("f") });
    expect(newestSaved([old, recent], ME)).toBe(recent);
    expect(newestSaved([recent, old], ME)).toBe(recent);

    const low = saved({ created_at: 300, id: hex64("1") });
    const high = saved({ created_at: 300, id: hex64("f") });
    expect(newestSaved([high, low], ME)).toBe(low);
    expect(newestSaved([low, high], ME)).toBe(low);
  });

  it("ignores another list's name, another author and another kind, however new", () => {
    const mine = saved({ created_at: 100 });
    const anotherName = saved({ created_at: 900, tags: [["d", "favourites"]] });
    const noName = saved({ created_at: 900, tags: [] });
    const anotherAuthor = saved({ created_at: 900, pubkey: OTHER });
    const bookmarks = shapedEvent({ kind: 10003, pubkey: ME, created_at: 900, tags: [["d", "regulars-saved"]] });
    const anotherSet = shapedEvent({ kind: 30001, pubkey: ME, created_at: 900, tags: [["d", "regulars-saved"]] });

    expect(newestSaved([anotherName, noName, anotherAuthor, bookmarks, anotherSet, mine], ME)).toBe(mine);
    expect(newestSaved([anotherName, anotherAuthor, bookmarks], ME)).toBeNull();
    expect(newestSaved([], ME)).toBeNull();
  });

  it("goes by the list's first name, as relays do", () => {
    const named = saved({ tags: [["d", "regulars-saved"], ["d", "favourites"]] });
    const namedSecond = saved({ created_at: 900, tags: [["d", "favourites"], ["d", "regulars-saved"]] });

    expect(newestSaved([namedSecond, named], ME)).toBe(named);
  });
});
