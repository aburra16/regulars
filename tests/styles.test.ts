import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";

import { WIDE_QUERY } from "../src/shell/useWide";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const indexCss = read("src/styles/index.css");
const tokensCss = read("handoff/design/tokens.css");

/** Every `--name: value` declaration in tokens.css. */
const tokens = [...tokensCss.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)].map(([, name, value]) => ({
  name: name as string,
  value: (value as string).trim(),
}));

// Layout and size tokens with no naming pattern of their own.
const LAYOUT_UTILITIES: Record<string, Array<[className: string, property: string]>> = {
  touch: [
    ["min-h-touch", "min-height"],
    ["min-w-touch", "min-width"],
  ],
  "gutter-phone": [["px-gutter-phone", "padding-inline"]],
  "gutter-desktop": [["px-gutter-desktop", "padding-inline"]],
  "content-max": [["max-w-content", "max-width"]],
  "list-width": [["w-list", "width"]],
  "rail-width": [["w-rail", "width"]],
  measure: [["max-w-measure", "max-width"]],
  border: [["border-token", "border-width"]],
};

/** The utility that reads this token, and the property it sets. */
function utilitiesFor(name: string, value: string): Array<[className: string, property: string]> {
  if (value.startsWith("#")) return [[`bg-${name}`, "background-color"]];
  const layout = LAYOUT_UTILITIES[name];
  if (layout) return layout;
  const [, group, rest] = name.match(/^(size|font|tracking|radius|shadow)-(.+)$/) ?? [];
  switch (group) {
    case "size":
      return [[`text-${rest}`, "font-size"]];
    case "font":
      return [[`font-${rest}`, "font-family"]];
    case "tracking":
      return [[`tracking-${rest}`, "letter-spacing"]];
    case "radius":
      return [[`rounded-${rest}`, "border-radius"]];
    case "shadow":
      return [[`shadow-${rest}`, "box-shadow"]];
    default:
      return [];
  }
}

/** Compiles src/styles/index.css with Tailwind itself, so a utility that does not generate fails here. */
async function compileUtilities(classNames: string[]): Promise<string> {
  const compiler = await compile(indexCss, {
    base: root,
    async loadStylesheet(id, base) {
      const path = id === "tailwindcss" ? resolve(root, "node_modules/tailwindcss/index.css") : resolve(base, id);
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
  return compiler.build(classNames);
}

function declarationsOf(css: string, className: string): string[] {
  const escaped = className.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  const rule = new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return (rule?.[1] ?? "")
    .split(";")
    .map((declaration) => declaration.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("styles", () => {
  it("carries handoff/design/tokens.css verbatim", () => {
    expect(indexCss).toContain(tokensCss.trim());
  });

  it("puts Noto Sans JP before the generic fallbacks so Japanese place names use it", () => {
    expect(indexCss).toMatch(/--font-display:\s*'Bricolage Grotesque', 'Noto Sans', 'Noto Sans JP', sans-serif;/);
    expect(indexCss).toMatch(/--font-text:\s*'Figtree', 'Noto Sans', 'Noto Sans JP', system-ui, sans-serif;/);
  });

  it("sets the body font, colour and background from the tokens", () => {
    expect(indexCss).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-text\)/);
    expect(indexCss).toMatch(/body\s*\{[^}]*color:\s*var\(--ink\)/);
    expect(indexCss).toMatch(/body\s*\{[^}]*background:\s*var\(--ground\)/);
  });
});

describe("focus and scrolling", () => {
  /** What the stylesheet puts in `@layer base`. */
  const baseLayer = /@layer base\s*\{([\s\S]*)\}\s*$/.exec(indexCss)?.[1] ?? "";

  it("draws one keyboard focus ring for the whole app: 2 px, in the ink colour, 2 px out", () => {
    expect(baseLayer).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ink\);[^}]*outline-offset:\s*2px;/,
    );
  });

  it("leaves no component to draw a focus ring of its own, but the field that holds an input", () => {
    const files = filesUnder("src").filter((file) => /\.tsx$/.test(file));
    const own = files.flatMap((file) =>
      [...read(file).matchAll(/(?<![\w-])(?:focus|focus-visible|focus-within):outline[\w-]*/g)].map(
        (match) => `${file}: ${match[0]}`,
      ),
    );
    expect(own).toEqual([]);
  });

  it("keeps a target the sticky tab bar covers in view: the page scrolls past the bar's height", () => {
    expect(indexCss).toMatch(/--tab-bar-height:\s*73\.5px;/);
    expect(baseLayer).toMatch(/html\s*\{\s*scroll-padding-bottom:\s*var\(--tab-bar-height\);/);
    // No tab bar on a desktop, so no room to keep clear.
    expect(baseLayer).toMatch(/@variant wide\s*\{\s*scroll-padding-bottom:\s*0;/);
  });

  it("clears that room on a desktop with the one breakpoint, not a second one", async () => {
    const css = await compileUtilities([]);
    expect(css).toMatch(/html\s*\{\s*scroll-padding-bottom:\s*var\(--tab-bar-height\);\s*@media \(width >= 900px\)\s*\{\s*scroll-padding-bottom:\s*0;/);
  });

  it("compiles the pressed chip's padding: a rem and the edge it has no more of", async () => {
    const css = await compileUtilities(["px-[calc(1rem+var(--border))]"]);
    // (`declarationsOf` cannot read a class with brackets in its name, so this reads the rule's text.)
    expect(css).toMatch(/\.px-\\\[calc\\\(1rem\\\+var\\\(--border\\\)\\\)\\\]\s*\{\s*padding-inline:\s*calc\(1rem \+ var\(--border\)\);/);
  });

  it("has the desktop's panel corners and padding as tokens (DeskPlace.dc.html: 24 px and 22 px)", async () => {
    expect(indexCss).toMatch(/--radius-panel-desktop:\s*24px;/);
    expect(indexCss).toMatch(/--space-panel-desktop:\s*22px;/);
    const css = await compileUtilities(["rounded-panel-desktop", "p-panel-desktop"]);
    expect(declarationsOf(css, "rounded-panel-desktop")).toEqual(["border-radius: var(--radius-panel-desktop)"]);
    expect(declarationsOf(css, "p-panel-desktop")).toEqual(["padding: var(--space-panel-desktop)"]);
  });

  it("gives the tab bar the height the page scrolls past", () => {
    // At least that tall: a bar that grows with a larger text size still clears the page's padding.
    expect(read("src/shell/TabBar.tsx")).toMatch(/(?<![\w-])min-h-\(--tab-bar-height\)/);
  });
});

describe("Tailwind utilities for the tokens", () => {
  const expected = tokens.flatMap(({ name, value }) =>
    utilitiesFor(name, value).map(([className, property]) => ({ token: name, className, property })),
  );
  let css = "";

  beforeAll(async () => {
    css = await compileUtilities(expected.map(({ className }) => className));
  });

  it("reads every token in tokens.css", () => {
    expect(tokens.length).toBeGreaterThanOrEqual(50);
    expect(tokens.map(({ name }) => name)).toEqual(expect.arrayContaining(["touch", "gutter-phone", "border", "ink"]));
  });

  it("has a utility for every token", () => {
    const unmapped = tokens.filter(({ name, value }) => utilitiesFor(name, value).length === 0);
    expect(unmapped).toEqual([]);
  });

  it("names the layout and size utilities the screens use", () => {
    const names = expected.map(({ className }) => className);
    expect(names).toEqual(
      expect.arrayContaining([
        "min-h-touch",
        "min-w-touch",
        "px-gutter-phone",
        "px-gutter-desktop",
        "max-w-content",
        "w-list",
        "w-rail",
        "max-w-measure",
        "border-token",
      ]),
    );
  });

  it.each(tokens.flatMap(({ name, value }) => utilitiesFor(name, value).map(([c, p]) => ({ token: name, c, p }))))(
    "$c sets $p from --$token",
    ({ token, c, p }) => {
      expect(declarationsOf(css, c)).toContain(`${p}: var(--${token})`);
    },
  );

  it("declares no variable that refers to itself", () => {
    expect(css).not.toMatch(/--([a-z0-9-]+):\s*var\(--\1\)/);
  });
});

/** Every file under a folder, as paths relative to the project. */
function filesUnder(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}

describe("one breakpoint", () => {
  // Tailwind's own breakpoints, alone or as max-*: prefixes.
  const OTHER_BREAKPOINT = /(?<![\w-])(?:max-)?(?:sm|md|lg|xl|2xl):/g;

  it("defines `wide` at the width useWide asks for, and nothing else", async () => {
    const px = /min-width:\s*(\d+)px/.exec(WIDE_QUERY)?.[1];
    expect(px).toBe("900");
    expect(indexCss).toMatch(new RegExp(`--breakpoint-wide:\\s*${px}px;`));

    const css = await compileUtilities(["wide:flex", "md:flex", "sm:flex", "lg:flex", "xl:flex"]);
    expect(css).toMatch(/@media \(width >= 900px\)\s*\{\s*\.wide\\:flex/);
    expect(css).not.toMatch(/\.(?:md|sm|lg|xl)\\:flex/);
  });

  it("is the only one used anywhere in src", () => {
    const files = filesUnder("src").filter((file) => /\.(?:tsx?|css)$/.test(file));
    expect(files.length).toBeGreaterThan(20);
    const offences = files.flatMap((file) =>
      [...read(file).matchAll(OTHER_BREAKPOINT)].map((match) => `${file}: ${match[0]}`),
    );
    expect(offences).toEqual([]);
  });

  it("catches the other breakpoints in a class list", () => {
    const sample = "flex md:hidden max-sm:p-2 lg:grid 2xl:gap-4 wide:block https://x.test a:b";
    expect(sample.match(OTHER_BREAKPOINT)).toEqual(["md:", "max-sm:", "lg:", "2xl:"]);
  });
});
