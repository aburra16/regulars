import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";

import { CHECK_MS } from "../src/circle/CircleNews";
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

/** Where each `@layer name { ... }` block of a stylesheet starts and ends. */
const layerBlocks = (css: string) =>
  [...css.matchAll(/@layer [\w-]+\s*\{/g)].map((match) => {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return [match.index, i] as const;
    }
    return [match.index, css.length] as const;
  });

/** Whether the text at `at` is inside one of the stylesheet's layers: a rule in none wins over every rule in one. */
const inLayer = (css: string, at: number) => layerBlocks(css).some(([start, end]) => at > start && at < end);

describe("styles", () => {
  it("carries handoff/design/tokens.css verbatim", () => {
    expect(indexCss).toContain(tokensCss.trim());
  });

  it("puts a Noto Sans for each script of the places' names before the generic fallbacks, so those names use it", () => {
    const scripts = "'Noto Sans', 'Noto Sans JP', 'Noto Sans KR', 'Noto Sans Thai', 'Noto Sans Lao', 'Noto Sans Arabic'";
    expect(indexCss).toContain(`--font-display: 'Bricolage Grotesque Variable', 'Bricolage Grotesque', ${scripts}, sans-serif;`);
    expect(indexCss).toContain(`--font-text: 'Figtree', ${scripts}, system-ui, sans-serif;`);
  });

  it("loads each script's face at 400 and 700 only, by unicode-range, so a page downloads it only for a name that needs it", () => {
    const main = read("src/main.tsx");
    for (const family of ["noto-sans-jp", "noto-sans-kr", "noto-sans-thai", "noto-sans-lao", "noto-sans-arabic"]) {
      const imported = [...main.matchAll(new RegExp(`import "@fontsource/${family}/([^"]+)";`, "g"))].map(([, file]) => file);
      expect(imported, family).toEqual(["400.css", "700.css"]);
      for (const file of imported) {
        const faces = read(`node_modules/@fontsource/${family}/${file}`).split("@font-face").slice(1);
        expect(faces.length).toBeGreaterThan(0);
        for (const face of faces) expect(face).toMatch(/unicode-range:/);
      }
    }
  });

  it("draws the display face from its variable font, with the optical-size axis the screens use", () => {
    // The screens load Bricolage Grotesque with `opsz 12..96`: at 26 px and up its letters are
    // narrower than the static files', and headlines wrap as the design does.
    const main = read("src/main.tsx");
    expect(main).toContain('import "@fontsource-variable/bricolage-grotesque/opsz.css";');
    expect(main).not.toMatch(/@fontsource\/bricolage-grotesque/);
    const faces = read("node_modules/@fontsource-variable/bricolage-grotesque/opsz.css");
    expect(faces).toMatch(/font-family: 'Bricolage Grotesque Variable';/);
    // The weights the app uses, 700 and 800, are inside the face's range.
    expect(faces).toMatch(/font-weight: 200 800;/);
    expect(indexCss).toMatch(/body\s*\{[^}]*font-optical-sizing:\s*auto/);
  });

  it("leaves text with no line height of its own at the browser's normal, as the screens do, not Tailwind's 1.5", async () => {
    // The screens set a line height only where they mean one; everywhere else the browser's
    // `normal` (about 1.2 in Figtree) applies. Tailwind's preflight puts 1.5 on the root.
    const css = await compileUtilities(["text-body", "text-secondary"]);
    const rootRules = [...css.matchAll(/(?:^|[\s}])html(?:,\s*:host)?\s*\{([^}]*)\}/g)].map(([, body]) => body ?? "");
    const lineHeights = rootRules.flatMap((body) => /line-height:\s*([^;]+);/.exec(body)?.[1] ?? []);
    expect(lineHeights.at(-1)).toBe("normal");
    // A size utility sets the size alone, so it keeps the line height it is given.
    expect(declarationsOf(css, "text-body")).toEqual(["font-size: var(--size-body)"]);
    expect(declarationsOf(css, "text-secondary")).toEqual(["font-size: var(--size-secondary)"]);
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

  it("draws it white on a dark ground, since the sign-in page's ground is the ink colour and an ink ring would not show", async () => {
    const night = tokens.find((token) => token.name === "night")?.value;
    expect(night).toBe(tokens.find((token) => token.name === "ink")?.value);
    expect(baseLayer).toMatch(/\.on-dark\s+:focus-visible\s*\{[^}]*outline-color:\s*var\(--ground\);/);
    // The ring's width and offset stay the one rule's: the dark ground changes its colour only.
    expect(baseLayer.match(/\.on-dark\s+:focus-visible\s*\{([^}]*)\}/)?.[1]).not.toMatch(/outline(?:-width|-offset|-style)|outline:/);
    const css = await compileUtilities([]);
    expect(css).toMatch(/\.on-dark :focus-visible\s*\{\s*outline-color:\s*var\(--ground\);/);
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

describe("the motion of My circle being worked out (Avi, 2026-10-09)", () => {
  it("turns the arrow once every 1.6 s, evenly, and in its place fades it to 72% and back every 2 s for a person who asks for less motion", async () => {
    const css = await compileUtilities(["animate-turn", "motion-reduce:animate-breathe"]);
    expect(css).toMatch(/--animate-turn:\s*turn 1\.6s linear infinite;/);
    expect(css).toMatch(/@keyframes turn\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);?\s*\}\s*\}/);
    expect(css).toMatch(/--animate-breathe:\s*breathe 2s ease-in-out infinite;/);
    expect(css).toMatch(/@keyframes breathe\s*\{\s*50%\s*\{\s*opacity:\s*0\.72;?\s*\}\s*\}/);
    expect(declarationsOf(css, "animate-turn")).toEqual(["animation: var(--animate-turn)"]);
    // The fade is the turn's stand-in only where the person asks for less motion.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.motion-reduce\\:animate-breathe\s*\{\s*animation:\s*var\(--animate-breathe\);/);
  });

  it("fades the check in and out over the time it shows (CHECK_MS), and the bar in; neither for a person who asks for less motion", async () => {
    expect(CHECK_MS).toBe(4_000);
    const css = await compileUtilities(["animate-check", "animate-appear", "motion-reduce:animate-none"]);
    expect(css).toMatch(/--animate-check:\s*check 4s ease-in-out both;/);
    expect(css).toMatch(/@keyframes check\s*\{\s*from\s*\{\s*opacity:\s*0;?\s*\}[^@]*to\s*\{\s*opacity:\s*0;?\s*\}\s*\}/);
    expect(css).toMatch(/--animate-appear:\s*appear 0\.2s ease-out;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.motion-reduce\\:animate-none\s*\{\s*animation:\s*none;/);
  });
});

describe("the note a map shows when it leaves a gesture to the page", () => {
  const SELECTOR = ".maplibregl-map .maplibregl-cooperative-gesture-screen";

  it("is in the app's face and colours, from the tokens, and clear of the zoom buttons on both sides", () => {
    const body = new RegExp(`${SELECTOR.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(indexCss)?.[1] ?? "";
    expect(body).toMatch(/font-family:\s*var\(--font-text\);/);
    expect(body).toMatch(/font-size:\s*var\(--size-body\);/);
    // The fill that marks things out: the ink in the light theme, a softer one in the dark (tests/theme.test.tsx).
    expect(body).toMatch(/color:\s*var\(--on-emphasis\);/);
    expect(body).toMatch(/background:\s*color-mix\(in srgb, var\(--emphasis\) \d+%, transparent\);/);
    // The zoom buttons are a touch target wide, in from the map's edge: the words keep that far in from each side.
    expect(body).toMatch(/padding:[^;]*calc\(var\(--touch\) \+ \d+px\)/);
    // No colour of its own: every colour is a token's.
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });

  it("wins over MapLibre's own rule, which is in no layer and loads after the app's", async () => {
    // Two classes to MapLibre's one, so the order the stylesheets load in does not decide it.
    const maplibre = read("node_modules/maplibre-gl/dist/maplibre-gl.css");
    expect(maplibre).toMatch(/(?:^|\})\s*\.maplibregl-cooperative-gesture-screen\s*\{/);
    // In no layer: a rule in a layer loses to any rule in none, whatever its selector.
    const at = indexCss.indexOf(`${SELECTOR} {`);
    expect(at).toBeGreaterThan(-1);
    expect(inLayer(indexCss, at)).toBe(false);
    const css = await compileUtilities([]);
    const compiledAt = css.indexOf(`${SELECTOR} {`);
    expect(compiledAt).toBeGreaterThan(-1);
    expect(inLayer(css, compiledAt)).toBe(false);
  });
});

describe("the map's own focus ring", () => {
  it("is drawn inside the map's edge, since the map's box cuts off what overflows it, and in no layer, so it wins", async () => {
    // BaseMap's box hides what overflows it: the app's ring, 2 px outside, would not show on the map.
    expect(read("src/map/BaseMap.tsx")).toMatch(/className=\{`relative overflow-hidden bg-map-land/);
    const rule = /\.maplibregl-map \.maplibregl-canvas:focus-visible\s*\{([^}]*)\}/.exec(indexCss);
    expect(rule?.[1]).toMatch(/^\s*outline-offset:\s*-2px;\s*$/);
    const css = await compileUtilities([]);
    expect(css).toMatch(/\.maplibregl-map \.maplibregl-canvas:focus-visible\s*\{\s*outline-offset:\s*-2px;\s*\}/);
    const at = indexCss.indexOf(".maplibregl-map .maplibregl-canvas:focus-visible {");
    expect(at).toBeGreaterThan(-1);
    expect(inLayer(indexCss, at)).toBe(false);
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
