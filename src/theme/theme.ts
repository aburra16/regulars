import { useSyncExternalStore } from "react";

/**
 * The page's two themes. The page follows the device's setting until the person chooses one with the
 * switch (ThemeToggle.tsx); the choice is kept on this device. The theme is `data-theme` on <html>,
 * which src/styles/index.css turns into the colours.
 *
 * index.html's head sets it before the page is first drawn, from what is kept here or else the
 * device's setting, so the page never shows the other theme first. That script repeats the key, the
 * query and the two colours below, in a few lines a browser reads before anything else:
 * tests/theme.test.tsx runs it and checks that the two agree.
 */
export type Theme = "light" | "dark";

/** Where the person's choice is kept, in `localStorage`: "light" or "dark". */
export const THEME_STORAGE_KEY = "regulars.theme";

/** The device's setting. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Each theme's ground (--ground), the colour a browser gives its own bar around the page (theme-color). */
export const THEME_GROUND: Readonly<Record<Theme, string>> = { light: "#FFFFFF", dark: "#10161F" };

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

/** The theme the person chose on this device, or undefined when there is none, or none that can be read. */
export function storedTheme(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : undefined;
  } catch {
    // Storage that is blocked: no choice is kept, and the device's setting decides.
    return undefined;
  }
}

function keep(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Blocked or full. The choice still holds until the page is closed.
  }
}

/** The device's setting; light in a browser that cannot say. */
function darkQuery(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return window.matchMedia(DARK_QUERY);
}
const deviceTheme = (): Theme => (darkQuery()?.matches ? "dark" : "light");

/** The theme the page is in. Before anything has set it (a test), the one it would be set to. */
export function currentTheme(): Theme {
  const set = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
  return isTheme(set) ? set : (storedTheme() ?? deviceTheme());
}

const listeners = new Set<() => void>();

/**
 * Puts the page in `theme`. The browser's bar takes its ground: the chosen theme's for either
 * setting of the device when the person chose it, and each setting's own while the page follows the
 * device (index.html gives one colour for each, by `media`).
 */
function apply(theme: Theme, chosen: boolean): void {
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme: Theme = chosen ? theme : (meta.getAttribute("media") ?? "").includes("dark") ? "dark" : "light";
    meta.setAttribute("content", THEME_GROUND[scheme]);
  }
  for (const listener of [...listeners]) listener();
}

/** The person chose a theme: the page takes it, and keeps it on this device over the device's setting. */
export function chooseTheme(theme: Theme): void {
  keep(theme);
  apply(theme, true);
}

/**
 * Follows the device's setting while the page is open, for as long as the person has chosen no theme
 * of their own. main.tsx starts it once; it returns what stops it.
 */
export function followDevice(): () => void {
  const query = darkQuery();
  const follow = () => {
    const chosen = storedTheme();
    apply(chosen ?? deviceTheme(), chosen !== undefined);
  };
  follow();
  const onChange = () => {
    if (storedTheme() === undefined) follow();
  };
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The page's theme, as it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "light");
}
