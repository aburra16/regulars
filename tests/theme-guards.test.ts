// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

/*
 * Guards that keep both themes whole as the app grows: they read the code in src as code (its string
 * literals, and which element each class list is on), so comments and words on screen are not read
 * as classes. Each guard is shown catching what it is for, and letting through what it allows.
 */

const root = process.cwd();

/** Every .ts and .tsx file under a folder, as paths relative to the project. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesUnder(`${dir}/${entry.name}`)
      : /\.tsx?$/.test(entry.name)
        ? [`${dir}/${entry.name}`]
        : [],
  );
}

type Node = { type: string; start: number; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** A class list as the code has it: one string literal, or the text of one template literal. */
interface ClassList {
  file: string;
  /** Where it is in the file, for the message. */
  at: number;
  classes: string[];
}

/** A class list on an element: every string of its className, with the element's ancestors in the same component. */
interface ElementClasses extends ClassList {
  /** Whether the element, or an element around it in the same component, keeps the light theme's colours. */
  keptLight: boolean;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

/** Whether a JSX element sets `data-theme="light"`. */
function setsLight(element: Node): boolean {
  const opening = element.openingElement as Node | undefined;
  return ((opening?.attributes as Node[] | undefined) ?? []).some(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      (attribute.name as Node & { name?: string }).name === "data-theme" &&
      (attribute.value as Node & { value?: unknown } | null)?.value === "light",
  );
}

/** The class lists of a file: every string in it, and every element's className. */
function classListsOf(file: string, source: string): { lists: ClassList[]; elements: ElementClasses[]; outside: ClassList[] } {
  const { program, errors } = parseSync(file, source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  if (errors.length > 0) throw new Error(`${file} did not parse: ${errors.map((error) => error.message).join("; ")}`);
  const lists: ClassList[] = [];
  const elements: ElementClasses[] = [];
  const outside: ClassList[] = [];

  /** The strings under a node, each a class list of its own. */
  const stringsUnder = (node: Node): ClassList[] => {
    const found: ClassList[] = [];
    const visit = (each: unknown) => {
      if (Array.isArray(each)) return each.forEach(visit);
      if (!isNode(each)) return;
      if (each.type === "Literal" && typeof each.value === "string") {
        found.push({ file, at: each.start, classes: words(each.value) });
        return;
      }
      if (each.type === "TemplateLiteral") {
        const quasis = (each.quasis as Array<{ value: { cooked: string | null; raw: string } }>).map((quasi) => quasi.value.cooked ?? quasi.value.raw);
        found.push({ file, at: each.start, classes: words(quasis.join(" ")) });
      }
      for (const [key, child] of Object.entries(each)) if (key !== "type") visit(child);
    };
    visit(node);
    return found;
  };

  const walk = (node: unknown, ancestors: Node[]) => {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, ancestors));
    if (!isNode(node)) return;
    // An import's path is no class list.
    if (node.type === "ImportDeclaration") return;
    if (node.type === "JSXAttribute" && (node.name as Node & { name?: string }).name === "className" && isNode(node.value)) {
      const strings = stringsUnder(node.value);
      lists.push(...strings);
      // The element, and the elements around it up to the component it is drawn in. A function passed
      // to a call (a list's \`.map\`) is part of the component that calls it; any other is a component of its own.
      const around: Node[] = [];
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i]!;
        if (FUNCTION.test(ancestor.type) && ancestors[i - 1]?.type !== "CallExpression") break;
        if (ancestor.type === "JSXElement") around.push(ancestor);
      }
      elements.push({
        file,
        at: node.start,
        classes: strings.flatMap((list) => list.classes),
        keptLight: around.some(setsLight),
      });
      return;
    }
    if (node.type === "Literal" || node.type === "TemplateLiteral") {
      const strings = stringsUnder(node);
      lists.push(...strings);
      outside.push(...strings);
      return;
    }
    const next = [...ancestors, node];
    for (const [key, child] of Object.entries(node)) if (key !== "type") walk(child, next);
  };
  walk(program, []);
  return { lists, elements, outside };
}

const SOURCES = sourcesUnder("src");
const parsed = SOURCES.map((file) => classListsOf(file, readFileSync(resolve(root, file), "utf8")));
const all = {
  lists: parsed.flatMap((each) => each.lists),
  elements: parsed.flatMap((each) => each.elements),
  outside: parsed.flatMap((each) => each.outside),
};

/** A class split into its variants and the utility itself: `wide:hover:bg-ink/5` is [wide, hover] and `bg-ink/5`. */
function split(name: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) {
      parts.push(name.slice(from, i));
      from = i + 1;
    }
  }
  return { variants: parts, base: name.slice(from) };
}

/** A variant that applies only while the person points at, presses or focuses something: a wash, not a fill. */
const passing = (variants: string[]) => variants.some((variant) => /(?:^|-)(?:hover|focus|focus-visible|focus-within|active)$/.test(variant));

const where = (list: ClassList, what: string) => `${list.file}@${list.at}: ${what}`;

// ---- The guards, each a function of class lists, so each can be shown at work ----

/** Tailwind's own palette, by name: the app's colours are its tokens. */
const PALETTE = /^-?(?:bg|text|border(?:-[trblxyse])?|outline|ring(?:-offset)?|fill|stroke|decoration|divide|from|via|to|shadow|inset-shadow|inset-ring|drop-shadow|caret|accent|placeholder)-(?:white|black|(?:slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\S+)?$/;
/** A colour written into a class: `bg-[#fff]`, `text-[rgb(0,0,0)]`, `shadow-[0_0_4px_rgba(…)]`, `[color:#123]`. */
const COLOUR_VALUE = /#[0-9a-f]{3,8}(?![\w-])|(?<![a-z-])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\(/i;

function paletteOffences(lists: ClassList[]): string[] {
  return lists.flatMap((list) =>
    list.classes.flatMap((name) => {
      const { base } = split(name);
      if (PALETTE.test(base)) return [where(list, name)];
      const arbitrary = /^-?[a-z-]*-?\[(.*)\](?:\/\S+)?$/.exec(base) ?? /^\[(.*)\]$/.exec(base);
      if (arbitrary !== null && COLOUR_VALUE.test(arbitrary[1]!)) return [where(list, name)];
      return [];
    }),
  );
}

/**
 * A scrim: a fixed element over the whole page with a see-through ground, or a dialog's backdrop. It is
 * the shade's, never another colour's: DeskReview.dc.html draws the review dialog's in ink-soft, which
 * would be a light wash in the dark.
 */
function scrimOffences(lists: ClassList[]): string[] {
  return lists.flatMap((list) => {
    const fixedLayer = list.classes.includes("fixed") && list.classes.includes("inset-0");
    return list.classes.flatMap((name) => {
      const { variants, base } = split(name);
      if (variants.includes("backdrop")) {
        const ground = /^bg-([\w-]+?)(?:\/(?:\d+|\[[^\]]+\]))?$/.exec(base);
        return ground !== null && ground[1] !== "shade" && ground[1] !== "transparent" ? [where(list, name)] : [];
      }
      if (!fixedLayer) return [];
      const wash = /^bg-([\w-]+)\/(?:\d+|\[[^\]]+\])$/.exec(base);
      return wash !== null && wash[1] !== "shade" && !passing(variants) ? [where(list, name)] : [];
    });
  });
}

/** The lighter accent behind words in white or the ground's colour: those go on the solid accent. */
function accentOffences(lists: ClassList[]): string[] {
  return lists.flatMap((list) => {
    const words = list.classes.map(split);
    const lightWords = words.some(({ base }) => base === "text-on-accent" || base === "text-ground");
    if (!lightWords) return [];
    return words.flatMap(({ variants, base }, i) =>
      base === "bg-accent" && !passing(variants) ? [where(list, list.classes[i]!)] : [],
    );
  });
}

/**
 * The night colours, and a fill in the ink or the soft ink, which turn light in the dark theme, go only
 * where the light theme's colours are kept. A fill that marks a choice is the emphasis; a scrim, the shade.
 */
const LIGHT_ONLY = /^(?:bg-night|text-on-night-soft|text-wordmark-on-night|bg-ink|bg-ink-soft)$/;

function lightOnlyOffences(elements: ElementClasses[], outside: ClassList[]): string[] {
  const offending = (list: ClassList) => list.classes.filter((name) => {
    const { variants, base } = split(name);
    return LIGHT_ONLY.test(base) && !passing(variants);
  });
  return [
    ...elements.filter((element) => !element.keptLight).flatMap((element) => offending(element).map((name) => where(element, name))),
    // Written anywhere but an element's className, it cannot be seen to be kept light.
    ...outside.flatMap((list) => offending(list).map((name) => where(list, `${name} (outside a className)`))),
  ];
}

/** The guards run over a piece of code, as over src. */
function sample(code: string) {
  const { lists, elements, outside } = classListsOf("sample.tsx", code);
  return {
    palette: paletteOffences(lists).map((offence) => offence.replace(/^.*: /, "")),
    scrim: scrimOffences([...elements, ...outside]).map((offence) => offence.replace(/^.*: /, "")),
    accent: accentOffences([...elements, ...outside]).map((offence) => offence.replace(/^.*: /, "")),
    lightOnly: lightOnlyOffences(elements, outside).map((offence) => offence.replace(/^.*: /, "")),
  };
}

describe("colours in src", () => {
  it("reads every source file in src", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(all.elements.length).toBeGreaterThan(200);
  });

  it("are tokens only: no colour from Tailwind's own palette, and none written into a class", () => {
    expect(paletteOffences(all.lists)).toEqual([]);
  });

  it("catches a palette colour or a written colour, and lets the tokens and other written values through", () => {
    const { palette } = sample(`
      const a = <div className="bg-white text-gray-500 hover:bg-black/50 border-x-slate-200 shadow-[0_0_4px_rgba(0,0,0,.2)]" />;
      const b = <p className={\`bg-[#fff] text-[rgb(0,0,0)] \${x ? "[color:#123]" : "fill-red-600"}\`} />;
      const ok = <i className="bg-ground text-ink bg-transparent text-[17px] rounded-[16px] w-[calc(100%-2px)] has-[input:focus-visible]:outline-ink bg-accent/10 text-current" />;
      // bg-white in a comment is no class
    `);
    expect(palette).toEqual([
      "bg-white",
      "text-gray-500",
      "hover:bg-black/50",
      "border-x-slate-200",
      "shadow-[0_0_4px_rgba(0,0,0,.2)]",
      "bg-[#fff]",
      "text-[rgb(0,0,0)]",
      "[color:#123]",
      "fill-red-600",
    ]);
  });
});

describe("a scrim", () => {
  it("is in the shade wherever a fixed layer dims the whole page", () => {
    expect(scrimOffences([...all.elements, ...all.outside])).toEqual([]);
  });

  it("catches another colour behind a fixed layer over the whole page, and lets washes and other layers be", () => {
    const { scrim } = sample(`
      const a = <div className="fixed inset-0 bg-ink/60" />;
      const b = <div className={\`fixed inset-0 z-50 \${wide ? "wide:bg-black/40" : ""}\`} />;
      const ok1 = <div className="fixed inset-0 wide:bg-shade/60" />;
      const ok2 = <div className="fixed inset-0 bg-ground hover:bg-ink/5" />;
      const ok3 = <button className="rounded-full hover:bg-ink/5 bg-surface/50" />;
    `);
    expect(scrim).toEqual(["bg-ink/60", "wide:bg-black/40"]);
  });

  it("catches a dialog's backdrop in any colour but the shade, as a scrim (DeskReview.dc.html draws it in ink-soft)", () => {
    const { scrim } = sample(`
      const a = <dialog className="rounded-dialog bg-ground backdrop:bg-ink-soft/60" />;
      const b = <dialog className="wide:backdrop:bg-ink" />;
      const ok1 = <dialog className="backdrop:bg-shade/60" />;
      const ok2 = <dialog className="backdrop:bg-shade" />;
    `);
    expect(scrim).toEqual(["backdrop:bg-ink-soft/60", "wide:backdrop:bg-ink"]);
  });
});

describe("the lighter accent", () => {
  it("is behind no words in white or the ground's colour anywhere in src", () => {
    expect(accentOffences([...all.elements, ...all.outside])).toEqual([]);
  });

  it("catches it behind such words on the same element, and lets tints, a hover and other words be", () => {
    const { accent } = sample(`
      const a = <button className="bg-accent text-on-accent" />;
      const b = <span className={\`px-2 bg-accent \${x} text-ground\`} />;
      const c = "rounded-button bg-accent font-bold text-on-accent";
      const ok1 = <button className="bg-accent-solid text-on-accent" />;
      const ok2 = <span className="bg-accent/10 text-ground" />;
      const ok3 = <a className="hover:bg-accent text-ground" />;
      const ok4 = <b className="bg-accent text-ink" />;
      // bg-accent text-on-accent in a comment
    `);
    expect(accent).toEqual(["bg-accent", "bg-accent", "bg-accent"]);
  });
});

describe("the night colours and the ink fills", () => {
  it("are only where the light theme's colours are kept: the sign-in page and About's dark card", () => {
    expect(lightOnlyOffences(all.elements, all.outside)).toEqual([]);
    const kept = all.elements.filter((element) => element.keptLight && element.classes.some((name) => LIGHT_ONLY.test(split(name).base)));
    expect([...new Set(kept.map((element) => element.file))].sort()).toEqual(["src/about/AboutPage.tsx", "src/signin/SignInPage.tsx"]);
  });

  it("catches them on an element with no light theme around it in its component, or in a string of their own", () => {
    const { lightOnly } = sample(`
      function Kept() {
        return <div data-theme="light" className="bg-night"><p className="text-on-night-soft">x</p><b className={\`bg-ink \${y}\`} /></div>;
      }
      function Bare() {
        return <section><p className="text-wordmark-on-night" /><i className="wide:bg-ink hover:bg-ink/5" /><b className="bg-ink-soft text-ink-soft" /></section>;
      }
      function Inner() {
        // A component of its own: the light theme of whatever draws it is not seen here.
        return <span className="bg-night" />;
      }
      const tone = "bg-ink text-ground";
    `);
    expect(lightOnly).toEqual(["text-wordmark-on-night", "wide:bg-ink", "bg-ink-soft", "bg-night", "bg-ink (outside a className)"]);
  });
});
