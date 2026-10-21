// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bare, exportsOf, imported, isModule, isNode, nameOf, type Node, programOf, read, sourcesUnder } from "./support/codeGuard";

/*
 * The guard on the saved places' one writer. A person's saved places are one bookmark set (kind
 * 30003) that saving replaces everywhere, so only src/saved/change.ts may sign or send one: it is the
 * code that takes the lock, reads the list afresh and checks what was signed. This reads the code in
 * src as code (its imports, its names, its object literals and its calls: tests/support/codeGuard.ts),
 * so a comment or a word on screen is never taken for a breach, and holds every module to four rules:
 *
 *   1. Built in one place. An object literal whose `kind` is 30003 or `SAVED_KIND`, which is an event
 *      or a template of a saved list, is written only in src/saved/list.ts, the list's rules: not even
 *      in the one writer, which has the list's rules build what it signs.
 *   2. Its builders used in one place. `withSaved` and `withoutSaved`, which make the list that is
 *      signed, are named only there and in src/saved/change.ts.
 *   3. What knows saved lists neither signs nor sends. A module knows them when it imports the list's
 *      rules, its reading, its one writer or the session's provider of the list (src/saved/list.ts,
 *      read.ts, change.ts, SavedProvider.tsx), and those modules do by being them: the provider will
 *      hold the person's signer beside their list. Such a module, the one writer apart, does not call
 *      a signer's `signEvent` or a writer's `publish`, and does not import the code the app signs and
 *      sends with (src/nostr/send.ts, src/nostr/listWrite.ts, src/review/post.ts). So a list that was
 *      read cannot be sent again from elsewhere, and what calls `changeSaved` sends nothing itself. A
 *      module that shows saved places through a component of src/saved that is none of those, as a
 *      page shows a button, is not taken to know them.
 *   4. No other list of bookmarks. Nothing in src writes an object literal whose `kind` is 10003, the
 *      person's own list of bookmarks: the app keeps its places in a set of its own, and writes no
 *      other.
 *
 * And the one writer hands out one function that signs and sends, and no more: its exports are pinned
 * here, so another way to write a list is a change to this test.
 *
 * It is a tripwire, not a proof: code that hid a kind 30003 behind another name, or reached a signer
 * through a module not listed here, would pass. Each rule is shown catching what it is for, and
 * letting through what it allows. A module that must break one is a second writer of saved lists,
 * and belongs in `changeSaved` instead.
 */

/** The one module that may sign and send a saved list. */
const ONLY_WRITER = "src/saved/change.ts";
/** The list's rules, pure: where a saved list's template is built. */
const LIST_RULES = "src/saved/list.ts";
/** The session's own list, for the button and the page. Named before it exists: it will hold the person's signer and their list side by side. */
const PROVIDER = "src/saved/SavedProvider.tsx";
/** The modules that make a module one that knows saved lists: by importing one of them, or by being one. */
const SAVED_LIST_CODE = [LIST_RULES, "src/saved/read.ts", ONLY_WRITER, PROVIDER];
/** The modules the app signs an event with, or sends one to a relay with. */
const SIGNING_AND_SENDING = ["src/nostr/send.ts", "src/nostr/listWrite.ts", "src/review/post.ts"];
/** The names of what builds the list to sign. */
const BUILDERS = ["withSaved", "withoutSaved"];
/** The methods that sign an event (a signer's) and send one (a relay writer's). */
const SIGN_OR_SEND_CALLS = ["signEvent", "publish"];
/** The kind of a saved list, by its number and by its name; and the person's own list of bookmarks, which is never written. */
const SAVED_KIND = 30003;
const SAVED_KIND_NAME = "SAVED_KIND";
const BOOKMARKS_KIND = 10003;

/** Whether an expression is the kind `value` as the code writes it: the number, or `name` when it is given. */
function isKind(node: unknown, value: number, name?: string): boolean {
  const each = bare(node);
  return each !== undefined && ((each.type === "Literal" && each.value === value) || (name !== undefined && each.type === "Identifier" && each.name === name));
}

/** What a module does that the rules are about, each with where in the file. */
interface Facts {
  /** Object literals of kind 30003: an event or a template of a saved list. */
  builds: number[];
  /** Object literals of kind 10003: the person's own list of bookmarks. */
  bookmarks: number[];
  /** Where a builder is named. */
  builders: number[];
  /** Why the module is taken to know saved lists. */
  knows: Array<{ at: number; why: string }>;
  /** How the module signs or sends. */
  signsOrSends: Array<{ at: number; how: string }>;
}

function factsOf(file: string, source: string): Facts {
  const program = programOf(file, source);
  const facts: Facts = { builds: [], bookmarks: [], builders: [], knows: [], signsOrSends: [] };
  if (SAVED_LIST_CODE.includes(file)) facts.knows.push({ at: 0, why: `is ${file}` });

  /** A module of the project's that code, not only a type, is taken from. */
  const takesFrom = (at: number, specifier: unknown) => {
    const path = typeof specifier === "string" ? imported(file, specifier) : undefined;
    const lists = SAVED_LIST_CODE.find((module) => isModule(path, module));
    if (lists !== undefined) facts.knows.push({ at, why: `imports ${lists}` });
    const sends = SIGNING_AND_SENDING.find((module) => isModule(path, module));
    if (sends !== undefined) facts.signsOrSends.push({ at, how: `imports ${sends}` });
  };

  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isNode(node)) return;

    if (node.type === "ImportDeclaration") {
      const specifiers = (node.specifiers as Node[] | undefined) ?? [];
      // `import type { … }`, and an import whose every name is a type, bring no code.
      const code = node.importKind !== "type" && (specifiers.length === 0 || specifiers.some((specifier) => specifier.importKind !== "type"));
      if (code) takesFrom(node.start, (node.source as Node).value);
    }
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && isNode(node.source) && node.exportKind !== "type") {
      takesFrom(node.start, node.source.value);
    }
    if (node.type === "ImportExpression") takesFrom(node.start, bare(node.source)?.value);

    if (node.type === "Identifier" && BUILDERS.includes(node.name as string)) facts.builders.push(node.start);

    if (node.type === "Property" && nameOf(node.key) === "kind") {
      if (isKind(node.value, SAVED_KIND, SAVED_KIND_NAME)) facts.builds.push(node.start);
      if (isKind(node.value, BOOKMARKS_KIND)) facts.bookmarks.push(node.start);
    }

    if (node.type === "CallExpression") {
      const callee = bare(node.callee);
      const method = callee?.type === "MemberExpression" ? nameOf(callee.property) : undefined;
      if (method !== undefined && SIGN_OR_SEND_CALLS.includes(method)) facts.signsOrSends.push({ at: node.start, how: `calls ${method}()` });
    }

    for (const [key, child] of Object.entries(node)) if (key !== "type") walk(child);
  };
  walk(program);
  return facts;
}

/** Where the rules are broken in `source`, the code of the module at `file`: one line each, or none. */
function breaches(file: string, source: string): string[] {
  const facts = factsOf(file, source);
  const where = (at: number) => `${file}:${source.slice(0, at).split("\n").length}`;
  const found: string[] = [];
  if (file !== LIST_RULES) {
    for (const at of facts.builds) found.push(`${where(at)} builds an event of kind 30003: only ${LIST_RULES} does (rule 1)`);
  }
  if (file !== LIST_RULES && file !== ONLY_WRITER) {
    for (const at of facts.builders) found.push(`${where(at)} names a builder of the saved list: only ${ONLY_WRITER} uses them (rule 2)`);
  }
  const knows = facts.knows[0];
  if (knows !== undefined && file !== ONLY_WRITER) {
    for (const { at, how } of facts.signsOrSends) {
      found.push(`${where(at)} ${how}, in a module that knows saved lists (it ${knows.why}): only ${ONLY_WRITER} signs or sends one (rule 3)`);
    }
  }
  for (const at of facts.bookmarks) found.push(`${where(at)} builds an event of kind 10003: the app writes no list of bookmarks but its own set (rule 4)`);
  return found;
}

describe("the saved list's one writer", () => {
  it("is the only module in src that builds, signs or sends a saved list, and nothing in src builds a list of bookmarks", () => {
    const sources = sourcesUnder("src");
    // The scan reads the app: the writer, the list's rules, its reading and the code that signs and sends
    // are all there. The provider is held to the rules from the day it is.
    for (const module of [...SAVED_LIST_CODE.filter((each) => each !== PROVIDER), ...SIGNING_AND_SENDING]) expect(sources).toContain(module);

    expect(sources.flatMap((file) => breaches(file, read(file)))).toEqual([]);
  });

  it("sees the writer do what no other module may: it is let through by name, not for want of looking", () => {
    const writer = factsOf(ONLY_WRITER, read(ONLY_WRITER));
    expect(writer.builders.length).toBeGreaterThan(0);
    expect(writer.knows.map((each) => each.why)).toContain(`imports ${LIST_RULES}`);
    expect(writer.signsOrSends.map((each) => each.how)).toEqual(expect.arrayContaining(["imports src/nostr/send.ts", "imports src/nostr/listWrite.ts"]));

    // The list's rules build the templates, and the code that sends calls a signer and a writer.
    expect(factsOf(LIST_RULES, read(LIST_RULES)).builds.length).toBeGreaterThan(0);
    const sending = [...factsOf("src/nostr/send.ts", read("src/nostr/send.ts")).signsOrSends, ...factsOf("src/nostr/listWrite.ts", read("src/nostr/listWrite.ts")).signsOrSends];
    expect(sending.map((each) => each.how)).toEqual(expect.arrayContaining(["calls signEvent()", "calls publish()"]));
  });
});

describe("what the saved list's one writer hands out", () => {
  it("is one way to change the list, one to ask whether a list is older than one seen, one to say a list was seen and one to forget what was seen, with its lock's name, its wait for the relays and its shapes: nothing else that could sign or send", () => {
    expect(exportsOf(ONLY_WRITER, read(ONLY_WRITER))).toEqual([
      "SAVED_LOCK",
      "SAVED_SETTLE_MS",
      "SavedDeps",
      "SavedOutcome",
      "belowSavedFloor",
      "changeSaved",
      "forgetSavedFloor",
      "raiseSavedFloor",
    ]);
  });
});

describe("rule 1: a saved list is built only by the list's rules", () => {
  it.each([
    ["a literal 30003", `export const fresh = (address: string) => ({ kind: 30003, created_at: 0, tags: [["d", "regulars-saved"], ["a", address]], content: "" });`],
    ["the kind by its name", `import { SAVED_KIND } from "../saved/list.ts";\nexport const fresh = () => ({ kind: SAVED_KIND, tags: [], content: "" });`],
    ["a quoted key, and a kind dressed as a type", `export const fresh = () => ({ "kind": 30_003 as number, tags: [], content: "" });`],
  ])("catches an event of kind 30003 built elsewhere, written with %s", (_, source) => {
    expect(breaches("src/place/sneaky.ts", source)).toEqual([expect.stringMatching(/^src\/place\/sneaky\.ts:\d+ builds an event of kind 30003.*\(rule 1\)$/)]);
  });

  it("catches one built in the one writer too: what it signs is built by the list's rules", () => {
    const source = `import { SAVED_KIND } from "./list.ts";\nexport const fresh = (now: number) => ({ kind: SAVED_KIND, created_at: now, tags: [], content: "" });`;
    expect(breaches(ONLY_WRITER, source)).toEqual([expect.stringMatching(/^src\/saved\/change\.ts:2 builds an event of kind 30003.*\(rule 1\)$/)]);
  });

  it("lets through other kinds, a filter that asks for kind 30003, a comparison, an outcome's kind, and words about it", () => {
    const source = `
      // A saved list is kind 30003: { kind: 30003 } is what changeSaved signs.
      export const filter = { kinds: [30003], authors: [], "#d": ["regulars-saved"] };
      export const isList = (event: { kind: number }) => event.kind === 30003;
      export const review = { kind: 34259, tags: [], content: "kind: 30003" };
      export const ended = (outcome: { kind: string }) => ({ kind: outcome.kind, at: 0 });
    `;
    expect(breaches("src/saved/SavedPage.tsx", source)).toEqual([]);
  });

  it("lets the list's rules build one", () => {
    expect(breaches(LIST_RULES, `export const SAVED_KIND = 30003;\nexport const fresh = () => ({ kind: SAVED_KIND, tags: [], content: "" });`)).toEqual([]);
  });
});

describe("rule 2: the list's builders are used only by the one writer", () => {
  it.each([
    ["imported", `import { withSaved } from "../saved/list.ts";\nexport const next = (list: never, place: never) => withSaved(list, place, 0);`],
    ["reached through the module", `import * as list from "../saved/list.ts";\nexport const next = (old: never, address: string) => list.withoutSaved(old, address, 0);`],
    ["loaded when needed", `export const next = async (old: never, place: never) => (await import("../saved/list.ts")).withSaved(old, place, 0);`],
  ])("catches a builder %s elsewhere", (_, source) => {
    const found = breaches("src/place/sneaky.ts", source);
    expect(found.length).toBeGreaterThan(0);
    for (const each of found) expect(each).toMatch(/names a builder of the saved list.*\(rule 2\)$/);
  });

  it("lets through the rest of the list's rules, which only read, and lets the one writer use the builders", () => {
    const reads = `import { newestSaved, savedAddresses } from "./list.ts";\nexport const shown = (events: never[], me: string) => savedAddresses(newestSaved(events, me));`;
    expect(breaches(PROVIDER, reads)).toEqual([]);
    const writes = `import { withSaved, withoutSaved } from "./list.ts";\nexport const both = [withSaved, withoutSaved];`;
    expect(breaches(ONLY_WRITER, writes)).toEqual([]);
  });
});

describe("rule 3: a module that knows saved lists neither signs nor sends", () => {
  it.each([
    ["sends again a list it read", `import { readSavedList } from "./read.ts";\nexport const heal = async (w: any, list: never, s: never) => [readSavedList, w.publish(list, s)];`, /calls publish\(\)/],
    ["has a signer sign beside the kind", `import { SAVED_KIND } from "./list.ts";\nexport const sign = (signer: any, tags: string[][]) => signer?.signEvent({ kind: Number(SAVED_KIND), tags });`, /calls signEvent\(\)/],
    ["reaches a writer by a quoted name", `import { savedAddresses } from "../saved/list.ts";\nexport const send = (w: any, e: never) => [savedAddresses, w["publish"](e)];`, /calls publish\(\)/],
    ["imports the code that sends", `import { SAVED_D } from "../saved/list.ts";\nimport { sendOnce } from "../nostr/send.ts";\nexport const again = [SAVED_D, sendOnce];`, /imports src\/nostr\/send\.ts/],
    ["imports the code that sends a list", `import { readSavedList } from "../saved/read.ts";\nimport { sendToAll } from "../nostr/listWrite.ts";\nexport const again = [readSavedList, sendToAll];`, /imports src\/nostr\/listWrite\.ts/],
    ["imports the code that posts", `import { readSavedList } from "../saved/read";\nimport { postReview } from "../review/post";\nexport const again = [readSavedList, postReview];`, /imports src\/review\/post\.ts/],
    ["passes on the code that sends", `import { SAVED_D } from "./list.ts";\nexport { sendOnce } from "../nostr/send.ts";\nexport const named = SAVED_D;`, /imports src\/nostr\/send\.ts/],
    ["loads the code that sends when needed", `import { SAVED_D } from "./list.ts";\nexport const later = () => import("../nostr/send.ts");\nexport const named = SAVED_D;`, /imports src\/nostr\/send\.ts/],
  ])("catches a module that knows saved lists and %s", (_, source, how) => {
    const found = breaches("src/saved/sneaky.ts", source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(how);
    expect(found[0]).toMatch(/\(rule 3\)$/);
  });

  it.each([
    ["changes the list the one way, and sends something itself", "src/place/sneaky.tsx", `import { changeSaved } from "../saved/change.ts";\nexport const both = (w: any, e: never, s: never) => [changeSaved, w.publish(e, s)];`, /calls publish\(\)/],
    ["takes the session's list from its provider, and the code that posts", "src/place/sneaky.tsx", `import { useSavedList } from "../saved/SavedProvider.tsx";\nimport { postReview } from "../review/post.ts";\nexport const both = [useSavedList, postReview];`, /imports src\/review\/post\.ts/],
    ["is the session's provider, whatever it imports", PROVIDER, `export const sign = (signer: any, template: never) => signer.signEvent(template);`, /calls signEvent\(\)/],
    ["is the list's reading, whatever it imports", "src/saved/read.ts", `export const again = (w: any, list: never, s: never) => w.publish(list, s);`, /calls publish\(\)/],
  ])("catches a module that %s", (_, file, source, how) => {
    const found = breaches(file, source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(how);
    expect(found[0]).toMatch(/\(rule 3\)$/);
  });

  it("lets through reading saved lists, changing one the one way, and types of the code that sends", () => {
    const source = `
      import type { Posted } from "../review/post.ts";
      import { type Sent } from "../nostr/listWrite.ts";
      import { changeSaved, type SavedOutcome } from "./change.ts";
      import { savedAddresses, SAVED_KIND } from "./list.ts";
      import { readSavedList } from "./read.ts";
      export const filter = { kinds: [SAVED_KIND] };
      export const use = [changeSaved, savedAddresses, readSavedList];
      export type Ended = Posted | Sent | SavedOutcome;
    `;
    expect(breaches(PROVIDER, source)).toEqual([]);
  });

  it("does not take a module that shows saved places through a component of src/saved for one that knows them", () => {
    const source = `
      import { SaveButton } from "../saved/SaveButton.tsx";
      import { sendOnce } from "../nostr/send.ts";
      export const shown = [SaveButton, sendOnce];
    `;
    expect(breaches("src/place/PlacePage.tsx", source)).toEqual([]);
  });

  it("lets through code that signs and sends, and knows nothing of saved lists", () => {
    const source = `
      import { sendOnce, signInTime } from "../nostr/send.ts";
      export const post = async (signer: any, writer: any, template: never, s: never) => writer.publish(await signer.signEvent(template), s);
      export const kept = [sendOnce, signInTime, { kind: 34259 }, { kinds: [0, 10002, 30003] }];
    `;
    expect(breaches("src/review/another.ts", source)).toEqual([]);
  });

  it("lets the one writer sign and send", () => {
    const source = `
      import { sendToAll } from "../nostr/listWrite.ts";
      import { signInTime } from "../nostr/send.ts";
      import { withSaved } from "./list.ts";
      export const save = async (signer: any, w: any, e: never) => [sendToAll, signInTime, withSaved, await signer.signEvent(e), w.publish(e)];
    `;
    expect(breaches(ONLY_WRITER, source)).toEqual([]);
  });
});

describe("rule 4: no list of bookmarks but the app's own set", () => {
  it.each([
    ["anywhere in src", "src/person/sneaky.ts", `export const marks = (id: string) => ({ kind: 10003, created_at: 0, tags: [["e", id]], content: "" });`],
    ["with a quoted key, and a kind dressed as a type", "src/place/sneaky.ts", `export const marks = () => ({ "kind": 10_003 as number, tags: [], content: "" });`],
    ["in the list's rules", LIST_RULES, `export const marks = () => ({ kind: 10003, tags: [], content: "" });`],
    ["in the one writer", ONLY_WRITER, `export const marks = () => ({ kind: 10003, tags: [], content: "" });`],
  ])("catches an event of kind 10003 built %s", (_, file, source) => {
    const found = breaches(file, source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/builds an event of kind 10003.*\(rule 4\)$/);
  });

  it("lets through a filter that asks for kind 10003, a comparison, and words about it", () => {
    const source = `
      // { kind: 10003 } is the person's own list of bookmarks, which the app never writes.
      export const filter = { kinds: [10003], authors: [] };
      export const isBookmarks = (event: { kind: number }) => event.kind === 10003;
      export const words = "kind: 10003";
    `;
    expect(breaches("src/saved/SavedPage.tsx", source)).toEqual([]);
  });
});
