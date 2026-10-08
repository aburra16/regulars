import { describe, expect, it } from "vitest";

import { profilesFrom } from "../src/nostr/profiles";
import { hex64, shapedEvent } from "./support/events";

const profile = (fields: Record<string, unknown>) => JSON.stringify(fields);
const ALICE = hex64("a");
const BOB = hex64("b");
const CAROL = hex64("c");
/**
 * What a profile whose `content` is this gives of ALICE, through `profilesFrom`, the path the app reads
 * profiles by: undefined when it gives neither a name nor a picture to show.
 */
const profileIn = (content: string) => profilesFrom([shapedEvent({ kind: 0, pubkey: ALICE, content })]).get(ALICE);
const nameIn = (content: string) => profileIn(content)?.name;
const pictureIn = (content: string) => profileIn(content)?.picture;
/** A real public key's code (the house's), as a person might paste it into their name. */
const NPUB = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";

describe("the name a profile gives (Review Focus 4)", () => {
  it("takes display_name, else name", () => {
    expect(nameIn(profile({ display_name: "Alice Bento", name: "alice" }))).toBe("Alice Bento");
    expect(nameIn(profile({ name: "alice" }))).toBe("alice");
    expect(nameIn(profile({ display_name: "   ", name: "alice" }))).toBe("alice");
  });

  it("takes out the characters that reorder the text around them, and makes runs of space one", () => {
    // A right-to-left override would reverse what follows it on the page.
    expect(nameIn(profile({ name: "\u202eecilA" }))).toBe("ecilA");
    // Every embedding, override, isolate and mark that can reorder text: U+202A–E, U+2066–9, U+200E–F, U+061C.
    const reorderers = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061c";
    expect(nameIn(profile({ name: `Bo${reorderers}b` }))).toBe("Bob");
    expect(nameIn(profile({ name: "\u2066Bob\u2069 \n\t Ferreira" }))).toBe("Bob Ferreira");
    expect(nameIn(profile({ name: "\u0000\u0007" }))).toBeUndefined();
  });

  it("keeps the joiners and other format characters that names are written with", () => {
    // An emoji joined into one (woman, ZWJ, laptop), and a Persian word with a zero-width non-joiner.
    expect(nameIn(profile({ name: "\u{1f469}\u200d\u{1f4bb} Maya" }))).toBe("\u{1f469}\u200d\u{1f4bb} Maya");
    expect(nameIn(profile({ name: "می\u200cخواهم" }))).toBe("می\u200cخواهم");
    expect(nameIn(profile({ name: "Ana\u00adbela" }))).toBe("Ana\u00adbela");
  });

  it("takes a name of nothing but invisible characters for no name", () => {
    expect(nameIn(profile({ display_name: "\u200b\u200d\u2060\u200c", name: "Carol" }))).toBe("Carol");
    expect(nameIn(profile({ name: "\ufeff\u200b \u00ad" }))).toBeUndefined();
  });

  it("takes the blank characters that draw nothing for invisible: Hangul fillers, the blank Braille cell and the like", () => {
    // Hangul fillers (U+3164, U+115F, U+1160, U+FFA0), the blank Braille pattern (U+2800), the combining
    // grapheme joiner (U+034F), the Khmer inherent vowels (U+17B4, U+17B5), the Mongolian vowel separator
    // (U+180E) and a variation selector (U+FE0F): each shows as nothing, alone or in a run.
    const blanks = ["\u3164", "\u115f", "\u1160", "\uffa0", "\u2800", "\u034f", "\u17b4", "\u17b5", "\u180e", "\ufe0f"];
    for (const blank of blanks) {
      expect(nameIn(profile({ display_name: blank, name: "Carol" }))).toBe("Carol");
      expect(nameIn(profile({ name: blank.repeat(3) }))).toBeUndefined();
    }
    expect(nameIn(profile({ name: "\u3164 \u2800\u200b" }))).toBeUndefined();
    // Beside letters that show, they are part of the name, as the person wrote it.
    expect(nameIn(profile({ name: "\u3164Maya" }))).toBe("\u3164Maya");
  });

  it("passes over a code or a key with invisible characters inside it, which would still show as the code", () => {
    // A zero-width space, a soft hyphen, a word joiner and a Hangul filler inside the house's code.
    expect(nameIn(profile({ name: `${NPUB.slice(0, 12)}\u200b${NPUB.slice(12)}` }))).toBeUndefined();
    expect(nameIn(profile({ name: `${NPUB.slice(0, 5)}\u00ad${NPUB.slice(5, 30)}\u2060${NPUB.slice(30)}` }))).toBeUndefined();
    expect(nameIn(profile({ name: `\u3164${NPUB}\u2800` }))).toBeUndefined();
    // A space inside it hides nothing either.
    expect(nameIn(profile({ name: `${NPUB.slice(0, 30)} ${NPUB.slice(30)}` }))).toBeUndefined();
    // A key with a byte-order mark in the middle, or a blank Braille cell at the front.
    const key = hex64("c");
    expect(nameIn(profile({ display_name: `${key.slice(0, 32)}\ufeff${key.slice(32)}`, name: "Carol" }))).toBe("Carol");
    expect(nameIn(profile({ name: `\u2800${key}` }))).toBeUndefined();
    // A short name that begins like a code is still a name, invisible characters or not.
    expect(nameIn(profile({ name: "npub1\u200bparty" }))).toBe("npub1\u200bparty");
  });

  it("passes over a code or a key, but keeps a short name that begins like one", () => {
    expect(nameIn(profile({ name: NPUB }))).toBeUndefined();
    expect(nameIn(profile({ name: NPUB.toUpperCase() }))).toBeUndefined();
    expect(nameIn(profile({ name: `nprofile1${"q".repeat(70)}` }))).toBeUndefined();
    expect(nameIn(profile({ display_name: hex64("c"), name: "Carol" }))).toBe("Carol");
    expect(nameIn(profile({ name: hex64("c").toUpperCase() }))).toBeUndefined();
    for (const name of ["Note12", "npub1", "naddr1xyz", "Nevent1 party"]) expect(nameIn(profile({ name }))).toBe(name);
  });

  it("is undefined for content that is not a JSON object, or names that are not text", () => {
    for (const content of ["{not json", "", "null", "[]", '"Alice"', "7"]) expect(nameIn(content)).toBeUndefined();
    expect(nameIn(profile({ name: 7, display_name: ["Dave"] }))).toBeUndefined();
  });
});

describe("the picture a profile gives", () => {
  const AT = "https://img.example.test/me.jpg";

  it("keeps an https address, trimmed", () => {
    expect(pictureIn(profile({ name: "Alice", picture: AT }))).toBe(AT);
    expect(pictureIn(profile({ picture: ` \n${AT}?size=96\t ` }))).toBe(`${AT}?size=96`);
  });

  it("drops any other scheme, and an address that is not whole", () => {
    for (const picture of [
      "http://img.example.test/me.jpg",
      "data:image/png;base64,iVBORw0KGgo=",
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "blob:https://img.example.test/1",
      "ftp://img.example.test/me.jpg",
      "//img.example.test/me.jpg",
      "/me.jpg",
      "img.example.test/me.jpg",
      "https://",
    ]) {
      expect(pictureIn(profile({ picture })), picture).toBeUndefined();
    }
  });

  it("drops an address with a user name or a password in it", () => {
    expect(pictureIn(profile({ picture: "https://alice:secret@img.example.test/me.jpg" }))).toBeUndefined();
    expect(pictureIn(profile({ picture: "https://alice@img.example.test/me.jpg" }))).toBeUndefined();
    expect(pictureIn(profile({ picture: "https://:secret@img.example.test/me.jpg" }))).toBeUndefined();
  });

  it("drops an address longer than 2,000 characters", () => {
    const longest = `https://img.example.test/${"a".repeat(2000 - "https://img.example.test/".length)}`;
    expect(longest).toHaveLength(2000);
    expect(pictureIn(profile({ picture: `  ${longest}  ` }))).toBe(longest);
    expect(pictureIn(profile({ picture: `${longest}a` }))).toBeUndefined();
  });

  it("is undefined with no picture, one that is not text, or content that is not a JSON object", () => {
    expect(pictureIn(profile({ name: "Alice" }))).toBeUndefined();
    for (const picture of ["", "   ", 7, [AT], { url: AT }, null]) expect(pictureIn(profile({ picture }))).toBeUndefined();
    for (const content of ["{not json", "", "null", "[]", `"${AT}"`]) expect(pictureIn(content)).toBeUndefined();
  });
});

describe("profilesFrom", () => {
  const AT = "https://img.example.test/alice.jpg";

  it("reads each person's name and picture from their newest profile, even one with neither", () => {
    const older = shapedEvent({ kind: 0, pubkey: ALICE, created_at: 1_700_000_000, content: profile({ name: "Alice", picture: AT }) });
    const newer = shapedEvent({ kind: 0, pubkey: ALICE, created_at: 1_700_000_100, content: profile({ about: "hi" }) });
    const bob = shapedEvent({ kind: 0, pubkey: BOB, content: profile({ name: "Bob", picture: "http://img.example.test/bob.jpg" }) });
    const carol = shapedEvent({ kind: 0, pubkey: CAROL, content: profile({ picture: "https://img.example.test/carol.jpg" }) });
    expect(profilesFrom([newer, bob, older])).toEqual(new Map([[BOB, { name: "Bob" }]]));
    expect(profilesFrom([older, bob, carol])).toEqual(
      new Map([
        [ALICE, { name: "Alice", picture: AT }],
        [BOB, { name: "Bob" }],
        [CAROL, { picture: "https://img.example.test/carol.jpg" }],
      ]),
    );
    // Nothing is set that a profile does not give.
    expect(Object.keys(profilesFrom([bob]).get(BOB)!)).toEqual(["name"]);
  });

  it("passes over events of other kinds and values that are not events", () => {
    const note = shapedEvent({ kind: 1, pubkey: ALICE, content: profile({ name: "Alice", picture: AT }) });
    expect(profilesFrom([note, null, "Alice"])).toEqual(new Map());
  });
});
