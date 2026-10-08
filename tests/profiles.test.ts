import { describe, expect, it } from "vitest";

import { nameIn, namesFrom } from "../src/nostr/profiles";
import { hex64, shapedEvent } from "./support/events";

const profile = (fields: Record<string, unknown>) => JSON.stringify(fields);
const ALICE = hex64("a");
const BOB = hex64("b");
/** A real public key's code (the house's), as a person might paste it into their name. */
const NPUB = "npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8";

describe("nameIn (Review Focus 4)", () => {
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

describe("namesFrom", () => {
  it("names each person from their newest profile, even one with no name", () => {
    const older = shapedEvent({ kind: 0, pubkey: ALICE, created_at: 1_700_000_000, content: profile({ name: "Alice" }) });
    const newer = shapedEvent({ kind: 0, pubkey: ALICE, created_at: 1_700_000_100, content: profile({ about: "hi" }) });
    const bob = shapedEvent({ kind: 0, pubkey: BOB, content: profile({ name: "Bob" }) });
    expect(namesFrom([newer, bob, older])).toEqual(new Map([[BOB, "Bob"]]));
    expect(namesFrom([older, bob])).toEqual(
      new Map([
        [ALICE, "Alice"],
        [BOB, "Bob"],
      ]),
    );
  });

  it("passes over events of other kinds and values that are not events", () => {
    const note = shapedEvent({ kind: 1, pubkey: ALICE, content: profile({ name: "Alice" }) });
    expect(namesFrom([note, null, "Alice"])).toEqual(new Map());
  });
});
