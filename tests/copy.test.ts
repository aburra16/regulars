import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { ALLOWED_PROTOCOL_STRINGS, copy } from "../src/copy/en";
import kinds from "../src/data/kinds.json";

// Words a diner must never see (decision 12; the brief's list is a minimum).
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

// The protocol strings are exempt from the scan only at these keys: the sign-in button's, each of the
// four words of the Payment chip, by how the place takes bitcoin, and each of the four sentences a
// link's preview of a place says it in. Anywhere else the same text is an offence, and so is any
// sentence that merely contains it.
const ALLOWED_AT: Readonly<Record<string, string>> = {
  "signin.continueButton": ALLOWED_PROTOCOL_STRINGS.signInButton,
  ...Object.fromEntries(Object.entries(ALLOWED_PROTOCOL_STRINGS.bitcoinChip).map(([how, words]) => [`place.bitcoin.${how}`, words])),
  ...Object.fromEntries(Object.entries(ALLOWED_PROTOCOL_STRINGS.bitcoinSentence).map(([how, words]) => [`share.bitcoin.${how}`, words])),
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

// Decision 44, the one exception to "trust, never follow": the Follow button and its lines
// (`copy.follow`) say "follow", "following" and "unfollow", and the line on a reviewer's page that
// names who follows them says "followed" (ruling R31). Under that group those four forms are let
// through, each as a whole word, in any case, and no other: "followers", "follows", "unfollowed" and
// the rest are an offence there too, as is every other banned word. Anywhere else the word is an
// offence in every form, as before.
//
// One line of the group may say one form more: a copy of the person's list kept before an unfollow
// says so of itself ("Before you unfollowed Maya"), and has no other word for it. "Unfollowed" is
// let through at that line's key and at no other, in the group or out of it.
const FOLLOW_GROUP = /^follow\./;
const FOLLOW_FORMS = new RegExp(`\\b(?:un)?follow${INFLECTIONS}\\b`, "gi");
const NAMED_FORMS = new Set(["follow", "following", "unfollow", "followed"]);
/** The one line that may say "unfollowed": the key itself, or the key called with a name. */
const SAYS_UNFOLLOWED = /^follow\.keptBeforeUnfollow(?:\(|$)/;
const allowedThere = (leaf: Leaf, word: string) =>
  word === "follow" &&
  FOLLOW_GROUP.test(leaf.path) &&
  (leaf.text.match(FOLLOW_FORMS) ?? []).every((form) => NAMED_FORMS.has(form.toLowerCase()) || (form.toLowerCase() === "unfollowed" && SAYS_UNFOLLOWED.test(leaf.path)));

const offencesIn = (leaves: Leaf[]) =>
  leaves
    .filter((leaf) => ALLOWED_AT[leaf.path] !== leaf.text)
    .map((leaf) => ({ path: leaf.path, text: leaf.text, banned: bannedWordsIn(leaf.text).filter((word) => !allowedThere(leaf, word)) }))
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

  it("allows exactly the protocol strings: the sign-in button, the four words of the Payment chip, and the four sentences of a place's preview", () => {
    expect(ALLOWED_PROTOCOL_STRINGS).toEqual({
      signInButton: "Continue with Nostr",
      bitcoinChip: {
        lightning: "Bitcoin: Lightning",
        onchain: "Bitcoin: on-chain",
        both: "Bitcoin: Lightning and on-chain",
        yes: "Bitcoin accepted",
      },
      bitcoinSentence: {
        lightning: "Takes Bitcoin over Lightning.",
        onchain: "Takes Bitcoin on-chain.",
        both: "Takes Bitcoin over Lightning and on-chain.",
        yes: "Takes Bitcoin.",
      },
    });
  });

  it("shows each protocol string only at its own key", () => {
    expect(copy.signin.continueButton).toBe(ALLOWED_PROTOCOL_STRINGS.signInButton);
    expect(copy.place.bitcoin).toEqual(ALLOWED_PROTOCOL_STRINGS.bitcoinChip);
    expect(copy.share.bitcoin).toEqual(ALLOWED_PROTOCOL_STRINGS.bitcoinSentence);

    const found = [...leavesOf(copy, ""), ...kindLabelsOf(kinds, "kinds")];
    const pathsOf = (text: string) => found.filter((leaf) => leaf.text === text).map((leaf) => leaf.path);
    expect(pathsOf(ALLOWED_PROTOCOL_STRINGS.signInButton)).toEqual(["signin.continueButton"]);
    for (const [how, words] of Object.entries(ALLOWED_PROTOCOL_STRINGS.bitcoinChip)) expect(pathsOf(words)).toEqual([`place.bitcoin.${how}`]);
    for (const [how, words] of Object.entries(ALLOWED_PROTOCOL_STRINGS.bitcoinSentence)) expect(pathsOf(words)).toEqual([`share.bitcoin.${how}`]);
  });

  it("flags a protocol string under any other key, or inside a longer sentence", () => {
    const { lightning, yes } = ALLOWED_PROTOCOL_STRINGS.bitcoinChip;
    const misplaced: Leaf[] = [
      { path: "explore.cta", text: ALLOWED_PROTOCOL_STRINGS.signInButton },
      { path: "signin.other", text: yes },
      { path: "place.bitcoin.yes", text: `Pay by ${yes} today` },
      // One chip's words at another's key.
      { path: "place.bitcoin.yes", text: lightning },
      // A preview's sentence at a chip's key, a chip's words at a sentence's key, and one sentence at another's.
      { path: "place.bitcoin.lightning", text: ALLOWED_PROTOCOL_STRINGS.bitcoinSentence.lightning },
      { path: "share.bitcoin.lightning", text: lightning },
      { path: "share.bitcoin.yes", text: ALLOWED_PROTOCOL_STRINGS.bitcoinSentence.both },
    ];
    expect(offencesIn(misplaced).map((offence) => offence.path)).toEqual([
      "explore.cta",
      "signin.other",
      "place.bitcoin.yes",
      "place.bitcoin.yes",
      "place.bitcoin.lightning",
      "share.bitcoin.lightning",
      "share.bitcoin.yes",
    ]);
    // ...while each string is clean at its own key.
    expect(
      offencesIn([
        { path: "signin.continueButton", text: ALLOWED_PROTOCOL_STRINGS.signInButton },
        ...Object.entries(ALLOWED_PROTOCOL_STRINGS.bitcoinChip).map(([how, words]) => ({ path: `place.bitcoin.${how}`, text: words })),
        ...Object.entries(ALLOWED_PROTOCOL_STRINGS.bitcoinSentence).map(([how, words]) => ({ path: `share.bitcoin.${how}`, text: words })),
      ]),
    ).toEqual([]);
  });

  it("lets the Follow button and its lines say follow, and nothing else in the copy (decision 44)", () => {
    // The button's own group says the word, in each of its forms.
    const said = leavesOf(copy.follow, "follow").filter((leaf) => bannedWordsIn(leaf.text).includes("follow"));
    expect(said.map((leaf) => leaf.text)).toEqual(
      expect.arrayContaining([
        "Follow",
        "Following",
        "Following Sample. Unfollow",
        "Unfollow",
        "Unfollow Sample",
        "Press again to unfollow Sample.",
        "You no longer follow Sample.",
      ]),
    );
    expect(offencesIn(said)).toEqual([]);
    // Nothing outside it does: every other line keeps "trust".
    const elsewhere = leavesOf(copy, "").filter((leaf) => !leaf.path.startsWith("follow."));
    expect(elsewhere.filter((leaf) => bannedWordsIn(leaf.text).includes("follow"))).toEqual([]);

    // The word under any other key is caught as before, a group named nearly so among them; and under
    // the button's group, every other banned word still is.
    const misplaced: Leaf[] = [
      { path: "reviews.someone", text: "Follow" },
      { path: "followers.count", text: "Following" },
      { path: "follow", text: "Unfollow" },
      { path: "follow.notLoaded", text: "We couldn't load your follow list from the relays." },
      { path: "follow.follow", text: "Follow their key" },
    ];
    expect(offencesIn(misplaced).map((offence) => [offence.path, offence.banned])).toEqual([
      ["reviews.someone", ["follow"]],
      ["followers.count", ["follow"]],
      ["follow", ["follow"]],
      ["follow.notLoaded", ["relay"]],
      ["follow.follow", ["key"]],
    ]);
  });

  it("lets through, under the Follow button's group, only the forms it is given: follow, following, unfollow (decision 44) and followed (ruling R31); and unfollowed in the one line that says a copy was kept before an unfollow", () => {
    // In any case, each as a whole word.
    const named: Leaf[] = [
      "Follow",
      "follow",
      "FOLLOW",
      "Following",
      "following",
      "Unfollow",
      "unfollow",
      "Following Maya. Unfollow",
      "You no longer follow Maya.",
      "Followed by Maya, who you follow",
      "Followed by Maya and Jon, people you follow",
      "followed",
      "FOLLOWED",
      "Before you followed Maya",
    ].map((text, i) => ({ path: `follow.sample${i}`, text }));
    expect(offencesIn(named)).toEqual([]);

    // Every other form of the word is the network's talk, there as anywhere: who follows whom, and how many.
    const others = [
      "Followers",
      "3 followers",
      "Follower",
      "She follows you",
      "Follows",
      "Unfollowed",
      "Before you unfollowed Maya",
      "Unfollowing",
      "Unfollows",
      "Following and followers",
      "Followed by Maya and her followers",
    ];
    expect(offencesIn(others.map((text, i) => ({ path: `follow.sample${i}`, text }))).map((offence) => [offence.text, offence.banned])).toEqual(
      others.map((text) => [text, ["follow"]]),
    );
    // "Followed" is the Follow group's alone: under any other key it is caught, as every form is.
    expect(offencesIn([{ path: "person.someLine", text: "Followed by Maya, people you follow" }]).map((offence) => offence.banned)).toEqual([["follow"]]);

    // "Unfollowed" is one line's alone: what a copy kept before an unfollow says of itself, as the copy
    // module gives it, whoever it names. There it is let through, with the group's four.
    const itsLine = [`follow.keptBeforeUnfollow`, `follow.keptBeforeUnfollow(["Maya"])`, `follow.keptBeforeUnfollow(["Sample",3])`];
    expect(offencesIn(itsLine.map((path) => ({ path, text: "Before you unfollowed Maya" })))).toEqual([]);
    expect(offencesIn([{ path: itsLine[1]!, text: "Before you unfollowed Maya, who you follow" }])).toEqual([]);
    // Under every other key of the group it is an offence, as it is outside the group: the line beside it, a key
    // that only begins as that line's does, and a line of the button's.
    const elsewhere = [`follow.keptBeforeFollow(["Maya"])`, "follow.keptBeforeUnfollowed", "follow.keptBeforeUnfollow.more", "follow.unfollowed", "follow.putBackDone", "you.someLine"];
    expect(offencesIn(elsewhere.map((path) => ({ path, text: "Before you unfollowed Maya" }))).map((offence) => [offence.path, offence.banned])).toEqual(
      elsewhere.map((path) => [path, ["follow"]]),
    );
    // And that line may say no other form for it: the rest are an offence there too.
    expect(offencesIn([{ path: itsLine[1]!, text: "Before you unfollowed your followers" }]).map((offence) => offence.banned)).toEqual([["follow"]]);
    expect(offencesIn([{ path: itsLine[1]!, text: "Unfollowing Maya" }]).map((offence) => offence.banned)).toEqual([["follow"]]);

    // And the group's own strings are all of the four, but for that one line.
    expect(offencesIn(leavesOf(copy.follow, "follow"))).toEqual([]);
    const sayUnfollowed = leavesOf(copy.follow, "follow").filter((leaf) => /\bunfollowed\b/i.test(leaf.text));
    expect(new Set(sayUnfollowed.map((leaf) => leaf.path.replace(/\(.*$/, "")))).toEqual(new Set(["follow.keptBeforeUnfollow"]));
  });

  it("has the words given for a reviewer's page (approved, but for its title and Your reviews, drafts still): who of the people the person follows also does, by name, and never how many", () => {
    // One person is "who you follow", and two or three "people you follow" (ruling R35).
    expect(copy.follow.followedBy("Maya")).toBe("Followed by Maya, who you follow");
    expect(copy.follow.followedBy("Maya", "Jon")).toBe("Followed by Maya and Jon, people you follow");
    expect(copy.follow.followedBy("Maya", "Jon", "Dele")).toBe("Followed by Maya, Jon and Dele, people you follow");
    // The rest of the page says nothing of following: its strings are in a group of their own.
    expect(copy.person.you).toBe("This is you");
    expect(copy.person.back).toBe("Back");
    // On You, the way to the person's own page says what is on it.
    expect(copy.you.yourReviews).toBe("Your reviews");
    expect(copy.person.reviews).toBe("Reviews");
    expect(copy.person.none).toBe("No reviews yet.");
    expect(copy.person.showMore).toBe("Show more");
    expect([copy.person.failed, copy.person.retry]).toEqual(["Reviews couldn't be loaded.", "Try again"]);
    expect(copy.titles.person("Maya")).toBe(`Maya · ${config.appName}`);
    expect(leavesOf(copy.person, "person").filter((leaf) => bannedWordsIn(leaf.text).length > 0)).toEqual([]);
    // No line of the page has a number in it: none counts anyone, or their reviews (decision 19).
    const lines = [...leavesOf(copy.person, "person").map((leaf) => leaf.text), copy.follow.followedBy("Maya", "Jon", "Dele")];
    expect(lines.filter((text) => /\d/.test(text))).toEqual([]);
  });

  it("has the words given for the Follow button and its lines (decision 44; approved)", () => {
    expect(copy.follow.follow).toBe("Follow");
    expect(copy.follow.following).toBe("Following");
    expect(copy.follow.followingNamed("Maya")).toBe("Following Maya. Unfollow");
    // What Following says before it unfollows, and its name for a screen reader then (ruling R47).
    expect(copy.follow.unfollow).toBe("Unfollow");
    expect(copy.follow.unfollowNamed("Maya")).toBe("Unfollow Maya");
    // What a screen reader hears once a press has shown Unfollow (ruling R48).
    expect(copy.follow.pressAgain("Maya")).toBe("Press again to unfollow Maya.");
    expect(copy.follow.saving).toBe("Saving…");
    expect(copy.follow.undo).toBe("Undo");
    expect(copy.follow.unfollowed("Maya")).toBe("You no longer follow Maya.");
    expect([copy.follow.countsAfterUpdate, copy.follow.updateNow]).toEqual(["Counts after your circle's next update.", "Update now"]);
    expect([copy.follow.countsOnceBuilt, copy.follow.personalize]).toEqual(["Counts once your circle is built.", "Personalize"]);
    expect(copy.follow.notLoaded).toBe("We couldn't load the list of people you follow, so nothing was changed.");
    expect(copy.follow.notApproved).toBe("That wasn't approved, so nothing was changed.");
    expect(copy.follow.notSaved).toBe("That didn't save. Nothing was changed.");
    expect(copy.follow.unconfirmed).toBe("Saved, but we couldn't check it yet.");
    expect(copy.follow.tryAgain).toBe("Try again");
    // The button's name for a screen reader, which hears whom it is for (an addition to the brief's list).
    expect(copy.follow.followNamed("Maya")).toBe("Follow Maya");
  });

  it("has the words given for asking before a change is built on a copy found elsewhere (approved)", () => {
    expect(copy.follow.copyFound("March 6, 2027")).toBe(
      "We couldn't reach where your other apps keep your list. The newest copy we found was last changed on March 6, 2027. If you have followed anyone since then, they would be lost.",
    );
    expect(copy.follow.useThisCopy).toBe("Use this copy");
    // The app's own words for putting something off, where it has them already.
    expect(copy.follow.notNow).toBe("Not now");
    expect(copy.follow.notNow).toBe(copy.circle.notNow);
    // None of it says a word of the network's, nor counts anyone: the only digits are the date it is given.
    const lines = [copy.follow.copyFound("then"), copy.follow.useThisCopy, copy.follow.notNow];
    expect(lines.filter((text) => bannedWordsIn(text).filter((word) => word !== "follow").length > 0)).toEqual([]);
    expect(lines.filter((text) => /\d/.test(text))).toEqual([]);
    expect(lines.join(" ")).not.toMatch(/[\u2013\u2014]/);
  });

  it("has the words given for a change that was not made because no copy of the list could be kept (approved)", () => {
    expect(copy.follow.notKept).toBe("We couldn't keep a copy of your list in this browser, so nothing was changed.");
    // It is not the line for a list that could not be loaded: that is another thing going wrong.
    expect(copy.follow.notKept).not.toBe(copy.follow.notLoaded);
    expect(bannedWordsIn(copy.follow.notKept)).toEqual([]);
  });

  it("has the words given for the copies of the person's list kept before each change, and for putting one back (approved)", () => {
    expect(copy.follow.keptHeading).toBe("Earlier copies of who you follow");
    expect(copy.follow.keptAbout).toBe("Before each change you make here, Regulars keeps a copy of your list in this browser, so it can be put back.");
    // A row, by what the copy was kept for.
    expect(copy.follow.keptBeforeFollow("Maya")).toBe("Before you followed Maya");
    expect(copy.follow.keptBeforeUnfollow("Maya")).toBe("Before you unfollowed Maya");
    expect(copy.follow.keptBeforeUndo).toBe("Before an Undo");
    expect(copy.follow.keptBeforePutBack).toBe("Before a copy was put back");
    // Whom, when the app has no name for them: never a code.
    expect(copy.follow.keptSomeone).toBe("someone");
    expect(copy.follow.putBack).toBe("Put back");
    // The asking, and its two answers.
    expect(copy.follow.putBackQuestion).toBe(
      "Putting this back replaces your list as it is now. Anyone you have followed since, here or in another app, would be lost.",
    );
    expect(copy.follow.putItBack).toBe("Put it back");
    expect(copy.follow.keepAsItIs).toBe("Keep my list as it is");
    // How it ended.
    expect(copy.follow.putBackDone).toBe("Your list is as it was then.");
    expect(copy.follow.putBackAlready).toBe("Your list is already as it was then.");
    // None of them counts anyone: a copy does not say how many people it holds (decision 19).
    const { follow } = copy;
    const lines = [
      follow.keptHeading,
      follow.keptAbout,
      follow.keptBeforeFollow("Maya"),
      follow.keptBeforeUnfollow("Maya"),
      follow.keptBeforeUndo,
      follow.keptBeforePutBack,
      follow.putBack,
      follow.putBackQuestion,
      follow.putItBack,
      follow.keepAsItIs,
      follow.putBackDone,
      follow.putBackAlready,
    ];
    expect(lines.filter((text) => /\d/.test(text))).toEqual([]);
  });

  it("names Update now and Personalize under the Follow button as the pages they come from do", () => {
    expect(copy.follow.updateNow).toBe(copy.why.updateNow);
    expect(copy.follow.personalize).toBe(copy.circle.personalize);
  });

  it("names the house once in each line its badge sits in, by the one name copy has for it", () => {
    expect(copy.house.name).toBe("Mise en Place");
    for (const line of [copy.explore.houseLine, copy.about.houseBody]) {
      expect(line.split(copy.house.name)).toHaveLength(2);
    }
  });

  it("has the words approved for Explore", () => {
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

  it("has the words approved for the town picker and the filters", () => {
    expect(copy.location.pickTitle).toBe("Choose a town");
    expect(copy.filters.openNowNote).toBe("Places with no hours listed stay in.");
  });

  it("has the words for when a closed place opens soon, matching Closing soon", () => {
    expect(copy.hours.openingSoonWords).toBe("Opening soon");
    expect(copy.hours.openingSoon("3 pm")).toBe("Opening soon · 3 pm");
    expect(copy.hours.openingSoonInline("3 pm")).toBe("Opening soon, 3 pm");
    // The words lead the line, as Closing soon's do: the colour goes on exactly them.
    expect(copy.hours.openingSoon("3 pm").startsWith(copy.hours.openingSoonWords)).toBe(true);
    expect(copy.hours.openingSoonInline("3 pm").startsWith(copy.hours.openingSoonWords)).toBe(true);
  });

  it("has the words approved for the place page", () => {
    expect(copy.hours.closingSoon("4 pm")).toBe("Closing soon · 4 pm");
    expect(copy.hours.closingSoonInline("4 pm")).toBe("Closing soon, 4 pm");
    expect(copy.hours.closingSoonWords).toBe("Closing soon");
    expect([copy.place.go, copy.place.site, copy.place.directions]).toEqual(["Directions", "Website", "Get directions"]);
    expect(copy.reviews.foldedNote).toBe("Folded away, never deleted.");
    // Every review folded while the view can't be worked out: said as it is (DRAFT).
    expect(copy.reviews.uncounted(1)).toBe("1 review, shown without a rating for now");
    expect(copy.reviews.uncounted(2)).toBe("2 reviews, shown without a rating for now");
    expect(copy.reviews.removeQuestion).toBe("Remove your review? It comes off Regulars and everywhere else it was posted.");
    expect(copy.reviews.removePartial).toBe("Removed from your account, but not from Regulars yet. Try again.");
  });

  it("has the words approved in the rest of the walk-through (screens 5 to 12)", () => {
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

  it("says the circle is built, never worked out", () => {
    expect(leavesOf(copy, "").filter((leaf) => /\bwork(?:s|ed|ing)? (?:it )?out\b/i.test(leaf.text))).toEqual([]);
  });

  it("says My circle is not available in the same words wherever it says so", () => {
    expect(copy.circle.unavailable).toBe(copy.score.circleUnavailable);
  });

  it("says rating, never score, in every string a person reads or hears", () => {
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
