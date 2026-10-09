import { type FocusEvent, type JSX, type Ref, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAccount } from "../account/AccountProvider.tsx";
import { useCircleDoor } from "../circle/CircleDoor.tsx";
import { useCircleNews } from "../circle/CircleNews.tsx";
import { useCircle } from "../circle/CircleProvider.tsx";
import { DoorPanel } from "../circle/Personalize.tsx";
import { config } from "../config.ts";
import { copy } from "../copy/en.ts";
import { useView, type View } from "../view/ViewProvider.tsx";
import { CheckIcon, TurningIcon } from "./icons.tsx";

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

/**
 * Each look's group and buttons, and the buttons' padding at the sides (`pad`): none where the halves
 * share the width. `padSlots` is My circle's half's while its slots for a mark take the padding's place.
 */
const LOOK: Record<ViewToggleVariant, { group: string; button: string; pad: string; padSlots: string }> = {
  bar: { group: "rounded-button bg-surface", button: "h-11 flex-1 rounded-[12px] text-[15px]", pad: "", padSlots: "" },
  compact: {
    group: "rounded-tile bg-surface",
    button: "relative h-10 rounded-[10px] text-secondary after:absolute after:inset-x-0 after:-inset-y-0.5",
    pad: "px-4",
    padSlots: "px-1.5",
  },
  panel: { group: "rounded-tile bg-ground", button: "h-11 flex-1 rounded-[10px] text-secondary", pad: "", padSlots: "" },
  map: { group: "rounded-button bg-ground shadow-float", button: "h-11 flex-1 rounded-[12px] text-[15px]", pad: "", padSlots: "" },
};

/**
 * Where My circle stands for its half, when it can't be chosen yet or has just become ready:
 * - `soon`: My circle is not open (`config.features.circle`): off, "My circle · soon";
 * - `waiting`: the person's circle is looked for, or their add-on asks them: off, "My circle";
 * - `working`: Brainstorm works it out: off, "My circle" with the turning arrow after it, named so;
 * - `checked`: a run the person started has just ended in a circle: on, with the check after the words.
 */
export type CircleStatus = "soon" | "waiting" | "working" | "checked";

/**
 * A slot beside My circle's words as wide as its mark and the gap before it (16 px and 6 px): one
 * each side, so the words stay centred and the half keeps its width as the mark comes and goes.
 */
const SLOT = "w-[22px] shrink-0";

/**
 * The check after My circle's words, in the trust colour, fading in and out over the time it shows,
 * unless the person asks for less motion. Drawn after it came (`since`, a toggle on another page), its
 * fade starts as far in as the check has got, not from the start: worked out once, as it is drawn.
 */
function CheckMark({ since }: { since: number | undefined }): JSX.Element {
  const [delay] = useState(() => (since === undefined ? 0 : Math.min(0, since - Date.now())));
  return <CheckIcon size={16} className="text-trust animate-check motion-reduce:animate-none" style={{ animationDelay: `${delay}ms` }} />;
}

/**
 * The mark after My circle's words, about 16 px, in the line icons' style: the arrow, in the words'
 * colour (muted, as the half is off), turning once every 1.6 s, or for a person who asks for less
 * motion fading instead; the check (`CheckMark`), from `since`.
 */
function markOf(status: CircleStatus | undefined, since: number | undefined): JSX.Element | null {
  if (status === "working") return <TurningIcon size={16} className="animate-turn motion-reduce:animate-breathe" />;
  if (status === "checked") return <CheckMark since={since} />;
  return null;
}

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
  /** Where My circle stands, while it can't be chosen yet or has just become ready (`CircleStatus`). */
  circleStatus?: CircleStatus;
  /** When the check came (`Date.now()`'s time), while My circle's half is checked: its fade goes on from there. */
  checkSince?: number;
  /**
   * My circle's half is the door to it, before the person's circle is asked for (Avi, 2026-10-08): it
   * opens, or goes to, the panel that offers Personalize. It is not a view to choose yet, so it is not
   * pressed or unpressed: `expanded` says whether its panel shows, and `controls` names the panel while it does.
   */
  circleDoor?: { expanded: boolean; controls?: string };
  /** Each half's button, for what moves the focus to it. */
  halves?: { house?: Ref<HTMLButtonElement>; circle?: Ref<HTMLButtonElement> };
}

/**
 * The House picks / My circle toggle: two buttons, the chosen one pressed. It tells its parent what was
 * tapped. My circle's half, with no score on it, has its words between two slots, one of which holds
 * its mark while there is one (`circleStatus`): the turning arrow, or the check, which a chosen half
 * does not carry.
 */
export function ViewToggle({
  value,
  onChange,
  scores,
  variant = "bar",
  circleStatus,
  checkSince,
  circleDoor,
  halves,
}: ViewToggleProps): JSX.Element {
  const look = LOOK[variant];
  const views = [
    { view: "house", label: copy.view.house, score: scores?.house },
    { view: "circle", label: copy.view.circle, score: scores?.circle },
  ] as const;
  return (
    <div role="group" aria-label={copy.view.label} className={`flex gap-1 p-1 ${look.group}`}>
      {views.map(({ view, label, score }) => {
        const chosen = view === value;
        const status = view === "circle" && !chosen ? circleStatus : undefined;
        const off = status === "soon" || status === "waiting" || status === "working";
        const door = view === "circle" && circleDoor !== undefined && !off && !chosen;
        const scored = score === undefined ? label : copy.view.withScore(label, copy.score.value(score));
        const words = status === "soon" ? copy.view.circleSoon : scored;
        // "My circle · soon" never takes a mark, and a score leaves no room for one.
        const slots = view === "circle" && circleStatus !== "soon" && score === undefined;
        return (
          <button
            key={view}
            ref={halves?.[view]}
            type="button"
            aria-label={status === "working" ? copy.view.circleWorking : undefined}
            aria-pressed={door ? undefined : chosen}
            aria-expanded={door ? circleDoor?.expanded : undefined}
            aria-controls={door ? circleDoor?.controls : undefined}
            disabled={off}
            onClick={() => {
              if (!chosen) onChange(view);
            }}
            className={`border-0 font-text font-bold ${look.button} ${slots ? look.padSlots : look.pad} ${
              chosen
                ? "cursor-pointer bg-emphasis text-on-emphasis"
                : off
                  ? "cursor-not-allowed bg-transparent text-muted"
                  : "cursor-pointer bg-transparent text-ink"
            }`}
          >
            {slots ? (
              // A block, its children lined up by their middles: inline, it would take its baseline from
              // the empty slot and draw the words lower than the other half's.
              <span className="flex items-center justify-center">
                <span className={SLOT} />
                {words}
                <span className={`flex items-center justify-end ${SLOT}`}>{markOf(status, checkSince)}</span>
              </span>
            ) : (
              words
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The toggle for the app's own view (`useView`). My circle can be chosen once it is open
 * (`config.features.circle`) and the person's circle is ready (`useCircle`, after Personalize). Until
 * then the view stays House picks: tapping My circle goes to the sign-in page for a person who has not
 * signed in, which can come back to where they were, as signing in comes first.
 *
 * Signed in, before their circle is asked for, or when asking for it ended without one, My circle's
 * half is the door to Personalize (`useCircleDoor`; Avi, 2026-10-08). On a page with a panel of its
 * own (the phone's Explore, the Why page), a tap opens it, or goes to it if it shows already. Elsewhere
 * a tap opens a panel that floats under the toggle, and closes it again, with the focus on the half;
 * it closes on Not now and Escape (the focus back on the half, or on House picks while the half is off),
 * and on a tap or the focus anywhere else. It stays open through the sign-in its Personalize or Try
 * again starts, with Cancel and no Not now, and goes once the circle is being worked out, with the
 * focus on House picks if it was in it (ruling F1).
 *
 * While the circle is looked for, or asked for, the half is off and reads "My circle"; once Brainstorm
 * works it out, with the turning arrow after it, and its name says so (Avi, 2026-10-09). When a run the
 * person started ends in a circle, the half is on, with the check after it for a moment
 * (`useCircleNews`). While My circle is not open at all, the half is off and reads "soon".
 */
export function ViewSwitch(
  props: Omit<ViewToggleProps, "value" | "onChange" | "circleStatus" | "checkSince" | "circleDoor" | "halves">,
): JSX.Element {
  const { view, setView } = useView();
  const { account } = useAccount();
  const circle = useCircle();
  const door = useCircleDoor();
  const { checked, checkedSince } = useCircleNews();
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
    setView(next);
  };

  // My circle's half: off while My circle is not open, or the circle is looked for or asked for; with
  // the check for a moment once a run the person started ends in it.
  let status: CircleStatus | undefined;
  if (account !== undefined && !open && !door.door) {
    status = !config.features.circle ? "soon" : circle.state === "working" ? "working" : "waiting";
  } else if (open && checked) {
    status = "checked";
  }

  return (
    <div ref={root} onBlur={onBlur} className="relative">
      <ViewToggle
        {...props}
        value={view}
        onChange={choose}
        circleStatus={status}
        checkSince={checkedSince}
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
