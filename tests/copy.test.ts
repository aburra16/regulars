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

// "sign in" and "sign out" are the app's own words for starting and ending a session, so these
// phrases are scrubbed before "sign" is checked: "sign in", "signing in", "sign out", "signed in" and
// "signed out" (the M2b plan's ruling R7). Any other "sign" is still caught.
const PERMITTED_PHRASES = /\b(?:sign[ -]in|signing in|sign[ -]out|signed (?:in|out))\b/gi;

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

  it("names the house once in each line its badge sits in, by the one name copy has for it", () => {
    expect(copy.house.name).toBe("Mise en Place");
    for (const line of [copy.explore.houseLine, copy.about.houseBody]) {
      expect(line.split(copy.house.name)).toHaveLength(2);
    }
  });

  it("has the words Avi approved for Explore (his wording pass, 2026-10-09)", () => {
    expect(copy.search.placeholder).toBe("Tacos, coffee, a restaurant name");
    expect(copy.explore.houseLine).toBe("Ratings from reviewers our house curator, Mise en Place, trusts.");
    expect(copy.explore.circleLine).toBe("Ratings from your circle: the people you trust, and the people they trust.");
    expect(copy.explore.circleEmpty).toBe("Nobody in your circle has rated places yet. House picks still has ratings for you.");
    expect(copy.explore.circleOnlyYou).toBe("Only you have rated places in your circle so far. House picks still has ratings for you.");
    expect(copy.score.starless(1)).toBe("1 person the house trusts wrote about it, no stars yet");
    expect(copy.score.starless(3)).toBe("3 people the house trusts wrote about it, no stars yet");
    expect(copy.score.starlessCircle(1)).toBe("1 person in your circle wrote about it, no stars yet");
    expect(copy.score.starlessCircle(2)).toBe("2 people in your circle wrote about it, no stars yet");
    expect(copy.score.counting).toBe("Loading reviews…");
    expect(copy.score.houseUnavailable).toBe("House picks aren't available right now.");
    expect(copy.score.circleUnavailable).toBe("My circle isn't available right now.");
  });

  it("has the words Avi approved for the town picker and the filters (his wording pass, 2026-10-09)", () => {
    expect(copy.location.pickTitle).toBe("Choose a town");
    expect(copy.filters.openNowNote).toBe("Places with no hours listed stay in.");
  });

  it("has the words Avi approved for the place page (his wording pass, 2026-10-09)", () => {
    expect(copy.hours.closingSoon("4 pm")).toBe("Closing soon · 4 pm");
    expect(copy.hours.closingSoonInline("4 pm")).toBe("Closing soon, 4 pm");
    expect([copy.place.go, copy.place.site, copy.place.directions]).toEqual(["Directions", "Website", "Get directions"]);
    expect(copy.reviews.foldedNote).toBe("Folded away, never deleted.");
    // Every review folded while the view can't be worked out: said as it is (DRAFT).
    expect(copy.reviews.uncounted(1)).toBe("1 review, shown without a rating for now");
    expect(copy.reviews.uncounted(2)).toBe("2 reviews, shown without a rating for now");
    expect(copy.reviews.removeQuestion).toBe("Remove your review? It comes off Regulars and everywhere else it was posted.");
    expect(copy.reviews.removePartial).toBe("Removed from your account, but not from Regulars yet. Try again.");
  });

  it("has the words Avi approved in the rest of his walk-through (screens 5 to 12, 2026-10-09)", () => {
    // Signing in.
    expect(copy.signin.intro).toBe(
      "Right now you're seeing House picks. Sign in and every rating comes from the people you trust, and the people they trust.",
    );
    expect(copy.signin.steps[1]).toBe("We build your circle. It takes a few minutes, in the background.");
    expect(copy.signin.notice).toBe("Nothing is posted without you. Your circle is built by our scoring partner, and it is public.");
    // My circle: built, not worked out.
    expect(copy.circle.consent).toBe(
      "Personalizing asks Brainstorm, our scoring partner, to build your circle. It sets up a public scoring profile for you, and your circle is public.",
    );
    expect(copy.circle.workingTitle).toBe("Building your circle");
    expect(copy.circle.workingBody).toBe("This takes a few minutes.");
    expect(copy.circle.recently).toBe("Your circle was updated recently, so we're using that.");
    expect(copy.circle.workOutAgain).toBe("Build my circle again");
    expect(copy.view.circleWorking).toBe("My circle, being built");
    // The Why page.
    expect(copy.why.intro).toBe("There is no single rating for a place. Every rating here comes from a set of people. You choose which set.");
    expect(copy.why.housePicksNow).toBe(
      "Right now you're seeing House picks. My circle's ratings come from the people you trust, and the people they trust.",
    );
    expect([0, 1, 3, 14, 40].map((days) => copy.why.workedOut(days, Math.floor(days / 30)))).toEqual([
      "Updated today",
      "Updated yesterday",
      "Updated 3 days ago",
      "Updated 2 weeks ago",
      "Updated a month ago",
    ]);
    expect(copy.why.updateStarted).toBe("Your circle is still being built. We'll use the new one on your next visit.");
    expect(copy.why.rulesHeading).toBe("How ratings work");
    expect(copy.why.houseBody).toBe(
      "The same idea from a different starting point: the reviewers our house curator, Mise en Place, trusts. It's what everyone sees before signing in, and it's always one tap away.",
    );
    expect(copy.why.houseBodyDesk).toBe(
      "The same idea from a different starting point: the reviewers our house curator, Mise en Place, trusts. It's what everyone sees before signing in.",
    );
    // Trending.
    expect(copy.recent.loading).toBe("Loading reviews…");
    expect([copy.recent.failed, copy.recent.newerFailed, copy.recent.olderFailed]).toEqual([
      "Reviews couldn't be loaded.",
      "Reviews couldn't be loaded.",
      "Reviews couldn't be loaded.",
    ]);
    // About.
    expect(copy.about.reviewsBody).toBe(
      "People write them under their own names. Nobody at Regulars edits or reorders them. The rating you see for a place comes from the reviewers you trust, so two people can see different ratings for the same place.",
    );
    expect(copy.about.viewsBody).toBe(
      "House picks are the ratings from the reviewers the house trusts, and everyone starts there. My circle is the same idea, from the people you trust and the people they trust. You can switch between them whenever you like.",
    );
    expect(copy.about.figures.none).toBe("Not yet");
    expect(copy.about.yoursBody).toBe(
      "Places and reviews are public records that don't live inside this app. Other apps can read the same ones, and yours stay with you if you leave.",
    );
    // Everything else.
    expect(copy.meta.description).toBe("Places to eat and drink, rated by people you'd actually ask.");
  });

  it("says the circle is built, never worked out (Avi, 2026-10-09)", () => {
    expect(leavesOf(copy, "").filter((leaf) => /\bwork(?:s|ed|ing)? (?:it )?out\b/i.test(leaf.text))).toEqual([]);
  });

  it("says My circle is not available in the same words wherever it says so", () => {
    expect(copy.circle.unavailable).toBe(copy.score.circleUnavailable);
  });

  it("says rating, never score, in every string a person reads or hears (Avi, 2026-10-09)", () => {
    // Brainstorm, "our scoring partner", works out the person's circle with "a public scoring profile":
    // what it scores is people's trust, not places, and those two phrases are its own.
    const said = (text: string) => text.replace(/\bscoring (?:partner|profile)\b/gi, "");
    const scored = (text: string) => /\bscor\w*/i.test(said(text));
    expect(leavesOf(copy, "").filter((leaf) => scored(leaf.text))).toEqual([]);
    // It catches any word that starts so, and lets the partner's two phrases through.
    for (const word of ["Score", "scores", "scored", "scoring", "Scorer", "scoreboard"]) expect(scored(`A ${word} here`), word).toBe(true);
    expect(scored("our scoring partner, a public scoring profile")).toBe(false);
  });

  it("never says 'near you' of its own accord: where the places are near is given, and is 'you' only for the device", () => {
    expect(leavesOf(copy, "").filter((leaf) => /\bnear you\b/i.test(leaf.text))).toEqual([]);
    expect(copy.explore.near(copy.location.you)).toBe("Near you");
  });

  it("calls the newest reviews' page Trending, and nothing Recent any more (decision 31)", () => {
    expect([copy.nav.recent, copy.pages.recent]).toEqual(["Trending", "Trending"]);
    expect(copy.titles.recent).toBe(`Trending · ${config.appName}`);
    expect(leavesOf(copy, "").filter((leaf) => /\bRecent\b/.test(leaf.text))).toEqual([]);
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
    ["Unsigned", "sign"],
    ["Signs of life", "sign"],
    ["Signing up", "sign"],
    ["Signing out", "sign"],
    ["Signed up", "sign"],
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
    "Sign out",
    "You are signed in",
    "Signed out of Regulars",
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

  // Its icons, made from the house's logo, are checked in tests/icons.test.ts.

  it("no banned word in index.html title or meta", () => {
    const texts = [
      indexHtml.title,
      ...Array.from(indexHtml.querySelectorAll("meta")).map((meta) => meta.getAttribute("content") ?? ""),
    ];
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.flatMap(bannedWordsIn)).toEqual([]);
  });
});
