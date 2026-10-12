import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { fromNpub, personPath, toNpub } from "../src/person/npub";

/*
 * A person in the app's address: `/person/<npub>` (ruling R1). The code is nostr-tools' own
 * (`nip19`); these hold the app's use of it to one key in, the same key out, and nobody for anything
 * that is not a person's public code. The keys are thrown away.
 */

const SECRET = generateSecretKey();
const KEY = getPublicKey(SECRET);
const NPUB = nip19.npubEncode(KEY);

describe("a person's key as the address writes it", () => {
  it("goes there and back: the key that went in is the key that comes out", () => {
    expect(toNpub(KEY)).toBe(NPUB);
    expect(NPUB).toMatch(/^npub1[a-z0-9]{58}$/);
    expect(fromNpub(toNpub(KEY))).toBe(KEY);
    // And for a key that is all one digit, or all the last one.
    for (const key of ["0".repeat(64), "f".repeat(64), `${"0".repeat(63)}1`]) expect(fromNpub(toNpub(key))).toBe(key);
  });

  it("writes a key given in upper-case hex as the same person's", () => {
    expect(toNpub(KEY.toUpperCase())).toBe(NPUB);
    expect(fromNpub(toNpub(KEY.toUpperCase()))).toBe(KEY);
  });

  it.each([
    ["nothing", ""],
    ["a key too short", KEY.slice(2)],
    ["a key too long", `${KEY}00`],
    ["what is no hex", "z".repeat(64)],
    ["an address's own code", NPUB],
  ])("writes nothing for %s: it is no key", (_, text) => {
    expect(() => toNpub(text)).toThrow();
  });
});

describe("what an address names", () => {
  it("is the person, for their code in lower case or all in upper case, which are the same code", () => {
    expect(fromNpub(NPUB)).toBe(KEY);
    expect(fromNpub(NPUB.toUpperCase())).toBe(KEY);
  });

  it.each([
    ["nothing", ""],
    ["a word", "maya"],
    ["a key in hex", KEY],
    ["a note's code", nip19.noteEncode(KEY)],
    ["a secret key's code", nip19.nsecEncode(SECRET)],
    ["a profile's code, which names the person and more", nip19.nprofileEncode({ pubkey: KEY, relays: ["wss://relay.example.test"] })],
    ["a person's code of a key too short", nip19.encodeBytes("npub", new Uint8Array(31).fill(7))],
    ["a person's code of a key too long", nip19.encodeBytes("npub", new Uint8Array(33).fill(7))],
    ["a code with one character changed", `${NPUB.slice(0, -1)}${NPUB.endsWith("q") ? "p" : "q"}`],
    ["a code cut short", NPUB.slice(0, -4)],
    ["a code in mixed case", `${NPUB.slice(0, 20)}${NPUB.slice(20).toUpperCase()}`],
    ["a code with a space before it", ` ${NPUB}`],
    ["a code with a space after it", `${NPUB} `],
    ["a code with its scheme before it", `nostr:${NPUB}`],
  ])("is nobody for %s", (_, text) => {
    expect(fromNpub(text)).toBeNull();
  });
});

describe("the address of a person's page", () => {
  it("is /person/ and their code, the same for a key in either case", () => {
    expect(personPath(KEY)).toBe(`/person/${NPUB}`);
    expect(personPath(KEY.toUpperCase())).toBe(`/person/${NPUB}`);
    // Nothing in it needs writing another way for an address.
    expect(encodeURIComponent(NPUB)).toBe(NPUB);
  });

  it("is none for what is no key", () => {
    expect(() => personPath("not a key")).toThrow();
  });
});
