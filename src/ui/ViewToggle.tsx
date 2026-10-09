import { type FocusEvent, type JSX, type Ref, useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { useCircleDoor } from "../circle/CircleDoor.tsx";
import { useCircle } from "../circle/CircleProvider.tsx";
import { DoorPanel } from "../circle/Personalize.tsx";
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

/**
 * Where the door's own panel floats under the toggle: from the start of the top bar's, as wide as its
 * words need, and never wider than the window inside its gutters; across the others, as wide as they are.
 */
const FLOAT: Record<ViewToggleVariant, string> = {
  bar: "inset-x-0",
  compact: "left-0 w-[340px] max-w-[calc(100vw-2*var(--gutter-desktop))]",
  panel: "inset-x-0",
  map: "inset-x-0",
};

export interface ViewToggleProps {
  value: View;
  onChange(v: View): void;
  /** Each view's score for one place; a half shows its score when it has one: "House picks · 4.5". */
  scores?: { house?: number; circle?: number };
  variant?: ViewToggleVariant;
  /** My circle cannot be had yet: its half is off and says so, "My circle · soon" (the brief's screen 11). */
  circleSoon?: boolean;
  /**
   * My circle's half is the door to it, before the person's circle is asked for (Avi, 2026-10-08): it
   * opens, or goes to, the panel that offers Personalize. It is not a view to choose yet, so it is not
   * pressed or unpressed: `expanded` says whether its panel shows, and `controls` names the panel while it does.
   */
  circleDoor?: { expanded: boolean; controls?: string };
  /** Each half's button, for what moves the focus to it. */
  halves?: { house?: Ref<HTMLButtonElement>; circle?: Ref<HTMLButtonElement> };
}

/** The House picks / My circle toggle: two buttons, the chosen one pressed. It tells its parent what was tapped. */
export function ViewToggle({ value, onChange, scores, variant = "bar", circleSoon = false, circleDoor, halves }: ViewToggleProps): JSX.Element {
  const look = LOOK[variant];
  const views = [
    { view: "house", label: copy.view.house, score: scores?.house },
    { view: "circle", label: copy.view.circle, score: scores?.circle },
  ] as const;
  return (
    <div role="group" aria-label={copy.view.label} className={`flex gap-1 p-1 ${look.group}`}>
      {views.map(({ view, label, score }) => {
        const chosen = view === value;
        const soon = view === "circle" && circleSoon && !chosen;
        const door = view === "circle" && circleDoor !== undefined && !soon && !chosen;
        return (
          <button
            key={view}
            ref={halves?.[view]}
            type="button"
            aria-pressed={door ? undefined : chosen}
            aria-expanded={door ? circleDoor?.expanded : undefined}
            aria-controls={door ? circleDoor?.controls : undefined}
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
 * they were, as signing in comes first.
 *
 * Signed in, before their circle is asked for, or when asking for it ended without one, My circle's
 * half is the door to Personalize (`useCircleDoor`; Avi, 2026-10-08). On a page with a panel of its
 * own (the phone's Explore, the Why page), a tap opens it, or goes to it if it shows already. Elsewhere
 * a tap opens a panel that floats under the toggle, and closes it again, with the focus on the half;
 * it closes on Not now and Escape (the focus back on the half, or on House picks while the half is off),
 * and on a tap or the focus anywhere else. It stays open through the sign-in its Personalize or Try
 * again starts, and goes once the circle is being worked out, with the focus on House picks if it was
 * in it (ruling F1). While the circle is looked for, or asked for, the half is off and reads "soon".
 */
export function ViewSwitch(props: Omit<ViewToggleProps, "value" | "onChange" | "circleSoon" | "circleDoor" | "halves">): JSX.Element {
  const { view, setView } = useView();
  const { account } = useAccount();
  const circle = useCircle();
  const door = useCircleDoor();
  const navigate = useNavigate();
  const location = useLocation();
  const id = useId();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const house = useRef<HTMLButtonElement>(null);
  const half = useRef<HTMLButtonElement>(null);
  const { addToggle, close } = door;
  useLayoutEffect(() => addToggle(id, { house, circle: half }), [addToggle, id]);

  const open = config.features.circle && circle.ready;
  // The page's own panel, where it has one; else this toggle's, floating under it, open through a sign-in too.
  const page = door.pagePanel;
  const floating = page === null && door.openedBy === id;
  const pageShows = door.door && page !== null && (!page.waits || door.openedBy !== null || circle.state !== "off");
  const toHouse = useCallback(() => house.current?.focus(), []);

  // Floating, it closes on a tap anywhere else, and on Escape, with the focus back on the half (on House
  // picks while the half is off). A tap is heard before the page's own handlers, which the map's may stop.
  useEffect(() => {
    if (!floating) return;
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close("circle");
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [floating, close]);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // The focus going elsewhere on the page (Tab past the panel) closes it, as a tap elsewhere does.
    const next = event.relatedTarget;
    if (floating && next instanceof Node && !event.currentTarget.contains(next)) close();
  };

  const choose = (next: View) => {
    if (next === "circle" && door.door) {
      // The page's panel, showing already, takes the focus; this toggle's own closes again; else it opens.
      if (pageShows) page?.focus();
      else if (floating) close("circle");
      else door.open(id);
      return;
    }
    if (next === "circle" && !open) {
      if (account === undefined) void navigate("/signin", { state: { from: location } });
      return;
    }
    if (next === "circle") circle.dismissReady();
    setView(next);
  };

  return (
    <div ref={root} onBlur={onBlur} className="relative">
      <ViewToggle
        {...props}
        value={view}
        onChange={choose}
        circleSoon={!open && account !== undefined && !door.door}
        circleDoor={
          door.door ? { expanded: floating || pageShows, controls: floating ? panelId : pageShows ? page?.id : undefined } : undefined
        }
        halves={{ house, circle: half }}
      />
      {floating && (
        <DoorPanel
          id={panelId}
          className={`absolute top-full z-20 mt-2 ${FLOAT[props.variant ?? "bar"]}`}
          onLeave={toHouse}
          onClose={() => close("circle")}
        />
      )}
    </div>
  );
}
