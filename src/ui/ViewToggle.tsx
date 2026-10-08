import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useView, type View } from "../view/ViewProvider.tsx";

export type { View } from "../view/ViewProvider.tsx";

/**
 * How the toggle looks where it sits:
 * - `bar`: full width at the top of the phone's Explore (Main.dc.html);
 * - `compact`: in the desktop top bar (DeskExplore.dc.html). The buttons are drawn 40 px tall,
 *   and an invisible 2 px above and below makes each a 44 px target;
 * - `panel`: full width on white, in the place page's score panel (Place.dc.html).
 */
export type ViewToggleVariant = "bar" | "compact" | "panel";

const LOOK: Record<ViewToggleVariant, { group: string; button: string }> = {
  bar: { group: "rounded-button bg-surface", button: "h-11 flex-1 rounded-[12px] text-[15px]" },
  compact: {
    group: "rounded-tile bg-surface",
    button: "relative h-10 rounded-[10px] px-4 text-secondary after:absolute after:inset-x-0 after:-inset-y-0.5",
  },
  panel: { group: "rounded-tile bg-ground", button: "h-11 flex-1 rounded-[10px] text-secondary" },
};

export interface ViewToggleProps {
  value: View;
  onChange(v: View): void;
  /** Each view's score for one place; a half shows its score when it has one: "House picks · 4.5". */
  scores?: { house?: number; circle?: number };
  variant?: ViewToggleVariant;
}

/** The House picks / My circle toggle: two buttons, the chosen one pressed. It tells its parent what was tapped. */
export function ViewToggle({ value, onChange, scores, variant = "bar" }: ViewToggleProps): JSX.Element {
  const look = LOOK[variant];
  const halves = [
    { view: "house", label: copy.view.house, score: scores?.house },
    { view: "circle", label: copy.view.circle, score: scores?.circle },
  ] as const;
  return (
    <div role="group" aria-label={copy.view.label} className={`flex gap-1 p-1 ${look.group}`}>
      {halves.map(({ view, label, score }) => {
        const chosen = view === value;
        return (
          <button
            key={view}
            type="button"
            aria-pressed={chosen}
            onClick={() => {
              if (!chosen) onChange(view);
            }}
            className={`cursor-pointer border-0 font-text font-bold ${look.button} ${
              chosen ? "bg-ink text-ground" : "bg-transparent text-ink"
            }`}
          >
            {score === undefined ? label : copy.view.withScore(label, copy.score.value(score))}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The toggle for the app's own view (`useView`). Before sign in opens, My circle has nothing to
 * show: tapping it goes to the sign-in page, which can come back to where the person was, and the
 * view stays House picks.
 */
export function ViewSwitch(props: Omit<ViewToggleProps, "value" | "onChange">): JSX.Element {
  const { view, setView } = useView();
  const navigate = useNavigate();
  const location = useLocation();
  const choose = (next: View) => {
    if (next === "circle" && !config.features.signIn) {
      void navigate("/signin", { state: { from: location } });
      return;
    }
    setView(next);
  };
  return <ViewToggle {...props} value={view} onChange={choose} />;
}
