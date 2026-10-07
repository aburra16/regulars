import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ALLOWED_PROTOCOL_STRINGS, copy } from "../src/copy/en";

// Words a diner must never see (decisions.md #12; the handoff list is a minimum).
const BANNED = [
  "nostr",
  "bitcoin",
  "npub",
  "relay",
  "event",
  "web of trust",
  "zap",
  "dlist",
  "graperank",
  "follow",
  "followers",
  "following",
  "key",
  "keys",
  "sign",
  "signed",
  "signature",
];

// "sign in" is the app's own word for authenticating, so these phrases are
// scrubbed before "sign" is checked. "signed in" and "signed out" are NOT
// permitted: copy says "after you sign in", never "signed in".
const PERMITTED_PHRASES = /\b(?:sign[ -]in|signing in)\b/gi;

const ALLOWED = new Set<string>(Object.values(ALLOWED_PROTOCOL_STRINGS));

function bannedWordsIn(text: string): string[] {
  const scrubbed = text.replace(PERMITTED_PHRASES, " ");
  return BANNED.filter((word) => {
    const phrase = word.split(" ").join("\\s+");
    return new RegExp(`\\b${phrase}\\b`, "i").test(scrubbed);
  });
}

// Template functions are called with a spread of sample arguments (names, counts,
// pairs) so that every branch a screen can reach is scanned.
const SAMPLE_ARGS: unknown[][] = [
  ["Sample"],
  [0],
  [1],
  [2],
  [12],
  ["Sample", "Sample"],
  ["Sample", 3],
  [3, "Sample"],
  ["Sample", 3, "Sample"],
  [3, "Sample", "Sample"],
];

interface Leaf {
  path: string;
  text: string;
}

function leavesOf(node: unknown, path: string): Leaf[] {
  if (typeof node === "string") return [{ path, text: node }];
  if (typeof node === "function") {
    const outputs: Leaf[] = [];
    for (const args of SAMPLE_ARGS) {
      try {
        const out: unknown = node(...args);
        if (typeof out === "string") outputs.push({ path: `${path}(${JSON.stringify(args)})`, text: out });
      } catch {
        // This argument shape does not suit this template; another one will.
      }
    }
    if (outputs.length === 0) throw new Error(`copy.${path} returned no string for any sample arguments`);
    return outputs;
  }
  if (typeof node === "object" && node !== null) {
    return Object.entries(node).flatMap(([key, child]) => leavesOf(child, path ? `${path}.${key}` : key));
  }
  throw new Error(`copy.${path} is a ${typeof node}; copy leaves must be strings or template functions`);
}

const indexHtml = new DOMParser().parseFromString(
  readFileSync(resolve(process.cwd(), "index.html"), "utf8"),
  "text/html",
);

describe("copy", () => {
  it("no banned word appears in copy", () => {
    const leaves = leavesOf(copy, "");
    expect(leaves.length).toBeGreaterThan(0);

    const offences = leaves
      .filter((leaf) => !ALLOWED.has(leaf.text))
      .map((leaf) => ({ path: leaf.path, text: leaf.text, banned: bannedWordsIn(leaf.text) }))
      .filter((leaf) => leaf.banned.length > 0);

    expect(offences).toEqual([]);
  });

  it("allows exactly the two protocol strings, and only as whole strings", () => {
    expect(ALLOWED_PROTOCOL_STRINGS).toEqual({
      signInButton: "Continue with Nostr",
      bitcoinChip: "Bitcoin accepted",
    });
    // A sentence that merely contains an allowed string is still scanned.
    expect(ALLOWED.has("Pay with Bitcoin accepted here")).toBe(false);
    expect(bannedWordsIn("Pay with Bitcoin accepted here")).toContain("bitcoin");
  });

  it("the banned-word check catches what it should and lets 'sign in' through", () => {
    expect(bannedWordsIn("Open in Nostr")).toEqual(["nostr"]);
    expect(bannedWordsIn("Your public key")).toEqual(["key"]);
    expect(bannedWordsIn("Web  of   Trust")).toEqual(["web of trust"]);
    expect(bannedWordsIn("Sign the guestbook")).toEqual(["sign"]);
    expect(bannedWordsIn("You are signed in")).toEqual(["signed"]);
    expect(bannedWordsIn("Someone to follow")).toEqual(["follow"]);

    expect(bannedWordsIn("Sign in")).toEqual([]);
    expect(bannedWordsIn("Sign-in")).toEqual([]);
    expect(bannedWordsIn("Signing in to Regulars")).toEqual([]);
    expect(bannedWordsIn("Sign in to see your circle")).toEqual([]);
    expect(bannedWordsIn("Keyboard shortcuts")).toEqual([]);
  });

  it("scans template functions by calling them", () => {
    const leaves = leavesOf({ a: (name: string) => `Hello ${name}`, b: { c: "plain" } }, "");
    expect(leaves.map((leaf) => leaf.text)).toContain("Hello Sample");
    expect(leaves.map((leaf) => leaf.text)).toContain("plain");
  });
});

describe("index.html", () => {
  it("is titled and described from the copy module", () => {
    expect(indexHtml.documentElement.lang).toBe("en");
    expect(indexHtml.title).toBe(copy.app.name);
    expect(indexHtml.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      copy.meta.description,
    );
  });

  it("no banned word in index.html title or meta", () => {
    const texts = [
      indexHtml.title,
      ...Array.from(indexHtml.querySelectorAll("meta")).map((meta) => meta.getAttribute("content") ?? ""),
    ];
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.flatMap(bannedWordsIn)).toEqual([]);
  });
});
