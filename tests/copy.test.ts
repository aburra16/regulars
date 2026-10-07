import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { ALLOWED_PROTOCOL_STRINGS, copy } from "../src/copy/en";
import kinds from "../src/data/kinds.json";

// Words a diner must never see (decisions.md #12; the handoff list is a minimum).
// Each stem is matched with its inflections and an "un" prefix, so "relays", "zapped",
// "follows", "followers", "unfollow", "signing" and "keys" are all caught.
const INFLECTIONS = "(?:s|es|ed|er|ers|ing)?";
const STEMS = ["relay", "event", "zap", "npub", "dlist", "follow", "key", "sign", "graperank"];

const BANNED: ReadonlyArray<{ word: string; pattern: RegExp }> = [
  ...STEMS.map((stem) => ({
    word: stem,
    pattern: new RegExp(`\\b(?:un)?${stem}${INFLECTIONS}\\b`, "i"),
  })),
  { word: "zap", pattern: /\bzapp(?:ed|ing|er|ers)\b/i }, // doubled consonant
  { word: "signature", pattern: /\bsignatures?\b/i },
  { word: "web of trust", pattern: /\bweb\s+of\s+trust\b/i },
  { word: "nostr", pattern: /\bnostr\b/i },
  { word: "bitcoin", pattern: /\bbitcoins?\b/i },
  // "Kind 39999", "kind 1", and any bare five-digit number starting with 3 (the 3xxxx range
  // holds the list and place kinds). A diner never needs either.
  { word: "kind number", pattern: /\bkind\s*\d+\b|\b3\d{4}\b/i },
];

// "sign in" is the app's own word for authenticating, so these phrases are
// scrubbed before "sign" is checked. "signed in" and "signed out" are NOT
// permitted: copy says "after you sign in", never "signed in".
const PERMITTED_PHRASES = /\b(?:sign[ -]in|signing in)\b/gi;

function bannedWordsIn(text: string): string[] {
  const scrubbed = text.replace(PERMITTED_PHRASES, " ");
  return [...new Set(BANNED.filter(({ pattern }) => pattern.test(scrubbed)).map(({ word }) => word))];
}

// The two protocol strings are exempt from the scan only at these keys. Anywhere else
// the same text is an offence, and so is any sentence that merely contains it.
const ALLOWED_AT: Readonly<Record<string, string>> = {
  "signin.continueButton": ALLOWED_PROTOCOL_STRINGS.signInButton,
  "place.bitcoinChip": ALLOWED_PROTOCOL_STRINGS.bitcoinChip,
};

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

/** Every `label` and `familyLabel` in kinds.json: the words that name a kind of place on screen. */
function kindLabelsOf(node: unknown, path: string): Leaf[] {
  if (Array.isArray(node)) return node.flatMap((child, i) => kindLabelsOf(child, `${path}[${i}]`));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    (key === "label" || key === "familyLabel") && typeof child === "string"
      ? [{ path: `${path}.${key}`, text: child }]
      : kindLabelsOf(child, `${path}.${key}`),
  );
}

const indexHtml = new DOMParser().parseFromString(
  readFileSync(resolve(process.cwd(), "index.html"), "utf8"),
  "text/html",
);

const offencesIn = (leaves: Leaf[]) =>
  leaves
    .filter((leaf) => ALLOWED_AT[leaf.path] !== leaf.text)
    .map((leaf) => ({ path: leaf.path, text: leaf.text, banned: bannedWordsIn(leaf.text) }))
    .filter((leaf) => leaf.banned.length > 0);

describe("copy", () => {
  it("no banned word appears in copy", () => {
    const leaves = leavesOf(copy, "");
    expect(leaves.length).toBeGreaterThan(0);
    expect(offencesIn(leaves)).toEqual([]);
  });

  it("no banned word appears in the kind labels in kinds.json", () => {
    const labels = kindLabelsOf(kinds, "kinds");
    // One label per family and per kind value: the scan must not miss any.
    expect(labels).toHaveLength(kinds.families.length + kinds.families.flatMap((f) => f.values).length);
    expect(offencesIn(labels)).toEqual([]);
  });

  it("allows exactly the two protocol strings", () => {
    expect(ALLOWED_PROTOCOL_STRINGS).toEqual({
      signInButton: "Continue with Nostr",
      bitcoinChip: "Bitcoin accepted",
    });
  });

  it("shows each protocol string only at its own key", () => {
    expect(copy.signin.continueButton).toBe(ALLOWED_PROTOCOL_STRINGS.signInButton);
    expect(copy.place.bitcoinChip).toBe(ALLOWED_PROTOCOL_STRINGS.bitcoinChip);

    const found = [...leavesOf(copy, ""), ...kindLabelsOf(kinds, "kinds")];
    const pathsOf = (text: string) => found.filter((leaf) => leaf.text === text).map((leaf) => leaf.path);
    expect(pathsOf(ALLOWED_PROTOCOL_STRINGS.signInButton)).toEqual(["signin.continueButton"]);
    expect(pathsOf(ALLOWED_PROTOCOL_STRINGS.bitcoinChip)).toEqual(["place.bitcoinChip"]);
  });

  it("flags a protocol string under any other key, or inside a longer sentence", () => {
    const misplaced: Leaf[] = [
      { path: "explore.cta", text: ALLOWED_PROTOCOL_STRINGS.signInButton },
      { path: "signin.other", text: ALLOWED_PROTOCOL_STRINGS.bitcoinChip },
      { path: "place.bitcoinChip", text: `Pay by ${ALLOWED_PROTOCOL_STRINGS.bitcoinChip} today` },
    ];
    expect(offencesIn(misplaced).map((offence) => offence.path)).toEqual([
      "explore.cta",
      "signin.other",
      "place.bitcoinChip",
    ]);
    // ...while each string is clean at its own key.
    expect(
      offencesIn([
        { path: "signin.continueButton", text: ALLOWED_PROTOCOL_STRINGS.signInButton },
        { path: "place.bitcoinChip", text: ALLOWED_PROTOCOL_STRINGS.bitcoinChip },
      ]),
    ).toEqual([]);
  });

  it("takes the app name from config.appName, not a second literal", async () => {
    expect(copy.app.name).toBe(config.appName);

    vi.resetModules();
    vi.doMock("../src/config", () => ({ config: { appName: "Renamed" } }));
    try {
      const { copy: renamed } = await import("../src/copy/en");
      expect(renamed.app.name).toBe("Renamed");
    } finally {
      vi.doUnmock("../src/config");
      vi.resetModules();
    }
  });

  it.each<[string, string]>([
    ["Open in Nostr", "nostr"],
    ["Pay in Bitcoin", "bitcoin"],
    ["Your public key", "key"],
    ["Keys", "key"],
    ["Web  of   Trust", "web of trust"],
    ["Sign the guestbook", "sign"],
    ["You are signed in", "sign"],
    ["Unsigned", "sign"],
    ["Signs of life", "sign"],
    ["Signing up", "sign"],
    ["Your signature", "signature"],
    ["Someone to follow", "follow"],
    ["She follows you", "follow"],
    ["Followed by 3", "follow"],
    ["Unfollow", "follow"],
    ["Followers and following", "follow"],
    ["Events near you", "event"],
    ["Connect to relays", "relay"],
    ["Zaps", "zap"],
    ["Zapped you", "zap"],
    ["Your npubs", "npub"],
    ["DList", "dlist"],
    ["GrapeRank score", "graperank"],
    ["Kind 39999", "kind number"],
    ["kind 1", "kind number"],
    ["Posted as 30023", "kind number"],
  ])("the banned-word check catches %j (%s)", (text, word) => {
    expect(bannedWordsIn(text)).toEqual([word]);
  });

  it.each([
    "Sign in",
    "Sign-in",
    "Signing in works like this",
    "Signing in to Regulars",
    "Sign in to see your circle",
    "Open until 10 pm",
    "Opens at 9:30",
    "7,954 places",
    "What kind of place?",
    "Keyboard shortcuts",
    "Eventually",
    "Design",
    "Signal",
    "Unlimited",
  ])("the banned-word check lets %j through", (text) => {
    expect(bannedWordsIn(text)).toEqual([]);
  });

  it("scans template functions by calling them", () => {
    const leaves = leavesOf({ a: (name: string) => `Hello ${name}`, b: { c: "plain" } }, "");
    expect(leaves.map((leaf) => leaf.text)).toContain("Hello Sample");
    expect(leaves.map((leaf) => leaf.text)).toContain("plain");
  });
});

describe("index.html", () => {
  it("is titled and described from the copy module and the config", () => {
    expect(indexHtml.documentElement.lang).toBe("en");
    expect(indexHtml.title).toBe(config.appName);
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
