import { type JSX, useId } from "react";

import { copy } from "../copy/en.ts";
import { Switch } from "../ui/Switch.tsx";
import { chooseTheme, useTheme } from "./theme.ts";

/**
 * Dark mode as a setting: a row with its words and a switch, on the You page, where a phone reaches
 * it from the tabs. The same choice as the moon and sun in the top bar (ThemeToggle.tsx): on is dark.
 * The whole row is the switch's label, so a tap on its words turns it too; the switch is named by its
 * words alone.
 */
export function ThemeSwitch(): JSX.Element {
  const id = useId();
  const dark = useTheme() === "dark";
  return (
    <label
      htmlFor={`${id}-switch`}
      className="flex cursor-pointer items-center justify-between gap-3 border-t-token border-b-token border-line py-1"
    >
      <span id={`${id}-label`} className="py-2.5 text-body font-bold">
        {copy.nav.darkMode}
      </span>
      <Switch
        id={`${id}-switch`}
        checked={dark}
        onChange={(on) => chooseTheme(on ? "dark" : "light")}
        labelledBy={`${id}-label`}
      />
    </label>
  );
}
