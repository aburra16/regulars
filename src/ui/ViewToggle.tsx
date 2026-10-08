import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { useCircle } from "../circle/CircleProvider.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useView, type View } from "../view/ViewProvider.tsx";

export type { View } from "../view/ViewProvider.tsx";

/**
 * How the toggle looks where it sits:
 * - `bar`: full width at the top of the phone's Explore (Main.dc.html);
 * - `compact`: in the desktop top bar (DeskExplore.dc.html). The buttons are drawn 40 px tall,
 *   and an invisible 2 px above and below makes each a 44 px target;
 * - `panel`: full width on white, in the place page's score panel (Place.dc.html);
 * - `map`: full width, white with a shadow, floating over the phone's map (Map.dc.html).
 */
export type ViewToggleVariant = "bar" | "compact" | "panel" | "map";

const LOOK: Record<ViewToggleVariant, { group: string; button: string }> = {
  bar: { group: "rounded-button bg-surface", button: "h-11 flex-1 rounded-[12px] text-[15px]" },
  compact: {
    group: "rounded-tile bg-surface",
    button: "relative h-10 rounded-[10px] px-4 text-secondary after:absolute after:inset-x-0 after:-inset-y-0.5",
  },
  panel: { group: "rounded-tile bg-ground", button: "h-11 flex-1 rounded-[10px] text-secondary" },
  map: { group: "rounded-button bg-ground shadow-float", button: "h-11 flex-1 rounded-[12px] text-[15px]" },
};

export interface ViewToggleProps {
  value: View;
  onChange(v: View): void;
  /** Each view's score for one place; a half shows its score when it has one: "House picks · 4.5". */
  scores?: { house?: number; circle?: number };
  variant?: ViewToggleVariant;
  /** My circle cannot be had yet: its half is off and says so, "My circle · soon" (the brief's screen 11). */
  circleSoon?: boolean;
}

/** The House picks / My circle toggle: two buttons, the chosen one pressed. It tells its parent what was tapped. */
export function ViewToggle({ value, onChange, scores, variant = "bar", circleSoon = false }: ViewToggleProps): JSX.Element {
  const look = LOOK[variant];
  const halves = [
    { view: "house", label: copy.view.house, score: scores?.house },
    { view: "circle", label: copy.view.circle, score: scores?.circle },
  ] as const;
  return (
    <div role="group" aria-label={copy.view.label} className={`flex gap-1 p-1 ${look.group}`}>
      {halves.map(({ view, label, score }) => {
        const chosen = view === value;
        const soon = view === "circle" && circleSoon && !chosen;
        return (
          <button
            key={view}
            type="button"
            aria-pressed={chosen}
            disabled={soon}
            onClick={() => {
              if (!chosen) onChange(view);
            }}
            className={`border-0 font-text font-bold ${look.button} ${
              chosen
                ? "cursor-pointer bg-emphasis text-on-emphasis"
                : soon
                  ? "cursor-not-allowed bg-transparent text-muted"
                  : "cursor-pointer bg-transparent text-ink"
            }`}
          >
            {soon ? copy.view.circleSoon : score === undefined ? label : copy.view.withScore(label, copy.score.value(score))}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The toggle for the app's own view (`useView`). My circle can be chosen once it is open
 * (`config.features.circle`) and the person's circle is ready (`useCircle`, after Personalize):
 * choosing it puts away the notice that said so. Until then the view stays House picks: tapping My
 * circle goes to the sign-in page for a person who has not signed in, which can come back to where
 * they were, as signing in comes first; after sign in, its half is off and reads "soon".
 */
export function ViewSwitch(props: Omit<ViewToggleProps, "value" | "onChange" | "circleSoon">): JSX.Element {
  const { view, setView } = useView();
  const { account } = useAccount();
  const circle = useCircle();
  const navigate = useNavigate();
  const location = useLocation();
  const open = config.features.circle && circle.ready;
  const choose = (next: View) => {
    if (next === "circle" && !open) {
      if (account === undefined) void navigate("/signin", { state: { from: location } });
      return;
    }
    if (next === "circle") circle.dismissReady();
    setView(next);
  };
  return <ViewToggle {...props} value={view} onChange={choose} circleSoon={!open && account !== undefined} />;
}
