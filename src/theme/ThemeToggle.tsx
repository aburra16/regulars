import type { JSX } from "react";

import { copy } from "../copy/en.ts";
import { MoonIcon, SunIcon } from "../ui/icons.tsx";
import { chooseTheme, useTheme } from "./theme.ts";

/**
 * The dark mode switch: a quiet icon in the secondary text colour, with no words on screen. A moon
 * while the page is light, a sun while it is dark; a screen reader hears "Dark mode", pressed or
 * not. A tap turns the page to the other theme and keeps that choice on this device. It sits left
 * of the account button: in the desktop's top bar (and of Saved, once saved lists open), and on a
 * phone in the top row of Explore; the sign-in page, dark already, has none.
 */
export function ThemeToggle(): JSX.Element {
  const dark = useTheme() === "dark";
  return (
    <button
      type="button"
      aria-label={copy.nav.darkMode}
      aria-pressed={dark}
      onClick={() => chooseTheme(dark ? "light" : "dark")}
      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted hover:text-ink"
    >
      {dark ? <SunIcon size={20} /> : <MoonIcon size={20} />}
    </button>
  );
}
