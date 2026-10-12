import { useSyncExternalStore } from "react";

/**
 * The page's two themes. The page follows the device's setting until the person chooses the other
 * theme, with the moon and sun in the top bar (ThemeToggle.tsx) or the switch on You (ThemeSwitch.tsx).
 * The choice is kept on this device, and every open tab of the site takes it. Choosing the device's
 * own theme again forgets the choice, and the page follows the device once more. The theme is
 * `data-theme` on <html>, which src/styles/index.css turns into the colours.
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

/**
 * The choice made in this visit, kept here as well as on the device, so a device that will not keep it
 * (storage blocked or full) still holds it until the page is closed. While the device keeps choices,
 * what it keeps decides, and another tab can change it; once it would not, this does.
 */
let remembered: Theme | undefined;
let memoryOnly = false;

/** The theme the person chose, or undefined while the page follows the device. */
export function chosenTheme(): Theme | undefined {
  if (!memoryOnly) {
    try {
      const value = window.localStorage.getItem(THEME_STORAGE_KEY);
      return isTheme(value) ? value : undefined;
    } catch {
      // Storage that cannot be read: what was chosen in this visit, if anything.
    }
  }
  return remembered;
}

/** Keeps a choice, or forgets it (undefined), on the device if it will and in this visit whatever happens. */
function remember(theme: Theme | undefined): void {
  remembered = theme;
  try {
    if (theme === undefined) window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    memoryOnly = false;
  } catch {
    // Blocked or full: the choice holds until the page is closed.
    memoryOnly = true;
  }
}

/** For tests: forgets the choice made in this visit, as a new page would. */
export function forgetThemeInMemory(): void {
  remembered = undefined;
  memoryOnly = false;
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
  return isTheme(set) ? set : (chosenTheme() ?? deviceTheme());
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

/**
 * The person chose a theme: the page takes it. The other theme than the device's is kept, over the
 * device's setting; the device's own theme forgets any choice, and the page follows the device again.
 */
export function chooseTheme(theme: Theme): void {
  const follows = theme === deviceTheme();
  remember(follows ? undefined : theme);
  apply(theme, !follows);
}

/** The page in the theme chosen, or the device's while none is. */
function settle(): void {
  const chosen = chosenTheme();
  apply(chosen ?? deviceTheme(), chosen !== undefined);
}

/**
 * Keeps the page in the right theme while it is open: the device's, as its setting changes, while the
 * person has chosen none, and the one chosen in another tab of the site, which this one hears of
 * through `storage`. main.tsx starts it once; it returns what stops it.
 */
export function followDevice(): () => void {
  const query = darkQuery();
  settle();
  const onStorage = (event: StorageEvent) => {
    // A key of null: another tab cleared everything the site keeps.
    if (event.key === THEME_STORAGE_KEY || event.key === null) settle();
  };
  query?.addEventListener("change", settle);
  window.addEventListener("storage", onStorage);
  return () => {
    query?.removeEventListener("change", settle);
    window.removeEventListener("storage", onStorage);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The page's theme, as it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "light");
}
