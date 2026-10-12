// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

/*
 * The guard on the follow list's one writer (ruling R2). A follow list (kind 3) is one record that
 * saving replaces everywhere, so only `changeFollow` (src/follow/change.ts) may build, sign or send
 * one: it is the code that takes the lock, reads the list afresh and checks what was signed. This
 * reads the code in src as code (its imports, its names, its object literals and its calls), so a
 * comment, a word on screen or a permission's name (`sign_event:3`) is never taken for a breach,
 * and holds every other module to three rules:
 *
 *   1. Built in one place. An object literal whose `kind` is 3 or `FOLLOW_KIND`, which is an event
 *      or a template of a follow list, is written only in src/follow/list.ts, the list's rules. Nor
 *      does a module that knows follow lists make an event out of one it was given: an object with
 *      `tags` whose `kind` is another's (`kind: list.kind`), or one spread out and given other
 *      `tags` or another `created_at` (`{ ...list, tags }`).
 *   2. Its builders used in one place. `withFollow`, `withoutFollow` and `withRestored`, which make
 *      the list that is signed, are named only there and in src/follow/change.ts.
 *   3. What knows follow lists neither signs nor sends. A module knows them when it names
 *      `FOLLOW_KIND`, asks relays for kind 3 (`kinds: [3]`), builds one, or imports the list's
 *      rules, its reading, its one writer or the session's provider of it (src/follow/list.ts,
 *      read.ts, change.ts, FollowProvider.tsx), and the provider does by being it. Such a module
 *      does not call a signer's `signEvent` or a writer's `publish`, and does not import the code
 *      the app signs and sends with (src/nostr/send.ts, src/review/post.ts). So a list that was
 *      read cannot be sent again from elsewhere, and what calls `changeFollow` sends nothing itself.
 *
 * And the one writer hands out one function that signs and sends: its exports are pinned here, so a
 * second way to write a list is a change to this test.
 *
 * It is a tripwire, not a proof: code that hid a kind 3 behind another name, copied a list field by
 * field under other names, or reached a signer through a module not listed here, would pass. Each
 * rule is shown catching what it is for, and letting through what it allows. A module that must
 * break one is a second writer of follow lists, and belongs in `changeFollow` instead.
 */

const root = process.cwd();

/** The one module that may build, sign and send a follow list. */
const ONLY_WRITER = "src/follow/change.ts";
/** The list's rules, pure: where a follow list's template is built. */
const LIST_RULES = "src/follow/list.ts";
/** The session's own list, for the buttons (Task 4). Named before it exists: it will hold the person's signer and their list side by side. */
const PROVIDER = "src/follow/FollowProvider.tsx";
/** The modules that make a module one that knows follow lists: by importing one of them, or by being one. */
const FOLLOW_LIST_CODE = [LIST_RULES, "src/follow/read.ts", ONLY_WRITER, PROVIDER];
/** The modules the app signs an event with, or sends one to a relay with. */
const SIGNING_AND_SENDING = ["src/nostr/send.ts", "src/review/post.ts"];
/** The names of what builds the list to sign. */
const BUILDERS = ["withFollow", "withoutFollow", "withRestored"];
/** The methods that sign an event (a signer's) and send one (a relay writer's). */
const SIGN_OR_SEND_CALLS = ["signEvent", "publish"];

/** Every .ts and .tsx file under a folder, as paths relative to the project. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourcesUnder(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
  );
}

type Node = { type: string; start: number; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** `node` without what TypeScript and brackets wrap an expression in: `(3)`, `3 as number`, `x!`, `a?.b`. */
function bare(node: unknown): Node | undefined {
  let each = node;
  while (
    isNode(each) &&
    /^(?:ParenthesizedExpression|TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|ChainExpression)$/.test(each.type)
  ) {
    each = each.expression;
  }
  return isNode(each) ? each : undefined;
}

/** The name a property or a member is reached by: `kind` in `{ kind }`, `{ "kind": … }`, `x.kind` and `x["kind"]`. */
function nameOf(key: unknown): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/** Whether an expression is the follow list's kind, as the code writes it: 3, or `FOLLOW_KIND`. */
function isFollowKind(node: unknown): boolean {
  const value = bare(node);
  return value !== undefined && ((value.type === "Literal" && value.value === 3) || (value.type === "Identifier" && value.name === "FOLLOW_KIND"));
}

/** The project path of what `file` imports as `specifier`, when that is a file of the project's own. */
function imported(file: string, specifier: string): string | undefined {
  return specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), specifier)) : undefined;
}

/** Whether `path` is the module `module`, however the import wrote its ending. */
const isModule = (path: string | undefined, module: string) => path !== undefined && path.replace(/\.tsx?$/, "") === module.replace(/\.tsx?$/, "");

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
  const { program, errors } = parseSync(file, source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  if (errors.length > 0) throw new Error(`${file} did not parse: ${errors.map((error) => error.message).join("; ")}`);
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

/** The names a module exports, of values and of types alike, in order of name; `* from <module>` for all of another's. */
function exportsOf(file: string, source: string): string[] {
  const { program, errors } = parseSync(file, source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  if (errors.length > 0) throw new Error(`${file} did not parse: ${errors.map((error) => error.message).join("; ")}`);
  const names: string[] = [];
  for (const node of program.body as unknown as Node[]) {
    if (node.type === "ExportDefaultDeclaration") names.push("default");
    if (node.type === "ExportAllDeclaration") names.push(nameOf(node.exported) ?? `* from ${String((node.source as Node).value)}`);
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of (node.specifiers as Node[] | undefined) ?? []) names.push(nameOf(specifier.exported) ?? "?");
    const declared = node.declaration as Node | null;
    if (declared === null) continue;
    // A `const` may declare several; anything else that is exported has one name.
    const ids = declared.type === "VariableDeclaration" ? (declared.declarations as Node[]).map((each) => each.id) : [declared.id];
    for (const id of ids) names.push(nameOf(id) ?? "?");
  }
  return names.sort();
}

const read = (file: string) => readFileSync(resolve(root, file), "utf8");

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
  it("is one way to change a list, one to say what list is on screen and one to forget what was seen, with their times and their shapes: nothing else that could sign or send", () => {
    expect(exportsOf(ONLY_WRITER, read(ONLY_WRITER))).toEqual([
      "FOLLOW_LOCK",
      "FOLLOW_LOCK_WAIT_MS",
      "FOLLOW_SETTLE_MS",
      "FollowDeps",
      "FollowOutcome",
      "changeFollow",
      "forgetFollowFloor",
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

function asksOf(file: string, source: string): Asks {
  const { program, errors } = parseSync(file, source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  if (errors.length > 0) throw new Error(`${file} did not parse: ${errors.map((error) => error.message).join("; ")}`);
  const asks: Asks = { calls: [], uses: [] };

  const walk = (node: unknown, around: Node[]) => {
    if (Array.isArray(node)) return node.forEach((each) => walk(each, around));
    if (!isNode(node)) return;
    const parent = around[around.length - 1];

    if (node.type === "CallExpression") {
      const callee = bare(node.callee);
      if (callee?.type === "MemberExpression" && nameOf(callee.property) === "unfollow") {
        const within: string[] = [];
        for (let i = around.length - 1; i >= 0; i--) {
          if (FUNCTIONS.test(around[i]!.type)) within.push(functionName(around[i]!, around[i - 1]));
        }
        asks.calls.push(within);
      }
    }
    if (node.type === "Identifier" && node.name === PRESS && !(parent?.type === "VariableDeclarator" && parent.id === node)) {
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
