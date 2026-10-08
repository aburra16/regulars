import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { NostrEvent } from "@nostrify/nostrify";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { copy } from "../src/copy/en";
import { BaseMap } from "../src/map/BaseMap";
import { type Pin, PIN_SOURCE } from "../src/map/pins";
import { MAPTILER_DARK_STYLE_URL, MAPTILER_STYLE_URL, mapStyle, recolour } from "../src/map/style";
import {
  chooseTheme,
  currentTheme,
  DARK_QUERY,
  followDevice,
  THEME_GROUND,
  THEME_STORAGE_KEY,
} from "../src/theme/theme";
import { ThemeToggle } from "../src/theme/ThemeToggle";
import { MoonIcon, SunIcon } from "../src/ui/icons";
import raw from "./fixtures/funchal-items.json";
import { DESKTOP, openApp, PHONE, resetWidth } from "./support/app";
import { FakeMap } from "./support/fakeMaplibre";

const fixtures: NostrEvent[] = raw;
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const indexCss = read("src/styles/index.css");
const tokensCss = read("handoff/design/tokens.css");
const indexHtmlText = read("index.html");
const indexHtml = new DOMParser().parseFromString(indexHtmlText, "text/html");

// ---- The stylesheet's blocks ----

/** The body of the first rule whose selector is exactly `selector`, searched from `from`. */
function ruleBody(css: string, selector: string, from = 0): string | undefined {
  const at = css.indexOf(`${selector} {`, from);
  if (at < 0) return undefined;
  const open = at + selector.length + 1;
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** The `--name: value` declarations of a block, without comments. */
function declarationsIn(body: string | undefined): Map<string, string> {
  const text = (body ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map([...text.matchAll(/(--[a-z0-9-]+|color-scheme):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

/** Every plain `:root { ... }` block of a stylesheet, merged: the light theme, which is the page's own. */
function rootDeclarations(css: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const match of css.matchAll(/(?:^|\n)\s*:root\s*\{/g)) {
    const open = match.index + match[0].length;
    for (const [name, value] of declarationsIn(css.slice(open, css.indexOf("}", open)))) merged.set(name, value);
  }
  return merged;
}

const lightDeclared = rootDeclarations(indexCss);
const darkDeclared = declarationsIn(ruleBody(indexCss, ':root[data-theme="dark"]'));
const mediaAt = indexCss.indexOf("@media (prefers-color-scheme: dark)");
const darkByDevice = declarationsIn(ruleBody(indexCss, ':root:not([data-theme="light"])', mediaAt));
const lightScope = declarationsIn(ruleBody(indexCss, '[data-theme="light"]'));

/** A theme's colour of a token, by name without the dashes: the dark theme falls back to the light one where it does not change it. */
const colourOf = (theme: "light" | "dark", token: string): string => {
  const value = (theme === "dark" ? darkDeclared.get(`--${token}`) : undefined) ?? lightDeclared.get(`--${token}`);
  if (value === undefined || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`No colour for --${token} in the ${theme} theme`);
  return value;
};

// ---- Contrast, as WCAG 2 measures it ----

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text, and what it is on: 4.5 to 1. */
const TEXT: ReadonlyArray<[fg: string, bg: string, where: string]> = [
  ["ink", "ground", "text"],
  ["ink", "surface", "text on a panel and in the search field"],
  ["ink-soft", "ground", "body copy"],
  ["ink-soft", "surface", "the banners"],
  ["muted", "ground", "secondary text"],
  ["muted", "surface", "secondary text on a panel"],
  ["muted", "map-land", "the line a map shows when it cannot be drawn"],
  ["accent", "ground", "the open tab, links as they are pointed at"],
  ["accent", "surface", "accent text on a panel"],
  ["ground", "ink", "a chosen chip, the account button, a bubble's count"],
  ["on-accent", "accent-solid", "the accent buttons and the chosen pin"],
  ["trust", "ground", "words about who you trust"],
  ["trust-ink", "trust-tint", "text on the trust tint"],
];

/** Parts of the interface and graphics, and what they are on: 3 to 1. */
const GRAPHIC: ReadonlyArray<[fg: string, bg: string, where: string]> = [
  ["field-border", "ground", "a text field's edge, the off switch"],
  ["field-border", "surface", "a field's edge on a panel"],
  ["ground", "field-border", "the switch's knob on its track"],
  ["ink", "ground", "the focus ring"],
  ["ink", "surface", "the focus ring by a panel"],
  ["ink", "map-land", "the map's own focus ring, inside its edge"],
  ["accent", "ground", "a filled star"],
  ["accent", "surface", "a filled star on a panel"],
  ["accent", "map-land", "the chosen ring and the place's drop on the map"],
  ["on-accent", "accent", "the dot in the place's drop"],
  ["accent-solid", "map-land", "the chosen pin on the map"],
  ["accent-solid", "ground", "an accent button on the page"],
  ["muted", "ground", "the ring of a pin with no score"],
  ["you-are-here", "map-land", "where the person is"],
  ["trust", "trust-tint", "a trust mark on the tint"],
];

/** Edges and grounds that tell parts apart without a ratio of their own to meet: at least as clear in the dark as in the light. */
const EDGES: ReadonlyArray<[fg: string, bg: string, where: string]> = [
  ["line", "ground", "card edges and dividers"],
  ["line", "surface", "a divider on a panel"],
  ["line-strong", "ground", "chip and outline-button edges, empty stars"],
  ["line-dashed", "ground", "dashed 'nothing here yet' edges"],
  ["surface", "ground", "a panel on the page"],
  ["map-park", "map-land", "a park on the map"],
  ["map-water", "map-land", "water on the map"],
  ["trust-track", "trust-tint", "the progress bar's track"],
];

describe("the dark theme's colours", () => {
  it("are declared once for the device's setting and once for the person's choice, the same in both", () => {
    expect(mediaAt).toBeGreaterThan(-1);
    expect(darkDeclared.size).toBeGreaterThan(20);
    expect([...darkByDevice]).toEqual([...darkDeclared]);
    expect(darkDeclared.get("color-scheme")).toBe("dark");
  });

  it("change every colour of the tokens but the sign-in page's own, and the solid accent, the shade and the edge of what floats", () => {
    const tokenColours = [...tokensCss.matchAll(/^\s*--([a-z0-9-]+):\s*#[0-9a-fA-F]{6};/gm)].map(([, name]) => name!);
    const kept = ["night", "on-night-soft", "wordmark-on-night"];
    const changed = [...darkDeclared.keys()].filter((name) => /^--/.test(name) && /^#/.test(darkDeclared.get(name)!));
    expect(changed.map((name) => name.slice(2)).sort()).toEqual(
      [...tokenColours.filter((name) => !kept.includes(name)), "accent-solid", "shade", "float-edge"].sort(),
    );
    // The shadows darken too, to black.
    for (const shadow of ["--shadow-float", "--shadow-card-over-map", "--shadow-dialog"]) {
      expect(darkDeclared.get(shadow), shadow).toMatch(/rgba\(0, 0, 0, 0\.\d+\)/);
    }
  });

  it("has the light theme's solid accent and shade as its accent and ink", () => {
    expect(colourOf("light", "accent-solid")).toBe(colourOf("light", "accent"));
    expect(colourOf("light", "shade")).toBe(colourOf("light", "ink"));
    // The dark theme's solid accent is the light one's: white on it still reads.
    expect(colourOf("dark", "accent-solid")).toBe(colourOf("light", "accent"));
  });

  for (const theme of ["light", "dark"] as const) {
    it.each(TEXT)(`${theme}: --%s on --%s reads at 4.5 to 1 (%s)`, (fg, bg) => {
      expect(contrast(colourOf(theme, fg), colourOf(theme, bg))).toBeGreaterThanOrEqual(4.5);
    });
  }

  // The light theme's own colours are the design's: these are held to 3 to 1 in the dark one, which
  // starts from them, and to the light one's own ratio there (a field's edge on a panel is 2.8 in the design).
  it.each(GRAPHIC)("dark: --%s against --%s is at least 3 to 1 (%s)", (fg, bg) => {
    expect(contrast(colourOf("dark", fg), colourOf("dark", bg))).toBeGreaterThanOrEqual(3);
  });

  it.each(EDGES)("dark: --%s against --%s is at least as clear as in the light (%s)", (fg, bg) => {
    const light = contrast(colourOf("light", fg), colourOf("light", bg));
    expect(contrast(colourOf("dark", fg), colourOf("dark", bg))).toBeGreaterThanOrEqual(light - 0.005);
  });

  it("keeps a part of a page in the light theme's colours, whatever the theme: the sign-in page", () => {
    // Every colour the dark theme changes, put back as the light theme has it.
    expect([...lightScope.keys()].sort()).toEqual([...darkDeclared.keys()].sort());
    for (const [name, value] of lightScope) expect(value, name).toBe(lightDeclared.get(name));
    expect(lightScope.get("color-scheme")).toBe("light");
  });

  it("has the page's ground as each theme's colour for the browser's own bar", () => {
    expect(THEME_GROUND).toEqual({ light: colourOf("light", "ground"), dark: colourOf("dark", "ground") });
  });
});

// ---- The utilities read the variables, so the dark theme recolours them ----

async function compiled(classNames: string[]): Promise<string> {
  const compiler = await compile(indexCss, {
    base: root,
    async loadStylesheet(id, base) {
      const path = id === "tailwindcss" ? resolve(root, "node_modules/tailwindcss/index.css") : resolve(base, id);
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
  return compiler.build(classNames);
}

/** Every file under a folder, as paths relative to the project. */
function filesUnder(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}

describe("the stylesheet, compiled", () => {
  it("keeps both dark blocks, so the variables change under them", async () => {
    const css = await compiled([]);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--ground:\s*#10161F;/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{[^}]*--ground:\s*#10161F;/);
    expect(css).toMatch(/\[data-theme="light"\]\s*\{[^}]*--ground:\s*#FFFFFF;/);
  });

  it("draws each colour utility from its variable, never from a value fixed when it was compiled", async () => {
    const names = ["ground", "ink", "muted", "surface", "accent", "accent-solid", "on-accent", "map-land", "line"];
    const css = await compiled(names.flatMap((name) => [`bg-${name}`, `text-${name}`, `border-${name}`, `fill-${name}`]));
    for (const name of names) {
      expect(css).toMatch(new RegExp(`\\.bg-${name}\\s*\\{\\s*background-color:\\s*var\\(--${name}\\);`));
      expect(css).toMatch(new RegExp(`\\.text-${name}\\s*\\{\\s*color:\\s*var\\(--${name}\\);`));
      expect(css).toMatch(new RegExp(`\\.fill-${name}\\s*\\{\\s*fill:\\s*var\\(--${name}\\);`));
    }
  });

  it("casts the map's shadows in the shade, not the ink, which is light in the dark", async () => {
    const shadows = ["shadow-pin", "shadow-pin-ring", "shadow-pin-chosen", "shadow-map-button", "shadow-map-controls"];
    const css = await compiled(shadows);
    for (const shadow of shadows) {
      expect(css).toMatch(new RegExp(`\\.${shadow}\\s*\\{\\s*box-shadow:[^;]*var\\(--shade\\)`));
    }
    expect(indexCss).not.toMatch(/box-shadow:[^;]*var\(--ink\)/);
  });

  it("draws a quiet edge round what floats, over the map and the page, in the dark, where a shadow does not show; none in the light", async () => {
    expect(lightDeclared.get("--float-edge")).toBe("transparent");
    const edge = darkDeclared.get("--float-edge")!;
    expect(edge).toMatch(/^#[0-9a-fA-F]{6}$/);
    // Clear of the map and of the ground of a pin, a card or a button on it; no brighter than the strong line.
    expect(contrast(edge, colourOf("dark", "map-land"))).toBeGreaterThanOrEqual(1.4);
    expect(contrast(edge, colourOf("dark", "ground"))).toBeGreaterThanOrEqual(1.6);
    expect(luminance(edge)).toBeLessThanOrEqual(luminance(colourOf("dark", "line-strong")));
    // The pins, the bubbles and the map's own buttons, which are drawn in the page's ground.
    const css = await compiled(["shadow-pin", "shadow-map-controls"]);
    for (const shadow of ["shadow-pin", "shadow-map-controls"]) {
      expect(css).toMatch(new RegExp(`\\.${shadow}\\s*\\{\\s*box-shadow:\\s*0 0 0 1px var\\(--float-edge\\),`));
    }
    // The cards, the toggle and the menus over the map and the page, and the dialog.
    for (const token of ["--shadow-float", "--shadow-card-over-map", "--shadow-dialog"]) {
      expect(darkDeclared.get(token), token).toMatch(/^0 0 0 1px var\(--float-edge\), /);
      expect(lightDeclared.get(token), token).not.toContain("--float-edge");
    }
  });

  it("dims the page behind a dialog in the shade, never in the ink, which would be a light wash in the dark", async () => {
    const files = filesUnder("src").filter((file) => /\.tsx?$/.test(file));
    const inkWashes = files.flatMap((file) =>
      [...read(file).matchAll(/(?<![\w-])bg-ink\/\d+/g)].map((match) => `${file}: ${match[0]}`),
    );
    expect(inkWashes).toEqual([]);
    expect(read("src/location/CityPicker.tsx")).toMatch(/wide:bg-shade\/60/);
    const css = await compiled(["bg-shade/60"]);
    expect(css).toMatch(/\.bg-shade\\\/60\s*\{[^}]*var\(--shade\)/);
  });

  it("puts white words only on the solid accent: nothing in src is filled with the lighter accent", () => {
    const files = filesUnder("src").filter((file) => /\.tsx?$/.test(file));
    const offences = files.flatMap((file) =>
      [...read(file).matchAll(/(?<![\w-])bg-accent(?![\w-])/g)].map((match) => `${file}: ${match[0]}`),
    );
    expect(offences).toEqual([]);
  });

  it("keeps everything in the night colours in the light theme's, which they are drawn against: the sign-in page and About's dark card", async () => {
    // --night and the two colours on it do not change; what sits with them must not either.
    for (const path of ["/signin", "/about"]) {
      for (const px of [PHONE, DESKTOP]) {
        const { container, unmount } = await openApp(path, { events: fixtures, px });
        const night = [...container.querySelectorAll('[class*="night"]')];
        expect(night.length, `${path} at ${px} px`).toBeGreaterThan(0);
        for (const element of night) expect(element.closest('[data-theme="light"]'), `${path} at ${px} px: ${element.className}`).not.toBeNull();
        unmount();
      }
    }
  });

  it("keeps the sign-in page's look in both themes: its ground is already dark", async () => {
    for (const px of [PHONE, DESKTOP]) {
      const { unmount } = await openApp("/signin", { events: fixtures, px });
      const headline = screen.getByRole("heading", { level: 1 });
      expect(headline.closest('[data-theme="light"]'), `${px} px`).not.toBeNull();
      expect(headline.closest('[data-theme="light"]')).toHaveClass("bg-night");
      unmount();
    }
  });
});

// ---- The page before it is drawn: index.html ----

/** The script in index.html's head that sets the theme before the first paint. */
const firstPaintScripts = [...indexHtml.querySelectorAll("script:not([src])")];

/** The device's setting, as `matchMedia` answers it; `undefined`: a browser with no `matchMedia`. */
const deviceListeners = new Set<() => void>();
let deviceDark = false;
function setDevice(dark: boolean | undefined) {
  if (dark === undefined) {
    Reflect.deleteProperty(window, "matchMedia");
    return;
  }
  deviceDark = dark;
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query === DARK_QUERY ? deviceDark : false;
    },
    addEventListener: (_type: string, listener: () => void) => deviceListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => deviceListeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
}
/** The device's setting changes while the page is open. */
function deviceTurns(dark: boolean) {
  act(() => {
    deviceDark = dark;
    for (const listener of [...deviceListeners]) listener();
  });
}

/** index.html's theme colours, put in this page's head as the browser has them. */
function addThemeMetas(): HTMLMetaElement[] {
  const metas = [...indexHtml.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
    (meta) => document.importNode(meta, true),
  );
  document.head.append(...metas);
  return metas;
}
const themeColours = () =>
  [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => [meta.getAttribute("media"), meta.getAttribute("content")]);
const PER_SCHEME = [
  ["(prefers-color-scheme: light)", "#FFFFFF"],
  ["(prefers-color-scheme: dark)", "#10161F"],
];

function runFirstPaint() {
  // The script as the browser runs it: a classic script in the page's global scope.
  new Function(firstPaintScripts[0]!.textContent ?? "")();
}

afterEach(() => {
  vi.restoreAllMocks();
  deviceListeners.clear();
  resetWidth();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
});

describe("index.html", () => {
  it("says the page has both schemes, with a theme colour for each", () => {
    expect(indexHtml.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light dark");
    const metas = [...indexHtml.querySelectorAll('meta[name="theme-color"]')];
    expect(metas.map((meta) => [meta.getAttribute("media"), meta.getAttribute("content")])).toEqual([
      ["(prefers-color-scheme: light)", THEME_GROUND.light],
      ["(prefers-color-scheme: dark)", THEME_GROUND.dark],
    ]);
  });

  it("sets the theme in its head, after the theme colours, before the app's own script", () => {
    expect(firstPaintScripts).toHaveLength(1);
    const script = firstPaintScripts[0]!;
    expect(script.parentElement).toBe(indexHtml.head);
    expect(script.getAttribute("type")).toBeNull();
    const metas = [...indexHtml.querySelectorAll('meta[name="theme-color"]')];
    for (const meta of metas) expect(meta.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Tiny: it is read before the page is drawn.
    expect((script.textContent ?? "").length).toBeLessThan(800);
    expect(script.textContent).toContain(THEME_STORAGE_KEY);
  });

  it("keeps the person's choice on a reload, over the device's setting, with the browser's bar in its colour", () => {
    addThemeMetas();
    setDevice(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runFirstPaint();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeColours()).toEqual(PER_SCHEME.map(([media]) => [media, THEME_GROUND.dark]));

    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
    addThemeMetas();
    setDevice(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runFirstPaint();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeColours()).toEqual(PER_SCHEME.map(([media]) => [media, THEME_GROUND.light]));
  });

  it("follows the device when there is no choice, or none it can read, and leaves each scheme its colour", () => {
    addThemeMetas();
    for (const [dark, stored] of [
      [true, null],
      [false, null],
      [true, "purple"],
    ] as const) {
      setDevice(dark);
      window.localStorage.clear();
      if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
      runFirstPaint();
      expect(document.documentElement.dataset.theme).toBe(dark ? "dark" : "light");
      expect(themeColours()).toEqual(PER_SCHEME);
    }
    // A browser with no matchMedia: the light theme.
    setDevice(undefined);
    window.localStorage.clear();
    runFirstPaint();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the device when the storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setDevice(true);
    expect(() => runFirstPaint()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

// ---- The theme while the page is open ----

describe("the theme", () => {
  it("follows the device as its setting changes, while nothing is chosen", () => {
    setDevice(false);
    const stop = followDevice();
    expect(currentTheme()).toBe("light");
    deviceTurns(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    deviceTurns(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    stop();
    deviceTurns(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps the person's choice when the device changes", () => {
    setDevice(false);
    const stop = followDevice();
    act(() => chooseTheme("dark"));
    deviceTurns(true);
    deviceTurns(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
  });

  it("gives the browser's bar the chosen theme's colour, and each scheme its own while it follows the device", () => {
    addThemeMetas();
    setDevice(false);
    const stop = followDevice();
    expect(themeColours()).toEqual(PER_SCHEME);
    act(() => chooseTheme("dark"));
    expect(themeColours()).toEqual(PER_SCHEME.map(([media]) => [media, THEME_GROUND.dark]));
    act(() => chooseTheme("light"));
    expect(themeColours()).toEqual(PER_SCHEME.map(([media]) => [media, THEME_GROUND.light]));
    stop();
  });
});

describe("the dark mode switch", () => {
  const theSwitch = () => screen.getByRole("button", { name: copy.nav.darkMode });

  it("is a quiet icon button, named 'Dark mode', pressed in the dark: a moon in the light, a sun in the dark", async () => {
    const user = userEvent.setup();
    setDevice(false);
    render(<ThemeToggle />);
    const button = theSwitch();
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveTextContent("");
    expect(button).toHaveClass("text-muted", "size-11");
    expect(button.innerHTML).toBe(renderToStaticMarkup(<MoonIcon size={20} />));

    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.innerHTML).toBe(renderToStaticMarkup(<SunIcon size={20} />));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("starts from the device's setting when nothing is chosen, and from the choice when one is", () => {
    setDevice(true);
    const first = render(<ThemeToggle />);
    expect(theSwitch()).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    document.documentElement.removeAttribute("data-theme");
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<ThemeToggle />);
    expect(theSwitch()).toHaveAttribute("aria-pressed", "false");
  });

  it("turns with the device while it is open", () => {
    setDevice(false);
    const stop = followDevice();
    render(<ThemeToggle />);
    expect(theSwitch()).toHaveAttribute("aria-pressed", "false");
    deviceTurns(true);
    expect(theSwitch()).toHaveAttribute("aria-pressed", "true");
    stop();
  });

  it("still switches when the device will not keep the choice", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setDevice(false);
    render(<ThemeToggle />);
    await user.click(theSwitch());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(theSwitch()).toHaveAttribute("aria-pressed", "true");
  });

  it("sits in the desktop's top bar, just left of Saved, on every page but sign in", async () => {
    for (const path of ["/", "/map", "/search?q=tea", "/about", "/saved", "/you"]) {
      const { unmount } = await openApp(path, { events: fixtures, px: DESKTOP });
      const bar = screen.getByRole("banner");
      const button = within(bar).getByRole("button", { name: copy.nav.darkMode });
      expect(button.nextElementSibling, path).toBe(within(bar).getByRole("link", { name: copy.nav.saved }));
      expect(button.previousElementSibling).toBe(within(bar).getByRole("group", { name: copy.view.label }));
      unmount();
    }
  });

  it("sits in the top row of the phone's header, left of the account button", async () => {
    await openApp("/", { events: fixtures, px: PHONE });
    const top = screen.getByRole("banner");
    const button = within(top).getByRole("button", { name: copy.nav.darkMode });
    expect(button.nextElementSibling).toBe(within(top).getByRole("link", { name: copy.nav.account }));
    // The same row as the wordmark.
    expect(button.closest("div")?.parentElement).toContainElement(within(top).getByText(copy.app.name));
  });

  it("is not on the sign-in page, which is dark already", async () => {
    for (const px of [PHONE, DESKTOP]) {
      const { unmount } = await openApp("/signin", { events: fixtures, px });
      expect(screen.queryByRole("button", { name: copy.nav.darkMode })).not.toBeInTheDocument();
      unmount();
    }
  });
});

// ---- The map in the dark ----

describe("the map in the dark", () => {
  const funchal: [number, number] = [config.defaultCity.lon, config.defaultCity.lat];
  const pins: Pin[] = [
    { address: "a", lat: 32.65, lon: -16.91, name: "Alpha, Cafe, Hours not listed, no reviews yet", category: "cafe" },
    { address: "b", lat: 32.651, lon: -16.905, name: "Bravo, Cafe, Hours not listed, no reviews yet", category: "cafe" },
  ];

  /** The map made last, once its style has loaded and the pins are on it. */
  const theMap = () =>
    waitFor(() => {
      const map = FakeMap.instances.at(-1);
      if (map === undefined || !map.sources.has(PIN_SOURCE)) throw new Error("No map with pins yet");
      return map;
    });

  /** The colours `recolour` set, without the transitions it turned off first. */
  const coloursSet = (map: FakeMap) => map.setPaintProperty.mock.calls.filter(([, property]) => !property.endsWith("-transition"));

  it("is MapTiler's Dataviz Dark, from the same host with the same key", () => {
    expect(MAPTILER_DARK_STYLE_URL).toBe("https://api.maptiler.com/maps/dataviz-dark/style.json");
    expect(new URL(MAPTILER_DARK_STYLE_URL).host).toBe(new URL(MAPTILER_STYLE_URL).host);
    expect(mapStyle("k", "dark")).toBe(`${MAPTILER_DARK_STYLE_URL}?key=k`);
    expect(mapStyle("k", "light")).toBe(`${MAPTILER_STYLE_URL}?key=k`);
  });

  it("is a plain ground in the dark land colour without a key", () => {
    expect(mapStyle(undefined, "dark")).toMatchObject({ layers: [{ paint: { "background-color": colourOf("dark", "map-land") } }] });
  });

  it("recolours the land, parks and water to the dark tokens", () => {
    const map = new FakeMap({ container: document.createElement("div"), style: "https://x.test/style.json" });
    recolour(map as never, "dark");
    const land = colourOf("dark", "map-land");
    const park = colourOf("dark", "map-park");
    const water = colourOf("dark", "map-water");
    expect(coloursSet(map)).toEqual([
      ["Background", "background-color", land],
      ["Residential", "fill-color", land],
      ["Landcover", "fill-color", park],
      ["Forest", "fill-color", park],
      ["Stadium", "fill-color", park],
      ["Cemetery", "fill-color", park],
      ["Water shadow", "fill-color", water],
      ["Water", "fill-color", water],
      ["River", "line-color", water],
    ]);
  });

  it("is made dark when the page is dark", async () => {
    config.mapTilerKey = "test-key";
    act(() => chooseTheme("dark"));
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} />);
    const map = await theMap();
    expect(map.options.style).toBe(`${MAPTILER_DARK_STYLE_URL}?key=test-key`);
    expect(map.setPaintProperty).toHaveBeenCalledWith("Water", "fill-color", colourOf("dark", "map-water"));
  });

  it("changes its style when the theme changes while it is open, keeping where it looks, its pins and the chosen one", async () => {
    config.mapTilerKey = "test-key";
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} selected="a" onSelect={() => {}} />);
    const map = await theMap();
    expect(map.options.style).toBe(`${MAPTILER_STYLE_URL}?key=test-key`);
    act(() => map.dragTo({ west: -16.93, south: 32.63, east: -16.89, north: 32.67 }, 14));
    const [lon, lat] = map.center;
    map.setPaintProperty.mockClear();

    act(() => chooseTheme("dark"));
    expect(map.setStyle).toHaveBeenCalledWith(`${MAPTILER_DARK_STYLE_URL}?key=test-key`, { diff: false });
    // The new style has come: the dark colours, and the pins back on it.
    await waitFor(() => expect(map.setPaintProperty).toHaveBeenCalledWith("Background", "background-color", colourOf("dark", "map-land")));
    await waitFor(() => expect(map.sources.has(PIN_SOURCE)).toBe(true));
    expect(FakeMap.instances).toHaveLength(1);
    expect(map.center).toEqual([lon, lat]);
    expect(map.zoom).toBe(14);
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Alpha,/ })).toHaveAttribute("aria-pressed", "true");

    act(() => chooseTheme("light"));
    expect(map.setStyle).toHaveBeenLastCalledWith(`${MAPTILER_STYLE_URL}?key=test-key`, { diff: false });
    await waitFor(() => expect(map.setPaintProperty).toHaveBeenCalledWith("Background", "background-color", colourOf("light", "map-land")));
  });

  it("changes the plain ground's colour without a key", async () => {
    render(<BaseMap center={funchal} zoom={13} interactive pins={pins} />);
    const map = await theMap();
    act(() => chooseTheme("dark"));
    expect(map.setStyle).toHaveBeenCalledWith(mapStyle(undefined, "dark"), { diff: false });
    await waitFor(() => expect(map.sources.has(PIN_SOURCE)).toBe(true));
  });
});
