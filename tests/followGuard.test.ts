// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bare, exportsOf, imported, isModule, isNode, nameOf, type Node, programOf, read, sourcesUnder } from "./support/codeGuard";

/*
 * The guard on the follow list's one writer (ruling R2). A follow list (kind 3) is one record that
 * saving replaces everywhere, so only src/follow/change.ts may build, sign or send one: it is the
 * code that takes the lock, reads the list afresh and checks what was signed, for a change of one
 * entry (`changeFollow`) and for a kept copy put back whole (`putBackList`) alike. This
 * reads the code in src as code (its imports, its names, its object literals and its calls), so a
 * comment, a word on screen or a permission's name (`sign_event:3`) is never taken for a breach,
 * and holds every other module to three rules:
 *
 *   1. Built in one place. An object literal whose `kind` is 3 or `FOLLOW_KIND`, which is an event
 *      or a template of a follow list, is written only in src/follow/list.ts, the list's rules. Nor
 *      does a module that knows follow lists make an event out of one it was given: an object with
 *      `tags` whose `kind` is another's (`kind: list.kind`), or one spread out and given other
 *      `tags` or another `created_at` (`{ ...list, tags }`).
 *   2. Its builders used in one place. `withFollow`, `withoutFollow`, `withRestored` and
 *      `withWholeList`, which make the list that is signed, are named only there and in
 *      src/follow/change.ts.
 *   3. What knows follow lists neither signs nor sends. A module knows them when it names
 *      `FOLLOW_KIND`, asks relays for kind 3 (`kinds: [3]`), builds one, or imports the list's
 *      rules, its reading, its one writer, the copies kept of it, the session's store of those
 *      copies or the session's provider of the list (src/follow/list.ts, read.ts, change.ts,
 *      kept.ts, keptStore.ts, FollowProvider.tsx), and the provider and the copies' store do by
 *      being them: each holds the person's signer beside lists of theirs. A kept copy is a whole
 *      signed list, and an old one. Such a module
 *      does not call a signer's `signEvent` or a writer's `publish`, and does not import the code
 *      the app signs and sends with (src/nostr/send.ts, src/review/post.ts). So a list that was
 *      read cannot be sent again from elsewhere, and what calls `changeFollow` sends nothing itself.
 *
 * And the one writer hands out two functions that sign and send, and no more: its exports are pinned
 * here, so another way to write a list is a change to this test. Where the one that replaces a whole
 * list is called from is held to one press, further down; and so is where the person's say comes
 * from, that a change may be built on a copy of their list that could not be known to be the newest.
 *
 * It is a tripwire, not a proof: code that hid a kind 3 behind another name, copied a list field by
 * field under other names, or reached a signer through a module not listed here, would pass. Each
 * rule is shown catching what it is for, and letting through what it allows. A module that must
 * break one is a second writer of follow lists, and belongs in `changeFollow` instead.
 */

/** The one module that may build, sign and send a follow list. */
const ONLY_WRITER = "src/follow/change.ts";
/** The list's rules, pure: where a follow list's template is built. */
const LIST_RULES = "src/follow/list.ts";
/** The session's own list, for the buttons (Task 4). Named before it exists: it will hold the person's signer and their list side by side. */
const PROVIDER = "src/follow/FollowProvider.tsx";
/** The copies of a person's list kept in the browser: whole signed lists, each older than the list as it is. */
const KEPT = "src/follow/kept.ts";
/** The session's store of those copies, with the putting back of one: it holds the person's signer and their kept lists side by side. */
const COPIES_STORE = "src/follow/keptStore.ts";
/** The modules that make a module one that knows follow lists: by importing one of them, or by being one. */
const FOLLOW_LIST_CODE = [LIST_RULES, "src/follow/read.ts", ONLY_WRITER, KEPT, COPIES_STORE, PROVIDER];
/** The modules the app signs an event with, or sends one to a relay with. */
const SIGNING_AND_SENDING = ["src/nostr/send.ts", "src/review/post.ts", "src/nostr/listWrite.ts"];
/** The names of what builds the list to sign. */
const BUILDERS = ["withFollow", "withoutFollow", "withRestored", "withWholeList"];
/** The methods that sign an event (a signer's) and send one (a relay writer's). */
const SIGN_OR_SEND_CALLS = ["signEvent", "publish"];

/** Whether an expression is the follow list's kind, as the code writes it: 3, or `FOLLOW_KIND`. */
function isFollowKind(node: unknown): boolean {
  const value = bare(node);
  return value !== undefined && ((value.type === "Literal" && value.value === 3) || (value.type === "Identifier" && value.name === "FOLLOW_KIND"));
}

/** Whether an object literal has a property of this name, written out (not one a spread may bring). */
const hasProperty = (object: Node, name: string) =>
  (object.properties as Node[]).some((property) => property.type === "Property" && nameOf(property.key) === name);

/**
 * Whether an object literal is an event made out of another: one with `tags` whose `kind` is another
 * thing's (`kind: list.kind`), or another thing spread out and given `tags` or a `created_at` of its own.
 */
function copiesAnEvent(object: Node): boolean {
  const properties = object.properties as Node[];
  const kindOfAnother = properties.some((property) => {
    if (property.type !== "Property" || nameOf(property.key) !== "kind") return false;
    const value = bare(property.value);
    return value?.type === "MemberExpression" && nameOf(value.property) === "kind";
  });
  const spreads = properties.some((property) => property.type === "SpreadElement");
  return (kindOfAnother && hasProperty(object, "tags")) || (spreads && (hasProperty(object, "tags") || hasProperty(object, "created_at")));
}

/** What a module does that the rules are about, each with where in the file. */
interface Facts {
  /** Object literals of kind 3: an event or a template of a follow list. */
  builds: number[];
  /** Object literals that are an event made out of another (`copiesAnEvent`). */
  copies: number[];
  /** Where a builder is named. */
  builders: number[];
  /** Why the module is taken to know follow lists. */
  knows: Array<{ at: number; why: string }>;
  /** How the module signs or sends. */
  signsOrSends: Array<{ at: number; how: string }>;
}

function factsOf(file: string, source: string): Facts {
  const program = programOf(file, source);
  const facts: Facts = { builds: [], copies: [], builders: [], knows: [], signsOrSends: [] };
  if (FOLLOW_LIST_CODE.includes(file)) facts.knows.push({ at: 0, why: `is ${file}` });

  /** A module of the project's that code, not only a type, is taken from. */
  const takesFrom = (at: number, specifier: unknown) => {
    const path = typeof specifier === "string" ? imported(file, specifier) : undefined;
    const lists = FOLLOW_LIST_CODE.find((module) => isModule(path, module));
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

    if (node.type === "Identifier") {
      if (node.name === "FOLLOW_KIND") facts.knows.push({ at: node.start, why: "names FOLLOW_KIND" });
      if (BUILDERS.includes(node.name as string)) facts.builders.push(node.start);
    }

    if (node.type === "ObjectExpression" && copiesAnEvent(node)) facts.copies.push(node.start);

    if (node.type === "Property" && nameOf(node.key) === "kind" && isFollowKind(node.value)) {
      facts.builds.push(node.start);
      facts.knows.push({ at: node.start, why: "builds an event of kind 3" });
    }
    if (node.type === "Property" && nameOf(node.key) === "kinds") {
      const kinds = bare(node.value);
      if (kinds?.type === "ArrayExpression" && (kinds.elements as unknown[]).some(isFollowKind)) {
        facts.knows.push({ at: node.start, why: "asks relays for kind 3" });
      }
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
  if (file === ONLY_WRITER) return [];
  const facts = factsOf(file, source);
  const where = (at: number) => `${file}:${source.slice(0, at).split("\n").length}`;
  const found: string[] = [];
  if (file !== LIST_RULES) {
    for (const at of facts.builds) found.push(`${where(at)} builds an event of kind 3: only ${LIST_RULES} does (rule 1)`);
    for (const at of facts.builders) found.push(`${where(at)} names a builder of the follow list: only ${ONLY_WRITER} uses them (rule 2)`);
  }
  const knows = facts.knows[0];
  if (knows !== undefined && file !== LIST_RULES) {
    for (const at of facts.copies) {
      found.push(`${where(at)} builds an event from one it was given, in a module that knows follow lists (it ${knows.why}): only ${LIST_RULES} builds a follow list (rule 1)`);
    }
  }
  if (knows !== undefined) {
    for (const { at, how } of facts.signsOrSends) {
      found.push(`${where(at)} ${how}, in a module that knows follow lists (it ${knows.why}): only ${ONLY_WRITER} signs or sends one (rule 3)`);
    }
  }
  return found;
}

describe("the follow list's one writer (ruling R2)", () => {
  it("is the only module in src that builds, signs or sends a follow list", () => {
    const sources = sourcesUnder("src");
    // The scan reads the app: the writer, the list's rules, its reading and the code that signs and sends
    // are all there. The provider is held to the rules from the day it is.
    for (const module of [...FOLLOW_LIST_CODE.filter((each) => each !== PROVIDER), ...SIGNING_AND_SENDING]) expect(sources).toContain(module);

    expect(sources.flatMap((file) => breaches(file, read(file)))).toEqual([]);
  });

  it("sees the writer do what no other module may: it is let through by name, not for want of looking", () => {
    const writer = factsOf(ONLY_WRITER, read(ONLY_WRITER));
    expect(writer.builders.length).toBeGreaterThan(0);
    expect(writer.knows.map((each) => each.why)).toContain(`imports ${LIST_RULES}`);
    expect(writer.signsOrSends.map((each) => each.how)).toContain("imports src/nostr/send.ts");

    // The list's rules build the templates, and the code that sends calls a signer and a writer.
    expect(factsOf(LIST_RULES, read(LIST_RULES)).builds.length).toBeGreaterThan(0);
    const sending = factsOf("src/nostr/send.ts", read("src/nostr/send.ts")).signsOrSends.map((each) => each.how);
    expect(sending).toContain("calls signEvent()");
    expect(sending).toContain("calls publish()");
  });
});

describe("what the one writer hands out", () => {
  it("is one way to change a list, one to put a kept copy back, one to say what list is on screen, one to ask whether a list is older than one seen and one to forget what was seen, with their times and their shapes: nothing else that could sign or send", () => {
    expect(exportsOf(ONLY_WRITER, read(ONLY_WRITER))).toEqual([
      "FOLLOW_LOCK",
      "FOLLOW_LOCK_WAIT_MS",
      "FOLLOW_SETTLE_MS",
      "FollowDeps",
      "FollowOutcome",
      "belowFollowFloor",
      "changeFollow",
      "forgetFollowFloor",
      "putBackList",
      "raiseFollowFloor",
    ]);
  });

  it("is read from every way a module exports", () => {
    const source = `
      export const A = 1, B = 2;
      export function send() {}
      export async function sendLater() {}
      export class Sender {}
      export type Shape = string;
      export interface Deps {}
      const hidden = 3;
      export { hidden as shown };
      export { sendOnce } from "../nostr/send.ts";
      export * from "./list.ts";
      export default hidden;
    `;
    expect(exportsOf("src/follow/sample.ts", source)).toEqual(["* from ./list.ts", "A", "B", "Deps", "Sender", "Shape", "default", "send", "sendLater", "sendOnce", "shown"]);
  });
});

describe("rule 1: a follow list is built only by the list's rules", () => {
  it.each([
    ["a literal 3", `export const fresh = (who: string) => ({ kind: 3, created_at: 0, tags: [["p", who]], content: "" });`],
    ["the kind by its name", `import { FOLLOW_KIND } from "../follow/list.ts";\nexport const fresh = () => ({ kind: FOLLOW_KIND, tags: [], content: "" });`],
    ["a quoted key, and a kind dressed as a type", `export const fresh = () => ({ "kind": 3 as number, tags: [], content: "" });`],
  ])("catches an event of kind 3 built elsewhere, written with %s", (_, source) => {
    expect(breaches("src/person/sneaky.ts", source)).toEqual([expect.stringMatching(/^src\/person\/sneaky\.ts:\d+ builds an event of kind 3.*\(rule 1\)$/)]);
  });

  it("lets through other kinds, a filter that asks for kind 3, a comparison, and words about it", () => {
    const source = `
      // A follow list is kind 3: { kind: 3 } is what changeFollow signs.
      const PERMISSIONS = ["sign_event:3"];
      export const login = { kind: 22242, tags: [], content: "kind: 3" };
      export const filter = { kinds: [3], authors: [] };
      export const isList = (event: { kind: number }) => event.kind === 3;
      export const three = { stars: 3, kindness: 3 };
    `;
    expect(breaches("src/person/reads.ts", source)).toEqual([]);
  });

  it.each([
    ["the kind of a list it was given, with its tags", `import { readFollowList } from "./read.ts";\nexport const again = (list: any, who: string) => ({ kind: list.kind, created_at: 0, tags: [...list.tags, ["p", who]], content: list.content });`],
    ["a list spread out, with other tags", `import { followed } from "./list.ts";\nexport const again = (list: any, who: string) => [followed, { ...list, tags: [...list.tags, ["p", who]] }];`],
    ["a list spread out, at another time", `import { changeFollow } from "./change.ts";\nexport const again = (list: any, now: number) => [changeFollow, { ...list, created_at: now }];`],
  ])("catches, in a module that knows follow lists, an event made from %s", (_, source) => {
    expect(breaches("src/follow/sneaky.ts", source)).toEqual([expect.stringMatching(/^src\/follow\/sneaky\.ts:\d+ builds an event from one it was given.*\(rule 1\)$/)]);
  });

  it("lets through, in such a module, an outcome's kind copied, and a state spread out", () => {
    const source = `
      import { changeFollow } from "./change.ts";
      import { followed } from "./list.ts";
      export const kept = (outcome: any, state: any, list: any) => [
        changeFollow,
        { kind: outcome.kind, at: 0 },
        { ...state, list, follows: followed(list) },
        { tags: list.tags.length },
      ];
    `;
    expect(breaches("src/follow/FollowProvider.tsx", source)).toEqual([]);
  });

  it("does not hold code that knows nothing of follow lists to it: a review's template is copied so", () => {
    const source = `export const copy = (template: any, tags: string[][]) => ({ ...template, tags: tags.map((tag) => [...tag]) });`;
    expect(breaches("src/circle/another.ts", source)).toEqual([]);
  });

  it("lets the list's rules build one", () => {
    expect(breaches(LIST_RULES, `export const FOLLOW_KIND = 3;\nexport const fresh = () => ({ kind: FOLLOW_KIND, tags: [], content: "" });`)).toEqual([]);
  });
});

describe("rule 2: the list's builders are used only by the one writer", () => {
  it.each([
    ["imported", `import { withFollow } from "../follow/list.ts";\nexport const next = (list: never, who: string) => withFollow(list, who, 0);`],
    ["reached through the module", `import * as list from "../follow/list.ts";\nexport const next = (old: never, who: string) => list.withoutFollow(old, who, 0);`],
    ["loaded when needed", `export const next = async (old: never, who: string) => (await import("../follow/list.ts")).withFollow(old, who, 0);`],
    ["that puts back what an unfollow took out", `import { withRestored } from "../follow/list.ts";\nexport const next = (list: never, removed: never) => withRestored(list, removed, 0, "");`],
    ["that puts a whole list back", `import { withWholeList } from "../follow/list.ts";\nexport const next = (copy: never, newest: never) => withWholeList(copy, newest, 0);`],
  ])("catches a builder %s elsewhere", (_, source) => {
    const found = breaches("src/person/sneaky.ts", source);
    expect(found.length).toBeGreaterThan(0);
    for (const each of found) expect(each).toMatch(/names a builder of the follow list.*\(rule 2\)$/);
  });

  it("lets through the rest of the list's rules, which only read", () => {
    const source = `import { followed, names, type Removed, removedBy } from "../follow/list.ts";\nexport const follows = (list: never, who: string): [boolean, Removed[]] => [names(list, who) || followed(list).includes(who), removedBy(list, who)];`;
    expect(breaches("src/follow/FollowProvider.tsx", source)).toEqual([]);
  });
});

describe("rule 3: a module that knows follow lists neither signs nor sends", () => {
  it.each([
    ["sends again a list it read", `import { readFollowList } from "./read.ts";\nexport const heal = async (w: never, list: never, s: never) => (w as any).publish(list, s);`, /calls publish\(\)/],
    ["has a signer sign beside the kind", `import { FOLLOW_KIND } from "./list.ts";\nexport const sign = (signer: any, tags: string[][]) => signer?.signEvent({ kind: Number(FOLLOW_KIND), tags });`, /calls signEvent\(\)/],
    ["reaches a writer by a quoted name", `const filter = { kinds: [3] };\nexport const send = (w: any, e: never) => w["publish"](e, filter);`, /calls publish\(\)/],
    ["imports the code that sends", `import { FOLLOW_KIND } from "../follow/list.ts";\nimport { sendOnce } from "../nostr/send.ts";\nexport const again = [FOLLOW_KIND, sendOnce];`, /imports src\/nostr\/send\.ts/],
    ["imports the code that posts", `import { readFollowList } from "../follow/read.ts";\nimport { postReview } from "../review/post";\nexport const again = [readFollowList, postReview];`, /imports src\/review\/post\.ts/],
    ["passes on the code that sends", `import { names } from "../follow/list.ts";\nexport { sendOnce } from "../nostr/send.ts";\nexport const has = names;`, /imports src\/nostr\/send\.ts/],
    ["loads the code that sends when needed", `import { names } from "../follow/list.ts";\nexport const later = () => import("../nostr/send.ts");\nexport const has = names;`, /imports src\/nostr\/send\.ts/],
  ])("catches a module that knows follow lists and %s", (_, source, how) => {
    const found = breaches("src/follow/sneaky.ts", source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(how);
    expect(found[0]).toMatch(/\(rule 3\)$/);
  });

  it.each([
    ["changes a list the one way, and sends something itself", "src/person/sneaky.ts", `import { changeFollow } from "../follow/change.ts";\nexport const both = (w: any, e: never, s: never) => [changeFollow, w.publish(e, s)];`, /calls publish\(\)/],
    ["takes the session's list from its provider, and the code that posts", "src/person/sneaky.tsx", `import { useOwnFollowed } from "../follow/FollowProvider.tsx";\nimport { postReview } from "../review/post.ts";\nexport const both = [useOwnFollowed, postReview];`, /imports src\/review\/post\.ts/],
    ["is the session's provider, whatever it imports", "src/follow/FollowProvider.tsx", `export const sign = (signer: any, template: never) => signer.signEvent(template);`, /calls signEvent\(\)/],
    ["takes the copies kept of a list, and sends one itself", "src/you/sneaky.tsx", `import { keptCopies } from "../follow/kept.ts";\nexport const again = async (w: any, me: string, s: never) => w.publish((await keptCopies(me))[0]!.list, s);`, /calls publish\(\)/],
    ["is where the copies are kept, whatever it imports", "src/follow/kept.ts", `export const again = (w: any, list: never, s: never) => w.publish(list, s);`, /calls publish\(\)/],
    ["is the session's store of the copies, whatever it imports", "src/follow/keptStore.ts", `export const sign = (account: any, template: never) => account.signer.signEvent(template);`, /calls signEvent\(\)/],
    ["takes the copies from the session's store of them, and the code that sends", "src/you/sneaky.tsx", `import { usePutBack } from "../follow/keptStore.ts";\nimport { sendOnce } from "../nostr/send.ts";\nexport const both = [usePutBack, sendOnce];`, /imports src\/nostr\/send\.ts/],
  ])("catches a module that %s", (_, file, source, how) => {
    const found = breaches(file, source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(how);
    expect(found[0]).toMatch(/\(rule 3\)$/);
  });

  it("lets through reading follow lists, and changing one the one way", () => {
    const source = `
      import type { Posted } from "../review/post.ts";
      import { type Tried } from "../nostr/send.ts";
      import { changeFollow } from "./change.ts";
      import { FOLLOW_KIND, followed } from "./list.ts";
      import { readFollowList, readOwnList } from "./read.ts";
      export const filter = { kinds: [FOLLOW_KIND], "#p": [] };
      export const use = [changeFollow, followed, readFollowList, readOwnList];
      export type Kept = Posted | Tried;
    `;
    expect(breaches("src/follow/FollowProvider.tsx", source)).toEqual([]);
  });

  it("lets through code that signs and sends, and knows nothing of follow lists", () => {
    const source = `
      import { sendOnce, signInTime } from "../nostr/send.ts";
      export const post = async (signer: any, writer: any, template: never, s: never) => writer.publish(await signer.signEvent(template), s);
      export const kept = [sendOnce, signInTime, { kind: 34259 }, { kinds: [0, 10002] }];
    `;
    expect(breaches("src/review/another.ts", source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The one place that asks for an unfollow (ruling R47).
// ---------------------------------------------------------------------------------------------

/*
 * The Follow button says Unfollow before it unfollows, and one rule decides every press: only a
 * press on the word Unfollow asks for the unfollow (tests/followButton.test.tsx holds the button to
 * what it does). Here its code is held to where it asks from, read as code: a call of a method named
 * `unfollow` is made once in src, in the button's `onPress`, which is the button's click and nothing
 * else's. So no effect, no timer, no listener and no pointer's or focus's handler can ask for one.
 * A tripwire, as above: a call hidden behind another name would pass.
 */

/** The button, and the function in it that a press runs. */
const BUTTON = "src/follow/FollowButton.tsx";
const PRESS = "onPress";

/** A function, as the code writes one. */
const FUNCTIONS = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

/**
 * What a function is, by where it is written: its own name; the name it is given (`const onPress =
 * …`, `{ onBlur: … }`); the call it is handed to (`useEffect()`, `setTimeout()`); or the attribute
 * it is the value of (`onClick=`).
 */
function functionName(fn: Node, parent: Node | undefined): string {
  const own = nameOf(fn.id);
  if (own !== undefined) return own;
  if (parent?.type === "VariableDeclarator") return nameOf(parent.id) ?? "?";
  if (parent?.type === "Property") return nameOf(parent.key) ?? "?";
  // A method of a class, or a function a class keeps in a field.
  if (parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") return nameOf(parent.key) ?? "?";
  if (parent?.type === "CallExpression") {
    const callee = bare(parent.callee);
    return `${(callee?.type === "MemberExpression" ? nameOf(callee.property) : nameOf(callee)) ?? "?"}()`;
  }
  if (parent?.type === "JSXExpressionContainer") return "an attribute's";
  return "?";
}

/** Where a module asks for an unfollow, and what uses the function a press runs. */
interface Asks {
  /** Each call of a method named `unfollow`: the functions it is in, nearest first. */
  calls: string[][];
  /** Each use of `onPress` but its own declaration: the attribute it is the value of (`onClick=`), or what else it is in. */
  uses: string[];
}

/**
 * Where a module calls `asked`, a method by that name or a function of that name (by default, a
 * method named `unfollow`), and what uses `press`, the function a press runs (by default, `onPress`).
 */
function asksOf(file: string, source: string, asked = "unfollow", press = PRESS): Asks {
  const program = programOf(file, source);
  const asks: Asks = { calls: [], uses: [] };

  const walk = (node: unknown, around: Node[]) => {
    if (Array.isArray(node)) return node.forEach((each) => walk(each, around));
    if (!isNode(node)) return;
    const parent = around[around.length - 1];

    if (node.type === "CallExpression") {
      const callee = bare(node.callee);
      const called = callee?.type === "MemberExpression" ? nameOf(callee.property) : callee?.type === "Identifier" ? nameOf(callee) : undefined;
      if (called === asked) {
        const within: string[] = [];
        for (let i = around.length - 1; i >= 0; i--) {
          if (FUNCTIONS.test(around[i]!.type)) within.push(functionName(around[i]!, around[i - 1]));
        }
        asks.calls.push(within);
      }
    }
    if (node.type === "Identifier" && node.name === press && !(parent?.type === "VariableDeclarator" && parent.id === node)) {
      const attribute = parent?.type === "JSXExpressionContainer" ? around[around.length - 2] : undefined;
      asks.uses.push(attribute?.type === "JSXAttribute" ? `${String((attribute.name as Node).name)}=` : `in ${parent?.type ?? "nothing"}`);
    }

    const next = [...around, node];
    for (const [key, child] of Object.entries(node)) if (key !== "type") walk(child, next);
  };
  walk(program, []);
  return asks;
}

describe("the one place that asks for an unfollow (ruling R47)", () => {
  it("is the button's press, in all of src: one call, in the function its click runs and nothing else does", () => {
    const sources = sourcesUnder("src");
    expect(sources).toContain(BUTTON);
    const asking = sources.map((file) => ({ file, ...asksOf(file, read(file)) })).filter((each) => each.calls.length > 0);

    expect(asking.map((each) => each.file)).toEqual([BUTTON]);
    // In `onPress`, straight in it: in no function inside it (a timer's, a promise's), and in nothing but the button.
    expect(asking[0]!.calls).toEqual([[PRESS, "Shown"]]);
    // And `onPress` is the button's click: it is handed to nothing else, nor called from anywhere.
    expect(asking[0]!.uses).toEqual(["onClick="]);
  });

  it("catches a call from an effect, a timer, a listener or a pointer's handler, and a press handed to something else", () => {
    const sample = asksOf(
      "sample.tsx",
      `
      function Shown({ of }) {
        const onPress = () => { if (shown) of.unfollow(); };
        useEffect(() => { of.unfollow(); }, []);
        useEffect(() => { const timer = setTimeout(() => of.unfollow(), 400); return () => clearTimeout(timer); }, []);
        document.addEventListener("pointerdown", () => of?.unfollow());
        const told = { onPointerEnter: () => (of as Follow).unfollow(), onBlur() { of["unfollow"](); } };
        setTimeout(onPress, 4_000);
        return <button onClick={onPress} onPointerEnter={onPress} {...told} />;
      }
      // of.unfollow() in a comment is no call, nor is "of.unfollow()" in words
      const words = "of.unfollow()";
      const named = { unfollow: "Unfollow" };
      `,
    );

    expect(sample.calls).toEqual([
      ["onPress", "Shown"],
      ["useEffect()", "Shown"],
      ["setTimeout()", "useEffect()", "Shown"],
      ["addEventListener()", "Shown"],
      ["onPointerEnter", "Shown"],
      ["onBlur", "Shown"],
    ]);
    expect(sample.uses).toEqual(["in CallExpression", "onClick=", "onPointerEnter="]);
  });
});

/** Each module of `sources` that calls `asked`, with the functions each call is in, nearest first; in order of path. */
function callersOf(sources: Array<[file: string, source: string]>, asked: string): Array<{ file: string; calls: string[][] }> {
  return sources
    .map(([file, source]) => ({ file, calls: asksOf(file, source, asked, PUT_IT_BACK).calls }))
    .filter((each) => each.calls.length > 0)
    .sort((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * Where `source` names `name` other than to import it, to declare it or to call it: what it is in,
 * each time. A function that is only ever called is named nowhere else; one that is handed on is.
 */
function handedOn(file: string, source: string, name: string): string[] {
  const program = programOf(file, source);
  const found: string[] = [];
  const walk = (node: unknown, parent: Node | undefined) => {
    if (Array.isArray(node)) return node.forEach((each) => walk(each, parent));
    if (!isNode(node)) return;
    if (node.type === "Identifier" && node.name === name) {
      const imported = parent?.type === "ImportSpecifier";
      const declared = parent?.type === "FunctionDeclaration" && parent.id === node;
      const called = parent?.type === "CallExpression" && parent.callee === node;
      if (!imported && !declared && !called) found.push(`in ${parent?.type ?? "nothing"}`);
    }
    for (const [key, child] of Object.entries(node)) if (key !== "type") walk(child, node);
  };
  walk(program, undefined);
  return found;
}

/** The functions each node of `source` that `matches` is in, nearest first: one list for each such node, in the order of the code. */
function whereIn(file: string, source: string, matches: (node: Node) => boolean): string[][] {
  const program = programOf(file, source);
  const found: string[][] = [];
  const walk = (node: unknown, around: Node[]) => {
    if (Array.isArray(node)) return node.forEach((each) => walk(each, around));
    if (!isNode(node)) return;
    if (matches(node)) {
      const within: string[] = [];
      for (let i = around.length - 1; i >= 0; i--) {
        if (FUNCTIONS.test(around[i]!.type)) within.push(functionName(around[i]!, around[i - 1]));
      }
      found.push(within);
    }
    const next = [...around, node];
    for (const [key, child] of Object.entries(node)) if (key !== "type") walk(child, next);
  };
  walk(program, []);
  return found;
}

/** `a.b` or `a.#b`, read as the names it is made of: `["this", "#host", "live"]`. Undefined for anything else. */
function memberPath(node: unknown): string[] | undefined {
  const each = bare(node);
  if (each?.type === "ThisExpression") return ["this"];
  if (each?.type === "Identifier") return [each.name as string];
  if (each?.type !== "MemberExpression") return undefined;
  const object = memberPath(each.object);
  const property = each.property as Node;
  const name = nameOf(property);
  if (object === undefined || name === undefined) return undefined;
  return [...object, property.type === "PrivateIdentifier" ? `#${name}` : name];
}

/** Whether a node is a call of what `path` names: `this.#host.live()`. */
const callsPath = (path: string) => (node: Node) => node.type === "CallExpression" && memberPath(node.callee)?.join(".") === path;
/** Whether a node reads what `path` names: `config.features.follow`. */
const readsPath = (path: string) => (node: Node) => node.type === "MemberExpression" && memberPath(node)?.join(".") === path;

// ---------------------------------------------------------------------------------------------
// The one press that says to use a copy.
// ---------------------------------------------------------------------------------------------

/*
 * When no relay the person writes to answers, a change could only be built on a copy of their list
 * found on the app's relays, which may not be their newest: so nothing is written until they say so,
 * of the copy they were shown (src/follow/change.ts). Their say is one press, Use this copy, and
 * where it comes from is held to that, link by link, read as code: `changeFollow` is called once in
 * src, in the session's store (`#start`); only the store's `useCopy` hands `#start` an answer (a press
 * made in place of one, and Try again, start a change with none); that
 * is called once, by what `useFollow` hands out as `useThisCopy`; and that is called once in all of
 * src, in the button's `onUseThisCopy`, which is the tap of one word and nothing else's. A word's tap
 * is its own click. So no effect, no timer, no listener and no pointer's or focus's handler can
 * answer for the person.
 *
 * There is one other source of a say: the list a change made by their say saved, which later changes
 * in the session go on from with no second asking. That is held too: it is set in one place in src,
 * under a test that the change was saved, was made by their say and was confirmed; it is begun with
 * nothing; and it is read where a change is started and nowhere else. A tripwire, as above: a call
 * or an assignment hidden behind another name would pass.
 */

/** What the session keeps of the list later changes may go on from with no second asking: the one other source of a say. */
const GOES_ON_FROM = "allowed";

/**
 * Where `source` sets a member named `member` (`session.allowed = …`): the functions each such
 * assignment is in, nearest first, and what is read in the tests it stands under (the conditions of
 * the `if`s whose own branch it is in), as the names they are made of.
 */
function setsOf(file: string, source: string, member: string): Array<{ within: string[]; under: string[] }> {
  const program = programOf(file, source);
  const found: Array<{ within: string[]; under: string[] }> = [];
  /** Every `a.b.c` read in an expression, outermost first, each once. */
  const readsIn = (test: unknown): string[] => {
    const paths: string[] = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!isNode(node)) return;
      const path = node.type === "MemberExpression" ? memberPath(node)?.join(".") : undefined;
      if (path !== undefined) {
        if (!paths.includes(path)) paths.push(path);
        return;
      }
      for (const [key, child] of Object.entries(node)) if (key !== "type") visit(child);
    };
    visit(test);
    return paths;
  };
  const walk = (node: unknown, around: Node[]) => {
    if (Array.isArray(node)) return node.forEach((each) => walk(each, around));
    if (!isNode(node)) return;
    if (node.type === "AssignmentExpression" && memberPath(node.left)?.at(-1) === member) {
      const within: string[] = [];
      const under: string[] = [];
      for (let i = around.length - 1; i >= 0; i--) {
        const outer = around[i]!;
        if (FUNCTIONS.test(outer.type)) within.push(functionName(outer, around[i - 1]));
        // Only the branch the test holds for: what is in its `else` stands under no such test.
        if (outer.type === "IfStatement" && (around[i + 1] ?? node) === outer.consequent) under.unshift(...readsIn(outer.test));
      }
      found.push({ within, under });
    }
    const next = [...around, node];
    for (const [key, child] of Object.entries(node)) if (key !== "type") walk(child, next);
  };
  walk(program, []);
  return found;
}

/** Where `source` writes an object with a property named `member` that is anything but `undefined`: the functions each is in, nearest first. */
function beginsWith(file: string, source: string, member: string): string[][] {
  return whereIn(file, source, (node) => {
    if (node.type !== "Property" || nameOf(node.key) !== member) return false;
    const value = bare(node.value);
    return !(value?.type === "Identifier" && value.name === "undefined");
  });
}

/** The function in the button that a press of Use this copy runs, and the name the hook hands the store's method on by. */
const USE_PRESS = "onUseThisCopy";
const SAYS_USE = "useThisCopy";
/** The store's method that makes the change that asked, with the person's answer; and the one that starts every change. */
const STORE_USES = "useCopy";
const STARTS = "this.#start";

/**
 * Whether a call that starts a change hands it an answer: a third argument that is anything but the
 * word that says an asking was part of it (`"asking"`), which carries none. An object with an
 * `answer`, a name that may hold one, and anything else are taken for one.
 */
function givesAnswer(call: Node): boolean {
  const through = bare((call.arguments as unknown[])[2]);
  return through !== undefined && !(through.type === "Literal" && through.value === "asking");
}

describe("the one press that says to use a copy", () => {
  const sources = (): Array<[string, string]> => sourcesUnder("src").map((file) => [file, read(file)]);

  it("is Use this copy's, in all of src: one call, in the function that word's tap runs and nothing else does", () => {
    const all = sources();
    const answering = all.map(([file, source]) => ({ file, ...asksOf(file, source, SAYS_USE, USE_PRESS) })).filter((each) => each.calls.length > 0);

    expect(answering.map((each) => each.file)).toEqual([BUTTON]);
    // Straight in `onUseThisCopy`: in no function inside it, and in nothing but the button.
    expect(answering[0]!.calls).toEqual([[USE_PRESS, "Shown"]]);
    // Which is handed to one word as its tap, and to nothing else, nor called from anywhere.
    expect(answering[0]!.uses).toEqual(["onTap="]);
    // And a word's tap is called in one place, the word's own click.
    const word = asksOf(BUTTON, read(BUTTON), "onTap", "tap");
    expect(word.calls).toEqual([["tap", "Word"]]);
    expect(word.uses).toEqual(["onClick="]);
  });

  it("reaches the one change through the store's own answer and nothing else: the change is called in one place, and only that answer goes with it as the person's own", () => {
    const all = sources();
    const provider = read(PROVIDER);

    // What the hook hands out as the answer calls the store's method: once, in all of src.
    expect(callersOf(all, STORE_USES)).toEqual([{ file: PROVIDER, calls: [[SAYS_USE, "useMemo()", "useFollow"]] }]);
    // The change is called once in src, where the store starts every change.
    expect(callersOf(all, "changeFollow")).toEqual([{ file: PROVIDER, calls: [["start"]] }]);
    // And handed to nothing: beside that call it is named only where a type is read off it.
    expect(all.flatMap(([file, source]) => handedOn(file, source, "changeFollow").map((where) => `${file} ${where}`))).toEqual([`${PROVIDER} in TSTypeQuery`]);
    // A change is started by a tap's method, by Try again's and by the answer's, and only the answer's
    // hands it one. A tap's method starts one in two places, neither with an answer: the change the
    // tap is for, and, while the person is asked about that one, the change that asked, again. Try
    // again starts, with no answer either, the change that an asking was part of, as it was.
    const starts = (withAnswer: boolean) => whereIn(PROVIDER, provider, (node) => callsPath(STARTS)(node) && givesAnswer(node) === withAnswer);
    expect(starts(false)).toEqual([["change"], ["change"], ["retry"]]);
    expect(starts(true)).toEqual([[STORE_USES]]);
  });

  it("has one other source of a say, and it is held as the press is: what later changes go on from is set in one place in src, only for a change saved by the person's say and confirmed", () => {
    const all = sources();
    const set = all.flatMap(([file, source]) => setsOf(file, source, GOES_ON_FROM).map((each) => ({ file, ...each })));

    // One assignment in all of src: in the store, where a change's end is taken in.
    expect(set.map(({ file, within }) => [file, within])).toEqual([[PROVIDER, ["over"]]]);
    // Made only under a test of how that change ended: saved, by the person's say, and confirmed.
    expect(set[0]!.under).toEqual(expect.arrayContaining(["outcome.kind", "outcome.bySay", "outcome.confirmed"]));
    // Nor is it begun with a list: a session starts with none.
    expect(all.flatMap(([file, source]) => beginsWith(file, source, GOES_ON_FROM).map((within) => [file, within]))).toEqual([]);
    // And it is named in two places and no more: where the store starts a change, which reads it beside
    // the answer of a press, and that one assignment.
    const named = whereIn(PROVIDER, read(PROVIDER), (node) => node.type === "MemberExpression" && memberPath(node)?.join(".") === `session.${GOES_ON_FROM}`);
    expect(named).toEqual([["start"], ["over"]]);
  });

  it("catches what later changes go on from being set elsewhere, set without the test of how the change ended, or begun with a list", () => {
    const sample = `
      class OwnFollows {
        setAccount(account) { this.#session = { account, list: undefined, allowed: undefined }; }
        again(account, held) { this.#session = { account, allowed: held.id }; }
        #over(session, who, person, action, outcome) {
          if (outcome.kind === "saved" && outcome.bySay === true && outcome.confirmed) session.allowed = outcome.list.id;
          if (outcome.kind === "saved") session.allowed = outcome.list.id;
          if (outcome.bySay === true) { session.allowed = outcome.list.id; }
          if (outcome.confirmed) person.saving = false; else session.allowed = outcome.list.id;
          session.allowed = session.asking.copy.id;
        }
        async #read(session) { const read = await readOwnList(); if (read.trusted) session.allowed = read.list.id; }
      }
      // session.allowed = copy.id in a comment sets nothing
      const allowed = "allowed";
    `;

    expect(setsOf("sample.ts", sample, GOES_ON_FROM)).toEqual([
      { within: ["over"], under: ["outcome.kind", "outcome.bySay", "outcome.confirmed"] },
      { within: ["over"], under: ["outcome.kind"] },
      { within: ["over"], under: ["outcome.bySay"] },
      // In the branch a test does not hold for: that test stands over nothing.
      { within: ["over"], under: [] },
      { within: ["over"], under: [] },
      { within: ["read"], under: ["read.trusted"] },
    ]);
    expect(beginsWith("sample.ts", sample, GOES_ON_FROM)).toEqual([["again"]]);
  });

  it("catches an answer from an effect, a timer, a render or another handler, a press handed to something else, and a change started with an answer from elsewhere", () => {
    const sample = `
      function Shown({ of }) {
        const onUseThisCopy = () => { onUsed(); if (of.useThisCopy()) clearUpdate(); };
        useEffect(() => { of.useThisCopy(); }, [asking]);
        useEffect(() => { const timer = setTimeout(() => of?.useThisCopy(), 400); return () => clearTimeout(timer); }, []);
        of.useThisCopy();
        const told = { onFocus: () => of["useThisCopy"](), onPointerEnter() { (of as Follow).useThisCopy(); } };
        setTimeout(onUseThisCopy, 4_000);
        return <Word onTap={onUseThisCopy} onBlur={onUseThisCopy} {...told}>Use this copy</Word>;
      }
      class OwnFollows {
        change(who, action) { return asking ? this.#start(who, asking.action, "asking") : this.#start(who, action); }
        useCopy(who) { return this.#start(who, asking.action, { answer: asking.copy.id }); }
        retry(who) { return this.#start(who, "follow", { answer: this.#session.list.id }); }
        #read() { const through = { answer: copy.id }; this.#start(who, "follow", through); }
      }
      // of.useThisCopy() in a comment is no call, nor is "of.useThisCopy()" in words
      const words = "of.useThisCopy()";
      const named = { useThisCopy: "Use this copy" };
    `;

    const answers = asksOf("sample.tsx", sample, SAYS_USE, USE_PRESS);
    expect(answers.calls).toEqual([
      [USE_PRESS, "Shown"],
      ["useEffect()", "Shown"],
      ["setTimeout()", "useEffect()", "Shown"],
      ["Shown"],
      ["onFocus", "Shown"],
      ["onPointerEnter", "Shown"],
    ]);
    expect(answers.uses).toEqual(["in CallExpression", "onTap=", "onBlur="]);
    const withAnswer = whereIn("sample.tsx", sample, (node) => callsPath(STARTS)(node) && givesAnswer(node));
    expect(withAnswer).toEqual([[STORE_USES], ["retry"], ["read"]]);
  });
});

// ---------------------------------------------------------------------------------------------
// The one press that puts a whole list back.
// ---------------------------------------------------------------------------------------------

/*
 * `putBackList` (src/follow/change.ts) replaces a person's whole follow list with a copy that was
 * kept in the browser: the one write that takes a list away on purpose. So where it is called from
 * is held to one press, link by link, read as code: the writer's function is called once in src, by
 * the session's store of the copies (`OwnCopies.putBack`, src/follow/keptStore.ts); the store's is
 * called once, by the function its hook hands out (`usePutBack`, in that module); and that is called
 * once, in `onPutItBack` of the section that lists the copies, which is the click of Put it back and
 * nothing else's. No effect, no timer, no listener and
 * no other handler is on the way to it, and the writer's function is handed to nothing: it is
 * imported, and called. And the store that calls it looks at whether Follow is open itself: it asks
 * its host for the session in one place, which reads the switch and gives none while Follow is off,
 * and the method that calls the writer takes its session from there. A tripwire, as above: a call
 * hidden behind another name would pass.
 */

/** The section that lists a person's kept copies, the part of it that asks, and the function in that which a press of Put it back runs. */
const COPIES = "src/follow/KeptCopies.tsx";
const ASKING = "Asking";
const PUT_IT_BACK = "onPutItBack";
/** The writer's function, and the name the session's store and its hook hand it on by. */
const WRITES_WHOLE_LIST = "putBackList";
const HANDS_ON = "putBack";

describe("the one press that puts a whole list back", () => {
  const sources = (): Array<[string, string]> => sourcesUnder("src").map((file) => [file, read(file)]);

  it("is Put it back's, in all of src: the writer is called by the session's store alone, the store by its hook alone, and the hook's by the click of that one button", () => {
    const all = sources();
    expect(all.map(([file]) => file)).toEqual(expect.arrayContaining([ONLY_WRITER, COPIES_STORE, COPIES]));

    // The writer's function: called once, straight in the store's own method, and in no function inside it.
    expect(callersOf(all, WRITES_WHOLE_LIST)).toEqual([{ file: COPIES_STORE, calls: [[HANDS_ON]] }]);
    // And handed to nothing, anywhere: it is declared, imported and called, and no more.
    expect(all.flatMap(([file, source]) => handedOn(file, source, WRITES_WHOLE_LIST).map((where) => `${file} ${where}`))).toEqual([]);

    // The store's method: called once, by what the hook hands out. And that: called once, in the press.
    expect(callersOf(all, HANDS_ON)).toEqual([
      { file: COPIES, calls: [[PUT_IT_BACK, ASKING]] },
      { file: COPIES_STORE, calls: [["useCallback()", "usePutBack"]] },
    ]);
    // And the press is the button's click: it is handed to nothing else, nor called from anywhere.
    expect(asksOf(COPIES, read(COPIES), HANDS_ON, PUT_IT_BACK).uses).toEqual(["onClick="]);
  });

  it("is made by a store that looks at whether Follow is open itself: it asks its host for the session in one place, which reads the switch, and what calls the writer takes the session from there", () => {
    const store = read(COPIES_STORE);

    // The host is asked for the session once, in the store's own `#live`, and nowhere else in it.
    expect(whereIn(COPIES_STORE, store, callsPath("this.#host.live"))).toEqual([["live"]]);
    // That is where the store reads the switch: with Follow off it gives no session, whatever its host serves.
    expect(whereIn(COPIES_STORE, store, readsPath("config.features.follow"))).toEqual([["live"]]);
    // And the method that calls the writer takes its session from there, before it calls it.
    const takes = whereIn(COPIES_STORE, store, callsPath("this.#live"));
    expect(takes).toContainEqual([HANDS_ON]);
    expect(store.indexOf("this.#live()", store.indexOf(`  ${HANDS_ON}(`))).toBeLessThan(store.indexOf(`${WRITES_WHOLE_LIST}(`, store.indexOf(`  ${HANDS_ON}(`)));
    // The writer is still called from that one method, and from nothing else in src (the test above).
    expect(callersOf(sources(), WRITES_WHOLE_LIST)).toEqual([{ file: COPIES_STORE, calls: [[HANDS_ON]] }]);
  });

  it("catches a store that asks its host elsewhere, reads the switch elsewhere, or calls the writer with a session it did not take from there", () => {
    const sample = `
      class OwnCopies {
        #live() { return config.features.follow ? this.#host.live() : null; }
        of(pubkey) { const session = this.#host.live(); return config.features.follow ? session : null; }
        putBack(pubkey, copy) { const session = this.#host.live(); putBackList(session.account, copy.list, deps, session.signal); }
        written() { const session = this.#live(); }
      }
      // this.#host.live() in a comment is no call
      const other = { live: () => host.live(), follow: features.follow };
    `;

    expect(whereIn("sample.ts", sample, callsPath("this.#host.live"))).toEqual([["live"], ["of"], ["putBack"]]);
    expect(whereIn("sample.ts", sample, readsPath("config.features.follow"))).toEqual([["live"], ["of"]]);
    expect(whereIn("sample.ts", sample, callsPath("this.#live"))).toEqual([["written"]]);
  });

  it("catches a call from an effect, a timer, a render or another handler, a press handed to something else, and the writer handed on", () => {
    const sample = `
      import { putBackList } from "./change.ts";
      class OwnFollows {
        putBack(pubkey, copy) { putBackList(account, copy.list, deps, signal).then(over, over); }
        #retry = () => { putBackList(account, copy.list, deps, signal); };
        async #read() { await putBackList(account, newest, deps, signal); }
      }
      function Asking({ of, kept }) {
        const onPutItBack = (event) => { if (event.detail > 1) return; of.putBack(kept); };
        useEffect(() => { of.putBack(kept); }, []);
        useEffect(() => { const timer = setTimeout(() => of?.putBack(kept), 400); return () => clearTimeout(timer); }, []);
        of.putBack(kept);
        const onKeyDown = (event) => { if (event.key === "Enter") of["putBack"](kept); };
        setTimeout(onPutItBack, 4_000);
        const again = [putBackList, { write: putBackList }];
        return <div onKeyDown={onPutItBack}><button onClick={onPutItBack} onPointerEnter={onPutItBack} /></div>;
      }
      // putBackList(account, copy) in a comment is no call, nor is "of.putBack(kept)" in words
      const words = "of.putBack(kept)";
      const named = { putBack: "Put back" };
    `;

    // A class's method is known by its name, a private one's without its mark.
    expect(asksOf("sample.tsx", sample, WRITES_WHOLE_LIST, PUT_IT_BACK).calls).toEqual([["putBack"], ["retry"], ["read"]]);
    expect(handedOn("sample.tsx", sample, WRITES_WHOLE_LIST)).toEqual(["in ArrayExpression", "in Property"]);
    const asking = asksOf("sample.tsx", sample, HANDS_ON, PUT_IT_BACK);
    expect(asking.calls).toEqual([["onPutItBack", "Asking"], ["useEffect()", "Asking"], ["setTimeout()", "useEffect()", "Asking"], ["Asking"], ["onKeyDown", "Asking"]]);
    expect(asking.uses).toEqual(["in CallExpression", "onKeyDown=", "onClick=", "onPointerEnter="]);
  });
});
